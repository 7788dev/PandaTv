"""Verify that clearing a TV search also cancels its pending results."""

import argparse
import datetime
import importlib.util
import json
import os
from pathlib import Path
import time
import xml.etree.ElementTree as ET

import uiautomator2 as u2

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial", default="127.0.0.1:16416")
    parser.add_argument("--label", default="search-state")
    parser.add_argument("--queries", nargs="+", default=["刘德华", "西游记", "蜡笔小新"])
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("tv_helpers", ROOT / "scripts/verify-tv-mumu.py")
    h = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(h)
    h.SERIAL = args.serial
    os.environ["ADBUTILS_ADB_PATH"] = h.ADB
    d = u2.connect(args.serial)
    out = ROOT / "docs/evidence/runtime/tv-navigation" / args.label
    out.mkdir(parents=True, exist_ok=True)
    report = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "cases": [], "failures": []}
    report["version"] = h.run_adb("shell", "dumpsys", "package", "app.panda.tv").split("versionName=")[-1].splitlines()[0].strip()
    report["apkSha256"] = h.installed_apk_sha256()

    def state(name, capture=False):
        xml = d.dump_hierarchy(compressed=False)
        root = ET.fromstring(xml)
        input_node = next(n for n in root.iter("node") if n.get("class") == "android.widget.EditText")
        movie_grid = any(n.get("class", "").endswith("GridView") and h.parse_bounds(n.get("bounds"))[3] - h.parse_bounds(n.get("bounds"))[1] > 250 for n in root.iter("node"))
        labels = [n.get("text") for n in root.iter("node") if n.get("text")]
        input_text = input_node.get("text", "")
        if input_text == input_node.get("hint"):
            input_text = ""
        result = {"input": input_text, "movieGrid": movie_grid, "discovery": "A–Z / 0–9" in labels, "texts": labels}
        if capture:
            (out / f"{name}.xml").write_text(xml, encoding="utf-8")
            d.screenshot(str(out / f"{name}.png"))
        return result

    h.run_adb("shell", "am", "force-stop", "app.panda.tv")
    user_state = "/data/user/0/app.panda.tv/files/user-state.json"
    original = h.run_adb("shell", "cat", user_state)
    scratch = ROOT / ".tmp/tv-navigation"
    scratch.mkdir(parents=True, exist_ok=True)
    backup = scratch / "search-state-original.json"
    backup.write_text(original, encoding="utf-8")
    try:
        h.run_adb("shell", "am", "start", "-W", "-n", "app.panda.tv/.ui.MainActivity")
        h.wait_for(d, lambda ns: "播放" in h.texts(ns), timeout=30)
        h.focus_top_bar(d)
        h.move_focus_to_text(d, "搜索", max_steps=15)
        h.key("enter", wait=.6)
        h.wait_for(d, lambda ns: "A–Z / 0–9" in h.texts(ns), timeout=15)
        for idx, query in enumerate(args.queries):
            d(className="android.widget.EditText").set_text(query)
            # Input -> Search -> submit -> Clear Input -> clear, without network-dependent pauses.
            h.run_adb("shell", "input", "keyevent", "22", "66", "22", "66")
            immediate = state(f"{idx + 1}-clear", capture=True)
            assert not immediate["input"], f"D-pad sequence did not clear the input: {immediate}"
            deadline = time.monotonic() + 12
            last = immediate
            failed = None
            while time.monotonic() < deadline:
                time.sleep(.6)
                last = state("wait")
                if last["movieGrid"] or not last["discovery"]:
                    failed = last
                    break
            state(f"{idx + 1}-settled", capture=True)
            if failed:
                report["failures"].append({"query": query, "afterClear": failed})
                print(f"FAIL {query}: clearing the input was undone by pending search; {failed}", flush=True)
            else:
                report["cases"].append({"query": query, "passed": True, "observedSeconds": 12})
                print(f"PASS {query}: discovery stayed visible after clear", flush=True)
    except Exception as error:
        report["failures"].append({"error": str(error)})
        raise
    finally:
        h.run_adb("shell", "am", "force-stop", "app.panda.tv")
        remote = "/data/local/tmp/panda-tv-search-state.json"
        h.run_adb("push", str(backup), remote)
        h.run_adb("shell", "cp", remote, user_state)
        h.run_adb("shell", "rm", remote)
        report["userStateRestored"] = h.run_adb("shell", "cat", user_state) == original
        (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    assert not report["failures"], f"{len(report['failures'])} canceled TV searches restored stale results"


if __name__ == "__main__":
    main()
