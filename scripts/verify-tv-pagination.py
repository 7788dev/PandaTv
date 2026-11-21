"""Replay poster loading and a blocked next page on the installed TV release."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import tempfile
import time

import uiautomator2 as u2

import tv_runtime_helpers as tv


PACKAGE = "app.panda.tv"
STATE = f"/data/user/0/{PACKAGE}/files/user-state.json"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--case", choices=("loading", "channel", "person", "all"), default="all")
    args = parser.parse_args()
    tv.SERIAL = args.serial
    os.environ["ADBUTILS_ADB_PATH"] = tv.ADB
    device = u2.connect(args.serial)
    args.output.mkdir(parents=True, exist_ok=False)
    width, height = device.window_size()
    report = {"at": datetime.now(timezone.utc).isoformat(), "apkSha256": tv.installed_apk_sha256(),
              "viewport": [width, height], "cases": [], "failures": [], "navigation": {}}
    uid = re.search(r"(?:userId|appId)=(\d+)", tv.run_adb("shell", "dumpsys", "package", PACKAGE))[1]
    rules = {tool: tv.run_adb("shell", tool, "-S", "OUTPUT") for tool in ("iptables", "ip6tables")}
    active_rules = []

    def block_network():
        for tool in rules:
            tv.run_adb("shell", tool, "-I", "OUTPUT", "1", "-m", "owner", "--uid-owner", uid, "-j", "DROP")
            active_rules.append(tool)

    def restore_network():
        while active_rules:
            tv.run_adb("shell", active_rules[-1], "-D", "OUTPUT", "-m", "owner", "--uid-owner", uid, "-j", "DROP")
            active_rules.pop()

    def card(node):
        return (node["focusable"] and node["clickable"] and bool(node["directTexts"]) and
                node["bounds"][3] - node["bounds"][1] > height * .2)

    def title(node):
        # The title is a direct text child. The score, poster fallback and
        # status badge are nested and may appear or disappear as art loads.
        return node["directTexts"][0] if card(node) else None

    def focus(tree):
        focused = [node for node in tree if node["focused"]]
        assert len(focused) == 1, f"Expected one focus target, got {focused}"
        return focused[0]

    def capture(name):
        xml = device.dump_hierarchy(compressed=False)
        (args.output / f"{name}.xml").write_text(xml, encoding="utf-8")
        shot = device.screenshot()
        shot.save(args.output / f"{name}.png")
        return shot, tv.parse_nodes(xml)

    def restart():
        tv.run_adb("shell", "am", "force-stop", PACKAGE)
        tv.run_adb("shell", "am", "start", "-W", "-n", PACKAGE + "/.ui.MainActivity")
        tv.wait_for(device, lambda tree: "播放" in tv.texts(tree), timeout=40)
        tv.focus_top_bar(device)

    def open_person():
        tv.move_focus_to_text(device, "搜索", max_steps=15)
        tv.key("dpad_center")
        tv.wait_for(device, tv.has_keypad)
        device(className="android.widget.EditText").set_text("三体")
        tv.focus_search_submit(device)
        tv.key("enter")
        _, tree = tv.wait_for(device, lambda tree: not tv.has_keypad(tree) and any(
            node["focused"] and "三体" in node["childTexts"] and "8.8" in node["childTexts"] for node in tree), timeout=30)
        assert "三体" in focus(tree)["childTexts"]
        tv.key("dpad_center")
        tv.wait_for(device, lambda tree: "演职员" in tv.texts(tree), timeout=35)
        for _ in range(14):
            if "于和伟" in focus(tv.dump_nodes(device))["childTexts"]:
                break
            tv.key("dpad_down", wait=.2)
            tree = tv.dump_nodes(device)
            credits = next((node for node in tree if node["text"] == "演职员"), None)
            if credits and focus(tree)["cy"] > credits["cy"]:
                tv.move_focus_to_text(device, "于和伟", direction="dpad_right", max_steps=8)
                break
        assert "于和伟" in focus(tv.dump_nodes(device))["childTexts"]
        tv.key("dpad_center")
        tv.wait_for(device, lambda tree: "全部作品" in tv.texts(tree) and any(card(node) for node in tree), timeout=40)

    def loading():
        tv.move_focus_to_text(device, "电影", max_steps=12)
        block_network()
        try:
            tv.key("dpad_center", wait=.25)
            tv.wait_for(device, lambda tree: "最热" in tv.texts(tree), timeout=5)
            shot, tree = capture("channel-loading")
            assert not any(card(node) for node in tree), "The real cards loaded before the blocked initial request"
            assert focus(tree)["childTexts"] == ["电影"], "A non-interactive placeholder took focus"
            unit = min(width / 960, height / 540)
            margin, gap = round(width * .053), round(16 * unit)
            card_width = (width - 2 * margin - 5 * gap) // 6
            y = round(height * .34)
            rgb = shot.convert("RGB")
            posters = [rgb.getpixel((margin + card_width // 2 + (card_width + gap) * col, y)) for col in range(6)]
            gutter = rgb.getpixel((margin + card_width + gap // 2, y))
            assert all(sum(pixel) >= sum(gutter) + 30 for pixel in posters), f"No six reserved poster slots: {posters=} {gutter=}"
        finally:
            restore_network()
        _, ready = tv.wait_for(device, lambda tree: sum(card(node) for node in tree) >= 6 or "重试" in tv.texts(tree), timeout=40)
        if "重试" in tv.texts(ready):
            tv.move_focus_to_text(device, "重试", max_steps=12)
            tv.key("dpad_center")
            tv.wait_for(device, lambda tree: sum(card(node) for node in tree) >= 6, timeout=35)
        capture("channel-loading-resolved")
        return {"posterSampleRgb": posters, "gutterSampleRgb": gutter, "sampleY": y}

    def page_failure(kind):
        if kind == "channel":
            tv.move_focus_to_text(device, "电影", max_steps=12)
            tv.key("dpad_center")
            tv.wait_for(device, lambda tree: sum(card(node) for node in tree) >= 6, timeout=35)
        else:
            open_person()
        trace = report["navigation"][kind] = []
        for _ in range(4):
            tree = tv.dump_nodes(device)
            if title(focus(tree)):
                break
            tv.key("dpad_down", wait=.4)
        first = focus(tv.dump_nodes(device))
        assert title(first), f"Did not focus the first row: {first}"
        trace.append({"step": "first-row", "title": title(first), "bounds": first["bounds"]})

        def visible_row(tree, current):
            return {title(node) for node in tree if card(node) and abs(node["cy"] - current["cy"]) < height * .1}

        visited = set()
        block_network()
        try:
            while True:
                tree = tv.dump_nodes(device)
                departure = focus(tree)
                name = title(departure)
                assert name and name not in visited, f"Unexpected focus while walking rows: {departure}"
                visited.update(visible_row(tree, departure))
                tv.key("dpad_down", wait=.42)
                tree = tv.dump_nodes(device)
                following = focus(tree)
                trace.append({"step": "down", "title": title(following), "labels": following["childTexts"], "bounds": following["bounds"]})
                if name == title(following) or "重试" in following["childTexts"]:
                    break
                assert len(trace) < 14, "Never reached the end of the first page under the block"
            assert len(trace) >= 4, f"Never navigated deep into page one: {trace}"
            _, tree = tv.wait_for(device, lambda tree: "重试" in tv.texts(tree), timeout=32)
            if "重试" not in focus(tree)["childTexts"]:
                assert title(focus(tree)) == name, "Page error moved focus away from the last card"
                capture(kind + "-last-card")
                tv.key("dpad_down", wait=.35)
            _, tree = capture(kind + "-retry-focused")
            retry = focus(tree)
            assert "重试" in retry["childTexts"], f"The last row cannot reach pagination retry: {retry}"
            left, top, right, bottom = retry["bounds"]
            assert left >= width * .05 - 1 and right <= width * .95 + 1 and top >= height * .05 - 1 and bottom <= height * .95 + 1
            visible_while_focused = sorted(title(node) for node in tree if card(node))
            assert name in visible_while_focused, f"Entering Retry scrolled away from the last card: {name}, {visible_while_focused}"
            tv.key("dpad_up", wait=.35)
            _, tree = capture(kind + "-retry-up")
            assert title(focus(tree)) == name, f"Up from Retry did not return to {name}: {focus(tree)}"
            tv.key("dpad_down", wait=.35)
            assert "重试" in focus(tv.dump_nodes(device))["childTexts"], "Could not re-enter Retry from the last row"
        finally:
            restore_network()
        tv.key("dpad_center", wait=.2)
        _, tree = tv.wait_for(device, lambda tree: "重试" not in tv.texts(tree) and "正在加载更多" not in tv.texts(tree), timeout=35)
        returned = focus(tree)
        assert title(returned) == name, f"Retry replaced the departure card {name}: {returned}"
        assert abs(returned["cy"] - departure["cy"]) <= 4, f"Retry moved the departure row: before={departure['bounds']} after={returned['bounds']}"
        tv.key("dpad_down", wait=.45)
        _, tree = capture(kind + "-retried")
        resumed = focus(tree)
        assert title(resumed) and title(resumed) not in visited, f"Down after Retry did not reach a new page: {resumed}"
        return {"visitedTitles": sorted(visited), "departureTitle": name, "departureBounds": departure["bounds"],
                "retryBounds": retry["bounds"], "visibleWhileRetryFocused": visible_while_focused,
                "returnedBounds": returned["bounds"], "focusInNextPage": title(resumed)}

    with tempfile.TemporaryDirectory(prefix="panda-tv-page-") as tmp:
        local = Path(tmp) / "state.json"
        remote = f"/data/local/tmp/{Path(tmp).name}.json"
        tv.run_adb("shell", "am", "force-stop", PACKAGE)
        tv.run_adb("pull", STATE, str(local))
        digest = tv.run_adb("shell", "sha256sum", STATE)
        try:
            for name in ("loading", "channel", "person"):
                if args.case not in (name, "all"):
                    continue
                try:
                    restart()
                    details = loading() if name == "loading" else page_failure(name)
                    report["cases"].append({"name": name, **details})
                    print(f"PASS {name}", flush=True)
                except Exception as error:
                    shot, tree = capture(name + "-failure")
                    process = tv.run_adb("shell", "pidof", PACKAGE).strip()
                    if process.isdecimal():
                        raw = tv.run_adb("logcat", "-d", "--pid", process, "-s", "PandaTV")
                        diagnostics = "\n".join(line for line in raw.splitlines() if "[channel]" in line or "[person]" in line)
                        (args.output / f"{name}-failure-network.log").write_text(re.sub(r"https?://\S+", "<redacted-url>", diagnostics), encoding="utf-8")
                    report["failures"].append({"name": name, "error": str(error), "texts": tv.texts(tree)})
                    print(f"FAIL {name}: {error}", flush=True)
        finally:
            restore_network()
            tv.run_adb("shell", "am", "force-stop", PACKAGE)
            tv.run_adb("push", str(local), remote)
            tv.run_adb("shell", "cp", remote, STATE)
            tv.run_adb("shell", "rm", remote)
            report["userStateRestored"] = tv.run_adb("shell", "sha256sum", STATE) == digest
            report["firewallRulesRestored"] = all(tv.run_adb("shell", tool, "-S", "OUTPUT") == rule for tool, rule in rules.items())
            (args.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    assert report["userStateRestored"] and report["firewallRulesRestored"], "Device state changed"
    assert not report["failures"], "TV pagination replay failed"


if __name__ == "__main__":
    main()
