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
import subprocess

import uiautomator2 as u2

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "app.panda.tv"
STATE = "/data/user/0/app.panda.tv/files/user-state.json"
RULES = "/data/user/0/app.panda.tv/files/play-sources.json"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial", default="127.0.0.1:16416")
    parser.add_argument("--label", default="playback-transitions")
    parser.add_argument("--case", choices=["focus", "seek", "speed", "next", "missing", "all"], default="all")
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
    report = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "cases": [], "unavailable": [], "failures": []}
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

    def wait_playing_with_retries(timeout=150):
        deadline = time.monotonic() + timeout
        retries = 0
        last_error = None
        while time.monotonic() < deadline:
            try:
                wait_playing(timeout=min(6, max(1, int(deadline - time.monotonic()))))
                return retries
            except TimeoutError as error:
                last_error = str(error)
                nodes = h.dump_nodes(d)
                labels = h.texts(nodes)
                if "重试" in labels and any("暂时无法连接" in text or "播放失败" in text or "超时" in text for text in labels):
                    raise TimeoutError(f"Retryable source failure before a decodable first frame: {labels}")
                else:
                    time.sleep(.4)
        raise TimeoutError(f"Playback did not advance after {retries} retry actions; {last_error}")

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
            if result and result.get("status") == "unavailable":
                report["unavailable"].append({"name": name, **result})
                print(f"UNAVAILABLE {name}: {result.get('reason', 'measurement unavailable')}", flush=True)
                return
            report["cases"].append({"name": name, "passed": True, **(result or {})})
            print(f"PASS {name}", flush=True)
        except Exception as exc:
            state = snapshot(name + "-failure")
            message = str(exc)
            if isinstance(exc, TimeoutError) and any("暂时无法连接" in text or "超时" in text for text in state["texts"]):
                report["unavailable"].append({"name": name, "reason": message, "state": state,
                                               "detail": "Catalogues returned retryable network errors before this real playback sample could run."})
                print(f"UNAVAILABLE {name}: {message}", flush=True)
            else:
                report["failures"].append({"name": name, "error": message})
                print(f"FAIL {name}: {exc}", flush=True)

    def next_episode():
        restart()
        open_subject("三体", "8.8")
        h.key("enter", wait=.4)
        try:
            wait_playing()
        except TimeoutError as error:
            state = snapshot("episode-playback-unavailable", capture=True)
            labels = state["texts"]
            detail_still_open = "演职员" in labels and any("播放" in text for text in labels)
            retryable = any("暂时无法连接" in text or "超时" in text or "重试" in text for text in labels)
            if detail_still_open or retryable:
                return {"status": "unavailable", "reason": str(error), "detail": "Catalogue or media host failed before a decodable episode was available.", "state": state}
            raise
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
        seek_started = time.monotonic()
        h.wait_for(d, lambda ns: not any(n["class"] == "android.widget.ProgressBar" for n in ns) and any(
            " / " in n["text"] and (h.parse_clock(n["text"].split(" / ")[0]) or 0) >= seek_position + 2 for n in ns
        ), timeout=70)
        seek_recovery_ms = round((time.monotonic() - seek_started) * 1000)
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
        return {"before": before, "seekRecoveryMs": seek_recovery_ms, "seekPositionSec": seek_position,
                "loading": checks, "after": after, "paused": paused, "history": entry}

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

    def seek_control():
        restart()
        open_subject("三体", "8.8")
        h.key("dpad_center", wait=.3)
        try:
            source_retries = wait_playing_with_retries(timeout=150)
        except TimeoutError as error:
            state = snapshot("seek-playback-unavailable", capture=True)
            labels = state["texts"]
            if "演职员" in labels or any("暂时无法连接" in text or "超时" in text for text in labels):
                return {"status": "unavailable", "reason": str(error), "state": state}
            raise

        h.key("menu", wait=.1)
        h.key("dpad_down", wait=.1)
        h.key("dpad_up", wait=.1)
        h.wait_for(d, lambda ns: any(n["focused"] and n["class"] == "android.widget.SeekBar" for n in ns), timeout=8)
        before_nodes = h.dump_nodes(d)
        before_clock = next(n["text"].split(" / ")[0] for n in before_nodes if " / " in n["text"])
        before_sec = h.parse_clock(before_clock)
        started = time.monotonic()
        for _ in range(6):
            h.key("dpad_right", wait=.05)
        requested_nodes = h.dump_nodes(d)
        requested_clock = next(n["text"].split(" / ")[0] for n in requested_nodes if " / " in n["text"])
        requested_sec = h.parse_clock(requested_clock)
        assert before_sec is not None and requested_sec is not None and requested_sec > before_sec, f"Seek bar did not acknowledge D-pad input: {before_clock} -> {requested_clock}"
        request_feedback_ms = round((time.monotonic() - started) * 1000)

        recovered = False
        last = requested_nodes
        until = time.monotonic() + 70
        while time.monotonic() < until:
            last = h.dump_nodes(d)
            labels = h.texts(last)
            if any("暂时无法连接" in text or "播放失败" in text for text in labels):
                break
            if not any(" / " in text for text in labels) or "暂停" not in labels:
                h.key("dpad_down", wait=.05)
            clock_text = next((node["text"] for node in last if " / " in node["text"]), None)
            current = h.parse_clock(clock_text.split(" / ")[0]) if clock_text else None
            if (current is not None and requested_sec is not None and current >= requested_sec + 2
                and "暂停" in labels and not any(node["class"] == "android.widget.ProgressBar" for node in last)):
                recovered = True
                break
            time.sleep(.2)
        if not recovered:
            state = snapshot("seek-recovery-unavailable", capture=True)
            if any("暂时无法连接" in text or "播放失败" in text for text in state["texts"]):
                return {"status": "unavailable", "reason": "Source or media failed during seek refill.", "state": state,
                        "requestFeedbackMs": request_feedback_ms, "beforeClock": before_clock, "requestedClock": requested_clock}
            raise TimeoutError(f"Seek did not refill and advance after 70s: {h.texts(last)}")

        recovered_clock = next(node["text"] for node in last if " / " in node["text"])
        return {"sourceRetries": source_retries, "beforeClock": before_clock, "requestedClock": requested_clock,
                "recoveredClock": recovered_clock, "requestFeedbackMs": request_feedback_ms,
                "seekRecoveryMs": round((time.monotonic() - started) * 1000), "steps": 6}

    def speed_control():
        restart()
        open_subject("三体", "8.8")
        h.key("dpad_center", wait=.4)
        h.wait_for(d, lambda ns: "倍速" in h.texts(ns), timeout=35)
        h.move_focus_to_text(d, "倍速", max_steps=12)
        h.run_adb("logcat", "-c")
        states = [snapshot("speed-initial", capture=True)]
        for _ in range(5):
            if any("2.0×" in text or "2×" in text for text in h.texts(h.dump_nodes(d))):
                break
            h.key("dpad_center", wait=.15)
            states.append(snapshot("speed-step-" + str(len(states) + 1), capture=True))
        final = snapshot("speed-2x-selected", capture=True)
        assert any("2.0×" in text or "2×" in text for text in final["texts"]), f"Remote speed cycle did not reach 2.0x: {final}"
        try:
            retries = wait_playing_with_retries(timeout=150)
        except TimeoutError as error:
            failed = snapshot("speed-playback-unavailable", capture=True)
            return {"status": "unavailable", "selectionPassed": True, "steps": states, "final": final,
                    "reason": str(error), "playbackMeasurement": {"status": "unavailable", "final": failed,
                                                                    "renderedFrames": None, "droppedFrames": None}}
        before = h.dump_nodes(d)
        before_clock = next(n["text"].split(" / ")[0] for n in before if " / " in n["text"])
        before_sec = h.parse_clock(before_clock)
        started = time.monotonic()
        latest = before
        while time.monotonic() - started < 12.5:
            time.sleep(.5)
            latest = h.dump_nodes(d)
            labels = h.texts(latest)
            if any("暂时无法连接" in text or "播放失败" in text for text in labels):
                raise AssertionError(f"Playback failed during 2.0x measurement: {labels}")
            if not any(" / " in text for text in labels):
                h.key("dpad_down", wait=.05)
        after_clock = next(n["text"].split(" / ")[0] for n in latest if " / " in n["text"])
        after_sec = h.parse_clock(after_clock)
        elapsed = time.monotonic() - started
        if before_sec is None or after_sec is None or after_sec <= before_sec:
            return {"status": "unavailable", "selectionPassed": True, "steps": states, "final": final,
                    "reason": "Playback timeline did not advance during the 2.0x measurement window.",
                    "playbackMeasurement": {"status": "unavailable", "wallSeconds": round(elapsed, 2),
                                            "beforeClock": before_clock, "afterClock": after_clock,
                                            "renderedFrames": None, "droppedFrames": None}}
        observed_speed = (after_sec - before_sec) / elapsed

        log = subprocess.run(
            [h.ADB, "-s", args.serial, "logcat", "-d", "-s", "PandaTV:I"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20,
        ).stdout
        measurements = re.findall(r"\[speed\] rate=2\.0x elapsedMs=(\d+) (?:processed|rendered)Frames=(\d+) droppedFrames=(\d+)(?: offsetSamples=(\d+))?", log)
        assert 1.55 <= observed_speed <= 2.45, f"Observed playback rate was {observed_speed:.2f}x at the 2.0x setting"
        renderer_sample = None
        if measurements:
            measure_ms, rendered_frames, dropped_frames = map(int, measurements[-1][:3])
            offset_samples = int(measurements[-1][3] or 0)
            denominator = rendered_frames or offset_samples
            renderer_sample = {"elapsedMs": measure_ms, "renderedOutputBuffers": rendered_frames,
                               "frameProcessingOffsetSamples": offset_samples, "droppedOutputBuffers": dropped_frames,
                               "dropRateDenominatorFrames": denominator,
                               "dropRate": (round(dropped_frames / denominator, 4) if denominator > 0 else None),
                               "coverage": ("decoder counters" if rendered_frames > 0 else "processing-offset callback only" if offset_samples > 0 else "no renderer frame counters")}
        else:
            renderer_sample = {"coverage": "no frame-counter callback sample"}
        return {"steps": states, "final": final, "sourceRetries": retries,
                "rateSample": {"mediaSeconds": after_sec - before_sec, "wallSeconds": round(elapsed, 2), "observedSpeed": round(observed_speed, 2)},
                "rendererSample": renderer_sample}

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
        if args.case in ["seek", "all"]:
            record("seek-control", seek_control)
        if args.case in ["speed", "all"]:
            record("speed-control", speed_control)
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
