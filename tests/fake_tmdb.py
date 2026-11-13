# -*- coding: utf-8 -*-
"""假 TMDB 服务器（测试用 / c:\\tmp\\tmdb_check.py 的离线演练用）。

只实现 scrape.TmdbClient 用到的接口：/3/configuration、/3/search/{movie,tv}、/3/{movie,tv}/{id}、
/3/tv/{id}/season/{n}，以及 /t/p/{size}/{file} 图片。校验 Authorization: Bearer <token>。
用法：
    srv = FakeTmdb(token="T").start()   # srv.api_base / srv.image_base
    srv.stop()
也可命令行起：python tests/fake_tmdb.py [port] [token]
"""
import json
import re
import struct
import zlib
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PNG = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
       b"\x00\x00\x00\rIDATx\x9cc\xf8\xff\xff?\x00\x05\xfe\x02\xfe\xa7\x9a\xa0\xa0\x00\x00\x00\x00IEND\xaeB`\x82")

def make_png(name, w=120, h=180):
    """按文件名上色的竖向渐变 PNG（让截图 / 肉眼验收看得出海报）。"""
    seed = sum(ord(c) * (i + 3) for i, c in enumerate(name))
    r, g, b = (seed * 37) % 160 + 40, (seed * 91) % 160 + 40, (seed * 53) % 160 + 40
    rows = b"".join(bytes([0]) + bytes([min(255, r + y // 3), min(255, g + y // 4), min(255, b + y // 5)]) * w for y in range(h))

    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return (bytes([0x89]) + b"PNG" + bytes([13, 10, 26, 10]) + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


MOVIES = {
    603: {"zh": {"title": "黑客帝国", "overview": "一个程序员发现世界是虚拟的。", "tagline": ""},
          "en": {"title": "The Matrix", "overview": "A hacker learns the world is a simulation.", "tagline": "Welcome to the Real World"},
          "orig": "The Matrix", "date": "1999-03-31", "poster": "/matrix_poster1.jpg", "backdrop": "/matrix_backdrop1.jpg",
          "pop": 80, "runtime": 136, "genres": [(28, "动作", "Action"), (878, "科幻", "Science Fiction")]},
    535167: {"zh": {"title": "流浪地球", "overview": "太阳即将毁灭，人类带着地球流浪。", "tagline": ""},
             "en": {"title": "The Wandering Earth", "overview": "The sun is dying; humanity moves the Earth.", "tagline": ""},
             "orig": "流浪地球", "date": "2019-02-05", "poster": "/wandering_earth1.jpg", "backdrop": "/wandering_backdrop1.jpg",
             "pop": 60, "runtime": 125, "genres": [(878, "科幻", "Science Fiction")]},
    335984: {"zh": {"title": "银翼杀手2049", "overview": "新一代银翼杀手发现秘密。", "tagline": ""},
             "en": {"title": "Blade Runner 2049", "overview": "A new blade runner unearths a secret.", "tagline": ""},
             "orig": "Blade Runner 2049", "date": "2017-10-04", "poster": "/bladerunner1.jpg", "backdrop": "/bladerunner_bd1.jpg",
             "pop": 50, "runtime": 164, "genres": [(878, "科幻", "Science Fiction")]},
    9999: {"zh": {"title": "The Matrix Reloaded", "overview": "", "tagline": ""},
           "en": {"title": "The Matrix Reloaded", "overview": "Neo continues.", "tagline": ""},
           "orig": "The Matrix Reloaded", "date": "2003-05-15", "poster": "/matrix2_poster.jpg", "backdrop": "",
           "pop": 40, "runtime": 138, "genres": []},
}
MOVIES[7003] = {"zh": {"title": "Quax, der Bruchpilot", "overview": "", "tagline": ""},
                "en": {"title": "Quax, der Bruchpilot", "overview": "A 1941 German film.", "tagline": ""}, "orig": "Quax, der Bruchpilot",
                "date": "1941-12-18", "poster": "/quax1941_poster.jpg", "backdrop": "", "pop": 5, "runtime": 118, "genres": [],
                "aliases": ["夸克"]}
MOVIES[7001] = {"zh": {"title": "沙丘", "overview": "1984 版。", "tagline": ""},
                "en": {"title": "Dune", "overview": "The 1984 film.", "tagline": ""}, "orig": "Dune",
                "date": "1984-12-14", "poster": "/dune1984_poster.jpg", "backdrop": "", "pop": 40, "runtime": 137, "genres": []}
MOVIES[7002] = {"zh": {"title": "沙丘", "overview": "2021 版。", "tagline": ""},
                "en": {"title": "Dune", "overview": "The 2021 film.", "tagline": ""}, "orig": "Dune",
                "date": "2021-09-15", "poster": "/dune2021_poster.jpg", "backdrop": "", "pop": 42, "runtime": 155, "genres": []}
TV = {
    1396: {"zh": {"name": "绝命毒师", "overview": "化学老师变成毒枭。"},
           "en": {"name": "Breaking Bad", "overview": "A chemistry teacher turns drug lord."},
           "orig": "Breaking Bad", "date": "2008-01-20", "poster": "/bb_poster1.jpg", "backdrop": "/bb_backdrop1.jpg",
           "pop": 90, "genres": [(18, "剧情", "Drama")],
           "seasons": {1: [("试播集", "Pilot"), ("猫在袋子里", "Cat's in the Bag..."), ("袋子在河里", "...And the Bag's in the River")],
                       2: [("第二季第一集", "Seven Thirty-Seven"), ("平静", "Grilled")]}},
    1429: {"zh": {"name": "进击的巨人", "overview": "人类对抗巨人。"},
           "en": {"name": "Attack on Titan", "overview": "Humanity fights titans."},
           "orig": "進撃の巨人", "date": "2013-04-07", "poster": "/aot_poster1.jpg", "backdrop": "/aot_backdrop1.jpg",
           "pop": 85, "genres": [(16, "动画", "Animation")],
           "seasons": {1: [("致两千年后的你", "To You, in 2000 Years"), ("那一天", "That Day"), ("在绝望中", "A Dim Light Amid Despair"),
                           ("解散式之夜", "The Night of the Closing Ceremony"), ("初阵", "First Battle")],
                       2: [("野兽巨人", "Beast Titan")]}},
}


class FakeTmdb:
    def __init__(self, token="FAKE_TMDB_TOKEN_abc123"):
        self.token = token
        self.requests = []          # [(path, {query}, auth_header_or_None, user_agent)]
        self.fail_429 = 0           # 接下来多少次 API 请求回 429
        self.retry_after = "0"
        self.fail_500 = 0
        self.image_hits = 0
        self.httpd = None
        self._lock = threading.Lock()

    @property
    def api_base(self):
        return "http://127.0.0.1:%d/3" % self.httpd.server_address[1]

    @property
    def image_base(self):
        return "http://127.0.0.1:%d/t/p" % self.httpd.server_address[1]

    def count(self, prefix=""):
        with self._lock:
            return len([r for r in self.requests if r[0].startswith(prefix)])

    def start(self):
        fake = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def _send(self, code, body, ctype="application/json", extra=None):
                if not isinstance(body, bytes):
                    body = json.dumps(body, ensure_ascii=False).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                for k, v in (extra or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                u = urllib.parse.urlsplit(self.path)
                q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
                auth = self.headers.get("Authorization")
                with fake._lock:
                    fake.requests.append((u.path, q, auth, self.headers.get("User-Agent")))
                if u.path == "/__stats":
                    with fake._lock:
                        n = len(fake.requests) - 1
                        srch = len([r for r in fake.requests if r[0].startswith("/3/search")])
                    return self._send(200, {"requests": n, "search": srch})
                if u.path.startswith("/t/p/"):
                    m = re.match(r"^/t/p/(w\d+|original)/([A-Za-z0-9_-]+\.(?:jpg|png))$", u.path)
                    if not m:
                        return self._send(404, {"status_message": "nope"})
                    with fake._lock:
                        fake.image_hits += 1
                    return self._send(200, make_png(m.group(2)), "image/png")
                if auth != "Bearer " + fake.token:
                    return self._send(401, {"success": False, "status_code": 7, "status_message": "Invalid API key"})
                with fake._lock:
                    if fake.fail_429 > 0:
                        fake.fail_429 -= 1
                        return self._send(429, {"status_message": "slow down"}, extra={"Retry-After": fake.retry_after})
                    if fake.fail_500 > 0:
                        fake.fail_500 -= 1
                        return self._send(503, {"status_message": "busy"})
                lang = q.get("language", "en-US")
                lk = "zh" if lang.startswith("zh") else "en"
                p = u.path
                if p == "/3/configuration":
                    return self._send(200, {"images": {"secure_base_url": fake.image_base + "/",
                                                       "poster_sizes": ["w92", "w154", "w185", "w342", "w500", "w780", "original"]}})
                m = re.match(r"^/3/search/(movie|tv)$", p)
                if m:
                    return self._send(200, fake._search(m.group(1), q.get("query", ""), lk, q))
                m = re.match(r"^/3/movie/(\d+)$", p)
                if m and int(m.group(1)) in MOVIES:
                    return self._send(200, fake._movie(int(m.group(1)), lk))
                m = re.match(r"^/3/tv/(\d+)$", p)
                if m and int(m.group(1)) in TV:
                    return self._send(200, fake._tv(int(m.group(1)), lk))
                m = re.match(r"^/3/tv/(\d+)/season/(\d+)$", p)
                if m and int(m.group(1)) in TV and int(m.group(2)) in TV[int(m.group(1))]["seasons"]:
                    return self._send(200, fake._season(int(m.group(1)), int(m.group(2)), lk))
                return self._send(404, {"success": False, "status_code": 34, "status_message": "not found"})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return self

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    # ---- 数据 ----
    def _search(self, kind, query, lk, q):
        qn = re.sub(r"[\W_]+", "", query.casefold())
        out = []
        for tid, d in (MOVIES if kind == "movie" else TV).items():
            names = [d[lk].get("title") or d[lk].get("name"), d["en"].get("title") or d["en"].get("name"),
                     d["zh"].get("title") or d["zh"].get("name"), d["orig"]]
            names += d.get("aliases", [])          # 外语别名：TMDB 的搜索会按它命中，但结果里的标题不含它
            hit = any(qn and (qn in re.sub(r"[\W_]+", "", (n or "").casefold())) for n in names)
            if not hit:
                continue
            yr = q.get("year") or q.get("first_air_date_year")
            if yr and not d["date"].startswith(str(yr)):
                continue
            row = {"id": tid, "popularity": d["pop"], "poster_path": d["poster"], "overview": d[lk]["overview"]}
            if kind == "movie":
                row.update(title=d[lk]["title"], original_title=d["orig"], release_date=d["date"])
            else:
                row.update(name=d[lk]["name"], original_name=d["orig"], first_air_date=d["date"])
            out.append(row)
        return {"page": 1, "results": out, "total_results": len(out)}

    def _movie(self, tid, lk):
        d = MOVIES[tid]
        return {"id": tid, "title": d[lk]["title"], "original_title": d["orig"], "overview": d[lk]["overview"],
                "tagline": d[lk]["tagline"], "release_date": d["date"], "poster_path": d["poster"] or None,
                "backdrop_path": d["backdrop"] or None, "vote_average": 8.1, "runtime": d["runtime"],
                "genres": [{"id": g[0], "name": g[1 if lk == "zh" else 2]} for g in d["genres"]]}

    def _tv(self, tid, lk):
        d = TV[tid]
        return {"id": tid, "name": d[lk]["name"], "original_name": d["orig"], "overview": d[lk]["overview"],
                "first_air_date": d["date"], "poster_path": d["poster"], "backdrop_path": d["backdrop"],
                "vote_average": 8.9, "episode_run_time": [45], "number_of_seasons": len(d["seasons"]),
                "genres": [{"id": g[0], "name": g[1 if lk == "zh" else 2]} for g in d["genres"]],
                "seasons": [{"season_number": n, "episode_count": len(eps), "poster_path": "/season%d_poster1.jpg" % n}
                            for n, eps in sorted(d["seasons"].items())]}

    def _season(self, tid, n, lk):
        eps = TV[tid]["seasons"][n]
        return {"season_number": n, "name": ("第 %d 季" % n) if lk == "zh" else "Season %d" % n,
                "overview": "", "poster_path": "/season%d_poster1.jpg" % n,
                "episodes": [{"episode_number": i + 1, "name": e[0 if lk == "zh" else 1], "overview": "ep%d %s" % (i + 1, lk),
                              "air_date": "2008-01-%02d" % (20 + i), "still_path": "/still_%d_%d_x.jpg" % (n, i + 1),
                              "runtime": 47} for i, e in enumerate(eps)]}


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    tok = sys.argv[2] if len(sys.argv) > 2 else "FAKE_TMDB_TOKEN_abc123"
    s = FakeTmdb(tok).start()
    print("API base  :", s.api_base)
    print("image base:", s.image_base)
    print("token     :", tok)
    threading.Event().wait()
