"""Replay initials matching and re-editing on the installed release TV APK.

Uses the real metadata service and D-pad keys. Complete user state is restored.
"""

import argparse
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import time

import uiautomator2 as u2

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "app.panda.tv"
STATE = "/data/user/0/app.panda.tv/files/user-state.json"
KEYS = set("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") | {"␣", "⌫"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial", default="127.0.0.1:16416")
    parser.add_argument("--label", required=True)
    parser.add_argument("--case", choices=["initials", "edit", "all"], default="all")
    parser.add_argument("--repeat", type=int, default=2)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("tv_helpers", ROOT / "scripts/verify-tv-mumu.py")
    h = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(h)
    h.SERIAL = args.serial
    os.environ["ADBUTILS_ADB_PATH"] = h.ADB
    d = u2.connect(args.serial)
    out = ROOT / "docs/evidence/runtime/tv-search" / args.label
    out.mkdir(parents=True, exist_ok=True)
    scratch = ROOT / ".tmp/tv-search"
    scratch.mkdir(parents=True, exist_ok=True)
    report = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "cases": [], "failures": []}
    report["version"] = re.search(r"versionName=(\S+)", h.run_adb("shell", "dumpsys", "package", PACKAGE))[1]
    report["apkSha256"] = h.installed_apk_sha256()
    h.run_adb("shell", "am", "force-stop", PACKAGE)
    original = h.run_adb("shell", "cat", STATE)
    backup = scratch / "title-search-state.json"
    backup.write_text(original, encoding="utf-8")

    def snapshot(name):
        xml = d.dump_hierarchy(compressed=False)
        ns = h.parse_nodes(xml)
        (out / f"{name}.xml").write_text(xml.replace("\r\n", "\n").replace("\r", ""), encoding="utf-8", newline="\n")
        d.screenshot(str(out / f"{name}.png"))
        f = h.find_focused(ns)
        return {"texts": h.texts(ns), "focus": f["childTexts"] if f else [],
                "keyboard": "A–Z / 0–9" in h.texts(ns),
                "systemIme": "mInputShown=true" in h.run_adb("shell", "dumpsys", "input_method")}

    def open_search():
        h.run_adb("shell", "am", "force-stop", PACKAGE)
        h.run_adb("shell", "am", "start", "-W", "-n", PACKAGE + "/.ui.MainActivity")
        h.wait_for(d, lambda ns: "播放" in h.texts(ns), timeout=35)
        h.focus_top_bar(d)
        h.move_focus_to_text(d, "搜索", max_steps=15)
        h.key("enter", wait=.3)
        h.wait_for(d, lambda ns: "A–Z / 0–9" in h.texts(ns), timeout=15)

    def focus_input():
        trace = []
        for _ in range(18):
            ns = h.dump_nodes(d)
            f = h.find_focused(ns)
            trace.append({"class": f["class"] if f else None, "texts": f["childTexts"] if f else []})
            if f and f["class"] == "android.widget.EditText":
                return
            h.key("dpad_up", wait=.12)
        raise AssertionError(f"D-pad could not return to the search input; trace={trace}")

    def focus_key(label):
        for _ in range(80):
            ns = h.dump_nodes(d)
            f = h.find_focused(ns)
            if f and h.focus_child_text(ns, f) == label:
                return
            target = next((n for n in ns if n["text"] == label), None)
            if f and target and any(t in KEYS for t in f["childTexts"]):
                if abs(f["cy"] - target["cy"]) > 25:
                    direction = "dpad_down" if f["cy"] < target["cy"] else "dpad_up"
                else:
                    direction = "dpad_right" if f["cx"] < target["cx"] else "dpad_left"
            else:
                direction = "dpad_down"
            h.key(direction, wait=.07)
        raise AssertionError(f"D-pad could not reach keyboard key {label}")

    def submit_input():
        focus_input()
        h.key("dpad_right", wait=.12)
        ns = h.dump_nodes(d)
        f = h.find_focused(ns)
        assert f and "搜索" in f["childTexts"], "Search button was not actually focused"
        started = time.monotonic()
        h.key("enter", wait=.15)
        return started

    def wait_result(title):
        return h.wait_for(d, lambda ns: any(title in t for t in h.texts(ns)) and any(
            n["focused"] and n["cy"] > 250 and n["class"] != "android.widget.EditText" for n in ns
        ), timeout=50)

    def reedit(round_number):
        open_search()
        d(className="android.widget.EditText").set_text("三体")
        submit_input()
        wait_result("三体")
        before = snapshot(f"edit-{round_number}-results")
        assert not before["keyboard"], f"Results did not replace discovery: {before}"
        focus_input()
        h.key("enter", wait=.2)
        after = snapshot(f"edit-{round_number}-input-activated")
        assert after["keyboard"], f"Activating the input did not reopen the custom keypad: {after}"
        assert not after["systemIme"], "A system keyboard opened instead of Panda's keypad"
        h.key("back", wait=.2)
        dismissed = snapshot(f"edit-{round_number}-keyboard-back")
        assert not dismissed["keyboard"] and "三体" in dismissed["texts"], "Back did not restore existing results"
        assert any("三体" in text for text in dismissed["focus"]), "Back did not preserve focus on the input"
        return {"name": "re-edit", "round": round_number, "before": before, "after": after, "dismissed": dismissed}

    def initials(round_number):
        open_search()
        d(className="android.widget.EditText").set_text("")
        for letter in "LBXX":
            focus_key(letter)
            h.key("enter", wait=.06)
        typed = snapshot(f"initials-{round_number}-typed")
        assert "LBXX" in typed["texts"], "The D-pad did not type the requested initials"
        assert not typed["systemIme"], "The TV opened the system keyboard"
        started = submit_input()
        wait_result("蜡笔小新")
        elapsed = round((time.monotonic() - started) * 1000)
        result = snapshot(f"initials-{round_number}-results")
        assert any("蜡笔小新" in t for t in result["texts"]), "LBXX did not return the real title"
        focus = h.find_focused(h.dump_nodes(d))
        assert focus and any("蜡笔小新" in t for t in focus["childTexts"]), "The first result is not the expected initial match"
        h.key("enter", wait=.15)
        h.wait_for(d, lambda ns: "演职员" in h.texts(ns) and any("蜡笔小新" in t for t in h.texts(ns)), timeout=35)
        detail = snapshot(f"initials-{round_number}-detail")
        return {"name": "initials", "round": round_number, "query": "LBXX", "resultMs": elapsed,
                "typed": typed, "results": result, "detail": detail}

    try:
        for number in range(1, args.repeat + 1):
            callbacks = []
            if args.case in ("initials", "all"):
                callbacks.append(("initials", initials))
            if args.case in ("edit", "all"):
                callbacks.append(("re-edit", reedit))
            for name, callback in callbacks:
                try:
                    result = callback(number)
                    report["cases"].append({"passed": True, **result})
                    print(f"PASS {name} round {number}", flush=True)
                except Exception as error:
                    state = snapshot(f"{name}-{number}-failure")
                    report["failures"].append({"name": name, "round": number, "error": str(error), "state": state})
                    print(f"FAIL {name} round {number}: {error}", flush=True)
    finally:
        h.run_adb("shell", "am", "force-stop", PACKAGE)
        remote = "/data/local/tmp/panda-tv-title-search-state.json"
        h.run_adb("push", str(backup), remote)
        h.run_adb("shell", "cp", remote, STATE)
        h.run_adb("shell", "rm", remote)
        report["userStateRestored"] = h.run_adb("shell", "cat", STATE) == original
        (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")
    assert report["userStateRestored"], "The complete pre-run user state was not restored"
    assert not report["failures"], f"{len(report['failures'])} TV title-search regressions"


if __name__ == "__main__":
    main()
