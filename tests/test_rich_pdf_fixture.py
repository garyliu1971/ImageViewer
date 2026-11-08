# -*- coding: utf-8 -*-
"""tests/make_web_fixtures.py 的 rich_pdf：生成的 PDF 结构自洽（xref 偏移全对、页数对、确定性），已提交的小样本没被换行转换弄坏。"""

import importlib.util
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location("make_web_fixtures", os.path.join(HERE, "make_web_fixtures.py"))
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


def check_structure(tc, data, npages):
    tc.assertTrue(data.startswith(b"%PDF-1.5\n"))
    tc.assertTrue(data.rstrip().endswith(b"%%EOF"))
    sx = int(re.search(rb"startxref\n(\d+)\n%%EOF", data).group(1))
    tc.assertEqual(data[sx:sx + 5], b"xref\n")
    m = re.match(rb"xref\n0 (\d+)\n", data[sx:])
    count = int(m.group(1))
    rows = data[sx + m.end():].split(b"\n")[:count]
    tc.assertEqual(rows[0], b"0000000000 65535 f ")
    for oid, row in enumerate(rows[1:], start=1):
        off = int(row[:10])
        tc.assertTrue(data[off:].startswith(b"%d 0 obj\n" % oid), "对象 %d 的 xref 偏移不对" % oid)
    tc.assertEqual(int(re.search(rb"/Size (\d+)", data[sx:]).group(1)), count)
    tc.assertEqual(int(re.search(rb"/Type /Pages /Kids \[[^\]]*\] /Count (\d+)", data).group(1)), npages)


class TestRichPdf(unittest.TestCase):
    def test_structure_and_determinism(self):
        pages = [{"kind": "text"}, {"kind": "image"}, {"kind": "cjk"}, {"kind": "text", "rot": 90},
                 {"kind": "text", "w": 792, "h": 612}, {"kind": "scan"}]
        a = M.rich_pdf(pages, scan_kb=8)
        check_structure(self, a, 6)
        self.assertEqual(a, M.rich_pdf(pages, scan_kb=8))                 # 确定性：同样的输入 = 同样的字节
        self.assertIn(b"/Rotate 90", a)
        self.assertIn(b"/MediaBox [0 0 792 612]", a)
        self.assertIn(b"/Encoding /UniGB-UCS2-H", a)
        self.assertIn(b"/Outlines", a)
        self.assertIn(b"/Direction /R2L", M.rich_pdf(pages[:2], scan_kb=1, rtl=True))
        self.assertNotIn(b"/Outlines", M.rich_pdf(pages[:2], outline=False))

    def test_big_scan_pdf_is_lazy_friendly(self):
        """>100 页、每页自带一张扫描图：页面对象全在文件开头一小块里，扫描图在后面（读第 1 页只需要开头 + 结尾）。"""
        data = M.rich_pdf([{"kind": "scan"}] * 120, scan_kb=4, outline=False)
        check_structure(self, data, 120)
        last_page = data.index(b"\n%d 0 obj\n" % (10 + 2 * 119 + 1))
        first_scan = data.index(b"/ColorSpace /DeviceGray")
        self.assertLess(last_page, first_scan, "页面对象应该排在扫描图前面（紧凑布局）")

    def test_committed_sample_is_intact(self):
        p = os.path.join(HERE, "fixtures", "sample_rich.pdf")
        with open(p, "rb") as f:
            data = f.read()
        check_structure(self, data, 8)                                   # 换行被转换（autocrlf）的话 xref 偏移会全错
        self.assertLess(len(data), 100 * 1024, "入库的样本要小")
        self.assertNotIn(b"\r\n", data)


if __name__ == "__main__":
    unittest.main()
