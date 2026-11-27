"""Serve only the network boundaries used by the iPad simulator integration test."""
import json
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

MEDIA = Path(sys.argv[1]).resolve()
played = False
subject = {
    "id": "26647087", "type": "tv", "title": "三体", "year": "2023",
    "card_subtitle": "2023 / 中国大陆 / 剧情 科幻 / 杨磊",
    "intro": "科学家们相继发现实验结果偏离预期。汪淼和史强开始追查背后的原因。",
    "pic": {"large": "https://img1.doubanio.com/poster.png"},
    "photos": ["https://img1.doubanio.com/poster.png"], "episodes_count": 2,
    "directors": [{"name": "杨磊"}], "actors": [{"name": "张鲁一"}, {"name": "于和伟"}],
}


class Boundary(SimpleHTTPRequestHandler):
    def do_GET(self):
        global played
        path = urlsplit(self.path).path
        if path == "/test/played":
            body, mime = (b"yes" if played else b"no"), "text/plain"
        elif path.startswith("/480/") or path == "/poster.png":
            if path.endswith(".ts"):
                played = True
            return super().do_GET()
        else:
            if "/subject_collection/" in path:
                value = {"subject_collection_items": [subject]}
            elif path.endswith("/search/movie"):
                value = {"items": [{"target_type": "tv", "target": subject}]}
            elif path.endswith("/tv/26647087"):
                value = subject
            elif path.endswith("/recommend"):
                value = {"items": [subject], "total": 1}
            elif "/provide/vod" in path:
                url = "https://media.example.org/480/index.m3u8"
                value = {"list": [{"vod_id": 33, "vod_name": "三体", "vod_year": "2023", "type_name": "国产剧",
                                   "vod_play_from": "hls", "vod_play_url": f"第1集${url}#第2集${url}"}]}
            else:
                self.send_error(404)
                return
            body, mime = json.dumps(value, ensure_ascii=False).encode(), "application/json"
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


Boundary.extensions_map.update({".m3u8": "application/vnd.apple.mpegurl", ".ts": "video/mp2t"})
ThreadingHTTPServer(("127.0.0.1", 18765), partial(Boundary, directory=str(MEDIA))).serve_forever()
