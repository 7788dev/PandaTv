"""Replay save failures and explicit recovery on an identified installed release APK."""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time

import uiautomator2 as u2
import tv_runtime_helpers as h

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "app.panda.tv"
FILES = f"/data/user/0/{PACKAGE}/files"
STATE = FILES + "/user-state.json"
CLOCK = r"(?:\d+:)?\d{2}:\d{2} / (?:\d+:)?\d{2}:\d{2}"


def shell(*parts: str) -> str:
    return h.run_adb("shell", " ".join(shlex.quote(str(part)) for part in parts))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial", required=True)
    parser.add_argument("--apk", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--case", choices=("storage", "history", "recovery", "all"), default="all")
    parser.add_argument("--repeat", type=int, default=2)
    args = parser.parse_args()
    h.SERIAL = args.serial
    os.environ["ADBUTILS_ADB_PATH"] = h.ADB
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    apk_hash = hashlib.sha256(args.apk.read_bytes()).hexdigest().upper()
    if h.installed_apk_sha256() != apk_hash:
        raise RuntimeError("The installed APK differs from the requested final APK")
    manifest = json.loads((args.snapshot / "manifest.json").read_text(encoding="utf-8"))
    original = json.loads((args.snapshot / "originals/user-state.json").read_text(encoding="utf-8"))
    device = u2.connect(args.serial)
    report = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "serial": args.serial,
              "apkSha256": apk_hash, "cases": [], "unavailable": [], "failures": []}
    stage = {"faultInjected": False}

    def digest(path=STATE):
        return shell("sha256sum", path).split()[0]

    def state():
        return json.loads(shell("cat", STATE))

    def restore():
        result = subprocess.run([sys.executable, "-X", "utf8", str(ROOT / "scripts/tv-device-state.py"),
                                 "restore", "--serial", args.serial, "--output", str(args.snapshot)],
                                capture_output=True, text=True, encoding="utf-8")
        if result.returncode:
            raise RuntimeError("Complete device restoration failed: " + result.stdout + result.stderr)

    def write_bytes(path, contents, name):
        local = out / name
        local.write_bytes(contents)
        remote = "/data/local/tmp/panda-state-replay-" + name
        h.run_adb("push", str(local), remote)
        shell("cp", remote, path)
        shell("rm", "--", remote)

    def snap(name):
        xml = device.dump_hierarchy(compressed=False)
        (out / (name + ".xml")).write_text(xml, encoding="utf-8")
        device.screenshot(str(out / (name + ".png")))
        return h.parse_nodes(xml)

    def move(label, steps=16):
        for _ in range(steps):
            nodes = h.dump_nodes(device)
            focused = h.find_focused(nodes)
            if focused and focused["childTexts"] == [label]:
                return focused
            targets = [node for node in nodes if node["focusable"] and node["childTexts"] == [label]]
            if focused and targets:
                target = min(targets, key=lambda node: abs(node["cy"] - focused["cy"]) * 100 + abs(node["cx"] - focused["cx"]))
                dx, dy = target["cx"] - focused["cx"], target["cy"] - focused["cy"]
                direction = ("dpad_down" if dy > 0 else "dpad_up") if abs(dy) > abs(dx) else ("dpad_right" if dx > 0 else "dpad_left")
                h.key(direction, wait=.15)
            else:
                h.move_focus_to_text(device, label, max_steps=steps)
        raise AssertionError(f"Actual control was not reachable: {label}")

    def activate(label):
        focused = move(label)
        assert focused["childTexts"] == [label], f"Incorrect focused descendant before activation: {focused}"
        h.key("dpad_center", wait=.15)
        return focused["childTexts"]

    def start(recovery=False):
        shell("am", "force-stop", PACKAGE)
        shell("am", "start", "-W", "-n", PACKAGE + "/.ui.MainActivity")
        h.wait_for(device, lambda nodes: ("本机数据读取失败" if recovery else "首页") in h.texts(nodes), timeout=30)

    def alive(pid):
        return shell("pidof", PACKAGE).strip() == pid

    def errors(pid, name):
        text = h.run_adb("logcat", "-d", "--pid", pid, "-v", "threadtime", "-s", "AndroidRuntime:E")
        (out / (name + "-android-runtime.log")).write_text(text, encoding="utf-8")
        assert "FATAL EXCEPTION" not in text, "Saving or recovery crashed the application"

    def storage(name):
        start()
        h.focus_top_bar(device)
        activate("设置")
        h.wait_for(device, lambda nodes: any(node["focused"] and "自动播放下一集" in node["childTexts"] for node in nodes))
        before = snap(name + "-before")
        focused = h.find_focused(before)
        assert focused and focused["childTexts"] == ["自动播放下一集"], "The actual auto-next row must own focus"
        pid = shell("pidof", PACKAGE).strip()
        old = state()
        old_hash = digest()
        try:
            shell("chmod", "555", FILES)
            stage["faultInjected"] = True
            assert shell("stat", "-c", "%a", FILES).strip() == "555"
            h.key("dpad_center", wait=.15)
            _, failed = h.wait_for(device, lambda nodes: "保存失败" in h.texts(nodes), timeout=8, interval=.15)
            snap(name + "-save-failed")
            assert alive(pid) and digest() == old_hash, "A failed save must leave the process and old state intact"
            assert h.find_focused(failed)["childTexts"] == ["自动播放下一集"]
            h.key("dpad_down", wait=.2)
            assert h.find_focused(h.dump_nodes(device))["childTexts"] == ["自动跳过片头片尾"], "The UI must still respond after failure"
            h.key("dpad_up", wait=.2)
        finally:
            shell("chmod", manifest["root"]["mode"], FILES)
        h.key("dpad_center", wait=.1)
        until = time.monotonic() + 8
        while time.monotonic() < until and state()["settings"]["autoNext"] == old["settings"]["autoNext"]:
            time.sleep(.15)
        assert state()["settings"]["autoNext"] is not old["settings"]["autoNext"], "Retry after restoring write access did not commit"
        snap(name + "-retry-saved")
        assert alive(pid)
        errors(pid, name)
        return {"controlFocus": focused["childTexts"], "fault": "files directory chmod 555",
                "saveErrorShown": True, "processSurvived": True, "oldStatePreserved": True,
                "remoteStillResponds": True, "retryCommitted": True}

    def clock(nodes):
        label = next((text for text in h.texts(nodes) if re.fullmatch(CLOCK, text)), None)
        return h.parse_clock(label.split(" / ")[0]) if label else None

    def playing(timeout=85):
        until = time.monotonic() + timeout
        previous = None
        while time.monotonic() < until:
            nodes = h.dump_nodes(device)
            texts = h.texts(nodes)
            current = clock(nodes)
            if current is None:
                h.key("dpad_down", wait=.05)
            if current is not None and current >= 2 and previous is not None and current > previous and "暂停" in texts and not any(node["class"] == "android.widget.ProgressBar" for node in nodes):
                return current
            if "重试" in texts and "返回" in texts and any("暂时无法连接" in text or "超时" in text or "播放失败" in text for text in texts):
                raise TimeoutError("Real source failed before decoded playback could be observed")
            if current is not None:
                previous = current
            time.sleep(.2)
        raise TimeoutError("Real playback did not advance before fault injection")

    def history(name):
        seeded = {**original, "history": [entry for entry in original["history"] if entry["id"] != "db-26647087"],
                  "settings": {**original["settings"], "speed": 1, "quality": "720P", "muted": True}}
        write_bytes(STATE, json.dumps(seeded, ensure_ascii=False).encode(), name + "-seed.json")
        start()
        h.focus_top_bar(device)
        activate("搜索")
        h.wait_for(device, lambda nodes: any(node["class"] == "android.widget.EditText" for node in nodes))
        device(className="android.widget.EditText").set_text("三体")
        h.focus_search_submit(device)
        h.key("dpad_center", wait=.2)
        h.wait_for(device, lambda nodes: not h.has_keypad(nodes) and any(node["focused"] and node["cy"] > 250 for node in nodes), timeout=35)
        for step in range(36):
            focused = h.find_focused(h.dump_nodes(device))
            if focused and "三体" in focused["childTexts"] and "8.8" in focused["childTexts"]:
                break
            h.key("dpad_right" if step % 6 < 5 else "dpad_down", wait=.15)
        else:
            raise TimeoutError("The real 三体 subject was not available in search")
        result_focus = focused["childTexts"]
        h.key("dpad_center", wait=.15)
        h.wait_for(device, lambda nodes: "播放" in h.texts(nodes), timeout=35)
        activate("播放")
        playing()
        pid = shell("pidof", PACKAGE).strip()
        snap(name + "-playing-before-fault")
        try:
            shell("chmod", "555", FILES)
            stage["faultInjected"] = True
            frozen_hash = digest()
            first = clock(h.dump_nodes(device))
            shown = False
            last = first
            until = time.monotonic() + 14
            while time.monotonic() < until:
                nodes = h.dump_nodes(device)
                shown = shown or "保存失败" in h.texts(nodes)
                current = clock(nodes)
                if current is None:
                    h.key("dpad_down", wait=.05)
                else:
                    last = current
                if shown and first is not None and last is not None and last >= first + 2:
                    break
                time.sleep(.15)
            snap(name + "-history-save-failed")
            assert shown, "Periodic history save did not report its write failure"
            assert first is not None and last is not None and last >= first + 2, "Playback stopped after a history save failure"
            assert alive(pid) and digest() == frozen_hash, "History failure must keep the existing file and player process"
        finally:
            shell("chmod", manifest["root"]["mode"], FILES)
        until = time.monotonic() + 12
        while time.monotonic() < until and digest() == frozen_hash:
            time.sleep(.2)
        assert digest() != frozen_hash, "History saving did not resume after write access was restored"
        entry = next(row for row in state()["history"] if row["id"] == "db-26647087")
        assert entry["episode"] == 1 and entry["position"] >= 2 and entry["duration"] > 0
        assert alive(pid)
        errors(pid, name)
        snap(name + "-history-recovered")
        return {"subjectFocus": result_focus, "fault": "files directory chmod 555 during real playback",
                "saveErrorShown": True, "processSurvived": True, "oldStatePreserved": True,
                "positionBefore": first, "positionAfterFailure": last, "historyResumed": True, "recordedEpisode": entry["episode"]}

    def recovery(name):
        damaged = '{"favorites":["db-1"],\n损坏'.encode()
        backup = {**original, "favorites": ["db-1292052"], "history": [], "searches": []}
        backup_bytes = json.dumps(backup, ensure_ascii=False).encode()
        damaged_hash = hashlib.sha256(damaged).hexdigest()
        write_bytes(STATE, damaged, name + "-damaged.json")
        write_bytes(STATE + ".bak", backup_bytes, name + "-backup.json")
        start(recovery=True)
        snap(name + "-recovery-entry")
        nodes = h.dump_nodes(device)
        assert "搜索" not in h.texts(nodes) and "恢复备份" in h.texts(nodes), "Corruption must gate normal writes and offer the valid backup"
        activate("重置本机数据")
        h.wait_for(device, lambda nodes: "取消" in h.texts(nodes))
        assert h.find_focused(h.dump_nodes(device))["childTexts"] == ["取消"]
        h.key("dpad_center", wait=.25)
        assert digest() == damaged_hash and digest(STATE + ".bak") == hashlib.sha256(backup_bytes).hexdigest()
        h.key("back", wait=.2)
        assert digest() == damaged_hash, "Back from recovery replaced the damaged original"
        start(recovery=True)
        activate("恢复备份")
        h.wait_for(device, lambda nodes: "取消" in h.texts(nodes))
        assert h.find_focused(h.dump_nodes(device))["childTexts"] == ["取消"]
        activate("恢复备份")
        h.wait_for(device, lambda nodes: "首页" in h.texts(nodes), timeout=30)
        assert state() == backup
        archives = shell("find", FILES, "-maxdepth", "1", "-name", "user-state.json.corrupt-*").splitlines()
        assert any(digest(path) == damaged_hash for path in archives), "Restore did not preserve exact damaged bytes"
        start()
        assert state() == backup and "重置本机数据" not in h.texts(h.dump_nodes(device))
        snap(name + "-backup-restored")

        restore()
        write_bytes(STATE, damaged, name + "-reset-damaged.json")
        write_bytes(STATE + ".bak", b"bad backup", name + "-reset-backup.json")
        start(recovery=True)
        assert "恢复备份" not in h.texts(h.dump_nodes(device)), "An invalid backup must not be offered"
        activate("重置本机数据")
        h.wait_for(device, lambda nodes: "取消" in h.texts(nodes))
        assert h.find_focused(h.dump_nodes(device))["childTexts"] == ["取消"]
        activate("重置本机数据")
        h.wait_for(device, lambda nodes: "首页" in h.texts(nodes), timeout=30)
        expected = {"favorites": [], "history": [], "searches": [], "settings": {
            "autoNext": True, "skipIntro": True, "quality": "1080P", "speed": 1, "volume": .8, "muted": False}}
        assert state() == expected
        archives = shell("find", FILES, "-maxdepth", "1", "-name", "user-state.json.corrupt-*").splitlines()
        assert any(digest(path) == damaged_hash for path in archives)
        start()
        assert state() == expected
        snap(name + "-reset-restarted")
        return {"normalWritesBlocked": True, "cancelPreservesOriginal": True, "backPreservesOriginal": True,
                "backupRestored": True, "invalidBackupOmitted": True, "confirmedReset": True,
                "originalBytesArchived": True, "healthyRestart": True}

    try:
        for case, callback in (("storage", storage), ("history", history), ("recovery", recovery)):
            if args.case not in (case, "all"):
                continue
            for repeat in range(args.repeat):
                name = f"{case}-{repeat + 1}"
                restore()
                stage["faultInjected"] = False
                try:
                    details = callback(name)
                    report["cases"].append({"name": name, "passed": True, **details})
                    print("PASS " + name, flush=True)
                except Exception as error:
                    observation = {"name": name, "error": f"{type(error).__name__}: {error}", **stage}
                    try:
                        snap(name + "-failure")
                    except Exception as capture_error:
                        observation["captureError"] = str(capture_error)
                    if case == "history" and not stage["faultInjected"] and isinstance(error, TimeoutError):
                        report["unavailable"].append(observation)
                        print("UNAVAILABLE " + name + ": " + str(error), flush=True)
                    else:
                        report["failures"].append(observation)
                        print("FAIL " + name + ": " + str(error), flush=True)
                finally:
                    restore()
                    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    finally:
        restore()
        report["completeUserStateRestored"] = True
        report["firewallRulesRestored"] = True
        report["displaySettingsRestored"] = True
        (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    assert not report["failures"], "TV storage or recovery regression; inspect report.json"
    assert report["cases"], "No storage or recovery case completed"


if __name__ == "__main__":
    main()
