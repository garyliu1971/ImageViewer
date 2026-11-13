# -*- coding: utf-8 -*-
"""/api/media/{probe,stream,subtitle}、/api/media/in/<nonce>、/api/open-external 的后端测试。
用真 ffmpeg 生成 H.264+AC3 的 mkv；没装 ffmpeg 就带原因跳过。云端输入走假 WebDAV，并抓 argv 证明凭据不在命令行里。"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ffmpeg_tools as ft
import web_backend as wb
from tests.fake_webdav import FakeWebDav
from tests.test_ffmpeg_tools import HAVE_FF, SKIP, make_media


def req(base, token, route, params=None, method="GET", body=None, headers=None, timeout=60):
    q = dict(params or {})
    if token:
        q["t"] = token
    u = base + route + ("?" + urllib.parse.urlencode(q) if q else "")
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(u, data=data, method=method, headers=dict({"Content-Type": "application/json"}, **(headers or {})))
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def jbody(b):
    return json.loads(b.decode("utf-8"))


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd, _t, url = wb.serve(0, open_browser=False)
        cls.base = url.rstrip("/")
        cls.token = wb.Handler.token
        cls.tmp = tempfile.mkdtemp(prefix="iv_media_")

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def get(self, route, params=None, **kw):
        return req(self.base, self.token, route, params, **kw)

    def post(self, route, body, **kw):
        return req(self.base, self.token, route, None, "POST", body, **kw)


class TestWithoutFfmpeg(Base):
    def setUp(self):
        self._old = ft.info
        ft.info = lambda: {"available": False, "version": "", "ffprobe": False, "encoders": []}

    def tearDown(self):
        ft.info = self._old

    def test_feature_hidden_but_nothing_breaks(self):
        st, _, b = req(self.base, None, "/api/ping")
        j = jbody(b)
        self.assertEqual((st, j["ffmpeg"]["available"]), (200, False))
        v = os.path.join(self.tmp, "a.mkv")
        open(v, "wb").write(b"x")
        for st, _, b in (self.post("/api/media/probe", {"path": v}), self.get("/api/media/stream", {"path": v}),
                         self.get("/api/media/subtitle", {"path": v, "stream": 0})):
            self.assertEqual((st, jbody(b)["code"]), (501, "no_ffmpeg"))
        st, _, b = self.get("/api/data", {"path": v})               # 原来的播放路径完全不受影响
        self.assertEqual((st, b), (200, b"x"))


@unittest.skipUnless(HAVE_FF, SKIP)
class TestMedia(Base):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.ac3 = make_media(cls.tmp, "h264_ac3.mkv")
        cls.aac = make_media(cls.tmp, "h264_aac.mkv", acodec="aac")
        cls.subs = make_media(cls.tmp, "subs.mkv", acodec="aac", subs=True)
        cls.long = make_media(cls.tmp, "long.mkv", dur=240, extra=["-preset", "ultrafast"])

    def setUp(self):
        self.old_cfg = wb.CONFIG_PATH
        wb.CONFIG_PATH = os.path.join(tempfile.mkdtemp(dir=self.tmp), "cfg.json")
        wb._remote_cache.clear()
        wb._probe_cache.clear()
        wb._sub_cache.clear()

    def tearDown(self):
        wb.CONFIG_PATH = self.old_cfg
        wb._popen_ffmpeg = None
        wb._popen_external = None
        ft.kill_all()

    # ---- caps ----
    def test_caps_report_ffmpeg(self):
        j = jbody(req(self.base, None, "/api/ping")[2])
        self.assertTrue(j["ffmpeg"]["available"])
        self.assertIn("libx264", j["ffmpeg"]["encoders"])
        self.assertRegex(j["ffmpeg"]["version"], r"^\d")
        self.assertIn("vlc", j)

    # ---- probe ----
    def test_probe_get_and_post(self):
        for st, _, b in (self.get("/api/media/probe", {"path": self.ac3}), self.post("/api/media/probe", {"path": self.ac3})):
            j = jbody(b)
            self.assertEqual(st, 200)
            p = j["probe"]
            self.assertEqual((p["container"], p["video"]["codec"], p["audio"][0]["codec"], p["action"]), ("matroska", "h264", "ac3", "transcode_audio"))
            self.assertEqual((p["video"]["width"], p["video"]["height"]), (320, 180))
            self.assertFalse(p["audio"][0]["browser_ok"])
            self.assertIn("ac3", p["reason"])
        self.assertEqual(jbody(self.get("/api/media/probe", {"path": self.aac})[2])["probe"]["action"], "direct")

    def test_probe_validation_and_token(self):
        self.assertEqual(req(self.base, None, "/api/media/probe", {"path": self.ac3})[0], 403)
        txt = os.path.join(self.tmp, "x.txt")
        open(txt, "w").write("x")
        self.assertEqual(self.get("/api/media/probe", {"path": txt})[0], 400)
        self.assertEqual(self.get("/api/media/probe", {"path": os.path.join(self.tmp, "nope.mkv")})[0], 404)
        self.assertEqual(self.get("/api/media/probe", {"path": ""})[0], 400)
        self.assertEqual(self.get("/api/media/probe", {"path": "x" * 5000 + ".mkv"})[0], 400)
        self.assertEqual(self.get("/api/media/probe", {"remote": "/dav/a.mkv"})[0], 400)       # 没配置 WebDAV

    def test_probe_is_cached(self):
        calls = []
        orig = ft.run_probe
        ft.run_probe = lambda *a, **k: (calls.append(1), orig(*a, **k))[1]
        try:
            self.get("/api/media/probe", {"path": self.ac3})
            self.get("/api/media/probe", {"path": self.ac3})
        finally:
            ft.run_probe = orig
        self.assertEqual(len(calls), 1)

    # ---- stream ----
    def _probe_bytes(self, data, name):
        out = os.path.join(self.tmp, name)
        with open(out, "wb") as f:
            f.write(data)
        return ft.analyze(ft.run_probe(out))

    def test_stream_auto_transcodes_ac3_to_aac(self):
        st, h, b = self.get("/api/media/stream", {"path": self.ac3})
        self.assertEqual(st, 200)
        self.assertEqual((h["Content-Type"], h["X-IV-Transcode"]), ("video/mp4", "audio"))
        a = self._probe_bytes(b, "s1.mp4")
        self.assertEqual((a["video"]["codec"], a["audio"][0]["codec"], a["action"]), ("h264", "aac", "direct"))
        self.assertGreater(a["duration"], 5)

    def test_stream_start_offset(self):
        st, _, b = self.get("/api/media/stream", {"path": self.ac3, "start": 3})
        a = self._probe_bytes(b, "s2.mp4")
        self.assertEqual(st, 200)
        self.assertLess(a["duration"], 4.5)

    def test_stream_remux_mode_and_param_validation(self):
        st, h, b = self.get("/api/media/stream", {"path": self.aac, "mode": "remux"})
        self.assertEqual((st, h["X-IV-Transcode"]), (200, "remux"))
        for params in ({"mode": "evil"}, {"start": "-1"}, {"start": "abc"}, {"audio": "x"}, {"audio": "99"}, {"start": "99999999"}):
            st, _, b = self.get("/api/media/stream", dict({"path": self.ac3}, **params))
            self.assertIn(st, (400, 500), params)
            self.assertFalse(jbody(b)["ok"])
        self.assertEqual(self.get("/api/media/stream", {"path": os.path.join(self.tmp, "x.txt")})[0], 400)

    def test_client_cannot_inject_ffmpeg_args(self):
        seen = []
        real = subprocess.Popen

        def spy(argv, *a, **k):
            seen.append(list(argv))
            return real(argv, *a, **k)
        wb._popen_ffmpeg = spy
        st, _, _ = self.get("/api/media/stream", {"path": self.ac3, "mode": "audio", "extra": "-f null", "vf": "scale=1:1",
                                                   "args": "-i /etc/passwd", "audio": "0"})
        self.assertEqual(st, 200)
        argv = seen[-1]
        self.assertEqual(argv.count("-i"), 1)
        self.assertEqual(argv[argv.index("-i") + 1], os.path.abspath(self.ac3))
        self.assertNotIn("scale=1:1", " ".join(argv))
        self.assertNotIn("/etc/passwd", " ".join(argv))

    def test_disconnect_kills_ffmpeg_and_frees_slot(self):
        host, port = self.base.replace("http://", "").split(":")
        s = socket.create_connection((host, int(port)), timeout=30)
        q = urllib.parse.urlencode({"path": self.long, "mode": "audio", "t": self.token})
        s.sendall(("GET /api/media/stream?%s HTTP/1.1\r\nHost: x\r\n\r\n" % q).encode())
        got = b""
        while b"\r\n\r\n" not in got:
            got += s.recv(65536)
        t0 = time.time()
        while ft.live_count() < 1 and time.time() - t0 < 10:
            time.sleep(0.1)
        self.assertEqual(ft.live_count(), 1)
        s.close()
        t0 = time.time()
        while ft.live_count() and time.time() - t0 < 20:
            time.sleep(0.2)
        self.assertEqual(ft.live_count(), 0)                        # 断开后进程被杀
        for _ in range(ft.MAX_CONCURRENT):                           # 并发名额已归还
            ft.acquire_slot()
        for _ in range(ft.MAX_CONCURRENT):
            ft.release_slot()

    def test_concurrency_limit(self):
        got = 0
        try:
            for _ in range(ft.MAX_CONCURRENT):
                ft.acquire_slot()
                got += 1
            st, _, b = self.get("/api/media/stream", {"path": self.ac3})
            self.assertEqual(st, 503)
            self.assertIn("转码任务太多", jbody(b)["error"])
        finally:
            for _ in range(got):
                ft.release_slot()
        self.assertEqual(self.get("/api/media/stream", {"path": self.ac3})[0], 200)

    def test_bad_source_returns_ffmpeg_error_not_hang(self):
        bad = os.path.join(self.tmp, "garbage.mkv")
        with open(bad, "wb") as f:
            f.write(b"this is not media at all " * 50)
        st, _, b = self.get("/api/media/stream", {"path": bad, "mode": "audio"})
        self.assertIn(st, (400, 502))
        self.assertFalse(jbody(b)["ok"])

    # ---- subtitle ----
    def test_embedded_text_subtitle_to_vtt_with_shift(self):
        st, h, b = self.get("/api/media/subtitle", {"path": self.subs, "stream": 0})
        t = b.decode("utf-8")
        self.assertEqual(st, 200)
        self.assertTrue(h["Content-Type"].startswith("text/vtt"))
        self.assertTrue(t.startswith("WEBVTT"))
        self.assertIn("你好 hello", t)
        st, _, b2 = self.get("/api/media/subtitle", {"path": self.subs, "stream": 0, "start": 2.5})
        t2 = b2.decode("utf-8")
        self.assertNotIn("你好 hello", t2)
        self.assertIn("00:00:00.500 --> 00:00:02.500\n第二句", t2)
        self.assertEqual(self.get("/api/media/subtitle", {"path": self.subs, "stream": 3})[0], 404)
        self.assertEqual(self.get("/api/media/subtitle", {"path": self.subs, "stream": "x"})[0], 400)
        self.assertEqual(self.get("/api/media/subtitle", {"path": self.aac, "stream": 0})[0], 404)

    # ---- nonce 入口 ----
    def test_nonce_endpoint_serves_ranges_without_token_and_expires(self):
        n = wb.mint_input("local", os.path.abspath(self.aac), 60)
        st, h, b = req(self.base, None, "/api/media/in/" + n, headers={"Range": "bytes=0-9"})
        self.assertEqual((st, len(b)), (206, 10))
        st, _, b = req(self.base, None, "/api/media/in/" + n + "/name.mkv")
        self.assertEqual(st, 200)
        self.assertEqual(len(b), os.path.getsize(self.aac))
        wb.revoke_input(n)
        self.assertEqual(req(self.base, None, "/api/media/in/" + n)[0], 404)
        self.assertEqual(req(self.base, None, "/api/media/in/bogus")[0], 404)
        n2 = wb.mint_input("local", os.path.abspath(self.aac), -1)
        self.assertEqual(req(self.base, None, "/api/media/in/" + n2)[0], 404)       # 过期即失效

    # ---- 云端输入：凭据不在 argv ----
    def test_remote_source_credentials_never_reach_argv(self):
        data = open(self.ac3, "rb").read()
        dav = FakeWebDav({"/dav/视频/a.mkv": data}, user="alice", pw="s3cr3t-pw")
        root = dav.start()
        argvs = []
        real_popen = ft.popen
        ft.popen = lambda argv, popen_fn=subprocess.Popen: (argvs.append(list(argv)), real_popen(argv, popen_fn))[1]
        wb._popen_ffmpeg = subprocess.Popen
        try:
            wb.remote_save_config(root, "alice", "s3cr3t-pw")
            st, _, b = self.post("/api/media/probe", {"remote": "/dav/视频/a.mkv"})
            self.assertEqual(st, 200, b[:300])
            self.assertEqual(jbody(b)["probe"]["action"], "transcode_audio")
            st, h, b = self.get("/api/media/stream", {"remote": "/dav/视频/a.mkv", "start": 1})
            self.assertEqual((st, h["X-IV-Transcode"]), (200, "audio"))
            self.assertEqual(ft.analyze(ft.run_probe(self._write(b, "r.mp4")))["audio"][0]["codec"], "aac")
        finally:
            ft.popen = real_popen
            dav.stop()
        joined = "\n".join(" ".join(a) for a in argvs)
        self.assertTrue(argvs)
        for secret in ("alice", "s3cr3t-pw", self.token):
            self.assertNotIn(secret, joined)
        self.assertRegex(joined, r"http://127\.0\.0\.1:\d+/api/media/in/[A-Za-z0-9_-]+")

    def _write(self, data, name):
        p = os.path.join(self.tmp, name)
        with open(p, "wb") as f:
            f.write(data)
        return p

    # ---- 用 VLC 打开 ----
    def test_open_external_local_and_remote(self):
        launched = []
        wb._popen_external = lambda argv, **k: launched.append((list(argv), k))
        vlc = os.path.join(self.tmp, "vlc.exe")
        open(vlc, "w").close()
        old = os.environ.get("IV_VLC_PATH")
        os.environ["IV_VLC_PATH"] = vlc
        dav = FakeWebDav({"/dav/视频/a.mkv": b"0123456789"}, user="bob", pw="pw-secret")
        root = dav.start()
        try:
            if os.name == "nt":
                st, _, b = self.post("/api/open-external", {"path": self.ac3})
                self.assertEqual(st, 200, b)
                self.assertEqual(launched[-1][0], [vlc, self.ac3])
                self.assertNotIn("shell", launched[-1][1])
                wb.remote_save_config(root, "bob", "pw-secret")
                st, _, b = self.post("/api/open-external", {"remote": "/dav/视频/a.mkv"})
                self.assertEqual(st, 200, b)
                target = launched[-1][0][1]
                self.assertRegex(target, r"^http://127\.0\.0\.1:\d+/api/media/in/[A-Za-z0-9_-]+/a\.mkv$")
                for secret in ("bob", "pw-secret", self.token):
                    self.assertNotIn(secret, " ".join(launched[-1][0]))
                nonce = target.split("/api/media/in/")[1].split("/")[0]
                st, _, data = req(self.base, None, "/api/media/in/" + nonce)           # VLC 能用这个 URL 取到字节
                self.assertEqual((st, data), (200, b"0123456789"))
                self.assertEqual(self.post("/api/open-external", {"path": os.path.join(self.tmp, "x.txt")})[0], 403)      # 非视频：拒绝
            else:
                self.assertEqual(self.post("/api/open-external", {"path": self.ac3})[0], 501)
            self.assertEqual(req(self.base, None, "/api/open-external", None, "POST", {"path": self.ac3})[0], 403)      # 没 token
        finally:
            dav.stop()
            if old is None:
                os.environ.pop("IV_VLC_PATH", None)
            else:
                os.environ["IV_VLC_PATH"] = old

    def test_open_external_without_vlc(self):
        orig = ft.find_vlc
        ft.find_vlc = lambda: None
        try:
            st, _, b = self.post("/api/open-external", {"path": self.ac3})
        finally:
            ft.find_vlc = orig
        self.assertEqual(st, 404 if os.name == "nt" else 501)

    def test_shutdown_kills_processes(self):
        host, port = self.base.replace("http://", "").split(":")
        s = socket.create_connection((host, int(port)), timeout=30)
        q = urllib.parse.urlencode({"path": self.long, "mode": "audio", "t": self.token})
        s.sendall(("GET /api/media/stream?%s HTTP/1.1\r\nHost: x\r\n\r\n" % q).encode())
        got = b""
        while b"\r\n\r\n" not in got:
            got += s.recv(65536)
        self.assertGreaterEqual(ft.live_count(), 1)
        ft.kill_all()
        t0 = time.time()
        while ft.live_count() and time.time() - t0 < 5:
            time.sleep(0.1)
        self.assertEqual(ft.live_count(), 0)
        s.close()


if __name__ == "__main__":
    unittest.main()
