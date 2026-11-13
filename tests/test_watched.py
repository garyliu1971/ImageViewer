# -*- coding: utf-8 -*-
"""_video_watched_（已看）：纯逻辑 + 配置往返 + 后端接口。桌面版 GUI 本身在这里跑不了，只测它调用的纯逻辑。"""
import json
import os
import sys
import tempfile
import unittest
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import config_store
import watched_store as ws
import web_backend as wb


def old_desktop_rule(resumes, key, position, length):
    """桌面版改动前的原始逻辑（逐字照搬），用来证明续播部分行为没变。"""
    if position > 3000 and (length <= 0 or position < length - 3000):
        resumes[key] = position
    else:
        resumes.pop(key, None)


class TestLogic(unittest.TestCase):
    def test_resume_semantics_unchanged(self):
        for pos, length in ((0, 0), (2999, 600000), (3000, 600000), (3001, 600000), (300000, 600000), (596999, 600000),
                            (597000, 600000), (599000, 600000), (600000, 600000), (5000, 0), (5000, -1), (100, 100)):
            a, b = {"k": 1234}, {"_video_resume_": {"k": 1234}}
            old_desktop_rule(a, "k", pos, length)
            ws.apply_resume(b, "k", pos, length)
            self.assertEqual(a, b["_video_resume_"], (pos, length))

    def test_finish_marks_watched(self):
        c = {}
        self.assertIsNone(ws.apply_resume(c, "k", 599000, 600000, now=1000))
        self.assertEqual(c["_video_watched_"], {"k": 1000})
        self.assertTrue(ws.is_watched(c, "k"))

    def test_not_finished_cases(self):
        for pos, length in ((0, 600000), (2000, 600000), (300000, 600000), (5000, 0), (600000, 0)):
            c = {}
            ws.apply_resume(c, "k", pos, length)
            self.assertFalse(ws.is_watched(c, "k"), (pos, length))

    def test_partial_replay_keeps_watched(self):
        c = {}
        ws.apply_resume(c, "k", 600000, 600000, now=5)
        self.assertEqual(ws.apply_resume(c, "k", 90000, 600000), 90000)
        self.assertTrue(ws.is_watched(c, "k"))

    def test_manual_toggle_and_cap(self):
        c = {}
        ws.mark_watched(c, "a", True, now=1)
        ws.mark_watched(c, "a", False)
        self.assertFalse(ws.is_watched(c, "a"))
        for i in range(7):
            ws.mark_watched(c, "k%d" % i, True, now=i, max_keys=3)
        self.assertEqual(list(c["_video_watched_"]), ["k4", "k5", "k6"])

    def test_robust_to_garbage_config(self):
        c = {"_video_watched_": [1, 2], "_video_resume_": "x"}
        self.assertFalse(ws.is_watched(c, "k"))
        ws.apply_resume(c, "k", 599000, 600000)
        self.assertTrue(ws.is_watched(c, "k"))


class TestConfigCompat(unittest.TestCase):
    def test_unknown_keys_survive_old_style_roundtrip(self):
        """老版本桌面只读写它认识的 key，但 config_store 是整份 json 往返：新增的 _video_watched_ 不会被丢。"""
        fd, path = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        try:
            cfg = {"_video_resume_": {"/a.mp4": 1000}, "_video_watched_": {"/b.mp4": 1700000000}, "_other_": [1]}
            config_store.save_config(path, cfg)
            loaded = config_store.load_config(path)
            loaded.setdefault("_video_resume_", {})["/c.mp4"] = 2000          # 老版本只改自己的 key
            config_store.save_config(path, loaded)
            again = config_store.load_config(path)
            self.assertEqual(again["_video_watched_"], {"/b.mp4": 1700000000})
            self.assertEqual(again["_video_resume_"], {"/a.mp4": 1000, "/c.mp4": 2000})
            self.assertTrue(all(isinstance(v, int) for v in again["_video_resume_"].values()))   # 老格式：毫秒整数
        finally:
            os.remove(path)

    def test_desktop_source_uses_shared_logic(self):
        src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "image_viewer.py"), encoding="utf-8").read()
        self.assertIn("watched_store.apply_resume(self._config, key, position, length)", src)
        self.assertIn("watched_store.mark_watched(self._config, wkey, True)", src)


class TestEndpoint(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd, _t, url = wb.serve(0, open_browser=False)
        cls.base = url.rstrip("/")

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._old = wb.CONFIG_PATH
        wb.CONFIG_PATH = os.path.join(self.tmp, "c.json")
        self.t = wb.Handler.token
        self.vid = os.path.join(self.tmp, "a.mp4")
        with open(self.vid, "wb") as f:
            f.write(b"x")

    def tearDown(self):
        wb.CONFIG_PATH = self._old

    def call(self, method, body=None, **q):
        q["t"] = self.t
        u = self.base + "/api/videoresume?" + urllib.parse.urlencode(q)
        req = urllib.request.Request(u, data=json.dumps(body).encode() if body is not None else None, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_finish_then_get_then_toggle(self):
        self.assertEqual(self.call("GET", path=self.vid)[1]["watched"], False)
        st, j = self.call("PUT", {"path": self.vid, "ms": 599000, "length": 600000})
        self.assertEqual((st, j["ms"], j["watched"]), (200, None, True))
        self.assertTrue(self.call("GET", path=self.vid)[1]["watched"])
        st, j = self.call("PUT", {"path": self.vid, "watched": False})
        self.assertEqual((st, j["watched"]), (200, False))
        self.assertFalse(self.call("GET", path=self.vid)[1]["watched"])
        st, j = self.call("PUT", {"path": self.vid, "watched": True})
        self.assertTrue(j["watched"])
        cfg = config_store.load_config(wb.CONFIG_PATH)
        self.assertIn(wb.os.path.normcase(os.path.abspath(self.vid)), cfg["_video_watched_"])

    def test_toggle_keeps_resume_point(self):
        self.call("PUT", {"path": self.vid, "ms": 70000, "length": 600000})
        self.call("PUT", {"path": self.vid, "watched": True})
        self.assertEqual(self.call("GET", path=self.vid)[1]["ms"], 70000)

    def test_validation(self):
        self.assertEqual(self.call("PUT", {"path": self.vid, "watched": "yes"})[0], 400)
        self.assertEqual(self.call("PUT", {"path": os.path.join(self.tmp, "x.txt"), "watched": True})[0], 400)
        self.assertEqual(self.call("PUT", {"path": self.vid, "ms": -5, "length": 1})[0], 400)

    def test_remote_key_watched(self):
        wb.remote_save_config("http://nas:5244/dav", "u", "p")
        st, j = self.call("PUT", {"remote": "/dav/电影/a.mkv", "ms": 599000, "length": 600000})
        self.assertTrue(j["watched"])
        self.assertIn("dav:nas:5244/dav/电影/a.mkv", config_store.load_config(wb.CONFIG_PATH)["_video_watched_"])
        self.assertTrue(self.call("GET", remote="/dav/电影/a.mkv")[1]["watched"])


if __name__ == "__main__":
    unittest.main()
