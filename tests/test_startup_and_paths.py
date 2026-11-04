# -*- coding: utf-8 -*-
"""启动提速（懒加载）与 WebDAV 路径/连通性修复的单测。"""

import os
import subprocess
import sys
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import remote_source as rs
import remote_types


class TestLazyImports(unittest.TestCase):
    def test_import_does_not_pull_heavy_modules(self):
        code = ("import sys, image_viewer;"
                "bad=[m for m in ('numpy','pymupdf','urllib.request','http.server','remote_source')"
                " if m in sys.modules];"
                "print(','.join(bad))")
        out = subprocess.run([sys.executable, "-X", "utf8", "-c", code], cwd=ROOT,
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.strip(), "", "启动时不应加载：" + out.stdout)

    def test_lazy_module(self):
        import image_viewer as iv
        self.assertTrue(iv._LazyModule("math"))
        self.assertEqual(iv._LazyModule("math").sqrt(9), 3.0)
        missing = iv._LazyModule("definitely_not_a_module_xyz")
        self.assertFalse(missing)
        with self.assertRaises(ImportError):
            missing.anything
        # 第一个不存在时回退到后面的候选
        self.assertTrue(iv._LazyModule("definitely_not_a_module_xyz", "math"))

    def test_plain_text_strips_emoji(self):
        import image_viewer as iv
        self.assertEqual(iv._plain_text("📂 打开文件夹"), "打开文件夹")
        self.assertEqual(iv._plain_text("下一话 ⏭"), "下一话")
        self.assertEqual(iv._plain_text("⏮"), "·")
        self.assertEqual(iv._plain_text("普通文字"), "普通文字")

    def test_remote_source_reexported(self):
        self.assertIs(rs.RemoteSource, remote_types.RemoteSource)


class _Dav(BaseHTTPRequestHandler):
    """记录收到的请求路径；PROPFIND 返回大小写不同的自身 href + 一个子文件。"""
    seen = []

    def log_message(self, *a):
        pass

    def do_PROPFIND(self):
        type(self).seen.append(self.path)
        body = ('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">'
                '<d:response><d:href>/dav/%e6%88%91%e7%9a%84%e7%bd%91%e7%9b%98/</d:href>'
                '<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>'
                '<d:response><d:href>/dav/%E6%88%91%E7%9A%84%E7%BD%91%E7%9B%98/a.png</d:href>'
                '<d:propstat><d:prop><d:resourcetype/><d:getcontentlength>5</d:getcontentlength></d:prop></d:propstat></d:response>'
                '</d:multistatus>').encode()
        self.send_response(207)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class TestWebDavPaths(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Dav)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def test_encode_path(self):
        enc = rs.WebDavProvider._encode_path
        self.assertEqual(enc("/dav/a b"), "/dav/a%20b")
        self.assertEqual(enc("/dav/我的网盘"), "/dav/%E6%88%91%E7%9A%84%E7%BD%91%E7%9B%98")
        self.assertEqual(enc("/dav/%E6%88%91"), "/dav/%E6%88%91")           # 已编码保持原样
        self.assertEqual(enc("/dav/我%20x"), "/dav/%E6%88%91%20x")          # 混合不二次编码
        self.assertEqual(enc("/dav/我的%文件"), "/dav/%E6%88%91%E7%9A%84%25%E6%96%87%E4%BB%B6")  # 字面 %

    def test_url_encodes_raw_non_ascii_href(self):
        p = rs.WebDavProvider("http://h/dav")
        self.assertEqual(p._url("/dav/中文 a.jpg"), "http://h/dav/%E4%B8%AD%E6%96%87%20a.jpg")
        self.assertEqual(p._url("/dav/%E4%B8%AD.jpg"), "http://h/dav/%E4%B8%AD.jpg")

    def test_chinese_base_url_lists_and_skips_self(self):
        p = rs.WebDavProvider("http://127.0.0.1:%d/dav/我的网盘" % self.port, "u", "p")
        self.assertEqual(p.root_path, "/dav/%E6%88%91%E7%9A%84%E7%BD%91%E7%9B%98")
        entries = p.list_dir_strict(p.root_path)
        # 自身 href 是小写 %e6，请求路径是大写 %E6：按解码后比较仍应跳过
        self.assertEqual([e.name for e in entries], ["a.png"])
        self.assertEqual(_Dav.seen[-1], "/dav/%E6%88%91%E7%9A%84%E7%BD%91%E7%9B%98")

    def test_raw_chinese_path_argument_is_encoded(self):
        p = rs.WebDavProvider("http://127.0.0.1:%d/dav" % self.port)
        entries = p.list_dir_strict("/dav/我的网盘/")
        self.assertEqual([e.name for e in entries], ["a.png"])

    def test_unreachable_strict_raises_plain_swallows(self):
        p = rs.WebDavProvider("http://127.0.0.1:1/dav")
        with self.assertRaises(Exception):
            p.list_dir_strict(p.root_path)
        self.assertEqual(p.list_dir(p.root_path), [])

    def test_jellyfin_strict_raises_plain_swallows(self):
        j = rs.JellyfinProvider("http://127.0.0.1:1", "tok", "uid")
        with self.assertRaises(Exception):
            j.list_dir_strict("")
        self.assertEqual(j.list_dir(""), [])


if __name__ == "__main__":
    unittest.main()
