# -*- coding: utf-8 -*-
"""media_source 纯逻辑单元测试。"""

import os
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import media_source as ms


def _page_count(path):
    """伪造的 PDF 页数函数：根据文件名数字决定页数。"""
    base = os.path.basename(path)
    if base.startswith("book3"):
        return 3
    return 1


class TestMediaFilesIn(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        # 结构：root/ a.txt, 1.jpg, 2.jpg, 10.jpg, b.pdf, sub/ 3.jpg, sub2/4.png
        for name in ("1.jpg", "2.jpg", "10.jpg", "a.txt", "b.pdf"):
            open(os.path.join(self.dir, name), "w").close()
        os.makedirs(os.path.join(self.dir, "sub"))
        open(os.path.join(self.dir, "sub", "3.jpg"), "w").close()
        os.makedirs(os.path.join(self.dir, "sub2"))
        open(os.path.join(self.dir, "sub2", "4.png"), "w").close()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_filters_and_natural_sorts(self):
        # 只收媒体（含子目录），相对路径自然排序
        files = ms.media_files_in(self.dir)
        names = [os.path.relpath(f, self.dir) for f in files]
        self.assertIn("1.jpg", names)
        self.assertIn("2.jpg", names)
        self.assertIn("10.jpg", names)
        self.assertIn(os.path.join("sub", "3.jpg"), names)
        self.assertIn("b.pdf", names)
        self.assertNotIn("a.txt", names)
        # 自然排序：2.jpg 在 10.jpg 之前
        self.assertLess(names.index("2.jpg"), names.index("10.jpg"))

    def test_custom_exts(self):
        files = ms.media_files_in(self.dir, exts={".txt"})
        names = [os.path.relpath(f, self.dir) for f in files]
        self.assertEqual(names, ["a.txt"])


class TestJunkFilter(unittest.TestCase):
    """打包工具元数据不该变成一页 / 一个章节（桌面版和网页版共用这段逻辑）。"""

    def test_is_junk(self):
        for n in ("__MACOSX/._1.jpg", ".DS_Store", "sub/.hidden.jpg", "Thumbs.db",
                  "desktop.ini", ""):
            self.assertTrue(ms.is_junk(n), n)
        for n in ("1.jpg", "sub/2.png", "a.b.c.jpg", "第1话/01.png"):
            self.assertFalse(ms.is_junk(n), n)
        self.assertTrue(ms.is_junk("__macosx\._1.jpg"))   # 反斜杠也认

    def test_zip_chapters_skip_macosx(self):
        names = ["1.jpg", "__MACOSX/._1.jpg", ".DS_Store", "ch2/2.jpg", "ch2/Thumbs.db"]
        chs = ms.build_zip_chapters("/x.cbz", names)
        self.assertEqual([c["title"] for c in chs], ["根目录", "ch2"])
        self.assertEqual([n for _, n in chs[0]["sources"]], ["1.jpg"])

    def test_media_files_in_skips_junk(self):
        d = tempfile.mkdtemp()
        try:
            for n in ("1.jpg", "2.jpg"):
                open(os.path.join(d, n), "w").close()
            os.makedirs(os.path.join(d, "__MACOSX"))
            open(os.path.join(d, "__MACOSX", "._1.jpg"), "w").close()
            open(os.path.join(d, ".DS_Store"), "w").close()
            os.makedirs(os.path.join(d, "sub"))
            open(os.path.join(d, "sub", "3.jpg"), "w").close()
            open(os.path.join(d, "sub", "Thumbs.db"), "w").close()
            got = sorted(os.path.relpath(p, d).replace(os.sep, "/") for p in ms.media_files_in(d))
            self.assertEqual(got, ["1.jpg", "2.jpg", "sub/3.jpg"])
        finally:
            import shutil
            shutil.rmtree(d, ignore_errors=True)


class TestBuildZipChapters(unittest.TestCase):
    def _make_zip(self):
        buf = tempfile.mkstemp(suffix=".zip")[1]
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("page1.jpg", b"")
            z.writestr("page10.jpg", b"")
            z.writestr("page2.jpg", b"")
            z.writestr("ch1/p1.jpg", b"")
            z.writestr("ch1/p2.jpg", b"")
            z.writestr("ch2/a.jpg", b"")
            z.writestr("README.txt", b"")
        return buf

    def tearDown(self):
        if hasattr(self, "_zip"):
            try:
                os.remove(self._zip)
            except OSError:
                pass

    def test_grouping_and_sort(self):
        self._zip = self._make_zip()
        with zipfile.ZipFile(self._zip) as z:
            chapters = ms.build_zip_chapters(self._zip, z.namelist())
        titles = [c["title"] for c in chapters]
        self.assertEqual(titles, ["根目录", "ch1", "ch2"])
        # 根目录按自然排序：page1, page2, page10
        root_names = [s[1] for s in chapters[0]["sources"]]
        self.assertEqual(root_names, ["page1.jpg", "page2.jpg", "page10.jpg"])
        # 每个 source 是 (zip_path, name)
        self.assertTrue(all(s[0] == self._zip for c in chapters for s in c["sources"]))

    def test_txt_excluded(self):
        self._zip = self._make_zip()
        with zipfile.ZipFile(self._zip) as z:
            chapters = ms.build_zip_chapters(self._zip, z.namelist())
        all_names = [s[1] for c in chapters for s in c["sources"]]
        self.assertNotIn("README.txt", all_names)


class TestExpandPaths(unittest.TestCase):
    def test_pdf_expanded_and_others_kept(self):
        src = ms.expand_paths(
            ["a.jpg", "book3.pdf", "b.mp4"],
            page_count_fn=_page_count,
        )
        self.assertEqual(src, ["a.jpg", ("book3.pdf", 0), ("book3.pdf", 1), ("book3.pdf", 2), "b.mp4"])

    def test_pdf_zero_pages_skipped(self):
        src = ms.expand_paths(["empty.pdf"], page_count_fn=lambda p: 0)
        self.assertEqual(src, [])


class TestParsePlaylist(unittest.TestCase):
    def test_relative_and_comment(self):
        base = tempfile.mkdtemp()
        open(os.path.join(base, "a.jpg"), "w").close()
        open(os.path.join(base, "book3.pdf"), "w").close()
        lines = ["#EXTM3U", "a.jpg", "# comment", "book3.pdf", ""]
        src = ms.parse_playlist(lines, base, page_count_fn=_page_count)
        # 相对条目解析为基于 base_dir 的绝对路径
        a = os.path.join(base, "a.jpg")
        p = os.path.join(base, "book3.pdf")
        self.assertEqual(src, [a, (p, 0), (p, 1), (p, 2)])
        import shutil
        shutil.rmtree(base, ignore_errors=True)

    def test_missing_file_skipped(self):
        base = tempfile.mkdtemp()
        src = ms.parse_playlist(["nope.jpg"], base, page_count_fn=_page_count)
        self.assertEqual(src, [])
        import shutil
        shutil.rmtree(base, ignore_errors=True)


class TestBookKeys(unittest.TestCase):
    def test_files_book_key_deterministic(self):
        k1 = ms.files_book_key(["a.jpg", "b.jpg"])
        k2 = ms.files_book_key(["a.jpg", "b.jpg"])
        k3 = ms.files_book_key(["b.jpg", "a.jpg"])  # 顺序不同 => 不同 key
        self.assertEqual(k1, k2)
        self.assertTrue(k1.startswith("files:"))
        self.assertNotEqual(k1, k3)

    def test_playlist_book_key(self):
        k = ms.playlist_book_key("C:/x/a.m3u")
        self.assertTrue(k.startswith("playlist:"))
        self.assertTrue(os.path.isabs(k[len("playlist:"):]))


class TestUpdateHistory(unittest.TestCase):
    def setUp(self):
        self.hist = tempfile.mkstemp(suffix=".m3u")[1]

    def tearDown(self):
        try:
            os.remove(self.hist)
        except OSError:
            pass

    def test_prepend_dedup_limit(self):
        ms.update_history("C:/a.jpg", self.hist, limit=100)
        ms.update_history("C:/b.jpg", self.hist, limit=100)
        ms.update_history("C:/a.jpg", self.hist, limit=100)  # 移到顶部
        with open(self.hist, encoding="utf-8") as f:
            lines = [l.strip() for l in f if l.strip() and not l.startswith("#")]
        self.assertEqual(lines, [os.path.abspath("C:/a.jpg"), os.path.abspath("C:/b.jpg")])

    def test_limit(self):
        for i in range(5):
            ms.update_history("C:/f%d.jpg" % i, self.hist, limit=3)
        with open(self.hist, encoding="utf-8") as f:
            lines = [l.strip() for l in f if l.strip() and not l.startswith("#")]
        self.assertEqual(len(lines), 3)
        self.assertEqual(lines[0], os.path.abspath("C:/f4.jpg"))


if __name__ == "__main__":
    unittest.main()
