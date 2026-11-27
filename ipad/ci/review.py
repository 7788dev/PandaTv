"""Make exported XCTest screenshots and accessibility trees browsable without Xcode."""
import html
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from urllib.parse import quote


def label(attachment):
    name = attachment.get("suggestedHumanReadableName", "")
    return re.sub(r"_\d+_[0-9a-f-]+(?:\.\w+)?$", "", name, flags=re.I)


def section(name):
    if "live-" in name:
        return "联网片库"
    if name.startswith("适配"):
        return "深色、大字号和窄窗"
    if name.startswith("异常") or name.startswith("载入"):
        return "加载、异常与恢复"
    if "player" in name or name.startswith("播放"):
        return "系统播放器"
    if name.startswith("资料库") or name.startswith("搜索") or "search" in name:
        return "搜索与资料库"
    return "首页、频道与作品详情"


TITLES = {"iPad-live-home-landscape": "首页 · 横屏", "iPad-live-home-portrait": "首页 · 竖屏",
          "iPad-live-detail": "作品详情", "iPad-live-detail-credits": "选集与演职人员",
          "iPad-live-channel": "电影频道", "iPad-live-search": "搜索片库", "iPad-live-player": "联网片源实际播放",
          "iPad-search-results": "搜索结果",
          "iPad-landscape": "横屏推荐", "iPad-portrait-detail": "竖屏详情", "iPad-system-player": "系统播放控制",
          "iPad-player-volume": "播放音量和静音", "iPad-player-options": "播放选项"}


def main(root):
    groups = defaultdict(list)
    devices = set()
    for manifest in sorted(root.rglob("manifest.json")):
        entries = json.loads(manifest.read_text(encoding="utf-8"))
        if not isinstance(entries, list):
            continue
        for test in entries:
            attachments = test.get("attachments", [])
            files = {label(a): a["exportedFileName"] for a in attachments if "exportedFileName" in a}
            for a in attachments:
                file = manifest.parent / a.get("exportedFileName", "")
                if file.suffix.lower() != ".png":
                    continue
                name = label(a)
                devices.add(a.get("deviceName", "iPad"))
                href = quote(file.relative_to(root).as_posix())
                title = html.escape(TITLES.get(name, name))
                tree = files.get(name + "-accessibility")
                link = ""
                if tree:
                    url = quote((manifest.parent / tree).relative_to(root).as_posix())
                    link = f'<a href="{url}">控件树</a>'
                groups[section(name)].append(f'<figure><a href="{href}"><img loading="lazy" src="{href}" alt="{title}"></a>'
                                             f'<figcaption><span>{title}</span>{link}</figcaption></figure>')
    if not groups:
        return
    sections = []
    for name in ["联网片库", "首页、频道与作品详情", "搜索与资料库", "系统播放器", "加载、异常与恢复", "深色、大字号和窄窗"]:
        if groups[name]:
            sections.append(f'<section><h2>{name}</h2><div class="grid">{"".join(groups[name])}</div></section>')
    page = """<!doctype html><html lang="zh-Hans"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Panda · iPad 界面验收</title>
<style>
:root{color-scheme:light dark;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{max-width:1320px;margin:0 auto;padding:28px clamp(16px,3vw,44px) 56px}h1{margin:0}h2{margin:30px 0 12px}
p{max-width:70ch;color:GrayText}.grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(min(285px,100%),1fr))}
figure{margin:0;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:14px;overflow:hidden}
img{display:block;width:100%;height:280px;object-fit:contain;background:color-mix(in srgb,CanvasText 5%,Canvas)}
figcaption{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 14px;font-weight:600}
a{color:LinkText}a:focus-visible{outline:3px solid Highlight;outline-offset:-3px}</style>
<h1>Panda · iPad 界面验收</h1>"""
    devices_text = html.escape("、".join(sorted(devices)))
    page += (f"<p>截图来自 {devices_text} 模拟器运行的原生客户端。联网片库使用实时内容。交互测试通过固定的网络响应和可解码 HLS 视频复现操作。"
             "点开截图可查看原图。</p>" + "".join(sections) + "</html>")
    (root / "index.html").write_text(page, encoding="utf-8")


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve())
