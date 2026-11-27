"""Check focus ownership, bezel geometry and root-tab memory on a real installed APK."""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time

import uiautomator2 as u2
import tv_runtime_helpers as helper

PACKAGE = "app.panda.tv"
STATE = f"/data/user/0/{PACKAGE}/files/user-state.json"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--apk", type=Path, required=True)
    parser.add_argument("--case", choices=["bezel", "channel_memory", "channel_grid_viewport", "detail_return", "channel_eviction",
                                           "channel_eviction_aux_click", "library_root_memory", "confirmation", "keypad_back"], action="append")
    args = parser.parse_args()
    helper.SERIAL = args.serial
    os.environ["ADBUTILS_ADB_PATH"] = helper.ADB
    device = u2.connect(args.serial)
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    apk_hash = helper.installed_apk_sha256()
    assert apk_hash == hashlib.sha256(args.apk.read_bytes()).hexdigest().upper(), "Wrong APK installed"
    report = {
        "at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "apkSha256": apk_hash,
        "device": helper.run_adb("shell", "getprop", "ro.build.version.release").strip(),
        "density": helper.run_adb("shell", "wm", "density").strip(), "cases": [],
    }
    key = helper.key
    labels = helper.texts

    def nodes():
        return helper.dump_nodes(device)

    def focused(tree):
        focus = [node for node in tree if node["focused"]]
        assert len(focus) == 1, f"Expected one focus target, got {focus}"
        return focus[0]

    def snap(name):
        xml = device.dump_hierarchy(compressed=False)
        tree = helper.parse_nodes(xml)
        shot = device.screenshot()
        shot.save(out / f"{name}.png")
        (out / f"{name}.xml").write_text(xml, encoding="utf-8")
        report["viewport"] = shot.size
        return tree

    def navigation_logs(label):
        process = helper.run_adb("shell", "pidof", PACKAGE).strip()
        if process.isdigit():
            logs = helper.run_adb("logcat", "-d", "--pid", process, "-s", "PandaTV")
            (out / f"{label}-navigation-logcat.txt").write_text(
                "\n".join(line for line in logs.splitlines() if "[navigation]" in line), encoding="utf-8")

    def safe_box(bounds, name):
        left, top, right, bottom = bounds
        width, height = report["viewport"]
        assert 0 < right - left and 0 < bottom - top, f"{name}: focus has no area"
        assert left >= width * .05 - 1 and right <= width * .95 + 1 and top >= height * .05 - 1 and bottom <= height * .95 + 1, \
            f"{name}: {bounds} crosses 5% inset (1px rounding tolerance) on {width}x{height}"

    def move(label):
        tree = helper.move_focus_to_text(device, label, max_steps=18)
        assert label in focused(tree)["childTexts"]

    def restart():
        helper.run_adb("shell", "am", "force-stop", PACKAGE)
        helper.run_adb("shell", "am", "start", "-W", "-n", PACKAGE + "/.ui.MainActivity")
        helper.wait_for(device, lambda tree: "播放" in labels(tree), timeout=45)

    def bezel():
        helper.focus_top_bar(device)
        move("首页")
        key("dpad_down")
        tree = snap("home-bezel")
        tabs = {"首页", "剧集", "电影", "综艺", "动漫", "纪录片", "我的", "搜索", "设置"}
        nav = [node for node in tree if node["focusable"] and node["cx"] > 0 and node["cy"] < report["viewport"][1] * .13
               and tabs.intersection(node["childTexts"])]
        assert len(nav) == len(tabs), f"Missing or clipped top navigation tabs: {nav}"
        for node in nav:
            safe_box(node["bounds"], node["childTexts"])
        safe_box(focused(tree)["bounds"], "home focus")

    def channel_memory():
        helper.focus_top_bar(device)
        move("电影")
        key("enter")
        helper.wait_for(device, lambda tree: "最新" in labels(tree))
        key("dpad_down")
        move("最新")
        key("enter")
        helper.wait_for(device, lambda tree: any(node["selected"] and "最新" in node["childTexts"] for node in tree))
        helper.focus_top_bar(device)
        move("剧集")
        key("enter")
        helper.focus_top_bar(device)
        move("电影")
        key("enter")
        tree = snap("channel-return")
        assert any(node["selected"] and "最新" in node["childTexts"] for node in tree), "Returning to a root tab reset its sort"

    def channel_grid_viewport():
        def poster_grid(tree):
            return next((node for node in tree if node["class"] == "android.widget.GridView" and node["bounds"][0] == 0), None)

        viewports = report["channelGridViewports"] = {}
        for tab in ("电影", "剧集", "动漫"):
            helper.focus_top_bar(device)
            move(tab)
            key("enter")
            grid, tree = helper.wait_for(device, poster_grid, timeout=35)
            for _ in range(4):
                if focused(tree)["bounds"][1] >= grid["bounds"][1]:
                    break
                key("dpad_down")
                tree = nodes()
            first_card = focused(tree)
            assert first_card["clickable"] and first_card["bounds"][1] >= grid["bounds"][1], f"{tab}: D-pad Down did not reach a card"
            key("dpad_down", .5)
            tree = snap(f"channel-grid-{tab}")
            current = focused(tree)
            assert current["childTexts"] and current["childTexts"] != first_card["childTexts"], f"{tab}: D-pad Down did not select another card"
            safe_box(current["bounds"], f"{tab} poster focus")
            viewports[tab] = {"gridBottom": poster_grid(tree)["bounds"][3], "windowBottom": tree[0]["bounds"][3],
                              "focusedCard": current["childTexts"]}
        assert all(value["gridBottom"] == value["windowBottom"] for value in viewports.values()), \
            f"An unused footer shortened a channel grid: {viewports}"

    def detail_return():
        helper.focus_top_bar(device)
        move("电影")
        key("enter")
        helper.wait_for(device, lambda tree: sum(n["focusable"] and n["cy"] > 250 for n in tree) >= 6)
        for _ in range(5):
            key("dpad_down", .24)
        time.sleep(.35)
        original = focused(snap("channel-card"))
        safe_box(original["bounds"], "channel focus")
        assert original["cy"] > report["viewport"][1] * .35 and original["childTexts"], f"Replay did not reach a card: {original}"
        key("enter")
        detail_ready = lambda tree: "演职员" in labels(tree) and bool({"收藏", "已收藏"}.intersection(labels(tree)))
        _, tree = helper.wait_for(device, lambda tree: detail_ready(tree) or "重试" in labels(tree))
        if not detail_ready(tree):
            snap("detail-network-error")
            move("重试")
            key("enter")
            helper.wait_for(device, detail_ready)
        key("back")
        restored = focused(snap("channel-card-return"))
        assert restored["childTexts"] == original["childTexts"] and abs(restored["cy"] - original["cy"]) <= report["viewport"][1] * .022, \
            f"Detail Back lost its card or scroll position: {original} -> {restored}"

    def channel_eviction():
        helper.focus_top_bar(device)
        move("电影")
        key("enter")
        helper.wait_for(device, lambda tree: "最新" in labels(tree))
        key("dpad_down")
        move("最新")
        key("enter")
        helper.wait_for(device, lambda tree: sum(n["focusable"] and n["cy"] > 300 for n in tree) >= 6)
        for _ in range(5):
            key("dpad_down", .24)
        original = focused(snap("channel-before-eviction"))
        safe_box(original["bounds"], "channel focus before eviction")
        move("最新")
        departure = focused(snap("channel-departure"))
        report["rootEviction"] = {"navigation": "D-pad", "departureFocus": departure["childTexts"],
                                  "setupFocusNotReturnBaseline": original["childTexts"]}
        for tab in ("剧集", "动漫", "纪录片", "电影"):
            helper.focus_top_bar(device)
            move(tab)
            key("enter")
        tree = snap("channel-after-eviction")
        assert any(node["selected"] and "最新" in node["childTexts"] for node in tree), "Evicting a root view discarded its selected sort"
        key("dpad_down", .35)
        restored = focused(snap("channel-evicted-card-return"))
        assert restored["childTexts"] == departure["childTexts"] and abs(restored["cy"] - departure["cy"]) <= report["viewport"][1] * .022, \
            f"Root eviction lost the actual departure focus: {departure} -> {restored}"

    def channel_eviction_aux_click():
        helper.focus_top_bar(device)
        move("电影")
        key("enter")
        helper.wait_for(device, lambda tree: "最新" in labels(tree))
        key("dpad_down")
        move("最新")
        key("enter")
        helper.wait_for(device, lambda tree: sum(node["focusable"] and node["cy"] > 300 for node in tree) >= 6)
        for _ in range(5):
            key("dpad_down", .24)
        original = focused(snap("channel-aux-before-eviction"))
        safe_box(original["bounds"], "channel focus before auxiliary root activation")
        report["rootEvictionAuxiliary"] = {"navigation": "Auxiliary top-bar tap to focus, then Confirm; not remote reachability evidence",
                                           "departureFocus": original["childTexts"]}
        for tab in ("剧集", "动漫", "纪录片", "电影"):
            tab_node = next(node for node in nodes() if node["focusable"] and node["childTexts"] == [tab]
                            and node["cy"] < report["viewport"][1] * .13)
            helper.run_adb("shell", "input", "tap", str(tab_node["cx"]), str(tab_node["cy"]))
            time.sleep(.15)
            tab_focus = focused(nodes())
            assert tab_focus["childTexts"] == [tab], f"Auxiliary tap did not focus {tab}: {tab_focus}"
            key("enter", .3)
            activated = snap(f"channel-aux-activated-{tab}")
            active_tabs = [node["childTexts"] for node in activated if node["focusable"] and node["selected"]
                           and node["cy"] < report["viewport"][1] * .13]
            assert [tab] in active_tabs, f"Auxiliary root tap did not activate {tab}: {active_tabs}"
            report["rootEvictionAuxiliary"].setdefault("activations", []).append({"tab": tab, "selected": active_tabs})
        tree = snap("channel-aux-after-eviction")
        assert any(node["selected"] and "最新" in node["childTexts"] for node in tree), "Auxiliary root activation discarded the channel query"
        key("dpad_down", .35)
        restored = focused(snap("channel-aux-card-return"))
        assert restored["childTexts"] == original["childTexts"] and abs(restored["cy"] - original["cy"]) <= report["viewport"][1] * .022, \
            f"Auxiliary root eviction lost the card or scroll position: {original} -> {restored}"

    def confirmation():
        helper.focus_top_bar(device)
        move("设置")
        key("enter")
        helper.wait_for(device, lambda tree: "清空观看历史" in labels(tree))
        move("清空观看历史")
        key("enter")
        helper.wait_for(device, lambda tree: "取消" in labels(tree))
        tree = snap("confirmation")
        assert focused(tree)["childTexts"] == ["取消"], "Confirm did not start on Cancel"
        for direction in ("up", "down", "right", "right", "down", "left", "up"):
            key(f"dpad_{direction}", .06)
            focus = focused(nodes())
            assert focus["childTexts"] in (["取消"], ["清空"]), f"Modal leaked focus: {focus}"
        helper.run_adb("shell", "input", "keyevent", "--longpress", "4")
        time.sleep(.25)
        tree = snap("confirmation-return")
        assert "取消" not in labels(tree) and "清空观看历史" in focused(tree)["childTexts"], "Back did not return focus to the trigger on Settings"

    def library_root_memory():
        helper.focus_top_bar(device)
        move("我的")
        key("enter")
        helper.wait_for(device, lambda tree: "收藏" in labels(tree) and "历史" in labels(tree))
        move("历史")
        key("enter")
        helper.wait_for(device, lambda tree: any(node["selected"] and node["childTexts"] == ["历史"] for node in tree))
        departure = focused(snap("library-root-departure"))
        assert departure["childTexts"] == ["历史"], f"Library departure was not the History tab: {departure}"
        for tab in ("电影", "剧集", "动漫", "我的"):
            helper.focus_top_bar(device)
            move(tab)
            key("enter")
        tree = snap("library-root-return")
        assert any(node["selected"] and node["childTexts"] == ["历史"] for node in tree), "Root navigation discarded the selected library tab"
        key("dpad_down", .35)
        returned = focused(snap("library-root-focus-return"))
        assert returned["childTexts"] == departure["childTexts"], f"Library root return lost its departure focus: {departure} -> {returned}"

    def keypad_back():
        helper.focus_top_bar(device)
        move("搜索")
        key("enter")
        helper.wait_for(device, helper.has_keypad)
        key("enter")
        tree = snap("keypad-focused")
        assert focused(tree)["text"] == "A", "Editing did not enter the keypad"
        key("enter")
        key("back")
        tree = snap("keypad-back")
        assert any(node["class"] == "android.widget.EditText" for node in tree), "Back exited Search while the keypad owned focus"
        assert focused(tree)["class"] == "android.widget.EditText", "Keypad Back did not restore the field"
        key("back")
        tree = snap("search-back")
        assert not any(node["class"] == "android.widget.EditText" for node in tree) and "搜索" in focused(tree)["childTexts"], "Second Back did not restore the Search launcher"

    with tempfile.TemporaryDirectory(prefix="panda-tv-audit-") as scratch:
        backup = Path(scratch) / "user-state.json"
        helper.run_adb("shell", "am", "force-stop", PACKAGE)
        helper.run_adb("pull", STATE, str(backup))
        before = helper.run_adb("shell", "sha256sum", STATE).split()[0]
        try:
            for case in (bezel, channel_memory, channel_grid_viewport, detail_return, channel_eviction,
                         channel_eviction_aux_click, library_root_memory, confirmation, keypad_back):
                if args.case and case.__name__ not in args.case:
                    continue
                try:
                    restart()
                    case()
                    navigation_logs(case.__name__)
                    report["cases"].append({"case": case.__name__, "pass": True})
                    print(f"PASS {case.__name__}", flush=True)
                except Exception as error:
                    report["cases"].append({"case": case.__name__, "pass": False, "error": str(error)})
                    snap(f"failure-{case.__name__}")
                    navigation_logs(case.__name__)
                    print(f"FAIL {case.__name__}: {error}", flush=True)
        finally:
            helper.run_adb("shell", "am", "force-stop", PACKAGE)
            remote = f"/data/local/tmp/{Path(scratch).name}.json"
            helper.run_adb("push", str(backup), remote)
            helper.run_adb("shell", "cp", remote, STATE)
            helper.run_adb("shell", "rm", remote)
            report["userStateRestored"] = helper.run_adb("shell", "sha256sum", STATE).split()[0] == before
            (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    assert report["userStateRestored"] and all(item["pass"] for item in report["cases"]), "TV surface audit failed; see report.json"


if __name__ == "__main__":
    main()
