"""Replay retryable search errors with real network blocking on the installed APK."""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import time

import uiautomator2 as u2
import tv_runtime_helpers as helper

PACKAGE = "app.panda.tv"
STATE = f"/data/user/0/{PACKAGE}/files/user-state.json"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--apk", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repeat", type=int, default=2)
    args = parser.parse_args()
    helper.SERIAL = args.serial
    os.environ["ADBUTILS_ADB_PATH"] = helper.ADB
    device = u2.connect(args.serial)
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    digest = helper.installed_apk_sha256()
    assert digest == hashlib.sha256(args.apk.read_bytes()).hexdigest().upper(), "Wrong APK installed"
    helper.run_adb("shell", "am", "force-stop", PACKAGE)
    original = helper.run_adb("shell", "cat", STATE)
    original_firewall = {binary: helper.run_adb("shell", binary, "-S", "OUTPUT") for binary in ("iptables", "ip6tables")}
    uid = re.search(r"(?:userId|appId)=(\d+)", helper.run_adb("shell", "dumpsys", "package", PACKAGE))[1]
    blocked = []
    report = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "apkSha256": digest,
              "cases": [], "failures": [], "unavailable": []}

    def snapshot(label):
        xml = device.dump_hierarchy(compressed=False)
        nodes = helper.parse_nodes(xml)
        (out / f"{label}.xml").write_text(xml, encoding="utf-8")
        device.screenshot(str(out / f"{label}.png"))
        focus = helper.find_focused(nodes)
        return {"texts": helper.texts(nodes), "focus": focus["childTexts"] if focus else [],
                "focusBounds": focus["bounds"] if focus else None}

    def restore_network():
        for binary in reversed(blocked):
            helper.run_adb("shell", binary, "-D", "OUTPUT", "-m", "owner", "--uid-owner", uid, "-j", "DROP")
        blocked.clear()

    with tempfile.TemporaryDirectory(prefix="panda-tv-error-") as scratch:
        backup = Path(scratch) / "user-state.json"
        backup.write_text(original, encoding="utf-8")
        try:
            for number in range(1, args.repeat + 1):
                try:
                    helper.run_adb("shell", "am", "force-stop", PACKAGE)
                    helper.run_adb("shell", "am", "start", "-W", "-n", PACKAGE + "/.ui.MainActivity")
                    helper.wait_for(device, lambda nodes: "播放" in helper.texts(nodes), timeout=45)
                    helper.focus_top_bar(device)
                    helper.move_focus_to_text(device, "搜索", max_steps=15)
                    helper.key("enter", wait=.2)
                    helper.wait_for(device, helper.has_keypad)
                    for binary in original_firewall:
                        helper.run_adb("shell", binary, "-I", "OUTPUT", "1", "-m", "owner", "--uid-owner", uid, "-j", "DROP")
                        blocked.append(binary)
                    device(className="android.widget.EditText").set_text("三体")
                    helper.focus_search_submit(device)
                    started = time.monotonic()
                    helper.key("enter", wait=.15)
                    helper.wait_for(device, lambda nodes: not helper.has_keypad(nodes) and "重试" in helper.texts(nodes), timeout=75)
                    error_observed_ms = round((time.monotonic() - started) * 1000)
                    error = snapshot(f"search-error-{number}")
                    assert error_observed_ms <= 32_000, f"The page deadline did not produce a prompt error: {error_observed_ms}ms"
                    assert "没有找到相关内容" not in error["texts"], f"A failed query became an empty result: {error}"
                    assert any("加载" in label or "网络" in label or "暂时无法连接" in label or "超时" in label for label in error["texts"]), error
                    restore_network()
                    helper.move_focus_to_text(device, "重试", max_steps=18)
                    focused = snapshot(f"search-retry-focused-{number}")
                    assert focused["focus"] == ["重试"], f"The retry control was not reachable: {focused}"
                    report["cases"].append({"name": "network-error", "round": number, "passed": True,
                                            "errorObservedMs": error_observed_ms,
                                            "retryFocusReadyMs": round((time.monotonic() - started) * 1000), "error": error, "retry": focused})
                    retry_started = time.monotonic()
                    helper.key("enter", wait=.1)
                    helper.wait_for(device, lambda nodes: "重试" not in helper.texts(nodes), timeout=3, interval=.1)
                    helper.wait_for(device, lambda nodes: "重试" in helper.texts(nodes) or any(
                        node["focusable"] and node["cy"] > 250 and "三体" in node["childTexts"] for node in nodes
                    ), timeout=60)
                    result = snapshot(f"search-recovered-{number}")
                    if "重试" in result["texts"]:
                        assert "没有找到相关内容" not in result["texts"], "Retry swallowed a second network failure"
                        report["unavailable"].append({"name": "network-recovery", "round": number, "state": result,
                                                       "reason": "The unblocked metadata service remained unavailable; no recovered result was observed."})
                    else:
                        assert any("三体" in text for text in result["texts"]), result
                        assert any("三体" in text for text in result["focus"]), f"Recovered results lost remote focus: {result}"
                        report["cases"].append({"name": "network-recovery", "round": number, "passed": True,
                                                "retryMs": round((time.monotonic() - retry_started) * 1000), "result": result})
                    print(f"PASS retryable search error round {number}", flush=True)
                except Exception as error:
                    report["failures"].append({"round": number, "error": str(error), "state": snapshot(f"failure-{number}")})
                    print(f"FAIL search error round {number}: {error}", flush=True)
                finally:
                    restore_network()
        finally:
            helper.run_adb("shell", "am", "force-stop", PACKAGE)
            helper.run_adb("push", str(backup), "/data/local/tmp/panda-ui-search-error-state.json")
            helper.run_adb("shell", "cp", "/data/local/tmp/panda-ui-search-error-state.json", STATE)
            helper.run_adb("shell", "rm", "/data/local/tmp/panda-ui-search-error-state.json")
            report["userStateRestored"] = helper.run_adb("shell", "cat", STATE) == original
            report["firewallRulesRestored"] = all(helper.run_adb("shell", binary, "-S", "OUTPUT") == rules
                                                   for binary, rules in original_firewall.items())
            (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    assert report["userStateRestored"] and report["firewallRulesRestored"], "Device state was not restored"
    assert not report["failures"], "Search error replay failed"


if __name__ == "__main__":
    main()
