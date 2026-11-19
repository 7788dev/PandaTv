"""Measure production TV focus and scroll frames without clearing user data."""

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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial", default="127.0.0.1:16416")
    parser.add_argument("--label", default="motion")
    parser.add_argument("--repeat", type=int, default=2)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("tv_helpers", ROOT / "scripts/verify-tv-mumu.py")
    h = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(h)
    h.SERIAL = args.serial
    os.environ["ADBUTILS_ADB_PATH"] = h.ADB
    d = u2.connect(args.serial)
    out = ROOT / "docs/evidence/runtime/tv-motion" / args.label
    out.mkdir(parents=True, exist_ok=True)
    report = {
        "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "version": re.search(r"versionName=(\S+)", h.run_adb("shell", "dumpsys", "package", PACKAGE))[1],
        "apkSha256": h.installed_apk_sha256(),
        "display": {"size": h.run_adb("shell", "wm", "size").strip(), "density": h.run_adb("shell", "wm", "density").strip()},
        "cases": [], "failures": [], "focusTrace": [],
    }

    def capture(name):
        xml = d.dump_hierarchy(compressed=False)
        (out / f"{name}.xml").write_text(xml, encoding="utf-8")
        d.screenshot(str(out / f"{name}.png"))
        return h.parse_nodes(xml)

    def measure(name, callback):
        capture(name + "-before")
        pid = h.run_adb("shell", "pidof", PACKAGE).strip()
        h.run_adb("shell", "dumpsys", "gfxinfo", PACKAGE, "reset")
        started = time.monotonic()
        details = callback() or {}
        time.sleep(.35)
        raw = h.run_adb("shell", "dumpsys", "gfxinfo", PACKAGE)
        (out / f"{name}-gfxinfo.txt").write_text(raw, encoding="utf-8")
        stats = h.parse_gfx_stats(raw)
        assert stats["totalFrames"] > 30, f"Insufficient rendered frames: {stats}"
        assert h.run_adb("shell", "pidof", PACKAGE).strip() == pid, "App process restarted during navigation"
        capture(name + "-after")
        report["cases"].append({"name": name, "passed": True, "elapsedMs": round((time.monotonic() - started) * 1000), "frames": stats, **details})
        print(f"PASS {name}: {stats}", flush=True)

    def home_scroll():
        def trace(phase):
            ns = h.dump_nodes(d)
            focus = h.find_focused(ns)
            report["focusTrace"].append({"phase": phase, "focus": {"bounds": focus["bounds"], "labels": focus["childTexts"]} if focus else None})
            return ns

        initial = h.dump_nodes(d)
        hero = next(n for n in initial if n["text"] == "播放" and n["cy"] > 140)
        for _ in range(8):
            h.key("dpad_down", wait=.18)
            trace("down")
        for code in ["dpad_right", "dpad_left"]:
            for _ in range(5):
                h.key(code, wait=.18)
                trace(code)
        for _ in range(18):
            ns = trace("up-check")
            focus = h.find_focused(ns)
            if focus and focus["cy"] > 140 and "播放" in h.focus_child_text(ns, focus):
                returned = next(n for n in ns if n["text"] == "播放" and n["cy"] > 140)
                assert abs(returned["cy"] - hero["cy"]) <= 24, f"Home hero did not return fully: {hero} -> {returned}"
                return {"heroReturnComplete": True, "initialHeroCy": hero["cy"], "returnedHeroCy": returned["cy"]}
            assert not focus or focus["cy"] >= 140, "Home focus escaped before returning to the hero"
            h.key("dpad_up", wait=.18)
        raise AssertionError("Home hero was not reachable")

    def grid_scroll():
        # Single steps exercise focus animation; batches exercise held-key handling.
        for code in ["dpad_down", "dpad_up"]:
            for _ in range(7):
                h.key(code, wait=.18)
        for code in ["20", "19"]:
            h.run_adb("shell", "input", "keyevent", *([code] * 9))
            time.sleep(.35)
        h.focus_top_bar(d)
        return {"normalAndRapidInput": True}

    try:
        h.run_adb("shell", "am", "force-stop", PACKAGE)
        h.run_adb("shell", "am", "start", "-W", "-n", PACKAGE + "/.ui.MainActivity")
        h.wait_for(d, lambda ns: "播放" in h.texts(ns), timeout=35)
        for repeat in range(args.repeat):
            h.focus_top_bar(d)
            h.move_focus_to_text(d, "首页", max_steps=15)
            h.key("dpad_center", wait=.4)
            h.wait_for(d, lambda ns: "播放" in h.texts(ns), timeout=35)
            h.key("dpad_down", wait=.4)
            # A reused home feed can still be aligning its hero after entry.
            # Establish the complete top row before taking the baseline.
            h.focus_top_bar(d)
            h.key("dpad_down", wait=.8)
            measure(f"home-{repeat + 1}", home_scroll)
            h.focus_top_bar(d)
            h.move_focus_to_text(d, "动漫", max_steps=15)
            h.key("dpad_center", wait=.4)
            h.wait_for(d, lambda ns: "最热" in h.texts(ns) and sum(n["focusable"] and n["cy"] > 250 for n in ns) >= 6, timeout=35)
            h.key("dpad_down", wait=.2)
            h.move_focus_to_text(d, "类型:", max_steps=8)
            h.key("dpad_center", wait=.4)
            measure(f"channel-expanded-{repeat + 1}", grid_scroll)
            h.key("back", wait=.2)
    except Exception as error:
        report["failures"].append(str(error))
        capture("failure")
        raise
    finally:
        (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
