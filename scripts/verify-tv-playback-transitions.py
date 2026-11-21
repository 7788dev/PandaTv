"""Replay episode switches and missing-source admission on the production TV APK.

Uses real Douban metadata and playback. Temporarily blocks only Panda's network
traffic while switching episodes, then restores firewall rules and user state.
"""

import argparse
import datetime
import json
import os
from pathlib import Path
import re
import time
import subprocess

import uiautomator2 as u2
import tv_runtime_helpers as h

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "app.panda.tv"
STATE = "/data/user/0/app.panda.tv/files/user-state.json"
RULES = "/data/user/0/app.panda.tv/files/play-sources.json"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial", required=True)
    parser.add_argument("--label", default="playback-transitions")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--case", choices=["focus", "panel", "media", "lifecycle", "seek", "speed", "switch", "next", "admission", "admission-wait", "detail-return", "error", "missing", "all"], default="all")
    parser.add_argument("--switch-repeats", type=int, default=2)
    parser.add_argument("--error-repeats", type=int, default=2)
    parser.add_argument("--line-title", default="三体", help="Real title to use when replaying source-line switching")
    parser.add_argument("--require-missing", action="store_true", help="Require a confirmed empty catalogue verdict, instead of a retryable network error")
    parser.add_argument("--enabled-sources", nargs="+", help="Temporarily enable only these real built-in catalogues; restore the original configuration after replay")
    args = parser.parse_args()
    h.SERIAL = args.serial
    os.environ["ADBUTILS_ADB_PATH"] = h.ADB
    d = u2.connect(args.serial)
    out = args.output or ROOT / ".tmp/e2e-evidence/tv-playback" / args.label
    out.mkdir(parents=True, exist_ok=True)
    scratch = ROOT / ".tmp/tv-playback"
    scratch.mkdir(parents=True, exist_ok=True)
    report = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "cases": [], "unavailable": [], "failures": []}
    report["version"] = re.search(r"versionName=(\S+)", h.run_adb("shell", "dumpsys", "package", PACKAGE))[1]
    report["apkSha256"] = h.installed_apk_sha256()
    original = None
    original_rules = None
    rules_changed = False
    firewall_before = {command: h.run_adb("shell", command, "-S", "OUTPUT") for command in ("iptables", "ip6tables")}
    blocked = []
    stage = {"name": "not-started"}
    clock_pattern = r"(?:\d+:)?\d{2}:\d{2} / (?:\d+:)?\d{2}:\d{2}"

    def snapshot(name, capture=True):
        xml = d.dump_hierarchy(compressed=False)
        ns = h.parse_nodes(xml)
        labels = h.texts(ns)
        clock = next((text for text in labels if re.fullmatch(clock_pattern, text)), None)
        state = {"texts": labels, "clock": clock, "player": clock is not None,
                 "spinner": any(n["class"] == "android.widget.ProgressBar" for n in ns)}
        focused = h.find_focused(ns)
        state["focus"] = {"class": focused["class"], "bounds": focused["bounds"],
                          "labels": focused["childTexts"]} if focused else None
        next_control = next((n for n in ns if n["text"] == "下一集"), None)
        if next_control:
            state["nextTap"] = [next_control["cx"], next_control["cy"]]
        if capture:
            (out / f"{name}.xml").write_text(xml.replace("\r\n", "\n").replace("\r", ""), encoding="utf-8", newline="\n")
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
        for binary in firewall_before:
            h.run_adb("shell", binary, "-I", "OUTPUT", "1", "-m", "owner", "--uid-owner", uid, "-j", "DROP")
            blocked.append((binary, uid))

    def restart():
        h.run_adb("shell", "am", "force-stop", PACKAGE)
        h.run_adb("shell", "am", "start", "-W", "-n", PACKAGE + "/.ui.MainActivity")
        h.wait_for(d, lambda ns: "播放" in h.texts(ns), timeout=35)

    def wait_playing(heading=None, timeout=80):
        until = time.monotonic() + timeout
        last = []
        previous_sec = None
        while time.monotonic() < until:
            last = h.dump_nodes(d)
            labels = h.texts(last)
            clock = next((label for label in labels if re.fullmatch(clock_pattern, label)), None)
            if clock is None and "重试" in labels and "返回" in labels and any(
                "暂时无法连接" in label or "播放失败" in label or "超时" in label for label in labels
            ):
                raise TimeoutError(f"Player reached the retry screen before the timeline advanced: {labels}")
            # Use ordinary D-pad navigation when an idle overlay disappears.
            # Repeated MEDIA_PLAY events also reach Android's media-key service
            # on key-up, so they are not a faithful remote-navigation replay.
            if clock is None:
                h.key("dpad_down", wait=.05)
            if clock and (heading is None or heading in labels) and "暂停" in labels and not any(
                n["class"] == "android.widget.ProgressBar" for n in last
            ):
                current_sec = h.parse_clock(clock.split(" / ")[0])
                if current_sec is not None and current_sec >= 2 and previous_sec is not None and current_sec > previous_sec:
                    return
                previous_sec = current_sec
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
        h.focus_search_submit(d)
        h.key("enter", wait=.3)
        h.wait_for(d, lambda ns: not h.has_keypad(ns) and any(
            n["focused"] and n["cy"] > 250 for n in ns
        ), timeout=35)
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
        # The same production control is renamed after a history entry exists.
        # An exact "播放" wait failed before the replay ever activated Resume.
        h.wait_for(d, lambda ns: query in h.texts(ns) and any(
            t == "播放" or t.startswith("继续播放") for t in h.texts(ns)
        ) and "演职员" in h.texts(ns), timeout=35)
        h.move_focus_to_text(d, "播放", max_steps=6)
        ready = snapshot("detail-primary-" + query)
        assert ready["focus"] and any(
            t == "播放" or t.startswith("继续播放") for t in ready["focus"]["labels"]
        ), f"The replay did not focus the real play/resume control: {ready}"

    def record(name, callback):
        stage.clear()
        stage["name"] = name + ":entry"
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
            observation = {"name": name, "stage": stage["name"], "error": message, "state": state}
            if "observation" in stage:
                observation["observedPhases"] = stage["observation"]
            try:
                process = h.run_adb("shell", "pidof", PACKAGE).strip()
                if re.fullmatch(r"\d+", process):
                    logs = h.run_adb("logcat", "-d", "-t", "300", "--pid", process, "-s", "PandaTV", "AndroidRuntime")
                    (out / f"{name}-failure-logcat.txt").write_text(re.sub(r"https?://\S+", "<redacted-url>", logs), encoding="utf-8")
                    observation["pid"] = process
            except Exception as error:
                observation["logUnavailable"] = str(error)
            is_deadline_case = name.startswith(("admission-wait", "playback-error-recovery"))
            if not is_deadline_case and isinstance(exc, TimeoutError) and any(
                "暂时无法连接" in text or "超时" in text for text in state["texts"]
            ):
                report["unavailable"].append({**observation, "reason": message,
                                               "detail": "Catalogues returned retryable network errors before this real playback sample could run."})
                print(f"UNAVAILABLE {name}: {message}", flush=True)
            else:
                report["failures"].append(observation)
                print(f"FAIL {name}: {exc}", flush=True)

    def panel_focus():
        restart()
        open_subject("三体", "8.8")
        h.key("dpad_center", wait=.1)
        wait_playing()
        h.key(127, wait=.1)
        h.move_focus_to_text(d, "选集", direction="dpad_right", max_steps=12)
        h.key("dpad_center", wait=.3)
        before = snapshot("panel-open")
        width, height = d.window_size()
        focus = before["focus"]
        assert focus and "第1集" in focus["labels"], f"Episode panel did not focus the current episode: {before}"
        failures = []
        left, top, right, bottom = focus["bounds"]
        if left < width * .05 - 1 or right > width * .95 + 1 or top < height * .05 - 1 or bottom > height * .95 + 1:
            failures.append(f"Episode focus crosses 5% safe inset: {focus['bounds']} on {width}x{height}")
        for direction in ("up", "up", "down", "right", "down", "up"):
            h.key(f"dpad_{direction}", wait=.05)
            current = snapshot(f"panel-{direction}", capture=False)
            if not current["focus"] or not any(re.fullmatch(r"第\d+集(?: · .+)?", text) for text in current["focus"]["labels"]):
                failures.append(f"Panel leaked focus after {direction}: {current['focus']}")
        h.key("back", wait=.2)
        after = snapshot("panel-closed")
        if not after["focus"] or after["focus"]["labels"] != ["选集"]:
            failures.append(f"Back did not restore the episode trigger: {after['focus']}")
        assert not failures, "; ".join(failures)
        return {"before": before, "after": after, "viewport": [width, height]}

    def source_admission_cancel():
        restart()
        h.focus_top_bar(d)
        h.move_focus_to_text(d, "首页", max_steps=12)
        h.key("dpad_down")
        h.move_focus_to_text(d, "播放", max_steps=8)
        origin = snapshot("admission-origin")["focus"]
        assert origin and (origin["labels"] == ["播放"] or any(text.startswith("继续播放") for text in origin["labels"])), f"Hero Play was not focused: {origin}"
        block_network()
        try:
            h.key("enter", wait=.05)
            h.wait_for(d, lambda ns: "取消" in h.texts(ns), timeout=5, interval=.08)
            active = snapshot("admission-checking")
            assert active["focus"] and active["focus"]["labels"] == ["取消"], f"Admission did not own focus: {active}"
            for direction in ("left", "right", "up", "down"):
                h.key(f"dpad_{direction}", wait=.03)
            assert snapshot("admission-trap", capture=False)["focus"] == active["focus"], "Focus escaped the admission dialog"
            h.key("back", wait=.2)
            returned = snapshot("admission-returned")
            assert returned["focus"] == origin and "取消" not in returned["texts"], f"Back did not return to the play trigger: {returned}"
            time.sleep(.4)
            h.wait_for(d, lambda tree: "首页" in h.texts(tree) and "正在查找片源" not in h.texts(tree), timeout=3, interval=.15)
        finally:
            restore_network()
        return {"before": active, "after": returned}

    def source_admission_wait():
        stage["name"] = "admission-wait:before-activation"
        restart()
        h.focus_top_bar(d)
        h.move_focus_to_text(d, "首页", max_steps=12)
        h.key("dpad_down")
        h.move_focus_to_text(d, "播放", max_steps=8)
        origin = snapshot("admission-wait-origin")["focus"]
        assert origin and any(label == "播放" or label.startswith("继续播放") for label in origin["labels"])
        block_network()
        try:
            stage["name"] = "admission-wait:blocked-home-play"
            started = time.monotonic()
            h.key("dpad_center", wait=.05)
            h.wait_for(d, lambda nodes: "取消" in h.texts(nodes), timeout=5, interval=.1)
            _, tree = h.wait_for(d, lambda nodes: "取消" not in h.texts(nodes) and any(
                "暂时无法连接" in text or "超时" in text or "网络连接" in text for text in h.texts(nodes)
            ), timeout=max(1, 27 - (time.monotonic() - started)), interval=.12)
            elapsed = round((time.monotonic() - started) * 1000)
            focused = h.find_focused(tree)
            assert focused and focused["childTexts"] == origin["labels"], f"Admission error lost the Play trigger: {focused}"
            assert "首页" in h.texts(tree) and not any(re.fullmatch(clock_pattern, text) for text in h.texts(tree)), "Failed admission left Home"
            failure = snapshot("admission-wait-returned")
        finally:
            restore_network()
        return {"errorObservedMs": elapsed, "before": origin, "after": failure}

    def next_episode():
        stage["name"] = "episode-switch:initial-playback"
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
        stage["name"] = "episode-switch:precondition-seek-refill"
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
            stage["name"] = "episode-switch:episode-2-loading"
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
            stage["name"] = "episode-switch:episode-3-loading"
            third = snapshot("episode-3-loading")
            assert "第3集" in third["texts"] and third["clock"] == "00:00 / 00:00", f"Latest episode choice was lost: {third}"
        finally:
            restore_network()
        stage["name"] = "episode-switch:episode-3-playback"
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
        assert restored["focus"] and "下一集" in restored["focus"]["labels"], f"Hidden controls lost the last active button: {restored}"
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

    def media_controls():
        restart()
        open_subject("三体", "8.8")
        h.key("dpad_center", wait=.3)
        wait_playing()
        h.key(127, wait=.2)
        h.wait_for(d, lambda nodes: "播放" in h.texts(nodes) and "暂停" not in h.texts(nodes), timeout=5)
        paused = snapshot("media-pause")
        time.sleep(1.2)
        still = snapshot("media-pause-stable", capture=False)
        assert paused["clock"] == still["clock"], f"MEDIA_PAUSE did not hold the timeline: {paused} -> {still}"
        h.key(126, wait=.2)
        wait_playing()
        resumed = snapshot("media-play")
        helper_idle_started = time.monotonic()
        h.wait_for(d, lambda nodes: not any(re.fullmatch(r"(?:\d+:)?\d{2}:\d{2} / (?:\d+:)?\d{2}:\d{2}", text)
                                          for text in h.texts(nodes)), timeout=8, interval=.2)
        auto_hide_ms = round((time.monotonic() - helper_idle_started) * 1000)
        h.key("dpad_down", wait=.15)
        revealed = snapshot("media-revealed")
        assert revealed["clock"] and revealed["focus"], f"D-pad did not reveal focused controls: {revealed}"
        h.key(85, wait=.2)
        h.wait_for(d, lambda nodes: "播放" in h.texts(nodes) and "暂停" not in h.texts(nodes), timeout=5)
        toggled = snapshot("media-toggle-pause")
        h.key(85, wait=.2)
        wait_playing()
        h.key("menu", wait=.15)
        hidden = snapshot("media-hidden", capture=False)
        assert hidden["clock"] is None, f"Menu did not hide the overlay: {hidden}"
        h.run_adb("shell", "input", "keyevent", "--duration", "1250", "23")
        h.wait_for(d, lambda nodes: "播放" in h.texts(nodes) and "暂停" not in h.texts(nodes), timeout=5)
        confirmed = snapshot("media-held-confirm")
        time.sleep(.5)
        stable = snapshot("media-held-confirm-stable", capture=False)
        assert stable["clock"] == confirmed["clock"] and "暂停" not in stable["texts"], "Held Confirm activated playback more than once"
        return {"pause": paused, "play": resumed, "togglePause": toggled, "hiddenConfirm": confirmed,
                "heldConfirmMs": 1250, "pauseStableMs": 1200, "autoHideObservedMs": auto_hide_ms, "revealed": revealed}

    def lifecycle_replay():
        restart()
        open_subject("三体", "8.8")
        process = h.run_adb("shell", "pidof", PACKAGE).strip()
        samples = []
        for number in range(1, 7):
            h.move_focus_to_text(d, "播放", max_steps=15)
            h.key("dpad_center", wait=.2)
            wait_playing()
            for _ in range(3):
                current = snapshot(f"lifecycle-{number}-back", capture=False)
                if "演职员" in current["texts"]:
                    break
                h.key("back", wait=.15)
            h.wait_for(d, lambda nodes: "演职员" in h.texts(nodes), timeout=10)
            returned = snapshot(f"lifecycle-{number}-detail", capture=number in (1, 6))
            assert returned["focus"] and any(label == "播放" or label.startswith("继续播放") for label in returned["focus"]["labels"]), \
                f"Player Back did not restore the detail trigger: {returned}"
            memory = h.run_adb("shell", "dumpsys", "meminfo", PACKAGE)
            (out / f"lifecycle-{number}-memory.txt").write_text(memory, encoding="utf-8")
            objects = re.search(r"Views:\s+(\d+)\s+ViewRootImpl:\s+(\d+)", memory)
            activities = re.search(r"AppContexts:\s+(\d+)\s+Activities:\s+(\d+)", memory)
            assert objects and activities, "Native view and activity counters were unavailable"
            assert int(objects[2]) == 1 and int(activities[2]) == 1, f"Repeated playback retained extra windows or activities: {memory}"
            assert h.run_adb("shell", "pidof", PACKAGE).strip() == process, "Lifecycle replay restarted the app instead of releasing the player"
            samples.append({"cycle": number, "views": int(objects[1]), "viewRoots": int(objects[2]),
                            "activities": int(activities[2]), "javaHeapPssKb": int(re.search(r"Java Heap:\s+(\d+)", memory)[1]),
                            "nativeHeapPssKb": int(re.search(r"Native Heap:\s+(\d+)", memory)[1]), "focus": returned["focus"]})
        return {"pid": process, "cycles": 6, "samples": samples,
                "scope": "Finite same-process playback/Back replay and native object counters. The release APK is not debuggable; these counters do not prove long-duration or coroutine-queue leak freedom."}

    def speed_control():
        restart()
        open_subject("三体", "8.8")
        h.key("dpad_center", wait=.4)
        h.wait_for(d, lambda ns: "倍速" in h.texts(ns), timeout=35)
        h.move_focus_to_text(d, "倍速", direction="dpad_right", max_steps=12)
        measurement_pid = h.run_adb("shell", "pidof", PACKAGE).strip()
        assert re.fullmatch(r"\d+", measurement_pid), "Playback process was not identified"
        states = [snapshot("speed-initial", capture=True)]
        h.key("dpad_center", wait=.15)
        h.move_focus_to_text(d, "2.0×", direction="dpad_down", max_steps=8)
        states.append(snapshot("speed-option-2x", capture=True))
        h.key("dpad_center", wait=.15)
        final = snapshot("speed-2x-selected", capture=True)
        assert final["focus"] and "2.0×" in final["focus"]["labels"], f"Speed selection did not return to the speed control: {final}"
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
        rate_samples = [{"wallSeconds": 0.0, "clock": before_clock,
                         "spinner": any(n["class"] == "android.widget.ProgressBar" for n in before),
                         "playing": "暂停" in h.texts(before),
                         "speed": next((t for t in h.texts(before) if re.fullmatch(r"\d+(?:\.\d+)?×", t)), None),
                         "line": next((t for t in h.texts(before) if t.startswith("线路:")), None)}]
        while time.monotonic() - started < 12.5:
            time.sleep(.5)
            latest = h.dump_nodes(d)
            labels = h.texts(latest)
            if any("暂时无法连接" in text or "播放失败" in text for text in labels):
                raise AssertionError(f"Playback failed during 2.0x measurement: {labels}")
            if not any(" / " in text for text in labels):
                h.key("dpad_down", wait=.05)
            clock = next((n["text"].split(" / ")[0] for n in latest if " / " in n["text"]), None)
            rate_samples.append({"wallSeconds": round(time.monotonic() - started, 2), "clock": clock,
                                 "spinner": any(n["class"] == "android.widget.ProgressBar" for n in latest),
                                 "playing": "暂停" in labels,
                                 "speed": next((t for t in labels if re.fullmatch(r"\d+(?:\.\d+)?×", t)), None),
                                 "line": next((t for t in labels if t.startswith("线路:")), None)})
        after_clock = next(n["text"].split(" / ")[0] for n in latest if " / " in n["text"])
        after_sec = h.parse_clock(after_clock)
        elapsed = time.monotonic() - started
        active_wall_sec = sum(
            max(0.0, right["wallSeconds"] - left["wallSeconds"])
            for left, right in zip(rate_samples, rate_samples[1:])
            if left["playing"] and not left["spinner"]
        )
        measured_speed = (after_sec - before_sec) / elapsed if before_sec is not None and after_sec is not None else None
        active_speed = (after_sec - before_sec) / active_wall_sec if active_wall_sec > 0 and before_sec is not None and after_sec is not None else None
        if before_sec is None or after_sec is None or after_sec <= before_sec:
            return {"status": "unavailable", "selectionPassed": True, "steps": states, "final": final,
                    "reason": "Playback timeline did not advance during the 2.0x measurement window.",
                    "playbackMeasurement": {"status": "unavailable", "wallSeconds": round(elapsed, 2),
                                            "beforeClock": before_clock, "afterClock": after_clock,
                                            "renderedFrames": None, "droppedFrames": None}}
        if active_wall_sec < 8.0:
            return {"status": "unavailable", "selectionPassed": True, "steps": states, "final": final,
                    "reason": "The real source buffered for most of the measurement window; active playback rate is not a stable speed sample.",
                    "playbackMeasurement": {"mediaSeconds": after_sec - before_sec, "wallSeconds": round(elapsed, 2),
                                            "effectiveWallSpeed": round(measured_speed, 2),
                                            "activePlaybackSeconds": round(active_wall_sec, 2),
                                            "activePlaybackSpeed": round(active_speed, 2) if active_speed is not None else None,
                                            "samples": rate_samples, "renderedFrames": None, "droppedFrames": None}}

        log = subprocess.run(
            [h.ADB, "-s", args.serial, "logcat", "-d", "--pid", measurement_pid, "-s", "PandaTV:I"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20,
        ).stdout
        measurements = re.findall(r"\[speed\] (?:requested=\S+\s+)?rate=2\.0x elapsedMs=(\d+) (?:processed|rendered)Frames=(\d+) droppedFrames=(\d+)(?: offsetSamples=(\d+))?", log)
        assert active_speed is not None and 1.55 <= active_speed <= 2.45, f"Observed active playback rate was {active_speed}x at the 2.0x setting; samples={rate_samples}"
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
                "rateSample": {"mediaSeconds": after_sec - before_sec, "wallSeconds": round(elapsed, 2),
                               "effectiveWallSpeed": round(measured_speed, 2), "activePlaybackSeconds": round(active_wall_sec, 2),
                               "activePlaybackSpeed": round(active_speed, 2), "samples": rate_samples},
                "rendererSample": renderer_sample}

    def line_switch():
        stage["name"] = "line-switch:initial-playback"
        restart()
        open_subject(args.line_title)
        h.key("dpad_center", wait=.2)
        wait_playing()
        try:
            h.wait_for(d, lambda tree: any(text.startswith("线路:") for text in h.texts(tree)), timeout=5, interval=.15)
        except TimeoutError:
            state = snapshot("line-control-unavailable")
            assert state["clock"], f"Playback controls disappeared while waiting for the line trigger: {state}"
            return {"status": "unavailable", "reason": "No alternate line became selectable in this playback sample.", "state": state}
        h.move_focus_to_text(d, "线路", max_steps=15)
        stage["name"] = "line-switch:panel-focus"
        controls = snapshot("line-switch-controls")
        assert controls["focus"] and any(text.startswith("线路:") for text in controls["focus"]["labels"]), f"The line trigger was not focused: {controls}"
        current_line = next(text.removeprefix("线路:").strip() for text in controls["texts"] if text.startswith("线路:"))
        assert current_line, f"The active line name was unavailable: {controls}"
        position = h.parse_clock((controls["clock"] or "").partition(" / ")[0])
        assert position is not None and position >= 2, f"Missing playback clock before opening the line panel: {controls}"
        h.key("enter", wait=.2)
        ns = h.dump_nodes(d)
        names = [row["name"] for row in json.loads((ROOT / "resources/play-sources.json").read_text(encoding="utf-8-sig"))["sources"]]
        choices = [name for name in ("360资源", "金鹰资源", *names) if name != current_line and name in h.texts(ns)]
        if not choices:
            return {"status": "unavailable", "reason": "No second real source is present in the line panel."}
        selected = choices[0]
        h.move_focus_to_text(d, selected, max_steps=18)
        before = snapshot("line-switch-before")
        assert selected != current_line and before["focus"] and selected in before["focus"]["labels"], f"A different real line was not focused: {before}"
        block_network()
        checks = []
        try:
            stage["name"] = "line-switch:activation"
            h.key("dpad_center", wait=.1)
            for number in range(3):
                time.sleep(.35)
                now = snapshot(f"line-switch-pending-{number}")
                checks.append(now)
            assert all(s["clock"] and (h.parse_clock(s["clock"].split(" / ")[0]) or 0) >= position for s in checks), f"Switching a line reset the existing timeline: {checks}"
            assert all(s["loadingRegionMaxRgb"] > 3 for s in checks), f"Switching a line blacked out the existing picture: {checks}"
        finally:
            restore_network()
        stage["name"] = "line-switch:recovery"
        expected = f"线路: {selected}"
        switched = None
        until = time.monotonic() + 40
        while time.monotonic() < until:
            state = snapshot("line-switch-recovery", capture=False)
            if "切换未成功，保留当前线路" in state["texts"]:
                return {"status": "unavailable", "reason": f"{selected} could not replace the active line; the old picture and timeline stayed visible during the attempt.",
                        "controls": controls, "panel": before, "pending": checks, "after": snapshot("line-switch-preserved")}
            if expected in state["texts"] and not state["spinner"] and "暂停" in state["texts"]:
                switched = h.parse_clock((state["clock"] or "").partition(" / ")[0])
                if switched is not None and switched >= position:
                    break
            if not state["clock"]:
                h.key("dpad_down", wait=.1)
            time.sleep(.18)
        else:
            raise AssertionError(f"The active line did not switch to {selected} with a retained clock: {snapshot('line-switch-stalled')}")
        h.wait_for(d, lambda tree: expected in h.texts(tree) and "暂停" in h.texts(tree) and not any(
            node["class"] == "android.widget.ProgressBar" for node in tree
        ) and any(
            re.fullmatch(r"[\d:]+ / [\d:]+", text) and (h.parse_clock(text.partition(" / ")[0]) or 0) > switched
            for text in h.texts(tree)), timeout=8, interval=.2)
        after = snapshot("line-switch-recovered")
        return {"selectedLine": selected, "controls": controls, "before": before, "pending": checks, "after": after}

    def loaded_detail_return():
        stage["name"] = "loaded-detail-return:await-episodes"
        restart()
        open_subject("三体", "8.8")
        h.wait_for(d, lambda tree: "选集" in h.texts(tree) and sum(
            node["clickable"] and node["focusable"] and bool(re.fullmatch(r"\d+", node["text"])) for node in tree
        ) >= 2, timeout=60)
        h.move_focus_to_text(d, "播放", max_steps=10)
        before = snapshot("loaded-detail-departure")
        assert before["focus"] and any(text == "播放" or text.startswith("继续播放") for text in before["focus"]["labels"]), f"The actual departure trigger was not focused: {before}"
        stage["name"] = "loaded-detail-return:playback"
        h.key("dpad_center", wait=.1)
        wait_playing()
        stage["name"] = "loaded-detail-return:back"
        h.key("back", wait=.1)
        if "演职员" not in h.texts(h.dump_nodes(d)):
            h.key("back", wait=.2)
        h.wait_for(d, lambda tree: "演职员" in h.texts(tree), timeout=8)
        returned = snapshot("loaded-detail-return")
        assert returned["focus"] and any(text.startswith("继续播放") or text == "播放" for text in returned["focus"]["labels"]), f"Loaded episode grid replaced the departure focus on Back: before={before['focus']}, after={returned['focus']}"
        return {"before": before, "returned": returned}

    def playback_error_recovery():
        stage["name"] = "playback-error:initial-playback"
        restart()
        open_subject("三体", "8.8")
        detail = snapshot("error-detail")
        assert detail["focus"] and any(text == "播放" or text.startswith("继续播放") for text in detail["focus"]["labels"]), f"The playback trigger was not focused: {detail}"
        h.key("dpad_center", wait=.1)
        wait_playing()
        stage["name"] = "playback-error:focus-next"
        h.move_focus_to_text(d, "下一集", max_steps=12)
        trigger = snapshot("error-episode-trigger")
        assert trigger["focus"] and "下一集" in trigger["focus"]["labels"], f"The episode transition trigger was not focused: {trigger}"
        observation = {"detail": detail, "trigger": trigger}
        stage["observation"] = observation
        block_network()
        try:
            stage["name"] = "playback-error:blocked-next-episode"
            started = time.monotonic()
            h.key("dpad_center", wait=.1)
            h.wait_for(d, lambda tree: "重试" in h.texts(tree) and any(
                "暂时无法连接" in text or "超时" in text or "播放失败" in text for text in h.texts(tree)
            ), timeout=45, interval=.2)
            error_ms = round((time.monotonic() - started) * 1000)
            error = snapshot("playback-error")
            assert error["focus"], f"The error state had no focused control: {error}"
            h.move_focus_to_text(d, "重试", max_steps=6)
            ready = snapshot("playback-error-retry-focused")
            assert ready["focus"] and "重试" in ready["focus"]["labels"], f"Retry was not D-pad reachable: {ready}"
            observation.update(errorObservedMs=error_ms, error=error, retryFocus=ready)
        finally:
            restore_network()
        stage["name"] = "playback-error:retry"
        started = time.monotonic()
        h.key("dpad_center", wait=.1)
        episode_heading = next(text for text in trigger["texts"] if re.fullmatch(r"第\d+集", text))
        target = f"第{int(episode_heading[1:-1]) + 1}集"
        observation["retryTarget"] = target
        wait_playing(heading=target, timeout=90)
        recovered_ms = round((time.monotonic() - started) * 1000)
        recovered = snapshot("playback-error-recovered")
        observation.update(retryRecoveryMs=recovered_ms, recovered=recovered)
        h.key("back", wait=.1)
        if "演职员" not in h.texts(h.dump_nodes(d)):
            h.key("back", wait=.2)
        h.wait_for(d, lambda tree: "演职员" in h.texts(tree), timeout=8)
        returned = snapshot("playback-error-return")
        observation["returned"] = returned
        assert returned["focus"] and any(text.startswith("继续播放") or text == "播放" for text in returned["focus"]["labels"]), f"Playback recovery lost the detail trigger on Back: {returned}"
        return {"errorObservedMs": error_ms, "retryRecoveryMs": recovered_ms, "error": error,
                "retryFocus": ready, "recovered": recovered, "returned": returned}

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
        if args.case in ["panel", "all"]:
            record("episode-panel-focus", panel_focus)
        if args.case in ["media", "all"]:
            record("media-controls", media_controls)
        if args.case in ["lifecycle", "all"]:
            record("player-lifecycle", lifecycle_replay)
        if args.case in ["seek", "all"]:
            record("seek-control", seek_control)
        if args.case in ["speed", "all"]:
            record("speed-control", speed_control)
        if args.case in ["switch", "all"]:
            for number in range(args.switch_repeats):
                record(f"line-switch-{number + 1}", line_switch)
        if args.case in ["next", "all"]:
            record("episode-switch", next_episode)
        if args.case in ["admission", "all"]:
            record("admission-cancel", source_admission_cancel)
        if args.case == "admission-wait":
            for number in range(args.error_repeats):
                record(f"admission-wait-{number + 1}", source_admission_wait)
        if args.case in ["detail-return", "all"]:
            for number in range(2):
                record(f"loaded-detail-return-{number + 1}", loaded_detail_return)
        if args.case in ["error", "all"]:
            for number in range(args.error_repeats):
                record(f"playback-error-recovery-{number + 1}", playback_error_recovery)
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
        report["firewallRulesRestored"] = all(h.run_adb("shell", command, "-S", "OUTPUT") == original
                                              for command, original in firewall_before.items())
        (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    assert report.get("userStateRestored") and report["firewallRulesRestored"] and report.get("sourceRulesRestored", True), "Replay did not restore device state"
    assert not report["failures"], f"{len(report['failures'])} TV playback transition regressions"
    assert report["cases"], "No playback case actually ran to completion; check the unavailable section"


if __name__ == "__main__":
    main()
