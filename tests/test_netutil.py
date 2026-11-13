# -*- coding: utf-8 -*-
"""netutil：内网主机直连（绕过环境变量代理），公网主机仍走代理。"""
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import netutil
import remote_source
from tests.fake_webdav import FakeWebDav

PROXY_VARS = ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy")
DEAD_PROXY = "http://127.0.0.1:9"          # discard 端口，没人听 -> 连接被拒


class Hello(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *a):
        pass


class TestClassify(unittest.TestCase):
    def test_private(self):
        for h in ("10.1.2.3", "127.0.0.1", "172.16.0.1", "172.31.255.1", "192.168.1.5", "169.254.1.1", "localhost",
                  "nas", "alist.local", "NAS.LOCAL", "::1", "[::1]", "fd12:3456::1", "fe80::1", "[fe80::1]"):
            self.assertTrue(netutil.is_private_host(h), h)

    def test_public(self):
        for h in ("8.8.8.8", "172.32.0.1", "172.15.0.1", "192.169.1.1", "11.0.0.1", "api.themoviedb.org",
                  "example.com", "2001:db8::1", "100.64.0.1", "", None):
            self.assertFalse(netutil.is_private_host(h), h)

    def test_url_helpers(self):
        self.assertTrue(netutil.is_private_url("http://192.168.1.5:5244/dav/x"))
        self.assertTrue(netutil.is_private_url("http://u:p@nas:5244/dav"))
        self.assertTrue(netutil.is_private_url("http://[::1]:8080/"))
        self.assertFalse(netutil.is_private_url("https://api.themoviedb.org/3"))
        self.assertFalse(netutil.is_private_url("not a url"))

    def test_matches_frontend_rules(self):
        """与 IVCore.plainHttpRisk 同一批用例（前端：warn=false 即内网）。"""
        import re
        html = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "image-viewer.html"), encoding="utf-8").read()
        self.assertIn("a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)", html)
        self.assertIn("host === 'localhost' || /\\.local$/.test(host) || host.indexOf('.') < 0", html)
        self.assertTrue(re.search(r"host === '::1' \|\| /\^f\[cd\]", html))


class TestProxyBypass(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in PROXY_VARS}
        for k in PROXY_VARS:
            os.environ.pop(k, None)
        os.environ["HTTP_PROXY"] = os.environ["http_proxy"] = DEAD_PROXY
        os.environ["HTTPS_PROXY"] = os.environ["https_proxy"] = DEAD_PROXY
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Hello)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:%d/" % self.httpd.server_address[1]

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_control_plain_urllib_fails_with_dead_proxy(self):
        """对照组：同样的环境下，原生 urllib 访问内网地址会被送去死代理 -> 失败（线上 TimeoutError 的成因）。"""
        with self.assertRaises(urllib.error.URLError):
            urllib.request.urlopen(self.url, timeout=3)

    def test_private_host_bypasses_proxy(self):
        with netutil.urlopen(urllib.request.Request(self.url), timeout=5) as r:
            self.assertEqual(r.read(), b"ok")

    def test_public_host_still_uses_proxy(self):
        with self.assertRaises(urllib.error.URLError) as cm:
            netutil.urlopen(urllib.request.Request("http://example.com/"), timeout=5)
        self.assertIsInstance(cm.exception.reason, ConnectionRefusedError)       # 连的是死代理，不是 DNS 失败

    def test_https_public_still_uses_proxy(self):
        with self.assertRaises(urllib.error.URLError) as cm:
            netutil.urlopen(urllib.request.Request("https://api.themoviedb.org/3/configuration"), timeout=5)
        self.assertNotIsInstance(cm.exception.reason, __import__("socket").gaierror)

    def test_redirect_to_public_host_goes_via_proxy_again(self):
        """私网 -> 302 到公网：公网这一跳仍按代理判断（这里代理是死的，所以会失败，证明重新判断了）。"""
        class Redir(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302)
                self.send_header("Location", "http://example.com/x")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *a):
                pass
        h = ThreadingHTTPServer(("127.0.0.1", 0), Redir)
        threading.Thread(target=h.serve_forever, daemon=True).start()
        try:
            with self.assertRaises(urllib.error.URLError) as cm:
                remote_source.netutil.build_opener(remote_source._SafeRedirect()).open(
                    urllib.request.Request("http://127.0.0.1:%d/" % h.server_address[1]), timeout=5)
            self.assertIsInstance(cm.exception.reason, ConnectionRefusedError)
        finally:
            h.shutdown()
            h.server_close()

    def test_webdav_provider_with_dead_proxy(self):
        dav = FakeWebDav({"/dav/视频/a.mp4": b"0123456789"}, user="u", pw="p")
        root = dav.start()
        try:
            p = remote_source.WebDavProvider(root, "u", "p")
            ents = p.list_dir(p.root_path)
            self.assertTrue(ents)
            p.list_dir_strict(p.root_path)
        finally:
            dav.stop()

    def test_webdav_open_stream_with_dead_proxy(self):
        dav = FakeWebDav({"/dav/视频/a.mp4": b"0123456789"}, user="u", pw="p")
        root = dav.start()
        try:
            p = remote_source.WebDavProvider(root, "u", "p")
            src = next(e for e in p.list_dir(p.root_path + "/视频") if e.name == "a.mp4")
            with p.open_stream(src, {"Range": "bytes=2-5"}) as r:
                self.assertEqual(r.read(), b"2345")
        finally:
            dav.stop()


if __name__ == "__main__":
    unittest.main()
