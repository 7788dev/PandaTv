"""Replay TV D-pad list/header navigation against the installed production APK."""

import argparse
import datetime
import json
import os
from pathlib import Path
import time
import xml.etree.ElementTree as ET

import uiautomator2 as u2
import tv_runtime_helpers as h

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial", required=True)
    parser.add_argument("--label", default="navigation")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--channels", nargs="+", default=["动漫", "电影", "剧集", "综艺", "纪录片"])
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--extended", action="store_true")
    parser.add_argument("--normal-only", action="store_true", help="Skip the fast-right focus-edge variant on unusually short viewports")
    parser.add_argument("--library", action="store_true", help="Use temporary library entries from the emulator's real metadata cache, then restore user state")
    parser.add_argument("--skip-channels", action="store_true")
    args = parser.parse_args()
    h.SERIAL = args.serial
    os.environ["ADBUTILS_ADB_PATH"] = h.ADB
    h.run_adb("get-state")
    d = u2.connect(args.serial)
    out = args.output or ROOT / ".tmp/e2e-evidence/tv-navigation" / args.label
    out.mkdir(parents=True, exist_ok=True)
    report = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "version": h.run_adb("shell", "dumpsys", "package", "app.panda.tv").split("versionName=")[-1].splitlines()[0].strip(),
              "display": {"size": h.run_adb("shell", "wm", "size").strip(), "density": h.run_adb("shell", "wm", "density").strip()},
              "cases": [], "failures": []}
    report["apkSha256"] = h.installed_apk_sha256()

    def snapshot(name, capture=False):
        xml = d.dump_hierarchy(compressed=False)
        root = ET.fromstring(xml)
        focused = next((n for n in root.iter("node") if n.get("focused") == "true"), None)
        grids = [n for n in root.iter("node") if n.get("class", "").endswith("GridView") and h.parse_bounds(n.get("bounds"))[3] - h.parse_bounds(n.get("bounds"))[1] > 250]
        grid = max(grids, key=lambda n: len(list(n.iter("node"))), default=None)

        def card(n):
            labels = [c.get("text") for c in n.iter("node") if c.get("text")]
            # A movie card has a title followed by optional subtitle; score/status badges precede it.
            direct_labels = [c.get("text") for c in n if c.get("text")]
            return {"title": direct_labels[0] if direct_labels else " | ".join(labels), "labels": labels, "bounds": h.parse_bounds(n.get("bounds")), "focused": focused is not None and any(c is focused for c in n.iter("node"))}

        cards = [card(n) for n in grid if n.get("focusable") == "true" and n.get("clickable") == "true"] if grid is not None else []
        state = {"focus": card(focused) if focused is not None else None, "cards": cards, "gridBounds": h.parse_bounds(grid.get("bounds")) if grid is not None else None,
                 "focusedInGrid": grid is not None and focused is not None and any(n is focused for n in grid.iter("node"))}
        if capture:
            (out / f"{name}.xml").write_text(xml, encoding="utf-8")
            d.screenshot(str(out / f"{name}.png"))
        return state

    def focus_in_grid(state):
        return state["focusedInGrid"]

    def detail_ready(nodes):
        labels = h.texts(nodes)
        return "演职员" in labels and any(t == "播放" or t.startswith("继续播放") for t in labels)

    def enter_grid():
        for _ in range(5):
            state = snapshot("enter")
            if focus_in_grid(state):
                return state
            h.key("dpad_down", wait=.35)
        raise AssertionError("D-pad Down did not enter the movie grid")

    def round_trip(name, fast=False, column=0):
        initial = enter_grid()
        for _ in range(column):
            h.key("dpad_right", wait=.2)
        initial = snapshot(name + "-first", capture=True)
        first_y = min(c["bounds"][1] for c in initial["cards"])
        first_row = [c for c in initial["cards"] if abs(c["bounds"][1] - first_y) < 20]
        has_later_row = any(c["bounds"][1] > first_y + 20 for c in initial["cards"])
        first_titles = {c["title"] for c in first_row}
        expected_card = next(c for c in first_row if c["focused"])
        expected_title = expected_card["title"]

        def restored_card(state, original):
            l, t, r, b = original["bounds"]
            return next((c for c in state["cards"] if c["title"] == original["title"]
                         and abs((c["bounds"][0] + c["bounds"][2]) - (l + r)) <= 20
                         and abs(c["bounds"][1] - t) <= 14
                         and abs((c["bounds"][3] - c["bounds"][1]) - (b - t)) <= 24), None)
        if fast:
            h.run_adb("shell", "input", "keyevent", *(["20"] * 8))
        else:
            for _ in range(8):
                h.key("dpad_down", wait=.22)
        time.sleep(.6)
        down = snapshot(name + "-down", capture=True)
        assert focus_in_grid(down), "D-pad Down unexpectedly left the movie grid"
        if not has_later_row:
            # Live title search often returns a single six-column row. Still
            # test the real first-row/header boundary and focus restoration;
            # there is no second row to use as a scroll fixture.
            trace = [down["focus"]]
            h.key("dpad_up", wait=.32)
            header = snapshot(name + "-header", capture=True)
            assert not focus_in_grid(header), f"Up from the only poster row did not reach its header: {header['focus']}"
            retained = [restored_card(header, original) for original in first_row]
            assert all(retained), f"The only poster row was lost when leaving it: {retained}"
            h.key("dpad_down", wait=.5)
            reentered = snapshot(name + "-reentered", capture=True)
            assert focus_in_grid(reentered) and reentered["focus"]["title"] == expected_title, \
                f"Down from the header did not restore the only poster row: {reentered['focus']}"
            return {"name": name, "fast": fast, "column": column, "rowCount": 1,
                    "upPressesToHeader": 1, "firstMovie": expected_title, "trace": trace,
                    "passed": True, "navigationScope": "Single live result row; checked header return and first-row restoration."}
        assert down["focus"]["title"] not in first_titles, "Test did not scroll beyond the first row"
        trace = []
        saw_first_row = False
        for step in range(24):
            h.key("dpad_up", wait=.32)
            now = snapshot(name + f"-up-{step + 1}")
            trace.append(now["focus"])
            if focus_in_grid(now):
                if all(restored_card(now, original) for original in first_row):
                    saw_first_row = True
                    assert now["focus"]["title"] == expected_title, f"Returning up changed the movie column: expected={expected_card}, actual={now['focus']}, trace={trace}"
                    assert abs((now["focus"]["bounds"][0] + now["focus"]["bounds"][2]) - (expected_card["bounds"][0] + expected_card["bounds"][2])) <= 20, f"Returning up changed the movie column: expected={expected_card}, actual={now['focus']}, trace={trace}"
                continue
            restored = [restored_card(now, original) for original in first_row]
            snapshot(name + "-header", capture=True)
            assert saw_first_row, f"Up escaped to header {now['focus']} before reaching the first movie row; trace={trace}"
            assert all(restored), f"First movie row is missing or clipped after reaching the header: {restored}"
            h.key("dpad_down", wait=.5)
            reentered = snapshot(name + "-reentered", capture=True)
            assert focus_in_grid(reentered) and reentered["focus"]["title"] == expected_title, f"Down from header did not restore the same first-row movie: {reentered['focus']}"
            return {"name": name, "fast": fast, "column": column, "upPressesToHeader": step + 1, "firstMovie": expected_title, "trace": trace, "passed": True}
        raise AssertionError("D-pad Up never reached the header")

    def record(name, run):
        try:
            result = run() or {}
            report["cases"].append({"name": name, "passed": True, **result})
            print(f"PASS {name}", flush=True)
        except Exception as exc:
            report["failures"].append({"name": name, "error": str(exc)})
            snapshot(name + "-failure", capture=True)
            print(f"FAIL {name}: {exc}", flush=True)

    def open_channel(channel):
        h.focus_top_bar(d)
        h.move_focus_to_text(d, "首页", max_steps=12)
        h.key("enter", wait=.7)
        h.wait_for(d, lambda ns: "播放" in h.texts(ns) and any(
            node["text"] == "首页" and node["selected"] for node in ns
        ), timeout=30)
        time.sleep(.35)
        h.focus_top_bar(d)
        h.move_focus_to_text(d, channel, max_steps=12)
        h.key("enter", wait=.7)
        h.wait_for(d, lambda ns: "最热" in h.texts(ns) and sum(n["focusable"] and n["cy"] > 250 for n in ns) >= 6, timeout=30)

    def open_search(query):
        h.focus_top_bar(d)
        h.move_focus_to_text(d, "搜索", max_steps=15)
        h.key("enter", wait=.6)
        d(className="android.widget.EditText").set_text(query)
        h.focus_search_submit(d)
        h.key("enter", wait=.5)
        h.wait_for(d, lambda ns: not h.has_keypad(ns) and sum(n["focusable"] and n["cy"] > 250 for n in ns) >= 6, timeout=30)
        time.sleep(.4)

    def search_person():
        open_search("刘德华")
        record("搜索结果回顶", lambda: round_trip("搜索结果回顶"))
        record("搜索末行保持列", lambda: round_trip("搜索末行保持列", fast=True, column=5))
        # Switch the same live Search screen to the subject used to enter its
        # detail and actor-work pages. Direct text setup does not replace the
        # renderer or its navigation path.
        d(className="android.widget.EditText").set_text("三体")
        h.focus_search_submit(d)
        h.key("enter", wait=.5)
        h.wait_for(d, lambda ns: not h.has_keypad(ns) and sum(n["focusable"] and n["cy"] > 250 for n in ns) >= 4, timeout=30)
        time.sleep(.4)
        for _ in range(5):
            h.key("dpad_left", wait=.12)
        for step in range(30):
            ns = h.dump_nodes(d)
            f = h.find_focused(ns)
            ft = h.focus_child_text(ns, f) if f else ""
            if f and f["cy"] > 250 and "三体" in ft and "8.8" in ft:
                break
            h.key("dpad_right" if step % 6 < 5 else "dpad_down", wait=.25)
        else:
            raise AssertionError("Could not select the real 2023 三体 series")
        h.key("enter", wait=.7)
        h.wait_for(d, detail_ready, timeout=30)
        for _ in range(12):
            ns = h.dump_nodes(d)
            f = h.find_focused(ns)
            if f and "于和伟" in h.focus_child_text(ns, f):
                break
            h.key("dpad_down", wait=.3)
            ns = h.dump_nodes(d)
            cast_head = next((n for n in ns if n["text"] == "演职员"), None)
            f = h.find_focused(ns)
            if f and cast_head and f["cy"] > cast_head["cy"]:
                h.move_focus_to_text(d, "于和伟", direction="dpad_right", max_steps=8)
                break
        h.key("enter", wait=.7)
        h.wait_for(d, lambda ns: "全部作品" in h.texts(ns) and sum(n["focusable"] and n["cy"] > 200 for n in ns) >= 6, timeout=30)
        record("影人作品回顶", lambda: round_trip("影人作品回顶"))
        h.key("back", wait=.7)
        h.key("back", wait=.7)

    def library_cases():
        state_path = "/data/user/0/app.panda.tv/files/user-state.json"
        temp_remote = "/data/local/tmp/panda-tv-navigation-state.json"
        scratch = ROOT / ".tmp/tv-navigation"
        original_file = scratch / "library-original.json"
        h.run_adb("shell", "am", "force-stop", "app.panda.tv")
        original = h.run_adb("shell", "cat", state_path)
        original_file.write_text(original, encoding="utf-8")
        metadata = json.loads(h.run_adb("shell", "cat", "/data/user/0/app.panda.tv/files/cache/metadata-v1.json"))
        ids = [r["item"]["id"] for r in metadata["records"] if r["item"]["type"] == "movie"][-36:]
        assert len(ids) >= 24, "Need at least 24 real cached movies for multi-row library navigation"
        seeded = json.loads(original)
        seeded["favorites"] = ids
        now = int(time.time() * 1000)
        seeded["history"] = [{"id": ident, "episode": 1, "position": 0.0, "duration": 0.0, "at": now - index} for index, ident in enumerate(ids)]
        seeded_file = scratch / "library-fixture.json"
        seeded_file.write_text(json.dumps(seeded, ensure_ascii=False), encoding="utf-8")
        try:
            h.run_adb("push", str(seeded_file), temp_remote)
            h.run_adb("shell", "cp", temp_remote, state_path)
            h.run_adb("shell", "am", "start", "-W", "-n", "app.panda.tv/.ui.MainActivity")
            h.wait_for(d, lambda ns: "播放" in h.texts(ns), timeout=30)
            h.focus_top_bar(d)
            h.move_focus_to_text(d, "我的", max_steps=12)
            h.key("enter", wait=.7)
            h.wait_for(d, lambda ns: sum(n["focusable"] and n["cy"] > 250 for n in ns) >= 6, timeout=30)
            record("收藏列表回顶", lambda: round_trip("收藏列表回顶"))

            def return_from_detail():
                enter_grid()
                for _ in range(3):
                    h.key("dpad_down", wait=.3)
                before = snapshot("收藏返回前", capture=True)
                h.key("enter", wait=.5)
                h.wait_for(d, detail_ready, timeout=30)
                h.key("back", wait=.6)
                time.sleep(.4)
                after = snapshot("收藏返回后", capture=True)
                assert focus_in_grid(after) and after["focus"]["title"] == before["focus"]["title"], f"Back lost the library movie focus: {before['focus']} -> {after['focus']}"
                assert abs(after["focus"]["bounds"][1] - before["focus"]["bounds"][1]) <= 20, f"Back lost library scroll position: {before['focus']} -> {after['focus']}"
                return {"movie": before["focus"]["title"]}

            record("收藏详情返回位置", return_from_detail)
            h.focus_top_bar(d)
            h.key("dpad_down", wait=.3)
            h.move_focus_to_text(d, "历史", max_steps=6)
            h.key("enter", wait=.7)
            h.wait_for(d, lambda ns: sum(n["focusable"] and n["cy"] > 250 for n in ns) >= 4, timeout=30)
            record("历史列表回顶", lambda: round_trip("历史列表回顶"))
        finally:
            h.run_adb("shell", "am", "force-stop", "app.panda.tv")
            h.run_adb("push", str(original_file), temp_remote)
            h.run_adb("shell", "cp", temp_remote, state_path)
            h.run_adb("shell", "rm", temp_remote)
            report["libraryUserStateRestored"] = h.run_adb("shell", "cat", state_path) == original

    state_path = "/data/user/0/app.panda.tv/files/user-state.json"
    scratch = ROOT / ".tmp/tv-navigation"
    scratch.mkdir(parents=True, exist_ok=True)
    backup = scratch / "navigation-original.json"
    h.run_adb("shell", "am", "force-stop", "app.panda.tv")
    original = h.run_adb("shell", "cat", state_path)
    backup.write_text(original, encoding="utf-8")
    try:
        h.run_adb("shell", "am", "start", "-W", "-n", "app.panda.tv/.ui.MainActivity")
        h.wait_for(d, lambda ns: "播放" in h.texts(ns), timeout=30)
        for repeat in range(args.repeat):
            for channel in ([] if args.skip_channels else args.channels):
                variants = [("normal", False, 0)] if args.normal_only else [("normal", False, 0), ("fast-right", True, 5)]
                for variant, fast, col in variants:
                    open_channel(channel)
                    name = f"{channel}-{repeat + 1}-{variant}"
                    try:
                        result = round_trip(name, fast=fast, column=col)
                        report["cases"].append(result)
                        print(f"PASS {name}: first movie={result['firstMovie']}, up presses={result['upPressesToHeader']}", flush=True)
                    except Exception as exc:
                        report["failures"].append({"name": name, "error": str(exc)})
                        snapshot(name + "-failure", capture=True)
                        print(f"FAIL {name}: {exc}", flush=True)
                    h.focus_top_bar(d)
                if args.extended:
                    open_channel(channel)
                    h.key("dpad_down", wait=.3)
                    h.move_focus_to_text(d, "类型:", max_steps=8)
                    h.key("enter", wait=.4)
                    record(f"{channel}筛选展开回顶", lambda: round_trip(f"{channel}筛选展开回顶"))
                    h.key("back", wait=.3)
        if args.extended:
            record("搜索与影人页面流程", search_person)
        if args.library:
            record("收藏历史流程", library_cases)
    except Exception as exc:
        report["failures"].append({"name": "navigation-run", "error": str(exc)})
        raise
    finally:
        h.run_adb("shell", "am", "force-stop", "app.panda.tv")
        remote = "/data/local/tmp/panda-tv-navigation-original.json"
        h.run_adb("push", str(backup), remote)
        h.run_adb("shell", "cp", remote, state_path)
        h.run_adb("shell", "rm", remote)
        report["userStateRestored"] = h.run_adb("shell", "cat", state_path) == original
        (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Report: {out / 'report.json'}", flush=True)
    assert report["userStateRestored"], "TV navigation did not restore the original user state"
    assert not report["failures"], f"{len(report['failures'])} TV navigation regressions"


if __name__ == "__main__":
    main()
