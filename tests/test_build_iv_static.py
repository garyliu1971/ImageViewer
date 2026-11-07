# -*- coding: utf-8 -*-
"""deploy/build_iv_static.py：--out 保护 + build 号与 CRLF / LF 检出无关。"""

import contextlib
import importlib.util
import io
import os
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
            return data if rel.endswith(".png") else data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
        orig = B.read
        with tempfile.TemporaryDirectory() as t:
            a = run_build(os.path.join(t, "a"))
            b = run_build(os.path.join(t, "b"), read=crlf)
            self.assertEqual((a[0], b[0]), (0, 0))
            self.assertEqual(a[1].split()[1], b[1].split()[1])      # "build <hash> -> ..."
            with open(os.path.join(t, "b", "sw.js"), "rb") as f:
                self.assertNotIn(b"\r\n", f.read())


if __name__ == "__main__":
    unittest.main()
