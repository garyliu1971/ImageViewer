# -*- coding: utf-8 -*-
"""remote_source 纯逻辑 / 协议单测：WebDAV 目录解析 + 本地流代理 Range 透传。"""

import json
import os
import re
import sys
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import remote_source as rs


# 假 WebDAV 后端：一个目录 + 一个 mp4，支持 PROPFIND / Range GET
_MP4 = b"0123456789abcdef" * 4  # 64 字节

PROPFIND_XML = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<d:multistatus xmlns:d="DAV:">'
    '<d:response><d:href>/dav/Movies/</d:href>'
    '<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>'
    '</d:response>'
    '<d:response><d:href>/dav/Movies/</d:href>'
    '<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>'
    '</d:response>'
    '<d:response><d:href>/dav/Movies/a.mp4</d:href>'
    '<d:propstat><d:prop>'
    '<d:resourcetype/><d:getcontentlength>64</d:getcontentlength>'
    '</d:prop></d:propstat>'
    '</d:response>'
    '<d:response><d:href>/dav/Movies/poster.png</d:href>'
    '<d:propstat><d:prop><d:resourcetype/><d:getcontentlength>10</d:getcontentlength></d:prop></d:propstat>'
    '</d:response>'
    '<d:response><d:href>/dav/Movies/song.mp3</d:href>'
    '<d:propstat><d:prop><d:resourcetype/><d:getcontentlength>100</d:getcontentlength></d:prop></d:propstat>'
    '</d:response>'
    '</d:multistatus>'
)


class _WebDavBackend(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, headers=None):
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        if body is not None:
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_PROPFIND(self):
        self._send(207, PROPFIND_XML.encode(), {"Content-Type": "application/xml"})

    def do_GET(self):
        if self.path == "/dav/Movies/a.mp4":
            rng = self.headers.get("Range")
            if rng:
                m = __import__("re").match(r"bytes=(\d+)-(\d*)", rng)
                if m:
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else len(_MP4) - 1
                    part = _MP4[start:end + 1]
                    self._send(206, part, {
                        "Content-Type": "video/mp4",
                        "Content-Range": "bytes %d-%d/%d" % (start, end, len(_MP4)),
                        "Accept-Ranges": "bytes",
                    })
                    return
            self._send(200, _MP4, {"Content-Type": "video/mp4", "Accept-Ranges": "bytes"})
        else:
            self._send(404, b"not found")

    do_HEAD = do_GET


class TestWebDavProvider(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _WebDavBackend)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def make_provider(self):
        return rs.WebDavProvider("http://127.0.0.1:%d/dav" % self.port, "u", "p")

    def test_list_dir_filters_videos_and_dirs(self):
        entries = self.make_provider().list_dir("/dav/Movies")
        # 保留目录 + 视频/图片/音频文件，目录自身被跳过
        self.assertEqual(len(entries), 3)
        kinds = {e.name: e.kind for e in entries}
        self.assertEqual(kinds, {"a.mp4": "video", "poster.png": "image", "song.mp3": "audio"})
        f = entries[0]
        self.assertFalse(f.is_dir)
        self.assertEqual(f.size, 64)
        self.assertEqual(f.path, "/dav/Movies/a.mp4")

    def test_open_stream_basic_auth(self):
        p = self.make_provider()
        resp = p.open_stream(rs.RemoteSource("webdav", "/dav/Movies/a.mp4"), None)
        data = resp.read()
        self.assertEqual(data, _MP4)

    def test_root_path_from_base_url(self):
        p = rs.WebDavProvider("https://dav.example.com/sub")
        self.assertEqual(p.origin, "https://dav.example.com")
        self.assertEqual(p.root_path, "/sub")


class TestRemoteStreamProxy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _WebDavBackend)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def test_proxy_range_relay(self):
        provider = rs.WebDavProvider("http://127.0.0.1:%d/dav" % self.port, "u", "p")
        src = rs.RemoteSource("webdav", "/dav/Movies/a.mp4", name="a.mp4", size=64)
        proxy = rs.RemoteStreamProxy(provider, src)
        try:
            url = proxy.start()
            self.assertTrue(url.startswith("http://127.0.0.1:"))
            req = urllib.request.Request(url, headers={"Range": "bytes=10-19"})
            with urllib.request.urlopen(req, timeout=10) as r:
                self.assertEqual(r.status, 206)
                self.assertEqual(r.read(), _MP4[10:20])
        finally:
            proxy.stop()

    def test_proxy_full_body(self):
        provider = rs.WebDavProvider("http://127.0.0.1:%d/dav" % self.port, "u", "p")
        src = rs.RemoteSource("webdav", "/dav/Movies/a.mp4", name="a.mp4", size=64)
        proxy = rs.RemoteStreamProxy(provider, src)
        try:
            url = proxy.start()
            with urllib.request.urlopen(url, timeout=10) as r:
                self.assertEqual(r.read(), _MP4)
        finally:
            proxy.stop()


class TestRemoteSource(unittest.TestCase):
    def test_key_stable(self):
        a = rs.RemoteSource("webdav", "/dav/a.mp4")
        b = rs.RemoteSource("webdav", "/dav/a.mp4")
        self.assertEqual(a, b)
        self.assertEqual(a.key(), b.key())

    def test_name_unquote(self):
        s = rs.RemoteSource("webdav", "/dav/%E7%94%B5%E5%BD%B1/a.mp4")
        self.assertEqual(s.name, "a.mp4")


# ---------------------------------------------------------------- Jellyfin 假后端
_JF_VIDEO = b"JELLYFIN_VIDEO_DATA_" * 10
_JF_AUDIO = b"JELLYFIN_AUDIO_DATA_" * 10
_POSTER = b"\xff\xd8\xff\xe0" + b"0" * 32


class _JellyfinBackend(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path == "/Users/AuthenticateByName":
            self._json({"AccessToken": "tok", "User": {"Id": "user1", "Name": "u"}})
        else:
            self._json({"error": "not found"}, 404)

    def _serve_range(self, data, ctype):
        rng = self.headers.get("Range")
        if rng:
            m = re.match(r"bytes=(\d+)-(\d*)", rng)
            if m:
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else len(data) - 1
                part = data[start:end + 1]
                self.send_response(206)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, len(data)))
                self.send_header("Content-Length", str(len(part)))
                self.end_headers()
                self.wfile.write(part)
                return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/Users/user1/Items"):
            self._json({"Items": [
                {"Id": "lib1", "Name": "电影", "Type": "CollectionFolder", "IsFolder": True},
                {"Id": "mov1", "Name": "盗梦空间", "Type": "Movie"},
                {"Id": "mov2", "Name": "HEVC 4K 电影", "Type": "Movie"},
                {"Id": "sng1", "Name": "某首歌", "Type": "Audio"},
            ]})
            return
        if "/PlaybackInfo" in self.path:
            iid = self.path.split("/Items/")[1].split("/")[0]
            if iid == "mov2":
                ms = {"Id": "ms-mov2", "Name": "ms-mov2", "SupportsDirectPlay": False,
                      "SupportsDirectStream": False, "SupportsTranscoding": True}
            else:
                ms = {"Id": "ms-" + iid, "Name": "ms-" + iid,
                      "SupportsDirectPlay": True, "SupportsDirectStream": True}
            self._json({"MediaSources": [ms]})
            return
        if self.path.startswith("/Videos/mov1/stream"):
            self._serve_range(_JF_VIDEO, "video/mp4")
            return
        if self.path.startswith("/Videos/mov2/master.m3u8"):
            body = b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\n/videos/seg.m3u8\n"
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.apple.mpegurl")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/Audio/sng1/stream"):
            self._serve_range(_JF_AUDIO, "audio/mpeg")
            return
        if "/Images/Primary" in self.path:
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(_POSTER)))
            self.end_headers()
            self.wfile.write(_POSTER)
            return
        self._json({"error": "not found"}, 404)


class TestJellyfinProvider(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _JellyfinBackend)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def make_provider(self):
        return rs.JellyfinProvider("http://127.0.0.1:%d" % self.port, "tok", "user1")

    def test_authenticate(self):
        token, uid, dev = rs.JellyfinProvider.authenticate(
            "http://127.0.0.1:%d" % self.port, "u", "p")
        self.assertEqual((token, uid), ("tok", "user1"))
        self.assertTrue(dev.startswith("iv-"))

    def test_list_dir(self):
        entries = self.make_provider().list_dir("")
        self.assertEqual(len(entries), 4)
        by_name = {e.name: e for e in entries}
        self.assertTrue(by_name["电影"].is_dir)
        self.assertEqual(by_name["盗梦空间"].kind, "video")
        self.assertEqual(by_name["HEVC 4K 电影"].kind, "video")
        self.assertEqual(by_name["某首歌"].kind, "audio")

    def test_open_stream_video_range(self):
        p = self.make_provider()
        src = rs.RemoteSource("jellyfin", "mov1", name="盗梦空间",
                              kind="video", extra={"id": "mov1", "type": "Movie"})
        resp = p.open_stream(src, {"Range": "bytes=0-9"})
        self.assertEqual(resp.read(), _JF_VIDEO[:10])

    def test_open_stream_audio(self):
        p = self.make_provider()
        src = rs.RemoteSource("jellyfin", "sng1", name="某首歌",
                              kind="audio", extra={"id": "sng1", "type": "Audio"})
        resp = p.open_stream(src, None)
        self.assertEqual(resp.read(), _JF_AUDIO)

    def test_direct_play_url_hls(self):
        p = self.make_provider()
        src = rs.RemoteSource("jellyfin", "mov2", name="HEVC 4K 电影",
                              kind="video", extra={"id": "mov2", "type": "Movie"})
        url = p.direct_play_url(src)
        self.assertIn("/Videos/mov2/master.m3u8", url)
        self.assertIn("ApiKey=tok", url)

    def test_direct_play_url_none_for_direct(self):
        p = self.make_provider()
        src = rs.RemoteSource("jellyfin", "mov1", name="盗梦空间",
                              kind="video", extra={"id": "mov1", "type": "Movie"})
        self.assertIsNone(p.direct_play_url(src))

    def test_open_stream_requires_transcode_raises(self):
        p = self.make_provider()
        src = rs.RemoteSource("jellyfin", "mov2", name="HEVC 4K 电影",
                              kind="video", extra={"id": "mov2", "type": "Movie"})
        with self.assertRaises(RuntimeError):
            p.open_stream(src, None)

    def test_fetch_image(self):
        p = self.make_provider()
        src = rs.RemoteSource("jellyfin", "mov1", name="盗梦空间",
                              kind="video",
                              extra={"id": "mov1", "type": "Movie", "image_tag": "abc"})
        self.assertEqual(p.fetch_image(src), _POSTER)

    def test_fetch_image_none_for_audio(self):
        p = self.make_provider()
        src = rs.RemoteSource("jellyfin", "sng1", name="某首歌",
                              kind="audio", extra={"id": "sng1", "type": "Audio"})
        self.assertIsNone(p.fetch_image(src))


if __name__ == "__main__":
    unittest.main()
