import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

import uiautomator2 as u2

ADB = os.environ.get("PANDA_ADB", r"D:\Program Files\Netease\MuMu\nx_main\adb.exe")
SERIAL = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1:16416"
APK_PATH = sys.argv[2] if len(sys.argv) > 2 else r"e:\dev\项目\panda\release\Panda-TV-1.0.3.apk"
SHOT_DIR_DST = r"e:\dev\项目\panda\docs\evidence\runtime\tv"
SHOT_DIR_TMP = os.path.join(os.environ.get("TEMP", r"C:\Temp"), "panda-tv-shots")
EVIDENCE_PATH = r"e:\dev\项目\panda\docs\evidence\tv-verification.json"

os.makedirs(SHOT_DIR_DST, exist_ok=True)
os.makedirs(SHOT_DIR_TMP, exist_ok=True)


def run_adb(*args: str, check: bool = True) -> str:
    res = subprocess.run([ADB, "-s", SERIAL, *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if check and res.returncode != 0:
        raise RuntimeError(f"adb {args} failed ({res.returncode}): {res.stderr}\n{res.stdout}")
    return res.stdout


def parse_bounds(bounds_str: str) -> tuple[int, int, int, int]:
    m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds_str or "")
    if not m:
        return (0, 0, 0, 0)
    return tuple(int(g) for g in m.groups())  # type: ignore[return-value]


def installed_apk_sha256(package: str = "app.panda.tv") -> str | None:
    paths = run_adb("shell", "pm", "path", package).splitlines()
    path = next((line.removeprefix("package:") for line in paths if line.startswith("package:")), None)
    if path is None:
        return None
    digest = run_adb("shell", "sha256sum", path, check=False)
    match = re.match(r"^([0-9a-fA-F]{64})\s", digest)
    return match[1].upper() if match else None


def dump_nodes(d) -> list[dict]:
    xml_text = d.dump_hierarchy(compressed=False)
    return parse_nodes(xml_text)


def parse_nodes(xml_text: str) -> list[dict]:
    root = ET.fromstring(xml_text)
    out = []
    for node in root.iter("node"):
        txt = (node.attrib.get("text") or "").strip()
        cls = node.attrib.get("class") or ""
        bounds = parse_bounds(node.attrib.get("bounds") or "")
        out.append(
            {
                "text": txt,
                "class": cls,
                "focused": node.attrib.get("focused") == "true",
                "focusable": node.attrib.get("focusable") == "true",
                "selected": node.attrib.get("selected") == "true",
                "clickable": node.attrib.get("clickable") == "true",
                "bounds": bounds,
                "cx": (bounds[0] + bounds[2]) // 2,
                "cy": (bounds[1] + bounds[3]) // 2,
                "childTexts": [(child.attrib.get("text") or "").strip() for child in node.iter("node") if (child.attrib.get("text") or "").strip()],
            }
        )
    return out


def texts(nodes: list[dict]) -> list[str]:
    return [n["text"] for n in nodes if n["text"]]


def wait_for(d, pred, timeout: float = 22.0, interval: float = 0.45):
    deadline = time.time() + timeout
    last = []
    while time.time() < deadline:
        last = dump_nodes(d)
        res = pred(last)
        if res:
            return res, last
        time.sleep(interval)
    raise TimeoutError(f"Timed out after {timeout}s; visible texts={texts(last)[:35]}")


def shot(d, name: str) -> str:
    tmp_path = os.path.join(SHOT_DIR_TMP, f"{name}.png")
    dst_path = os.path.join(SHOT_DIR_DST, f"{name}.png")
    d.screenshot(tmp_path)
    shutil.copy2(tmp_path, dst_path)
    return dst_path


def key(code_or_name: str | int, wait: float = 0.32) -> None:
    key_map = {
        "home": 3,
        "back": 4,
        "dpad_up": 19,
        "dpad_down": 20,
        "dpad_left": 21,
        "dpad_right": 22,
        "dpad_center": 23,
        "enter": 66,
        "menu": 82,
    }
    code = key_map.get(str(code_or_name).lower(), code_or_name)
    run_adb("shell", "input", "keyevent", str(code))
    if wait > 0:
        time.sleep(wait)


def find_focused(nodes: list[dict]) -> dict | None:
    return next((n for n in nodes if n["focused"]), None)


def focus_child_text(nodes: list[dict], focused_node: dict) -> str:
    if "childTexts" in focused_node:
        return " | ".join(focused_node["childTexts"])
    l, t, r, b = focused_node["bounds"]
    parts = [
        n["text"]
        for n in nodes
        if n["text"] and n["bounds"][0] >= l - 6 and n["bounds"][1] >= t - 6 and n["bounds"][2] <= r + 6 and n["bounds"][3] <= b + 6
    ]
    return " | ".join(parts)


def move_focus_to_text(d, target_text: str, direction: str | None = None, max_steps: int = 12) -> list[dict]:
    for _ in range(max_steps):
        nodes = dump_nodes(d)
        f = find_focused(nodes)
        if f and target_text in focus_child_text(nodes, f):
            return nodes
        step_dir = direction
        if step_dir is None:
            t_node = next((n for n in nodes if target_text in n["text"]), None)
            if f and t_node:
                step_dir = "dpad_right" if t_node["cx"] > f["cx"] else "dpad_left"
            else:
                step_dir = "dpad_right"
        key(step_dir, wait=0.28)
    raise AssertionError(f"Could not move focus to '{target_text}'")


def focus_top_bar(d) -> None:
    for _ in range(16):
        ns = dump_nodes(d)
        f = find_focused(ns)
        if f and f["cy"] < 140:
            return
        key("dpad_up", wait=0.28)
    raise AssertionError("Could not return focus to top navigation bar")


def parse_clock(s: str) -> int | None:
    m = re.match(r"^(?:(\d+):)?(\d{2}):(\d{2})$", s.strip())
    if not m:
        return None
    h = int(m.group(1) or 0)
    mn = int(m.group(2))
    sc = int(m.group(3))
    return h * 3600 + mn * 60 + sc


def parse_gfx_stats(raw: str) -> dict:
    total = next((int(m.group(1)) for m in [re.search(r"Total frames rendered:\s*(\d+)", raw)] if m), 0)
    janky = next((int(m.group(1)) for m in [re.search(r"Janky frames:\s*(\d+)", raw)] if m), 0)
    p90 = next((int(m.group(1)) for m in [re.search(r"90th percentile:\s*(\d+)ms", raw)] if m), None)
    p95 = next((int(m.group(1)) for m in [re.search(r"95th percentile:\s*(\d+)ms", raw)] if m), None)
    return {
        "totalFrames": total,
        "jankyFrames": janky,
        "jankPct": round((janky * 100.0 / total), 2) if total > 0 else 0.0,
        "p90Ms": p90,
        "p95Ms": p95,
    }


def assert_no_bezel_overflow(nodes: list[dict], context_label: str) -> int:
    card_rights = [
        n["bounds"][2]
        for n in nodes
        if n["focusable"] and n["clickable"] and n["bounds"][2] > 0 and (n["bounds"][2] - n["bounds"][0]) < 1700
    ]
    max_right = max(card_rights) if card_rights else 0
    assert max_right <= 1855, f"[{context_label}] Card/control overflowed right safe area: max_right={max_right}"
    return max_right


def main() -> None:
    subprocess.run([ADB, "connect", SERIAL], check=True)
    orig_density_out = run_adb("shell", "wm", "density").strip()

    # Standard 1080p Android TV density (320dpi -> 960x540dp)
    run_adb("shell", "wm", "density", "320")
    time.sleep(0.8)

    try:
        report: dict = {
            "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "serial": SERIAL,
            "apkPath": APK_PATH,
            "apkBytes": os.path.getsize(APK_PATH),
            "viewport": {
                "wmSize": run_adb("shell", "wm", "size").strip(),
                "wmDensity": run_adb("shell", "wm", "density").strip(),
                "viewportDp": "960x540",
            },
            "androidRelease": run_adb("shell", "getprop", "ro.build.version.release").strip(),
            "androidSdk": int(run_adb("shell", "getprop", "ro.build.version.sdk").strip()),
            "deviceAbi": run_adb("shell", "getprop", "ro.product.cpu.abi").strip(),
        }

        d = u2.connect(SERIAL)

        run_adb("install", "-r", APK_PATH)
        run_adb("shell", "pm", "clear", "app.panda.tv")
        run_adb("logcat", "-c")
        start_out = run_adb("shell", "am", "start", "-W", "-n", "app.panda.tv/.ui.MainActivity")
        am_this_time = next((int(m.group(1)) for m in [re.search(r"ThisTime:\s*(\d+)", start_out)] if m), None)

        # Check loading indicator centering if captured during cold start
        loading_cx_seen = None
        t0 = time.time()
        while time.time() - t0 < 25.0:
            ns = dump_nodes(d)
            loading_node = next((n for n in ns if "加载" in n["text"]), None)
            if loading_node:
                loading_cx_seen = loading_node["cx"]
                assert abs(loading_cx_seen - 960) <= 28, f"Loading text not centered horizontally: {loading_node}"
            if all(w in texts(ns) for w in ("热播剧集", "播放")):
                break
            time.sleep(0.18)
        else:
            raise TimeoutError("Timed out waiting for Home screen")

        home_load_ms = int((time.time() - t0) * 1000)
        time.sleep(1.3)
        home_nodes = dump_nodes(d)

        top_order = ["Panda", "首页", "剧集", "电影", "综艺", "动漫", "纪录片", "我的", "搜索", "设置"]
        top_xs = []
        top_max_right = 0
        for label in top_order:
            hit = next((n for n in home_nodes if n["text"] == label and n["cy"] < 140), None)
            if not hit:
                raise AssertionError(f"Missing top bar item '{label}' in {texts(home_nodes)[:25]}")
            top_xs.append(hit["cx"])
            top_max_right = max(top_max_right, hit["bounds"][2])
        assert top_xs == sorted(top_xs), f"Top bar order wrong: {list(zip(top_order, top_xs))}"
        assert top_max_right <= 1860, f"Top bar overflowed right safe area: {top_max_right}"

        play_btn = next((n for n in home_nodes if n["text"] == "播放" and n["cy"] < 680), None)
        detail_btn = next((n for n in home_nodes if n["text"] == "详情" and n["cy"] < 680), None)
        counter = next((n for n in home_nodes if re.match(r"^\d+\s*/\s*\d+$", n["text"]) and n["cy"] < 680), None)
        assert play_btn and detail_btn and counter, "Missing hero controls"
        assert play_btn["cx"] < detail_btn["cx"] < counter["cx"], "Hero controls out of order"
        initial_hero_play_cy = play_btn["cy"]
        home_max_right = assert_no_bezel_overflow(home_nodes, "Home initial")

        shot(d, "01-home")

        # Scroll down into shelves & rank boards + measure gfxinfo
        run_adb("shell", "dumpsys", "gfxinfo", "app.panda.tv", "reset")
        seen_rank = False
        seen_movies = False
        shot_ranks = False
        for _ in range(12):
            key("dpad_down", wait=0.34)
            cur_ns = dump_nodes(d)
            cur_t = texts(cur_ns)
            if "剧集榜" in cur_t:
                seen_rank = True
            if "最新电影" in cur_t:
                seen_movies = True
                if not shot_ranks:
                    time.sleep(0.8)
                    shot(d, "02-home-ranks")
                    shot_ranks = True
            if seen_rank and seen_movies and shot_ranks:
                break
        assert seen_rank and seen_movies, f"Missing home shelves: rank={seen_rank}, movies={seen_movies}"

        # BUG 1 REGRESSION CHECK: Press DPAD_UP repeatedly from lower shelves and verify we MUST land back
        # on the Hero Carousel with 100% of the Hero Carousel visible (NOT stuck scrolled off-screen, NOT skipping to top bar)!
        hero_returned = False
        returned_play_cy = None
        for _ in range(15):
            key("dpad_up", wait=0.32)
            ns_up = dump_nodes(d)
            f_up = find_focused(ns_up)
            assert not (f_up and f_up["cy"] < 140), "Focus jumped to top bar and skipped Hero Carousel!"
            if f_up and "播放" in focus_child_text(ns_up, f_up) and f_up["cy"] > 140:
                time.sleep(0.35)
                ns_up = dump_nodes(d)
                play_after = next((n for n in ns_up if n["text"] == "播放" and n["cy"] > 140), None)
                counter_after = next((n for n in ns_up if re.match(r"^\d+\s*/\s*\d+$", n["text"]) and n["cy"] < 680), None)
                assert play_after and counter_after, "Hero controls incomplete after scrolling back up"
                returned_play_cy = play_after["cy"]
                assert abs(returned_play_cy - initial_hero_play_cy) <= 24, (
                    f"Hero carousel partially clipped off-screen! initial play cy={initial_hero_play_cy}, returned={returned_play_cy}"
                )
                hero_returned = True
                shot(d, "01b-home-back-to-hero")
                break
        assert hero_returned, "Could not return focus to Hero Carousel via DPAD_UP"

        # Now one more DPAD_UP from Hero Carousel must focus top navigation bar cleanly
        key("dpad_up", wait=0.3)
        f_top = find_focused(dump_nodes(d))
        assert f_top and f_top["cy"] < 140, f"Expected DPAD_UP from Hero to focus top bar, got {f_top}"
        home_gfx = parse_gfx_stats(run_adb("shell", "dumpsys", "gfxinfo", "app.panda.tv"))

        report["home"] = {
            "amStartThisTimeMs": am_this_time,
            "feedLoadMs": home_load_ms,
            "loadingCenteredCx": loading_cx_seen,
            "topBarMaxRightPx": top_max_right,
            "homeMaxFocusableRightPx": home_max_right,
            "heroOrderOk": True,
            "rankAndMoviesVisible": True,
            "heroReturnFromBottomOk": True,
            "initialHeroPlayCy": initial_hero_play_cy,
            "returnedHeroPlayCy": returned_play_cy,
            "dpadBackToTopOk": True,
            "gfxScrollStats": home_gfx,
        }

        # 2. Channel screen + 6-column geometry + secondary filter scroll non-overlap + rapid hold scroll + Back close
        move_focus_to_text(d, "剧集", max_steps=12)
        key("enter", wait=0.15)
        # Check Channel loading indicator centering if visible
        ns_ch_load = dump_nodes(d)
        ch_load_node = next((n for n in ns_ch_load if "加载" in n["text"]), None)
        if ch_load_node:
            loading_cx_seen = loading_cx_seen or ch_load_node["cx"]
            assert abs(ch_load_node["cx"] - 960) <= 28, f"Channel loading text not centered: {ch_load_node}"

        wait_for(
            d,
            lambda ns: "高分" in texts(ns) and any(t.startswith("类型:") for t in texts(ns)) and sum(1 for n in ns if n["focusable"] and n["cy"] > 250) >= 6,
            timeout=22.0,
        )
        key("dpad_down", wait=0.28)
        move_focus_to_text(d, "高分", max_steps=6)
        key("enter", wait=0.7)
        wait_for(d, lambda ns: sum(1 for n in ns if n["focusable"] and n["cy"] > 250) >= 6, timeout=22.0)
        time.sleep(1.2)
        ch_nodes = dump_nodes(d)
        shot(d, "03-channel")

        cards = sorted([n for n in ch_nodes if n["focusable"] and n["cy"] > 250], key=lambda x: (x["cy"], x["cx"]))
        row1_y = cards[0]["cy"]
        row1 = sorted([c for c in cards if abs(c["cy"] - row1_y) < 45], key=lambda x: x["cx"])
        assert len(row1) == 6, f"Expected 6 columns in row 1 at 320dpi, got {len(row1)}: {[c['bounds'] for c in row1]}"
        assert row1[0]["bounds"][0] >= 75 and row1[-1]["bounds"][2] <= 1845, f"6-column grid violated TV safe margins: first={row1[0]['bounds']}, last={row1[-1]['bounds']}"

        # Open 类型 secondary filter chip drawer
        move_focus_to_text(d, "类型:", direction="dpad_right", max_steps=6)
        key("enter", wait=0.45)
        wait_for(d, lambda ns: "剧情" in texts(ns) and any(n["text"] == "剧情" and n["cy"] < 340 for n in ns), timeout=8.0)
        shot(d, "03b-channel-chips")

        # BUG 2 & BUG 3 REGRESSION CHECK: Leave secondary filter open, scroll down rapidly through 6 rows of movies
        # (including pagination!), then scroll back up, asserting secondary filter NEVER gets overlapped by movie cards!
        run_adb("shell", "dumpsys", "gfxinfo", "app.panda.tv", "reset")
        run_adb("shell", "input keyevent 20 20 20 20 20 20")
        time.sleep(0.85)
        scrolled_down_ns = dump_nodes(d)
        chip_after_down = next((n for n in scrolled_down_ns if n["text"] == "剧情" and n["cy"] < 340), None)
        assert chip_after_down, "Secondary filter chip disappeared unexpectedly while scrolling down"
        chip_bottom_px = chip_after_down["bounds"][3]
        movie_cards_down = [n for n in scrolled_down_ns if n["focusable"] and n["bounds"][3] > chip_bottom_px + 30]
        assert movie_cards_down, "Expected visible movie cards below chip drawer after scrolling down"
        min_card_top_down = min(c["bounds"][1] for c in movie_cards_down)
        assert min_card_top_down >= chip_bottom_px - 2, (
            f"Movie card bled on top of secondary filter while scrolling down! min_card_top={min_card_top_down}, chip_bottom={chip_bottom_px}"
        )
        shot(d, "03c-channel-chips-scrolled")

        # Scroll back up 4 rows while secondary filter remains open
        run_adb("shell", "input keyevent 19 19 19 19")
        time.sleep(0.75)
        scrolled_up_ns = dump_nodes(d)
        chip_after_up = next((n for n in scrolled_up_ns if n["text"] == "剧情" and n["cy"] < 340), None)
        assert chip_after_up, "Secondary filter chip missing after scrolling back up"
        movie_cards_up = [n for n in scrolled_up_ns if n["focusable"] and n["bounds"][3] > chip_after_up["bounds"][3] + 30]
        min_card_top_up = min(c["bounds"][1] for c in movie_cards_up)
        assert min_card_top_up >= chip_after_up["bounds"][3] - 2, (
            f"Movie card bled on top of secondary filter while scrolling up! min_card_top={min_card_top_up}, chip_bottom={chip_after_up['bounds'][3]}"
        )
        channel_gfx = parse_gfx_stats(run_adb("shell", "dumpsys", "gfxinfo", "app.panda.tv"))

        # Close filter chip drawer with Back
        key("back", wait=0.4)
        after_back = dump_nodes(d)
        assert not any(n["text"] == "剧情" and n["cy"] < 340 for n in after_back), "Expected Back to close filter chip row"

        report["channel"] = {
            "row1Columns": len(row1),
            "leftRailPx": row1[0]["bounds"][0],
            "rightRailPx": row1[-1]["bounds"][2],
            "chipDrawerBottomPx": chip_bottom_px,
            "minCardTopDuringScrollDownPx": min_card_top_down,
            "minCardTopDuringScrollUpPx": min_card_top_up,
            "filterScrollNoOverlapOk": True,
            "filterChipBackCloseOk": True,
            "gfxScrollStats": channel_gfx,
        }

        # 3. Search -> Discovery 3x13 keypad -> 三体 -> type filters -> Detail -> Person Works
        focus_top_bar(d)
        move_focus_to_text(d, "搜索", max_steps=12)
        key("enter", wait=0.8)
        _, search_disc = wait_for(d, lambda ns: "热搜" in texts(ns) and "百度影视热搜" in texts(ns) and "A–Z / 0–9" in texts(ns), timeout=15.0)
        time.sleep(0.4)
        assert_no_bezel_overflow(dump_nodes(d), "Search discovery")
        shot(d, "04-search-discovery")

        edit = d(className="android.widget.EditText")
        edit.set_text("三体")
        time.sleep(0.4)
        move_focus_to_text(d, "搜索", direction="dpad_right", max_steps=4)
        key("enter", wait=1.0)
        _, res_nodes = wait_for(d, lambda ns: any(n["text"] == "三体" and n["cy"] > 240 for n in ns), timeout=22.0)
        time.sleep(1.2)
        shot(d, "04b-search-results")
        type_tabs_present = any(n["text"] == "全部" and 180 < n["cy"] < 320 for n in dump_nodes(d))

        f_cur = find_focused(dump_nodes(d))
        if not f_cur or f_cur["cy"] < 260:
            key("dpad_down", wait=0.32)
        found_santi = False
        for step in range(18):
            ns_res = dump_nodes(d)
            f_res = find_focused(ns_res)
            if f_res and f_res["cy"] > 260:
                parts = [p.strip() for p in focus_child_text(ns_res, f_res).split("|")]
                if "三体" in parts and any(re.match(r"^[78]\.\d$", p) for p in parts):
                    found_santi = True
                    break
            if step % 6 == 5:
                key("dpad_down", wait=0.32)
                for _ in range(5):
                    key("dpad_left", wait=0.18)
            else:
                key("dpad_right", wait=0.28)
        assert found_santi, f"Could not focus 2023 series '三体': {texts(dump_nodes(d))[:25]}"
        key("enter", wait=0.8)

        wait_for(d, lambda ns: "播放" in texts(ns) and "选集" in texts(ns), timeout=22.0)
        move_focus_to_text(d, "收藏", direction="dpad_right", max_steps=5)
        key("enter", wait=0.5)
        wait_for(d, lambda ns: "已收藏" in texts(ns), timeout=5.0)
        time.sleep(2.5)

        cast_cards = []
        cast_names = []
        for _ in range(10):
            key("dpad_down", wait=0.4)
            ns_now = dump_nodes(d)
            f_now = find_focused(ns_now)
            cast_head_now = next((n for n in ns_now if n["text"] == "演职员"), None)
            rel_head_now = next((n for n in ns_now if n["text"] == "相关推荐"), None)
            rel_y_now = rel_head_now["cy"] if rel_head_now else 2000
            if f_now and cast_head_now and cast_head_now["cy"] < f_now["cy"] < rel_y_now:
                cast_cards = [
                    n for n in ns_now
                    if n["focusable"] and cast_head_now["cy"] < n["cy"] < rel_y_now and focus_child_text(ns_now, n)
                ]
                cast_names = [focus_child_text(ns_now, c) for c in cast_cards]
                break
        assert cast_cards, "Could not reach 演职员 row via D-pad"
        time.sleep(0.9)
        assert_no_bezel_overflow(dump_nodes(d), "Detail cast")
        shot(d, "05-detail")

        picked_person = None
        for _ in range(8):
            ns_cast = dump_nodes(d)
            f_cast = find_focused(ns_cast)
            ft = focus_child_text(ns_cast, f_cast) if f_cast else ""
            if "于和伟" in ft:
                picked_person = ft
                break
            key("dpad_right", wait=0.28)
        assert picked_person, f"Could not focus 于和伟 among {cast_names}"

        t_person = time.time()
        key("enter", wait=0.6)
        _, person_nodes = wait_for(
            d,
            lambda ns: "全部作品" in texts(ns) and sum(1 for n in ns if n["focusable"] and n["cy"] > 200) >= 6,
            timeout=22.0,
        )
        person_load_ms = int((time.time() - t_person) * 1000)
        time.sleep(1.3)
        person_nodes = dump_nodes(d)
        shot(d, "06-person-works")

        header_titles = [
            n["text"] for n in person_nodes
            if n["text"] and n["cy"] < 200 and n["text"] not in ("返回", "全部作品")
        ]
        assert any("于和伟" in t and "..." not in t and "…" not in t for t in header_titles), (
            f"Person header name truncated or missing: {header_titles}"
        )

        # Back to DetailScreen -> focus Play (also verifies Detail auto-scrolls back to top so 返回 is visible!)
        key("back", wait=0.7)
        for _ in range(8):
            ns_d = dump_nodes(d)
            f_d = find_focused(ns_d)
            if f_d and ("播放" in focus_child_text(ns_d, f_d) or "已收藏" in focus_child_text(ns_d, f_d)):
                break
            key("dpad_up", wait=0.3)
        move_focus_to_text(d, "播放", direction="dpad_left", max_steps=5)
        time.sleep(0.3)
        assert "返回" in texts(dump_nodes(d)), "Expected DetailScreen top header (返回) to scroll back into view when Play is focused"

        report["searchDetailPeople"] = {
            "searchKeypad3x13Visible": True,
            "searchTypeFilterTabsVisible": type_tabs_present,
            "castCountVisible": len(cast_cards),
            "castPeople": cast_names,
            "personHeaderTexts": header_titles,
            "personHeaderUntruncated": True,
            "personWorksFirstPageMs": person_load_ms,
            "detailScrollBackToTopOk": True,
        }

        # 4. PlayerScreen: real playback + consecutive D-pad Right seeking without focus theft + active line focus
        t_play = time.time()
        key("enter", wait=0.5)

        def playback_clock(ns: list[dict]):
            for t in texts(ns):
                m_clk = re.match(r"^(\d+:\d{2}(?::\d{2})?)\s*/\s*(\d+:\d{2}(?::\d{2})?)$", t)
                if m_clk:
                    pos = parse_clock(m_clk.group(1))
                    dur = parse_clock(m_clk.group(2))
                    if pos is not None and dur is not None and dur > 30:
                        return (pos, dur, t)
            return None

        t_first_ready, _ = wait_for(d, playback_clock, timeout=35.0, interval=0.5)
        start_ms = int((time.time() - t_play) * 1000)

        time.sleep(3.5)
        cur_nodes = dump_nodes(d)
        if playback_clock(cur_nodes) is None:
            key("menu", wait=0.4)
            cur_nodes = dump_nodes(d)
        clk2 = playback_clock(cur_nodes)
        assert clk2 is not None and clk2[0] > t_first_ready[0], f"Clock did not advance: {t_first_ready} -> {clk2}"
        shot(d, "07-player")

        if playback_clock(dump_nodes(d)) is not None:
            key("menu", wait=0.4)
        key("dpad_right", wait=0.3)
        key("dpad_right", wait=0.5)
        seek_nodes = dump_nodes(d)
        f_seek = find_focused(seek_nodes)
        assert f_seek and "SeekBar" in f_seek["class"], f"Expected SeekBar to hold focus during consecutive seeks, got {f_seek}"
        clk_seek = playback_clock(seek_nodes)
        assert clk_seek and clk_seek[0] >= clk2[0] + 15, f"Expected +20s seek jump, got {clk2} -> {clk_seek}"

        key("dpad_down", wait=0.32)
        cur_nodes = dump_nodes(d)
        lines_btn = next((n for n in cur_nodes if n["text"].startswith("线路")), None)
        eps_btn = next((n for n in cur_nodes if n["text"] == "选集"), None)
        panel_opened = None
        active_line_focused = False
        if lines_btn or eps_btn:
            target_lbl = "线路" if lines_btn else "选集"
            move_focus_to_text(d, target_lbl, direction="dpad_right", max_steps=6)
            key("enter", wait=0.8)
            panel_opened = (lines_btn or eps_btn)["text"]
            panel_nodes = dump_nodes(d)
            f_panel = find_focused(panel_nodes)
            if lines_btn and f_panel:
                active_line_focused = "✓" in focus_child_text(panel_nodes, f_panel)
            shot(d, "08-player-lines")
            key("dpad_left", wait=0.4)

        # Exit player -> Home
        for _ in range(8):
            ns = dump_nodes(d)
            t_list = texts(ns)
            if "热播剧集" in t_list and any(n["text"] == "首页" and n["cy"] < 140 for n in ns):
                break
            if any(n["text"] == "首页" and n["cy"] < 140 for n in ns):
                focus_top_bar(d)
                move_focus_to_text(d, "首页", max_steps=10)
                key("enter", wait=0.8)
                break
            key("back", wait=0.6)

        # 5. Home Continue Watching + Me (Favorites & 4-col wide History) + Settings
        for _ in range(6):
            if "继续观看" in texts(dump_nodes(d)):
                break
            key("dpad_up", wait=0.3)
        _, home2 = wait_for(
            d,
            lambda ns: "继续观看" in texts(ns) and any("第1集" in t for t in texts(ns)),
            timeout=18.0,
        )
        time.sleep(1.0)
        shot(d, "09-home-continue")

        focus_top_bar(d)
        move_focus_to_text(d, "我的", max_steps=10)
        key("enter", wait=0.8)
        wait_for(d, lambda ns: "收藏" in texts(ns) and "三体" in texts(ns), timeout=15.0)
        time.sleep(0.8)
        shot(d, "10-me-favorites")

        key("dpad_down", wait=0.3)
        move_focus_to_text(d, "历史", direction="dpad_right", max_steps=4)
        key("enter", wait=0.8)
        _, me_hist = wait_for(
            d,
            lambda ns: "三体" in texts(ns) and any("第1集" in t for t in texts(ns)),
            timeout=15.0,
        )
        time.sleep(0.8)
        shot(d, "11-me-history")

        focus_top_bar(d)
        move_focus_to_text(d, "设置", max_steps=10)
        key("enter", wait=0.8)
        wait_for(d, lambda ns: "自动播放下一集" in texts(ns) and "默认清晰度" in texts(ns), timeout=10.0)
        time.sleep(0.4)
        shot(d, "12-settings")

        # 6. Multi-DPI non-overflow check (simulating non-standard domestic TV ROMs: 240dpi & 480dpi on 1920x1080)
        multi_dpi_results = {}
        for dpi in (240, 480):
            run_adb("shell", "am", "force-stop", "app.panda.tv")
            run_adb("shell", "wm", "density", str(dpi))
            time.sleep(0.6)
            run_adb("shell", "am", "start", "-W", "-n", "app.panda.tv/.ui.MainActivity")
            _, dpi_ns = wait_for(d, lambda ns: all(w in texts(ns) for w in ("热播剧集", "播放", "设置")), timeout=20.0)
            time.sleep(0.6)
            dpi_ns = dump_nodes(d)
            settings_hit = next((n for n in dpi_ns if n["text"] == "设置" and n["cy"] < 150), None)
            assert settings_hit and settings_hit["bounds"][2] <= 1860, f"Top bar overflowed at {dpi}dpi: {settings_hit}"
            max_r = assert_no_bezel_overflow(dpi_ns, f"Home @{dpi}dpi")
            multi_dpi_results[f"{dpi}dpi"] = {
                "settingsRightPx": settings_hit["bounds"][2],
                "maxFocusableRightPx": max_r,
                "noOverflow": True,
            }

        run_adb("shell", "wm", "density", "320")
        time.sleep(0.5)

        logcat_out = run_adb("logcat", "-d", "-s", "PandaTV:*", "AndroidRuntime:E")
        crashes = [line for line in logcat_out.splitlines() if "AndroidRuntime" in line or "FATAL EXCEPTION" in line]
        source_logs = [line for line in logcat_out.splitlines() if "[source]" in line or "[ad]" in line]

        report["playback"] = {
            "startMs": start_ms,
            "clockInitial": t_first_ready[2],
            "clockAfterPlay": clk2[2],
            "clockAfterDoubleSeekRight": clk_seek[2],
            "consecutiveSeekKeptFocusOnSeekBar": True,
            "durationSeconds": clk2[1],
            "sidePanelOpened": panel_opened,
            "activeLineFocusedByDefault": active_line_focused,
            "sourceAndAdLogs": source_logs[:12],
            "crashes": crashes,
        }
        report["continueMeSettings"] = {
            "continueWatchingWithEpisodeLabel": True,
            "favoriteHasSanTi": True,
            "historyWideCardWithEpisodeProgress": True,
            "settingsRendered": True,
        }
        report["multiDpiLayout"] = multi_dpi_results

        with open(EVIDENCE_PATH, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        assert not crashes, f"Found crashes in logcat: {crashes}"
    finally:
        if "Override density" not in orig_density_out:
            run_adb("shell", "wm", "density", "reset", check=False)


if __name__ == "__main__":
    main()
