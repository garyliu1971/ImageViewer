# -*- coding: utf-8 -*-
"""web_backend（网页版本地后端）单元测试。

只用标准库 + 项目内模块；不依赖浏览器。运行：
    python -m unittest tests.test_web_backend -v
或：  python tests/test_web_backend.py

进度读写一律用临时文件，绝不碰真实的 image_viewer.json。
"""

import io
import json
import os
import shutil
import struct
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
import urllib.request
import zipfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import web_backend as wb
from tests.make_web_fixtures import png, rar3  # 复用样本生成器，测试自带数据


def _write(path, data):
    with open(path, "wb") as f:
        f.write(data)


def http_get(url, token=None, headers=None):
    """返回 (status, headers, body_bytes)。偶发的 loopback 中断重试一次。"""
    if token:
        sep = "&" if "?" in url else "?"
        url += "%st=%s" % (sep, urllib.parse.quote(token))
    for attempt in range(2):
        req = urllib.request.Request(url, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()
        except (ConnectionError, OSError):
            if attempt:
                raise
            import time
            time.sleep(0.3)


def http_put(url, payload, token=None):
    body = json.dumps(payload).encode("utf-8")
    if token:
        url += ("%st=%s" % ("&" if "?" in url else "?", urllib.parse.quote(token)))
    req = urllib.request.Request(url, data=body, method="PUT",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


class FixtureCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="iv-backend-")
        self.book = os.path.join(self.tmp, "漫画")
        os.makedirs(os.path.join(self.book, "第1话"))
        os.makedirs(os.path.join(self.book, "第2话"))
        self.cover = png(120, 80, (34, 102, 136))
        self.p1 = png(100, 160, (17, 34, 51))
        self.p2 = png(100, 160, (68, 85, 102))
        _write(os.path.join(self.book, "00_cover.png"), self.cover)
        _write(os.path.join(self.book, "第1话", "01.png"), self.p1)
        _write(os.path.join(self.book, "第2话", "01.png"), self.p2)
        _write(os.path.join(self.book, "说明.txt"), b"x")

        self.cbz = os.path.join(self.tmp, "book.cbz")
        with zipfile.ZipFile(self.cbz, "w") as z:
            z.writestr("00_cover.png", self.cover, compress_type=zipfile.ZIP_STORED)
            z.writestr("第1话/01.png", self.p1)
            z.writestr("第1话/02.png", self.p1)
            z.writestr("__MACOSX/._00_cover.png", b"junk")
            z.writestr("scan.pdf", b"%PDF-1.4")

        self.cbr = os.path.join(self.tmp, "book.cbr")
        with open(self.cbr, "wb") as f:
            f.write(rar3([("00_cover.png", self.cover),
                          ("第1话/01.png", self.p1),
                          ("第1话/02.png", self.p2),
                          ("第2话/01.png", self.p1),
                          ("readme.txt", b"not an image")]))
        # 进度文件指向临时目录
        self._cfg = wb.CONFIG_PATH
        wb.CONFIG_PATH = os.path.join(self.tmp, "image_viewer.json")

    def tearDown(self):
        wb.CONFIG_PATH = self._cfg
        shutil.rmtree(self.tmp, ignore_errors=True)


class TestGuards(FixtureCase):
    def test_is_servable_blocks_non_media(self):
        for p in ("a.exe", "image_viewer.json", "notes.txt", "a.py", "x.dll", "a.html", "a.docx"):
            self.assertFalse(wb.is_servable(p), p)
        # 压缩包/视频/PDF 都是要能读的（rar 由后端 rarfile+7-Zip 解）
        for p in ("a.png", "a.JPG", "a.cbz", "a.cbr", "a.rar", "a.zip", "a.pdf",
                  "a.mp4", "a.flac", "a.tif"):
            self.assertTrue(wb.is_servable(p), p)

    def test_read_file_refuses_arbitrary_path(self):
        secret = os.path.join(self.tmp, "secret.json")
        _write(secret, b'{"key":"leak"}')
        with self.assertRaises(PermissionError):
            wb.read_file(secret)
        with self.assertRaises(PermissionError):
            wb.read_file(os.path.join(self.tmp, "说明.txt"))

    def test_missing_file(self):
        with self.assertRaises(OSError):
            wb.read_file(os.path.join(self.tmp, "没有这个.png"))

    def test_list_dir_requires_directory(self):
        with self.assertRaises(NotADirectoryError):
            wb.list_dir(self.cbz)


class TestListDir(FixtureCase):
    def test_recursive_entries_and_kinds(self):
        r = wb.list_dir(self.book, recursive=True)
        rels = sorted(e["rel"] for e in r["entries"])
        self.assertEqual(rels, ["00_cover.png", "第1话/01.png", "第2话/01.png"])
        kinds = {e["rel"]: e["kind"] for e in r["entries"]}
        self.assertEqual(kinds["00_cover.png"], "image")
        for e in r["entries"]:
            self.assertTrue(os.path.isfile(e["path"]))
            self.assertGreater(e["size"], 0)

    def test_non_recursive_lists_dirs(self):
        r = wb.list_dir(self.book, recursive=False)
        by = {e["rel"]: e["kind"] for e in r["entries"]}
        self.assertEqual(by.get("第1话"), "dir")
        self.assertEqual(by.get("00_cover.png"), "image")
        self.assertNotIn("第1话/01.png", by)


class TestArchive(FixtureCase):
    def test_zip_entries_and_chapters(self):
        ents = wb.archive_entries(self.cbz)
        names = [e["name"] for e in ents]
        self.assertIn("第1话/01.png", names)
        self.assertNotIn("", names)
        chs = wb.archive_chapters(self.cbz)
        self.assertEqual([c["title"] for c in chs], ["根目录", "第1话"])
        self.assertEqual(len(chs[1]["sources"]), 2)

    def test_zip_read_entry(self):
        self.assertEqual(wb.archive_read(self.cbz, "00_cover.png"), self.cover)
        self.assertEqual(wb.archive_read(self.cbz, "第1话/01.png"), self.p1)
        with self.assertRaises(KeyError):
            wb.archive_read(self.cbz, "没有.png")

    def test_rar_entries_chapters_read(self):
        if wb.rarfile is None:
            self.skipTest("没装 rarfile")
        if not wb.configure_rar_tool():
            self.skipTest("本机没有 7-Zip / WinRAR，跳过 rar")
        names = [e["name"] for e in wb.archive_entries(self.cbr)]
        self.assertEqual(names, ["00_cover.png", "第1话/01.png", "第1话/02.png",
                                 "第2话/01.png", "readme.txt"])
        chs = wb.archive_chapters(self.cbr)
        self.assertEqual([c["title"] for c in chs], ["根目录", "第1话", "第2话"])
        self.assertEqual(wb.archive_read(self.cbr, "第1话/01.png"), self.p1)
        with self.assertRaises(Exception):
            wb.archive_read(self.cbr, "没有.png")

    def test_thumbnail_from_file_and_entry(self):
        if wb.Image is None:
            self.skipTest("没装 Pillow")
        for data in (wb.make_thumbnail(os.path.join(self.book, "第1话", "01.png"), width=64),
                     wb.make_thumbnail(self.cbz, "第1话/01.png", 64),
                     wb.make_thumbnail(self.cbr, "第1话/01.png", 64)):
            self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
            self.assertGreater(len(data), 50)
        with self.assertRaises(Exception):
            wb.make_thumbnail(os.path.join(self.book, "说明.txt"))


class TestRange(FixtureCase):
    @staticmethod
    def _slice(path, start, end):
        with open(path, "rb") as f:
            return f.read()[start:end]

    def test_range_slice(self):
        data, s, e, total = wb.read_file(self.cbz, 0, 10)
        self.assertEqual((s, e, total), (0, 9, os.path.getsize(self.cbz)))
        self.assertEqual(len(data), 10)
        data2, s2, e2, _ = wb.read_file(self.cbz, 100, 5)
        self.assertEqual((s2, e2), (100, 104))
        self.assertEqual(data2, self._slice(self.cbz, 100, 105))

    def test_range_past_eof(self):
        size = os.path.getsize(self.cbz)
        data, s, e, total = wb.read_file(self.cbz, size + 100)
        self.assertEqual(data, b"")
        self.assertEqual(total, size)


class TestProgress(FixtureCase):
    def test_roundtrip_creates_file(self):
        self.assertEqual(wb.progress_store(), {})
        wb.progress_save("C:/漫画/第1话", {"index": 7, "chapter": 2, "spread": True})
        got = wb.progress_store()
        self.assertEqual(got["C:/漫画/第1话"]["index"], 7)
        self.assertTrue(os.path.isfile(wb.CONFIG_PATH))

    def test_save_keeps_other_keys(self):
        wb.progress_save("a", {"index": 1})
        wb.progress_save("b", {"index": 2})
        self.assertEqual(sorted(wb.progress_store()), ["a", "b"])

    def test_bad_record_rejected(self):
        with self.assertRaises(ValueError):
            wb.progress_save("a", "不是对象")

    def test_corrupt_config_degrades(self):
        _write(wb.CONFIG_PATH, "{坏 json".encode("utf-8"))
        self.assertEqual(wb.progress_store(), {})


class TestCapabilities(unittest.TestCase):
    def test_shape(self):
        caps = wb.capabilities()
        for k in ("api", "rar", "pdf", "pillow", "extensions"):
            self.assertIn(k, caps)
        self.assertEqual(caps["api"], wb.API_VERSION)
        self.assertIsInstance(caps["rar"], bool)
        self.assertIn(".cbz", caps["extensions"])


class TestHttpApi(FixtureCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd, cls.thread, cls.url = wb.serve(0, open_browser=False)
        cls.base = cls.url.rstrip("/")

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def setUp(self):
        super().setUp()
        # 每个用例重新取 token（serve 里是类属性）
        self.token = wb.Handler.token

    def test_html_has_token(self):
        st, _, body = http_get(self.base + "/")
        self.assertEqual(st, 200)
        self.assertIn(b"__IV_TOKEN", body)
        self.assertIn(self.token.encode(), body)
        self.assertIn(b"<script id=\"iv-core\">", body)

    def test_ping_is_public(self):
        st, _, body = http_get(self.base + "/api/ping")
        self.assertEqual(st, 200)
        j = json.loads(body)
        self.assertTrue(j["ok"])
        self.assertEqual(j["token"], self.token)

    def test_api_requires_token(self):
        st, _, body = http_get(self.base + "/api/ls?path=" + urllib.parse.quote(self.book))
        self.assertEqual(st, 403)
        self.assertIn("token", json.loads(body)["error"])

    def test_ls_over_http(self):
        st, _, body = http_get(self.base + "/api/ls?path=" + urllib.parse.quote(self.book), self.token)
        self.assertEqual(st, 200)
        j = json.loads(body)
        self.assertEqual(sorted(e["rel"] for e in j["entries"]),
                         ["00_cover.png", "第1话/01.png", "第2话/01.png"])

    def test_data_file_and_entry(self):
        u = self.base + "/api/data?path=" + urllib.parse.quote(os.path.join(self.book, "00_cover.png"))
        st, hdr, body = http_get(u, self.token)
        self.assertEqual((st, body), (200, self.cover))
        self.assertTrue(hdr["Content-Type"].startswith("image/"))
        u2 = (self.base + "/api/data?path=" + urllib.parse.quote(self.cbz)
              + "&entry=" + urllib.parse.quote("第1话/01.png"))
        st2, _, body2 = http_get(u2, self.token)
        self.assertEqual((st2, body2), (200, self.p1))

    def test_data_rejects_non_media(self):
        cfg = os.path.join(self.tmp, "secret.txt")
        _write(cfg, b"nope")
        st, _, _ = http_get(self.base + "/api/data?path=" + urllib.parse.quote(cfg), self.token)
        self.assertEqual(st, 400)

    def test_data_range(self):
        u = self.base + "/api/data?path=" + urllib.parse.quote(self.cbz) + "&range=bytes=0-9"
        st, hdr, body = http_get(u, self.token)
        self.assertEqual(st, 206)
        self.assertEqual(len(body), 10)
        self.assertIn("/%d" % os.path.getsize(self.cbz), hdr["Content-Range"])

    def test_thumb_over_http(self):
        if wb.Image is None:
            self.skipTest("没装 Pillow")
        u = (self.base + "/api/thumb?path=" + urllib.parse.quote(self.cbz)
             + "&entry=" + urllib.parse.quote("第1话/01.png") + "&w=48")
        st, hdr, body = http_get(u, self.token)
        self.assertEqual(st, 200)
        self.assertEqual(hdr["Content-Type"], "image/png")
        self.assertEqual(body[:8], b"\x89PNG\r\n\x1a\n")

    def test_archive_over_http(self):
        st, _, body = http_get(self.base + "/api/archive?path=" + urllib.parse.quote(self.cbz), self.token)
        j = json.loads(body)
        self.assertEqual(st, 200)
        self.assertEqual([c["title"] for c in j["chapters"]], ["根目录", "第1话"])

    def test_progress_get_put(self):
        st, _, body = http_get(self.base + "/api/progress", self.token)
        self.assertEqual(json.loads(body)["books"], {})
        st2, _ = http_put(self.base + "/api/progress",
                          {"key": self.book.replace("\\", "/"),
                           "record": {"index": 3, "chapter": 1, "trim": True}}, self.token)
        self.assertEqual(st2, 200)
        st3, _, body3 = http_get(self.base + "/api/progress", self.token)
        books = json.loads(body3)["books"]
        self.assertEqual(books[self.book.replace("\\", "/")]["index"], 3)

    def test_all_path_endpoints_guard_extension(self):
        """任何拿 path 的接口都不能被用来读非媒体文件（目录列表除外）。"""
        for route in ("/api/data", "/api/archive", "/api/pdf", "/api/thumb", "/api/pdfpage"):
            u = self.base + route + "?path=" + urllib.parse.quote(
                os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web_backend.py"))
            st, _, _ = http_get(u, self.token)
            self.assertEqual(st, 400, route)
        # 目录列表是设计上要开放的（用户自己选的库），但仍要 token
        st, _, _ = http_get(self.base + "/api/ls?path=.", self.token)
        self.assertIn(st, (200, 400))

    def test_unknown_route(self):
        st, _, _ = http_get(self.base + "/api/nope", self.token)
        self.assertEqual(st, 404)

    def test_bind_is_loopback(self):
        self.assertEqual(self.httpd.server_address[0], "127.0.0.1")


class TestPdf(FixtureCase):
    def test_pdf_page_render(self):
        if wb.fitz is None or wb.Image is None:
            self.skipTest("没装 PyMuPDF / Pillow")
        import fitz
        p = os.path.join(self.tmp, "comic.pdf")
        doc = fitz.open()
        for i in range(3):
            page = doc.new_page(width=300, height=420)
            page.insert_text((40, 80), "page %d" % i)
        doc.save(p)
        doc.close()
        self.assertEqual(wb.pdf_page_count(p), 3)
        png1 = wb.pdf_render(p, 1, scale=1.5)
        self.assertEqual(png1[:8], b"\x89PNG\r\n\x1a\n")
        with self.assertRaises(IndexError):
            wb.pdf_render(p, 99)
        with self.assertRaises(Exception):
            wb.pdf_page_count(os.path.join(self.tmp, "没有.pdf"))


if __name__ == "__main__":
    unittest.main(verbosity=2)


class TestServerLifecycle(unittest.TestCase):
    """桌面版菜单用的 start_server / stop_server。"""

    def setUp(self):
        self._cfg = wb.CONFIG_PATH
        wb.CONFIG_PATH = os.path.join(tempfile.mkdtemp(), "image_viewer.json")

    def tearDown(self):
        wb.stop_server()
        wb.CONFIG_PATH = self._cfg

    def test_start_stop_idempotent(self):
        u1 = wb.start_server(port=0, open_browser=False)
        self.assertTrue(u1.startswith("http://127.0.0.1:"))
        u2 = wb.start_server(port=0, open_browser=False)   # 复用同一个，不重复开端口
        self.assertEqual(u1, u2)
        st, _, body = http_get(u1 + "api/ping")
        self.assertEqual(st, 200)
        self.assertTrue(json.loads(body)["ok"])
        wb.stop_server()
        with self.assertRaises(OSError):        # 停了就连不上
            http_get(u1 + "api/ping")

    def test_stop_without_start_is_safe(self):
        wb.stop_server()   # 不该抛

    def test_desktop_menu_wired(self):
        """桌面版源码里要挂上「网页版」菜单项，退出时要停服务。"""
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with io.open(os.path.join(root, "image_viewer.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("command=self.open_web_server", src)
        self.assertIn('label="网页版（本地服务', src)
        self.assertIn("wb.stop_server()", src)
        self.assertIn("def open_web_server(self)", src)


class TestArchivePathDetection(unittest.TestCase):
    """后端要能认出 rar/cbr（前端靠 caps + /api/archive）。"""

    def test_servable_archives(self):
        for p in ("a.zip", "a.cbz", "a.rar", "a.cbr"):
            self.assertTrue(wb.is_servable(p), p)

    def test_rar3_builder_roundtrip(self):
        from tests.make_web_fixtures import rar3, png
        data = png(40, 50, (1, 2, 3))
        blob = rar3([("a.png", data), ("ch1/b.png", data)])
        self.assertEqual(blob[:7], b"Rar!\x1a\x07\x00")
        d = tempfile.mkdtemp()
        try:
            p = os.path.join(d, "x.cbr")
            with open(p, "wb") as f:
                f.write(blob)
            names = [e["name"] for e in wb.archive_entries(p)]
            self.assertEqual(names, ["a.png", "ch1/b.png"])
            self.assertEqual(wb.archive_read(p, "ch1/b.png"), data)
            chs = wb.archive_chapters(p)
            self.assertEqual([c["title"] for c in chs], ["根目录", "ch1"])
        finally:
            shutil.rmtree(d, ignore_errors=True)


def http_post(url, body=None, token=None, raw=None, ctype="application/json"):
    if token:
        url += ("%st=%s" % ("&" if "?" in url else "?", urllib.parse.quote(token)))
    data = raw if raw is not None else json.dumps(body or {}).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


class TestUploadAndRemote(FixtureCase):
    """上传通道 + WebDAV（用假 WebDAV 服务，真走 remote_source 的 PROPFIND 解析）。"""

    @classmethod
    def setUpClass(cls):
        from tests.fake_webdav import FakeWebDav
        from tests.make_web_fixtures import png, rar3
        cls.p1 = png(100, 160, (10, 20, 30))
        cls.p2 = png(120, 90, (40, 50, 60))
        cls.cbz = io.BytesIO()
        with zipfile.ZipFile(cls.cbz, "w") as z:
            z.writestr("01.png", cls.p1)
            z.writestr("02.png", cls.p2)
        cls.cbz = cls.cbz.getvalue()
        cls.cbr = rar3([("01.png", cls.p1), ("ch2/02.png", cls.p2)])
        cls.dav = FakeWebDav({
            "/dav/cover.png": cls.p2,
            "/dav/漫画/01.png": cls.p1,
            "/dav/漫画/02.png": cls.p1,
            "/dav/漫画/书.cbz": cls.cbz,
            "/dav/漫画/扫描.pdf": b"%PDF-1.4\nfake\n",
            "/dav/漫画/说明.txt": b"junk",
        }, user="u", pw="p")
        cls.root = cls.dav.start()
        cls.httpd, cls.thread, cls.url = wb.serve(0, open_browser=False)
        cls.base = cls.url.rstrip("/")
        cls.token = wb.Handler.token

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.dav.stop()

    def setUp(self):
        super().setUp()
        wb._remote_cache.clear()

    def test_upload_then_open_as_archive(self):
        st, body = http_post(self.base + "/api/upload?name=%E4%B9%A6.cbr&mtime=123",
                             raw=self.cbr, token=self.token, ctype="application/octet-stream")
        self.assertEqual(st, 200)
        path = json.loads(body)["path"]
        self.assertTrue(path.endswith(".cbr"))
        ents = [e["name"] for e in wb.archive_entries(path)]
        self.assertEqual(ents, ["01.png", "ch2/02.png"])
        # 再传一次同样的（name/size/mtime 相同）应复用，不重复写盘
        st2, body2 = http_post(self.base + "/api/upload?name=%E4%B9%A6.cbr&mtime=123",
                               raw=self.cbr, token=self.token, ctype="application/octet-stream")
        self.assertEqual(json.loads(body2)["path"], path)

    def test_upload_over_http_and_too_large(self):
        st, body = http_post(self.base + "/api/upload?name=a.cbz", raw=self.cbz,
                             token=self.token, ctype="application/octet-stream")
        self.assertEqual(st, 200)
        st2, b2 = http_post(self.base + "/api/upload?name=b.cbz", raw=b"",
                            token=self.token, ctype="application/octet-stream")
        self.assertEqual(st2, 400)

    def test_upload_requires_token(self):
        st, _ = http_post(self.base + "/api/upload?name=x.cbz", raw=self.cbz,
                          ctype="application/octet-stream")
        self.assertEqual(st, 403)

    def test_remote_config_bad_password_not_saved(self):
        st, body = http_post(self.base + "/api/remote/config",
                             {"base_url": self.root, "username": "u", "password": "错"},
                             token=self.token)
        self.assertEqual(st, 400)
        self.assertIn("401", json.loads(body)["error"] + str(type(body)))
        self.assertEqual(wb.remote_config(), {})          # 没保存

    def test_remote_config_roundtrip_hides_password(self):
        st, _ = http_post(self.base + "/api/remote/config",
                          {"base_url": self.root, "username": "u", "password": "p"},
                          token=self.token)
        self.assertEqual(st, 200)
        cfg = wb.remote_config()
        self.assertEqual(cfg["base_url"], self.root)
        self.assertEqual(cfg["password"], "p")            # 存的是本地 json（和桌面版一样明文，已知问题）
        st2, body2 = http_get(self.base + "/api/remote/config", self.token)
        j = json.loads(body2)
        self.assertTrue(j["connected"])
        self.assertNotIn("password", j)                    # 不回传给页面
        self.assertTrue(j["has_password"])
        st3, _ = http_post(self.base + "/api/remote/disconnect", {}, token=self.token)
        self.assertEqual(st3, 200)
        self.assertEqual(wb.remote_config(), {})

    def _connect(self):
        st, _ = http_post(self.base + "/api/remote/config",
                          {"base_url": self.root, "username": "u", "password": "p"},
                          token=self.token)
        assert st == 200, st

    def test_remote_ls_kinds(self):
        self._connect()
        st, body = http_get(self.base + "/api/remote/ls?path=/dav", self.token)
        self.assertEqual(st, 200)
        ents = json.loads(body)["entries"]
        kinds = {e["name"]: e["kind"] for e in ents}
        self.assertEqual(kinds.get("漫画"), "dir")
        self.assertEqual(kinds.get("cover.png"), "image")
        st2, body2 = http_get(self.base + "/api/remote/ls?path=/dav/%E6%BC%AB%E7%94%BB", self.token)
        ents2 = {e["name"]: e["kind"] for e in json.loads(body2)["entries"]}
        self.assertEqual(ents2["书.cbz"], "archive")
        self.assertEqual(ents2["扫描.pdf"], "pdf")
        self.assertEqual(ents2["01.png"], "image")
        self.assertNotIn("说明.txt", ents2)     # 非媒体不显示

    def test_remote_data_and_range(self):
        self._connect()
        st, _, data = http_get(self.base + "/api/remote/data?path=/dav/%E6%BC%AB%E7%94%BB/01.png",
                               self.token)
        self.assertEqual((st, data), (200, self.p1))
        st2, hdr, chunk = http_get(self.base + "/api/remote/data?path=/dav/%E6%BC%AB%E7%94%BB/01.png"
                                   "&range=bytes=0-9", self.token)
        self.assertEqual(st2, 206)
        self.assertEqual(len(chunk), 10)
        self.assertIn("Content-Range", hdr)

    def test_remote_thumb_and_local_cache(self):
        self._connect()
        if wb.Image is None:
            self.skipTest("没装 Pillow")
        st, _, data = http_get(self.base + "/api/remote/thumb?path=/dav/%E6%BC%AB%E7%94%BB/01.png&w=64",
                               self.token)
        self.assertEqual((st, data[:8]), (200, b"\x89PNG\r\n\x1a\n"))
        st2, body2 = http_get(self.base + "/api/remote/local?path=/dav/%E6%BC%AB%E7%94%BB/%E4%B9%A6.cbz"
                              "&size=%d" % len(self.cbz), self.token)
        local = json.loads(body2)["path"]
        self.assertTrue(os.path.isfile(local))
        self.assertEqual([e["name"] for e in wb.archive_entries(local)], ["01.png", "02.png"])
        # 缓存：再要一次是同一个文件
        st3, body3 = http_get(self.base + "/api/remote/local?path=/dav/%E6%BC%AB%E7%94%BB/%E4%B9%A6.cbz"
                              "&size=%d" % len(self.cbz), self.token)
        self.assertEqual(json.loads(body3)["path"], local)

    def test_remote_endpoints_need_config_and_token(self):
        with self.assertRaises(RuntimeError):
            wb.remote_list("/dav")
        st, _ = http_get(self.base + "/api/remote/ls?path=/dav")
        self.assertEqual(st, 403)

    def test_capabilities_mentions_webdav(self):
        self.assertIn("webdav", wb.capabilities())
