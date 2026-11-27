"""Serve only the network boundaries used by the iPad simulator integration test."""
import json
import sys
from threading import Event
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

MEDIA = Path(sys.argv[1]).resolve()
played = False
alternative = False
recovered = False
release_loading = Event()
release_loading.set()
subject = {
    "id": "26647087", "type": "tv", "title": "三体", "year": "2023",
    "card_subtitle": "2023 / 中国大陆 / 剧情 科幻 / 杨磊",
    "intro": "科学家们相继发现实验结果偏离预期。汪淼和史强开始追查背后的原因。",
    "pic": {"large": "https://img1.doubanio.com/poster.png"},
    "photos": ["https://img1.doubanio.com/poster.png"], "episodes_count": 2,
    "directors": [{"name": "杨磊"}], "actors": [{"name": "张鲁一"}, {"name": "于和伟"}],
}
movie = {**subject, "id": "26266893", "type": "movie", "title": "流浪地球", "year": "2019",
         "card_subtitle": "2019 / 中国大陆 / 科幻 / 郭帆", "episodes_count": 0,
         "intro": "太阳逐渐衰老，人类决定在地球表面建造行星发动机，让地球离开太阳系。"
                  "人们迁入地下城生活，地表的运载车穿行在冰封的城市之间。刘启和韩朵朵第一次走出地下城时，"
                  "地球正在接近木星。突如其来的引力变化让多座发动机停机，一支救援队穿过冰原运送火石，"
                  "试图让地球重新启动。与此同时，在领航员空间站值守的刘培强发现，地面救援与空间站的选择息息相关。"
                  "远离故乡的旅程刚刚开始，每个人都要为共同的家园作出选择。"}
channels = {"综艺": ("123401", "声入人心", "真人秀"), "动画": ("123402", "中国奇谭", "动画"),
            "纪录片": ("123403", "航拍中国", "纪录片")}


class Boundary(SimpleHTTPRequestHandler):
    def do_GET(self):
        global played, alternative, recovered
        split = urlsplit(self.path)
        path, query = split.path, parse_qs(split.query)
        scenario = query.get("scenario", [""])[0]
        if scenario == "delayed" and ("/subject_collection/" in path or path.endswith("/recommend")):
            release_loading.wait(timeout=16)
        if path in ("/test/played", "/test/alternative", "/test/recover", "/test/reset", "/test/hold", "/test/release"):
            if path == "/test/hold":
                release_loading.clear()
            if path == "/test/release":
                release_loading.set()
            if path == "/test/recover":
                recovered = True
            if path == "/test/reset":
                recovered = alternative = played = False
            value = {"/test/played": played, "/test/alternative": alternative}.get(path, True)
            body, mime = (b"yes" if value else b"no"), "text/plain"
        elif scenario == "offline" and not recovered:
            self.send_error(503)
            return
        elif path.startswith("/480/") or path == "/poster.png":
            if path.endswith(".ts"):
                played = True
            if query.get("mirror") == ["2"]:
                alternative = True
            return super().do_GET()
        else:
            if "/subject_collection/" in path:
                value = {"subject_collection_items": [subject] if "tv_hot" in path else [movie]}
            elif path.endswith("/search/movie"):
                term = query.get("q", [""])[0]
                value = {"items": [{"target_type": "tv", "target": subject}] if term == "三体" else []}
            elif path.endswith("/tv/26647087"):
                value = subject
            elif path.endswith("/movie/26266893"):
                value = movie
            elif path.endswith("/credits"):
                value = {"items": [{"id": str(i + 1), "name": name, "category": job, "simple_character": job}
                                   for i, (name, job) in enumerate([("杨磊", "导演"), ("张鲁一", "饰 汪淼"), ("于和伟", "饰 史强")])]}
            elif path.endswith("/photos"):
                value = {"photos": []}
            elif path.endswith("/recommend"):
                item = dict(movie if "/movie/" in path else subject)
                tags = query.get("tags", [""])[0].split(",")
                for tag, (item_id, name, genre) in channels.items():
                    if tag in tags:
                        item.update(id=item_id, title=name, genres=[genre], card_subtitle=f"2023 / 中国大陆 / {genre}")
                if query.get("start") != ["0"]:
                    item["id"] = "88" + item["id"]
                if scenario == "scroll":
                    start = int(query.get("start", ["0"])[0])
                    batch = [{**item, "id": str(30000000+i), "title": f"{item['title']} {i+1}"} for i in range(start, start+24)]
                    value = {"items": batch, "total": 72}
                else:
                    value = {"items": [] if "美国" in tags else [item], "total": 0 if "美国" in tags else 2}
            elif "/provide/vod" in path:
                film = query.get("wd") == [movie["title"]]
                url = "https://media.example.org/480/" + ("missing.m3u8" if scenario == "bad-media" else "index.m3u8")
                playlist = lambda line: "#".join(f"第{i}集${url}?mirror={line}" for i in range(1, 2 if film else 25))
                record = {"vod_id": 33, "vod_name": movie["title"] if film else subject["title"],
                          "vod_year": "2019" if film else "2023", "type_name": "科幻片" if film else "国产剧",
                          "vod_play_from": "hls$$$hls", "vod_play_url": playlist(1) + "$$$" + playlist(2)}
                value = {"list": [] if scenario == "no-source" else [record]}
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
