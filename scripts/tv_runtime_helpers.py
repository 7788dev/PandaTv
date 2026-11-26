import os
import re
import subprocess
import time
import xml.etree.ElementTree as ET

ADB = os.environ.get("PANDA_ADB", r"D:\Program Files\Netease\MuMu\nx_main\adb.exe")
SERIAL = ""


def run_adb(*args: str, check: bool = True) -> str:
    if not SERIAL:
        raise RuntimeError("Select an explicit device serial before running ADB")
    result = subprocess.run([ADB, "-s", SERIAL, *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if check and result.returncode != 0:
        raise RuntimeError(f"adb {args} failed ({result.returncode}): {result.stderr}\n{result.stdout}")
    return result.stdout


def parse_bounds(bounds_str: str) -> tuple[int, int, int, int]:
    match = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds_str or "")
    if not match:
        return (0, 0, 0, 0)
    return tuple(int(value) for value in match.groups())  # type: ignore[return-value]


def installed_apk_sha256(package: str = "app.panda.tv") -> str:
    paths = run_adb("shell", "pm", "path", package).splitlines()
    path = next((line.removeprefix("package:") for line in paths if line.startswith("package:")), None)
    if path is not None:
        digest = run_adb("shell", "sha256sum", path)
        match = re.match(r"^([0-9a-fA-F]{64})\s", digest)
        if match:
            return match[1].upper()
    raise RuntimeError(f"Could not identify the installed APK: {package}")


def dump_nodes(device) -> list[dict]:
    return parse_nodes(device.dump_hierarchy(compressed=False))


def parse_nodes(xml_text: str) -> list[dict]:
    root = ET.fromstring(xml_text)
    nodes = []
    for node in root.iter("node"):
        bounds = parse_bounds(node.attrib.get("bounds") or "")
        nodes.append({
            "text": (node.attrib.get("text") or "").strip(),
            "description": (node.attrib.get("content-desc") or "").strip(),
            "class": node.attrib.get("class") or "",
            "focused": node.attrib.get("focused") == "true",
            "focusable": node.attrib.get("focusable") == "true",
            "selected": node.attrib.get("selected") == "true",
            "clickable": node.attrib.get("clickable") == "true",
            "bounds": bounds,
            "cx": (bounds[0] + bounds[2]) // 2,
            "cy": (bounds[1] + bounds[3]) // 2,
            "childTexts": [(child.attrib.get("text") or "").strip() for child in node.iter("node") if (child.attrib.get("text") or "").strip()],
            "directTexts": [text for child in node.findall("node") if (text := (child.get("text") or "").strip())],
        })
    return nodes


def texts(nodes: list[dict]) -> list[str]:
    return [node["text"] for node in nodes if node["text"]]


def has_keypad(nodes: list[dict]) -> bool:
    keys = {node["text"] for node in nodes if node["focusable"]}
    return {"A", "M", "N", "Z", "0", "9", "⌫"} <= keys


def wait_for(device, predicate, timeout: float = 22.0, interval: float = 0.45):
    deadline = time.monotonic() + timeout
    last = []
    while time.monotonic() < deadline:
        last = dump_nodes(device)
        result = predicate(last)
        if result:
            return result, last
        time.sleep(interval)
    raise TimeoutError(f"Timed out after {timeout}s; visible texts={texts(last)[:35]}")


def key(code_or_name: str | int, wait: float = 0.32) -> None:
    key_map = {
        "home": 3, "back": 4, "dpad_up": 19, "dpad_down": 20, "dpad_left": 21,
        "dpad_right": 22, "dpad_center": 23, "enter": 66, "menu": 82,
    }
    code = key_map.get(str(code_or_name).lower(), code_or_name)
    run_adb("shell", "input", "keyevent", str(code))
    if wait > 0:
        time.sleep(wait)


def find_focused(nodes: list[dict]) -> dict | None:
    return next((node for node in nodes if node["focused"]), None)


def focus_child_text(nodes: list[dict], focused_node: dict) -> str:
    return " | ".join(focused_node["childTexts"])


def move_focus_to_text(device, target_text: str, direction: str | None = None, max_steps: int = 12) -> list[dict]:
    for _ in range(max_steps):
        nodes = dump_nodes(device)
        focus = find_focused(nodes)
        if focus and target_text in focus_child_text(nodes, focus):
            return nodes
        step_dir = direction
        if step_dir is None:
            target = next((node for node in nodes if target_text in node["text"]), None)
            if focus and target:
                dx = target["cx"] - focus["cx"]
                dy = target["cy"] - focus["cy"]
                if abs(dy) > abs(dx):
                    step_dir = "dpad_down" if dy > 0 else "dpad_up"
                else:
                    step_dir = "dpad_right" if dx > 0 else "dpad_left"
            else:
                step_dir = "dpad_right"
        key(step_dir, wait=0.28)
    raise AssertionError(f"Could not move focus to '{target_text}'")


def focus_top_bar(device) -> None:
    trace = []
    for _ in range(24):
        nodes = dump_nodes(device)
        focus = find_focused(nodes)
        home = next((node for node in nodes if node["text"] == "首页" and node["focusable"]), None)
        if focus and home and focus["cy"] <= home["bounds"][3] and set(focus["childTexts"]).intersection(
            {"首页", "剧集", "电影", "综艺", "动漫", "纪录片", "我的", "搜索", "设置"}
        ):
            return
        trace.append({"focus": focus["childTexts"] if focus else None, "bounds": focus["bounds"] if focus else None,
                      "homeBounds": home["bounds"] if home else None})
        key("dpad_up", wait=0.28)
    raise AssertionError(f"Could not return focus to top navigation bar after {len(trace)} Up presses: {trace[-4:]}")


def focus_search_submit(device) -> None:
    for _ in range(18):
        focused = find_focused(dump_nodes(device))
        if focused and focused["class"] == "android.widget.EditText":
            query_length = len(focused["text"])
            break
        key("dpad_up", wait=.1)
    else:
        raise AssertionError("The real search input was not reachable before submission")
    for _ in range(query_length + 3):
        key("dpad_right", wait=.08)
        focused = find_focused(dump_nodes(device))
        if focused and focused["class"] == "android.widget.LinearLayout" and "搜索" in focused["childTexts"]:
            return
    raise AssertionError("The actual search submit button was not focused")


def parse_clock(text: str) -> int | None:
    match = re.fullmatch(r"(?:(\d+):)?(\d{2}):(\d{2})", text.strip())
    if not match:
        return None
    return int(match[1] or 0) * 3600 + int(match[2]) * 60 + int(match[3])


def parse_gfx_stats(raw: str) -> dict:
    frames = re.search(r"Total frames rendered:\s*(\d+)", raw)
    jank = re.search(r"Janky frames:\s*(\d+)", raw)
    p90 = re.search(r"90th percentile:\s*(\d+)ms", raw)
    p95 = re.search(r"95th percentile:\s*(\d+)ms", raw)
    total = int(frames[1]) if frames else 0
    janky = int(jank[1]) if jank else 0
    return {
        "totalFrames": total, "jankyFrames": janky,
        "jankPct": round((janky * 100.0 / total), 2) if total else 0.0,
        "p90Ms": int(p90[1]) if p90 else None, "p95Ms": int(p95[1]) if p95 else None,
    }
