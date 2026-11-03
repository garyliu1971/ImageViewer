# -*- coding: utf-8 -*-
"""browser_view 纯逻辑单测 + WebDavProvider.fetch_image / list_dir_strict。"""

import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import browser_view as bv
import remote_source as rs


def _entry(name, is_dir=False, size=None, mtime=None, kind=None):
    return rs.RemoteSource("webdav", "/" + name, name=name, size=size, is_dir=is_dir,
                           mtime=mtime, kind="folder" if is_dir else kind)


class TestFormat(unittest.TestCase):
    def test_fmt_size(self):
        self.assertEqual(bv.fmt_size(None), "")
        self.assertEqual(bv.fmt_size(0), "0 B")
        self.assertEqual(bv.fmt_size(1536), "1.5 KB")
        self.assertEqual(bv.fmt_size(5 * 1024 ** 3), "5.0 GB")

    def test_fmt_mtime(self):
        self.assertEqual(bv.fmt_mtime(None), "")
        self.assertEqual(bv.fmt_mtime("garbage"), "")
        out = bv.fmt_mtime("Wed, 21 Oct 2015 07:28:00 GMT")
        self.assertRegex(out, r"^2015-10-2[01] \d\d:\d\d$")

    def test_mtime_key_orders(self):
        a = bv.mtime_key("Wed, 21 Oct 2015 07:28:00 GMT")
        b = bv.mtime_key("Thu, 22 Oct 2015 07:28:00 GMT")
        self.assertLess(a, b)
        self.assertEqual(bv.mtime_key("bad"), 0.0)

    def test_kind_label(self):
        self.assertEqual(bv.kind_label(_entry("d", is_dir=True)), "目录")
        self.assertEqual(bv.kind_label(_entry("a.jpg", kind="image")), "图片")
        self.assertEqual(bv.kind_label(_entry("a.mp4", kind="video")), "视频")
        self.assertEqual(bv.kind_label(_entry("a.mp3", kind="audio")), "音频")


class TestGridLayout(unittest.TestCase):
    def test_wraps_by_width(self):
        # width 500: usable 472, (472+10)//(100+10)=4 列
        rects, total = bv.grid_layout(9, 500, 100, 80, 30, 10, 14)
        self.assertEqual(len(rects), 9)
        self.assertEqual(rects[0], (14, 14, 114, 94))
        self.assertEqual(rects[3][0], 14 + 3 * 110)
        self.assertEqual(rects[4][:2], (14, 14 + 120))       # 第二行
        self.assertEqual(total, 14 * 2 + 3 * 120 - 10)       # 3 行

    def test_at_least_one_column(self):
        rects, _ = bv.grid_layout(3, 50, 100, 80, 30, 10, 14)
        self.assertEqual([r[0] for r in rects], [14, 14, 14])

    def test_empty(self):
        self.assertEqual(bv.grid_layout(0, 500, 100, 80, 30, 10, 14), ([], 28))

    def test_hit_test_includes_label(self):
        rects, _ = bv.grid_layout(2, 500, 100, 80, 30, 10, 14)
        self.assertEqual(bv.hit_test(rects, 20, 20), 0)
        self.assertEqual(bv.hit_test(rects, 20, 94 + 20, label_h=30), 0)   # 标签区
        self.assertIsNone(bv.hit_test(rects, 20, 94 + 20))                 # 不含标签
        self.assertEqual(bv.hit_test(rects, 14 + 110 + 5, 20), 1)
        self.assertIsNone(bv.hit_test(rects, 5, 5))


class TestSort(unittest.TestCase):
    def setUp(self):
        self.es = [
            _entry("b10.jpg", size=300, kind="image", mtime="Wed, 21 Oct 2015 07:28:00 GMT"),
            _entry("b2.jpg", size=100, kind="image", mtime="Thu, 22 Oct 2015 07:28:00 GMT"),
            _entry("z_dir", is_dir=True),
            _entry("a.mp4", size=200, kind="video", mtime="Tue, 20 Oct 2015 07:28:00 GMT"),
            _entry("a_dir", is_dir=True),
        ]

    def names(self, col, desc=False):
        return [e.name for e in bv.sort_entries(self.es, col, desc)]

    def test_name_natural_dirs_first(self):
        self.assertEqual(self.names("name"), ["a_dir", "z_dir", "a.mp4", "b2.jpg", "b10.jpg"])

    def test_dirs_stay_first_when_descending(self):
        self.assertEqual(self.names("name", True), ["z_dir", "a_dir", "b10.jpg", "b2.jpg", "a.mp4"])

    def test_size_and_mtime(self):
        self.assertEqual(self.names("size")[2:], ["b2.jpg", "a.mp4", "b10.jpg"])
        self.assertEqual(self.names("mtime")[2:], ["a.mp4", "b10.jpg", "b2.jpg"])

    def test_unknown_column_falls_back_to_name(self):
        self.assertEqual(self.names("nope"), self.names("name"))


_PNG = b"\x89PNG\r\n\x1a\n" + b"x" * 32


class _Backend(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        body = _PNG if self.path == "/dav/p.png" else b"nope"
        self.send_response(200 if self.path == "/dav/p.png" else 404)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_PROPFIND(self):
        self.send_response(401)
        self.send_header("Content-Length", "0")
        self.end_headers()


class TestWebDavThumbAndStrict(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Backend)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def provider(self):
        return rs.WebDavProvider("http://127.0.0.1:%d/dav" % self.port, "u", "p")

    def test_fetch_image_returns_bytes(self):
        src = rs.RemoteSource("webdav", "/dav/p.png", size=len(_PNG), kind="image")
        self.assertEqual(self.provider().fetch_image(src), _PNG)

    def test_fetch_image_skips_non_images_dirs_and_huge(self):
        p = self.provider()
        self.assertIsNone(p.fetch_image(rs.RemoteSource("webdav", "/dav/a.mp4", kind="video")))
        self.assertIsNone(p.fetch_image(rs.RemoteSource("webdav", "/dav/d", is_dir=True, kind="folder")))
        big = rs.RemoteSource("webdav", "/dav/p.png", size=p.THUMB_MAX_BYTES + 1, kind="image")
        self.assertIsNone(p.fetch_image(big))

    def test_list_dir_swallows_but_strict_raises(self):
        p = self.provider()
        self.assertEqual(p.list_dir("/dav"), [])
        with self.assertRaises(Exception):
            p.list_dir_strict("/dav")


if __name__ == "__main__":
    unittest.main()
