# -*- coding: utf-8 -*-
"""deploy/build_iv_static.py：--out 保护 + build 号与 CRLF / LF 检出无关。"""

import contextlib
import hashlib
import importlib.util
import io
import os
import re
import tarfile
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location("build_iv_static", os.path.join(HERE, "..", "deploy", "build_iv_static.py"))
B = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(B)


def run_build(out, read=None):
    old = B.read
    if read:
        B.read = read
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            rc = B.main(["--out", out, "--no-tar"])
    finally:
        B.read = old
    return rc, buf.getvalue()


class TestOutGuard(unittest.TestCase):
    def test_refuses_repo_root_ancestors_and_source_dirs(self):
        for d in (B.ROOT, os.path.dirname(B.ROOT), os.path.join(B.ROOT, "deploy"), os.path.join(B.ROOT, "tests")):
            self.assertIsNotNone(B.refuse_reason(d), d)
        before = sorted(os.listdir(os.path.join(B.ROOT, "deploy")))
        rc, _ = run_build(os.path.join(B.ROOT, "deploy"))
        self.assertEqual(rc, 2)
        self.assertEqual(sorted(os.listdir(os.path.join(B.ROOT, "deploy"))), before)   # 什么都没删

    def test_allows_new_empty_and_own_output(self):
        with tempfile.TemporaryDirectory() as t:
            new = os.path.join(t, "new")
            empty = os.path.join(t, "empty"); os.mkdir(empty)
            for d in (new, empty):
                self.assertIsNone(B.refuse_reason(d))
                self.assertEqual(run_build(d)[0], 0)
                self.assertTrue(os.path.isfile(os.path.join(d, B.MARKER)))
            stale = os.path.join(new, "stale.txt")
            open(stale, "w").close()
            self.assertEqual(run_build(new)[0], 0)           # 自己生成的目录可以清空重建
            self.assertFalse(os.path.exists(stale))

    def test_refuses_foreign_nonempty_dir_and_file(self):
        with tempfile.TemporaryDirectory() as t:
            foreign = os.path.join(t, "foreign"); os.mkdir(foreign)
            keep = os.path.join(foreign, "keep.txt")
            open(keep, "w").close()
            self.assertEqual(run_build(foreign)[0], 2)
            self.assertTrue(os.path.exists(keep))
            f = os.path.join(t, "afile")
            open(f, "w").close()
            self.assertEqual(run_build(f)[0], 2)
            self.assertTrue(os.path.isfile(f))


class TestBuildHash(unittest.TestCase):
    def test_hash_same_for_crlf_checkout(self):
        def crlf(rel):
            data = orig(rel)
            return data if rel.endswith(".png") or rel.startswith("vendor/") else data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
        orig = B.read
        with tempfile.TemporaryDirectory() as t:
            a = run_build(os.path.join(t, "a"))
            b = run_build(os.path.join(t, "b"), read=crlf)
            self.assertEqual((a[0], b[0]), (0, 0))
            self.assertEqual(a[1].split()[1], b[1].split()[1])      # "build <hash> -> ..."
            with open(os.path.join(t, "b", "sw.js"), "rb") as f:
                self.assertNotIn(b"\r\n", f.read())


class TestVendorPdfjs(unittest.TestCase):
    """pdf.js 随包发布：原样字节、哈希随内容变、清单没被换行转换弄坏、sw.js 的缓存版本号与 vendor 一致。"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = os.path.join(cls.tmp.name, "o")
        cls.rc, cls.log = run_build(cls.out)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_vendor_copied_byte_identical(self):
        self.assertEqual(self.rc, 0)
        files = B.vendor_files()
        self.assertTrue(any(f.endswith("/pdf.min.js") for f in files))
        self.assertTrue(any("/cmaps/" in f and f.endswith(".bcmap") for f in files))
        self.assertTrue(any("/standard_fonts/" in f and f.endswith(".pfb") for f in files))
        self.assertFalse(any(f.endswith(("README.md", "SHA256SUMS")) for f in files))
        for f in files:
            with open(os.path.join(B.ROOT, *f.split("/")), "rb") as a, open(os.path.join(self.out, *f.split("/")), "rb") as b:
                self.assertEqual(a.read(), b.read(), f)

    def test_vendor_matches_sha256sums(self):
        base = os.path.join(B.ROOT, "vendor", "pdfjs")
        want = {}
        with open(os.path.join(base, "SHA256SUMS"), encoding="utf-8") as f:
            for line in f.read().splitlines():
                m = re.match(r"^([0-9a-f]{64}) [ *](.+)$", line)
                self.assertTrue(m, line)
                want[m.group(2)] = m.group(1)
        got = {f[len("vendor/pdfjs/"):] for f in B.vendor_files()}
        self.assertEqual(got, set(want))                       # 清单与目录一一对应：没有多出来 / 少掉的文件
        for rel, h in want.items():
            with open(os.path.join(base, *rel.split("/")), "rb") as f:
                self.assertEqual(hashlib.sha256(f.read()).hexdigest(), h, rel)   # 被换行转换 / 手滑改过就会在这里报

    def test_licence_headers_kept(self):
        for n in ("pdf.min.js", "pdf.worker.min.js"):
            with open(os.path.join(B.ROOT, "vendor", "pdfjs", n), "rb") as f:
                head = f.read(2000)
            self.assertIn(b"@licstart", head)
            self.assertIn(b"Mozilla Foundation", head)
            self.assertIn(b"Apache License", head)
        self.assertTrue(os.path.isfile(os.path.join(B.ROOT, "vendor", "pdfjs", "LICENSE.pdfjs")))

    def test_legacy_build_carries_withresolvers_polyfill(self):
        for n in ("pdf.min.js", "pdf.worker.min.js"):
            with open(os.path.join(B.ROOT, "vendor", "pdfjs", n), "rb") as f:
                self.assertIn(b'target:"Promise",stat:!0},{withResolvers:function withResolvers', f.read(), n)

    def test_build_hash_changes_with_vendor_bytes_and_ignores_crlf_checkout(self):
        orig = B.read
        def tweak(rel):
            d = orig(rel)
            return d + b" " if rel == "vendor/pdfjs/pdf.worker.min.js" else d
        with tempfile.TemporaryDirectory() as t:
            base = run_build(os.path.join(t, "a"))[1].split()[1]
            changed = run_build(os.path.join(t, "b"), read=tweak)[1].split()[1]
        self.assertEqual(base, self.log.split()[1])
        self.assertNotEqual(base, changed)

    def test_tar_has_vendor_paths_and_sw_placeholder_replaced(self):
        with tempfile.TemporaryDirectory() as t:
            out = os.path.join(t, "o")
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                self.assertEqual(B.main(["--out", out]), 0)
            with tarfile.open(out + ".tgz") as tf:
                names = set(tf.getnames())
            self.assertIn("vendor/pdfjs/pdf.worker.min.js", names)
            self.assertIn("vendor/pdfjs/cmaps/UniGB-UCS2-H.bcmap", names)
            self.assertNotIn(B.MARKER, names)
            self.assertNotIn("vendor/pdfjs/SHA256SUMS", names)
            with open(os.path.join(out, "sw.js"), encoding="utf-8") as f:
                sw = f.read()
        self.assertNotIn("__BUILD__", sw)
        m = re.search(r"PDFJS_VER = '([0-9.]+)'", sw)
        self.assertTrue(m)
        with open(os.path.join(B.ROOT, "vendor", "pdfjs", "README.md"), encoding="utf-8") as f:
            self.assertIn("pdfjs-dist@" + m.group(1), f.read())     # 升级 pdf.js 时 sw.js 的缓存名一起改

    def test_missing_vendor_is_an_error(self):
        old = B.vendor_files
        B.vendor_files = lambda: []
        try:
            with tempfile.TemporaryDirectory() as t:
                self.assertEqual(run_build(os.path.join(t, "o"))[0], 2)
        finally:
            B.vendor_files = old


class TestVendorLibarchive(unittest.TestCase):
    """libarchive.js（rar / 7z / tar 的 WASM 解压）随包发布：原样字节、清单一致、sw.js 的缓存版本与 vendor 一致、缺文件报错。"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = os.path.join(cls.tmp.name, "o")
        cls.rc, cls.log = run_build(cls.out)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_copied_byte_identical_and_no_readme_or_sums(self):
        self.assertEqual(self.rc, 0)
        files = B.libarchive_files()
        for need in ("libarchive.js", "worker-bundle.js", "libarchive.wasm", "LICENSE.libarchive-js"):
            self.assertIn("vendor/libarchive/" + need, files)
        self.assertFalse(any(f.endswith(("README.md", "SHA256SUMS")) for f in files))
        for f in files:
            with open(os.path.join(B.ROOT, *f.split("/")), "rb") as a, open(os.path.join(self.out, *f.split("/")), "rb") as b:
                self.assertEqual(a.read(), b.read(), f)
        self.assertIn("vendor/libarchive:", self.log)

    def test_matches_sha256sums(self):
        base = os.path.join(B.ROOT, "vendor", "libarchive")
        want = {}
        with open(os.path.join(base, "SHA256SUMS"), encoding="utf-8") as f:
            for line in f.read().splitlines():
                m = re.match(r"^([0-9a-f]{64}) [ *](.+)$", line)
                self.assertTrue(m, line)
                want[m.group(2)] = m.group(1)
        self.assertEqual({f[len("vendor/libarchive/"):] for f in B.libarchive_files()}, set(want))
        for rel, h in want.items():
            with open(os.path.join(base, *rel.split("/")), "rb") as f:
                self.assertEqual(hashlib.sha256(f.read()).hexdigest(), h, rel)

    def test_wasm_is_a_wasm_and_worker_locates_it_next_to_itself(self):
        base = os.path.join(B.ROOT, "vendor", "libarchive")
        with open(os.path.join(base, "libarchive.wasm"), "rb") as f:
            self.assertEqual(f.read(8), b"\x00asm\x01\x00\x00\x00")
        with open(os.path.join(base, "worker-bundle.js"), "rb") as f:
            self.assertIn(b'new URL("libarchive.wasm",import.meta.url)', f.read())     # wasm 与 worker 同目录，不需要改 locateFile

    def test_sw_version_matches_readme_and_cleanup_is_prefix_scoped(self):
        with open(os.path.join(self.out, "sw.js"), encoding="utf-8") as f:
            sw = f.read()
        m = re.search(r"LIBARCHIVE_VER = '([0-9.]+)'", sw)
        self.assertTrue(m)
        with open(os.path.join(B.ROOT, "vendor", "libarchive", "README.md"), encoding="utf-8") as f:
            self.assertIn("libarchive.js@" + m.group(1), f.read())
        self.assertIn("'iv-vendor-libarchive-' + LIBARCHIVE_VER", sw)
        # 清理旧缓存只动 iv- 前缀，并且保留三个名字：外壳 / pdf.js / libarchive
        self.assertIn("k.startsWith('iv-') && k !== CACHE && k !== VENDOR_CACHE && k !== LIBARCHIVE_CACHE", sw)
        self.assertIn("vendor/libarchive/", sw)

    def test_tar_has_libarchive_paths(self):
        with tempfile.TemporaryDirectory() as t:
            out = os.path.join(t, "o")
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(B.main(["--out", out]), 0)
            with tarfile.open(out + ".tgz") as tf:
                names = set(tf.getnames())
        self.assertIn("vendor/libarchive/libarchive.wasm", names)
        self.assertIn("vendor/libarchive/worker-bundle.js", names)
        self.assertNotIn("vendor/libarchive/SHA256SUMS", names)

    def test_build_hash_changes_with_wasm_bytes(self):
        orig = B.read
        def tweak(rel):
            d = orig(rel)
            return d + b"\x00" if rel == "vendor/libarchive/libarchive.wasm" else d
        with tempfile.TemporaryDirectory() as t:
            changed = run_build(os.path.join(t, "b"), read=tweak)[1].split()[1]
        self.assertNotEqual(self.log.split()[1], changed)

    def test_missing_libarchive_is_an_error(self):
        old = B.libarchive_files
        B.libarchive_files = lambda: []
        try:
            with tempfile.TemporaryDirectory() as t:
                self.assertEqual(run_build(os.path.join(t, "o"))[0], 2)
        finally:
            B.libarchive_files = old

    def test_csp_snippet_allows_wasm_only_in_the_iv_block(self):
        with open(os.path.join(B.ROOT, "deploy", "Caddyfile.iv.snippet"), encoding="utf-8") as f:
            snip = f.read()
        csp = re.search(r'header Content-Security-Policy "([^"]+)"', snip).group(1)
        self.assertIn("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'", csp)
        self.assertNotIn("'unsafe-eval'", csp.replace("'wasm-unsafe-eval'", ""))              # 只放行 wasm，不放行 JS eval
        self.assertEqual(snip.count("header Content-Security-Policy"), 1)                # /iv/* 块里唯一的一条 CSP header


if __name__ == "__main__":
    unittest.main()
