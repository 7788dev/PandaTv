"""Replay episode switches and missing-source admission on the production TV APK.

Uses real Douban metadata and playback. Temporarily blocks only Panda's network
traffic while switching episodes, then restores firewall rules and user state.
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
RULES = "/data/user/0/app.panda.tv/files/play-sources.json"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial", default="127.0.0.1:16416")
    parser.add_argument("--label", default="playback-transitions")
    parser.add_argument("--case", choices=["focus", "next", "missing", "all"], default="all")
    parser.add_argument("--require-missing", action="store_true", help="Require a confirmed empty catalogue verdict, instead of a retryable network error")
    parser.add_argument("--enabled-sources", nargs="+", help="Temporarily enable only these real built-in catalogues; restore the original configuration after replay")
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("tv_helpers", ROOT / "scripts/verify-tv-mumu.py")
    h = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(h)
    h.SERIAL = args.serial
    os.environ["ADBUTILS_ADB_PATH"] = h.ADB
    d = u2.connect(args.serial)
    out = ROOT / "docs/evidence/runtime/tv-playback" / args.label
    out.mkdir(parents=True, exist_ok=True)
    scratch = ROOT / ".tmp/tv-playback"
    scratch.mkdir(parents=True, exist_ok=True)
    report = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "cases": [], "failures": []}
    report["version"] = re.search(r"versionName=(\S+)", h.run_adb("shell", "dumpsys", "package", PACKAGE))[1]
    report["apkSha256"] = h.installed_apk_sha256()
    original = None
    original_rules = None
    rules_changed = False
    blocked = []

    def snapshot(name, capture=True):
        xml = d.dump_hierarchy(compressed=False)
        ns = h.parse_nodes(xml)
        labels = h.texts(ns)
        clock = next((t for t in labels if re.fullmatch(r"[\d:]+ / [\d:]+", t)), None)
        state = {"texts": labels, "clock": clock, "player": clock is not None,
                 "spinner": any(n["class"] == "android.widget.ProgressBar" for n in ns)}
        focused = h.find_focused(ns)
        state["focus"] = {"class": focused["class"], "bounds": focused["bounds"],
                          "labels": focused["childTexts"]} if focused else None
        next_control = next((n for n in ns if n["text"] == "下一集"), None)
        if next_control:
            state["nextTap"] = [next_control["cx"], next_control["cy"]]
        if capture:
            (out / f"{name}.xml").write_text(xml, encoding="utf-8")
            shot = d.screenshot()
            shot.save(out / f"{name}.png")
            w, ht = shot.size
            pixels = shot.convert("RGB").crop((int(w * .4), int(ht * .24), int(w * .6), int(ht * .38)))
            state["loadingRegionMaxRgb"] = max(high for _, high in pixels.getextrema())
        return state

    def restore_network():
        for binary, uid in reversed(blocked):
            h.run_adb("shell", binary, "-D", "OUTPUT", "-m", "owner", "--uid-owner", uid, "-j", "DROP")
        blocked.clear()

    def block_network():
        uid = re.search(r"(?:userId|appId)=(\d+)", h.run_adb("shell", "dumpsys", "package", PACKAGE))[1]
        for binary in ["iptables", "ip6tables"]:
            h.run_adb("shell", binary, "-I", "OUTPUT", "1", "-m", "owner", "--uid-owner", uid, "-j", "DROP")
            blocked.append((binary, uid))

    def restart():
        h.run_adb("shell", "am", "force-stop", PACKAGE)
        h.run_adb("shell", "am", "start", "-W", "-n", PACKAGE + "/.ui.MainActivity")
        h.wait_for(d, lambda ns: "播放" in h.texts(ns), timeout=35)

    def wait_playing(heading=None, timeout=80):
        until = time.monotonic() + timeout
        last = []
        while time.monotonic() < until:
            last = h.dump_nodes(d)
            # Use ordinary D-pad navigation when an idle overlay disappears.
            # Repeated MEDIA_PLAY events also reach Android's media-key service
            # on key-up, so they are not a faithful remote-navigation replay.
            if not any(" / " in t for t in h.texts(last)):
                h.key("dpad_down", wait=.05)
            if (heading is None or heading in h.texts(last)) and "暂停" in h.texts(last) and not any(
                n["class"] == "android.widget.ProgressBar" for n in last
            ) and any(
                " / " in n["text"] and (h.parse_clock(n["text"].split(" / ")[0]) or 0) >= 2 for n in last
            ):
                return
            time.sleep(.25)
        raise TimeoutError(f"Playback did not advance; visible texts={h.texts(last)}")

    def open_subject(query, rating=None):
        h.focus_top_bar(d)
        h.move_focus_to_text(d, "搜索", max_steps=15)
        h.key("enter", wait=.5)
        h.wait_for(d, lambda ns: any(n["class"] == "android.widget.EditText" for n in ns))
        snapshot("search-" + query)
        d(className="android.widget.EditText").set_text(query)
        h.key("dpad_right", wait=.1)
        h.key("enter", wait=.3)
        h.wait_for(d, lambda ns: any(n["focused"] and n["cy"] > 250 for n in ns), timeout=35)
        for step in range(36):
            ns = h.dump_nodes(d)
            focus = h.find_focused(ns)
            text = h.focus_child_text(ns, focus) if focus else ""
            if query in text and (rating is None or rating in text):
                break
            h.key("dpad_right" if step % 6 < 5 else "dpad_down", wait=.15)
        else:
            raise AssertionError(f"Real subject not found: {query} {rating}")
        h.key("enter", wait=.3)
        h.wait_for(d, lambda ns: query in h.texts(ns) and "播放" in h.texts(ns) and "演职员" in h.texts(ns), timeout=35)
        h.move_focus_to_text(d, "播放", max_steps=6)

    def record(name, callback):
        try:
            result = callback()
            report["cases"].append({"name": name, "passed": True, **(result or {})})
            print(f"PASS {name}", flush=True)
        except Exception as exc:
            report["failures"].append({"name": name, "error": str(exc)})
            snapshot(name + "-failure")
            print(f"FAIL {name}: {exc}", flush=True)

    def next_episode():
        restart()
        open_subject("三体", "8.8")
        h.key("enter", wait=.4)
        wait_playing()
        h.key("menu", wait=.1)
        h.key("dpad_down", wait=.1)
        # Move into feature content so the old episode is visibly distinguishable
        # from the expected black loading screen, and wait for a buffer refill.
        h.key("dpad_up", wait=.1)
        h.wait_for(d, lambda ns: any(n["focused"] and n["class"] == "android.widget.SeekBar" for n in ns), timeout=5)
        for _ in range(6):
            h.key("dpad_right", wait=.12)
        seek_nodes = h.dump_nodes(d)
        seek_clock = next(n["text"] for n in seek_nodes if " / " in n["text"])
        seek_position = h.parse_clock(seek_clock.split(" / ")[0]) or 0
        h.wait_for(d, lambda ns: not any(n["class"] == "android.widget.ProgressBar" for n in ns) and any(
            " / " in n["text"] and (h.parse_clock(n["text"].split(" / ")[0]) or 0) >= seek_position + 2 for n in ns
        ), timeout=70)
        h.key("dpad_down", wait=.1)
        h.move_focus_to_text(d, "下一集", max_steps=12)
        before = snapshot("episode-1-playing")
        assert before["loadingRegionMaxRgb"] > 3, f"The first episode did not show a distinguishable video frame: {before}"
        block_network()
        try:
            # Screenshot collection can hide an idle overlay. Reveal it again,
            # verify the actual D-pad focus, and activate the observed control.
            h.key("dpad_down", wait=.05)
            h.move_focus_to_text(d, "下一集", max_steps=12)
            h.key("dpad_center", wait=.05)
            checks = []
            for step in range(3):
                time.sleep(.5)
                now = snapshot(f"episode-2-loading-{step + 1}")
                checks.append(now)
            second = checks[-1]
            assert "第2集" in second["texts"], f"Header did not switch immediately: {second}"
            assert all(s["clock"] == "00:00 / 00:00" for s in checks), f"Old episode kept its timeline during resolve: {checks}"
            assert all(s["spinner"] and s["loadingRegionMaxRgb"] <= 3 for s in checks), f"Old video stayed visible during next-episode loading: {checks}"
            # A second quick choice must replace the unfinished episode-2 request.
            h.key("dpad_down", wait=.05)
            h.move_focus_to_text(d, "下一集", max_steps=12)
            h.key("dpad_center", wait=.05)
            time.sleep(.5)
            third = snapshot("episode-3-loading")
            assert "第3集" in third["texts"] and third["clock"] == "00:00 / 00:00", f"Latest episode choice was lost: {third}"
        finally:
            restore_network()
        wait_playing("第3集")
        after = snapshot("episode-3-playing")
        # A rendered frame and a nonzero clock can remain visible during a
        # later buffer refill. Wait for the live Pause control before navigating
        # to it; its label changes to Play while Media3 is not playing.
        wait_playing("第3集")
        h.key("dpad_down", wait=.1)
        h.move_focus_to_text(d, "暂停", max_steps=12)
        h.key("dpad_center", wait=.2)
        h.wait_for(d, lambda ns: "播放" in h.texts(ns) and "暂停" not in h.texts(ns), timeout=5)
        paused = snapshot("episode-3-paused")
        history = json.loads(h.run_adb("shell", "cat", STATE))["history"]
        entry = next((row for row in history if row["id"] == "db-26647087"), None)
        assert entry is not None and entry["episode"] == 3, f"Latest episode did not own its history: {entry}"
        return {"before": before, "loading": checks, "after": after, "paused": paused, "history": entry}

    def player_focus():
        restart()
        open_subject("三体", "8.8")
        h.key("dpad_center", wait=.1)
        h.wait_for(d, lambda ns: "第1集" in h.texts(ns) and any(" / " in t for t in h.texts(ns)), timeout=35)
        initial = snapshot("player-initial-focus")
        assert initial["focus"] and any(t in ["播放", "暂停"] for t in initial["focus"]["labels"]), f"Player did not focus its playback control: {initial}"
        h.key("dpad_right", wait=.1)
        selected = snapshot("player-next-focus")
        assert selected["focus"] and "下一集" in selected["focus"]["labels"], f"Video layer intercepted the remote focus: {selected}"
        # Hiding the controls and revealing them must also restore a real button.
        h.key("menu", wait=.1)
        h.key("dpad_down", wait=.1)
        restored = snapshot("player-restored-focus")
        assert restored["focus"] and any(t in ["播放", "暂停"] for t in restored["focus"]["labels"]), f"Hidden controls lost their remote focus: {restored}"
        return {"initial": initial, "next": selected, "restored": restored}

    def missing_source():
        restart()
        # This is a real Douban entry whose absence was previously verified in
        # all built-in catalogues; no invented subject or production fixture.
        open_subject("骑有此理 第四季")
        snapshot("missing-detail")
        h.move_focus_to_text(d, "播放", max_steps=6)
        h.key("dpad_center", wait=.1)
        activation = snapshot("missing-activated")
        assert not activation["player"], f"Source-less subject entered the player before an availability verdict: {activation}"
        states = [activation]
        started = time.monotonic()
        until = time.monotonic() + 28
        verdict = None
        verdict_type = None
        while time.monotonic() < until:
            now = snapshot("missing-wait", capture=False)
            states.append(now)
            if any("没有片源" in t or "未找到可用片源" in t for t in now["texts"]):
                verdict = now
                verdict_type = "missing"
                break
            if any("暂时无法连接" in t or "超时" in t or "网络连接" in t for t in now["texts"]):
                verdict = now
                verdict_type = "retryable"
                break
            time.sleep(.2)
        (out / "missing-observations.json").write_text(json.dumps(states, ensure_ascii=False, indent=2), encoding="utf-8")
        final = snapshot("missing-verdict")
        assert verdict is not None, f"No source verdict within the request budget: activation={activation}, final={final}"
        assert not args.require_missing or verdict_type == "missing", f"A catalogue failed, so absence is unconfirmed: {verdict}"
        assert not any(s["player"] for s in states), f"Missing-source subject entered the player: {states}"
        assert "演职员" in final["texts"], f"Missing-source verdict did not keep the detail page: {final}"
        return {"activation": activation, "verdict": verdict_type, "final": final, "samples": len(states),
                "elapsedMs": round((time.monotonic() - started) * 1000)}

    try:
        h.run_adb("shell", "am", "force-stop", PACKAGE)
        original = h.run_adb("shell", "cat", STATE)
        (scratch / "original-state.json").write_text(original, encoding="utf-8")
        if args.enabled_sources:
            rules = json.loads((ROOT / "resources/play-sources.json").read_text(encoding="utf-8-sig"))
            requested = set(args.enabled_sources)
            known = {row["key"] for row in rules["sources"] if row["enabled"]}
            assert requested <= known, f"Unknown or disabled built-in catalogues: {requested - known}"
            if h.run_adb("shell", "ls", RULES, check=False).strip() == RULES:
                original_rules = h.run_adb("shell", "cat", RULES)
                (scratch / "original-rules.json").write_text(original_rules, encoding="utf-8")
            for row in rules["sources"]:
                row["enabled"] = row["key"] in requested
            rules_file = scratch / "replay-rules.json"
            rules_file.write_text(json.dumps(rules, ensure_ascii=False), encoding="utf-8")
            h.run_adb("push", str(rules_file), "/data/local/tmp/panda-tv-playback-rules.json")
            rules_changed = True
            h.run_adb("shell", "cp", "/data/local/tmp/panda-tv-playback-rules.json", RULES)
            report["enabledSources"] = sorted(requested)
        seeded = json.loads(original)
        seeded["history"] = [row for row in seeded["history"] if row["id"] != "db-26647087"]
        path = scratch / "state-without-subject-history.json"
        path.write_text(json.dumps(seeded, ensure_ascii=False), encoding="utf-8")
        h.run_adb("push", str(path), "/data/local/tmp/panda-tv-playback-state.json")
        h.run_adb("shell", "cp", "/data/local/tmp/panda-tv-playback-state.json", STATE)
        restart()
        if args.case in ["focus", "all"]:
            record("player-focus", player_focus)
        if args.case in ["next", "all"]:
            record("episode-switch", next_episode)
        if args.case in ["missing", "all"]:
            record("missing-source", missing_source)
    finally:
        restore_network()
        if rules_changed:
            h.run_adb("shell", "am", "force-stop", PACKAGE)
            if original_rules is not None:
                h.run_adb("push", str(scratch / "original-rules.json"), "/data/local/tmp/panda-tv-playback-rules.json")
                h.run_adb("shell", "cp", "/data/local/tmp/panda-tv-playback-rules.json", RULES)
                report["sourceRulesRestored"] = h.run_adb("shell", "cat", RULES) == original_rules
            else:
                h.run_adb("shell", "rm", "-f", RULES)
                report["sourceRulesRestored"] = not h.run_adb("shell", "ls", RULES, check=False).strip()
            h.run_adb("shell", "rm", "-f", "/data/local/tmp/panda-tv-playback-rules.json")
        if original is not None:
            h.run_adb("shell", "am", "force-stop", PACKAGE)
            h.run_adb("push", str(scratch / "original-state.json"), "/data/local/tmp/panda-tv-playback-state.json")
            h.run_adb("shell", "cp", "/data/local/tmp/panda-tv-playback-state.json", STATE)
            h.run_adb("shell", "rm", "/data/local/tmp/panda-tv-playback-state.json")
            report["userStateRestored"] = h.run_adb("shell", "cat", STATE) == original
        report["firewallRulesRestored"] = not blocked
        (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    assert not report["failures"], f"{len(report['failures'])} TV playback transition regressions"


if __name__ == "__main__":
    main()
