# -*- coding: utf-8 -*-
"""生成网页版（image-viewer.html）的 zip/cbz 测试样本。

用法： python tests/make_web_fixtures.py
产物： tests/fixtures/*.zip|*.cbz   （web_core.test.mjs / web_e2e.mjs 会读取）

覆盖点：store / deflate 两种压缩、中文目录名（章节）、__MACOSX 垃圾条目、
非图片条目（pdf/tif）、zip64、GBK 文件名。
"""
import io
import os
import struct
import zipfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixtures")


def png(w=60, h=80, rgb=(200, 30, 30)):
    """无 Pillow 依赖的最小 PNG（纯色）。IHDR 固定 13 字节，像素在 IDAT。"""
    import zlib

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def rar3(entries):
    """手拼一个 RAR3 归档（stored，无压缩）。

    没有 WinRAR/rar 也能造出**真 .cbr**：块布局照 rarfile 自己的 RAR3 写法
    （rarfile.rar3_decompress 里那套），实测 rarfile 与 7-Zip 都能读。
    注：真实世界的 rar 多为压缩/solid，那部分用 rarfile 实包在
    tests/test_web_backend.py 里另外覆盖。
    """
    from struct import Struct

    S_BLK = Struct("<HBHH")
    S_FILE = Struct("<LLBLLBBHL")
    sig = b"Rar!\x1a\x07\x00"
    main = S_BLK.pack(0x90CF, 0x73, 0, 13) + b"\0" * 6
    out = [sig, main]
    ftime = ((2024 - 1980) << 25) + (6 << 21) + (15 << 16) + (12 << 11) + (30 << 5)
    for name, data in entries:
        nb = name.encode("utf-8")
        fhdr = S_FILE.pack(len(data), len(data), 0, zlib.crc32(data) & 0xFFFFFFFF,
                           ftime, 29, 0x30, len(nb), 0x20)          # 0x30 = store
        hlen = S_BLK.size + len(fhdr) + len(nb)
        body = S_BLK.pack(0, 0x74, 0x8000, hlen) + fhdr + nb
        out.append(S_BLK.pack(zlib.crc32(body[2:]) & 0xFFFF, 0x74, 0x8000, hlen)
                   + fhdr + nb + data)
    out.append(S_BLK.pack(0xDDCC, 0x75, 0, 7))
    return b"".join(out)


def mini_pdf(pages):
    """手写一个最小合法 PDF（无外部依赖）。pages = [(w, h), ...]。"""
    objs = []
    n = len(pages)
    kids = " ".join("%d 0 R" % (3 + i * 2) for i in range(n))
    objs.append("<< /Type /Catalog /Pages 2 0 R >>")
    objs.append("<< /Type /Pages /Kids [%s] /Count %d >>" % (kids, n))
    for i, (w, h) in enumerate(pages):
        content = "0.85 0.85 0.85 rg\n0 0 %d %d re f\n0.1 0.1 0.1 rg\n%d %d %d %d re f\n" % (
            w, h, int(w * 0.15), int(h * 0.12), int(w * 0.7), int(h * 0.76))
        objs.append("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] /Contents %d 0 R >>"
                    % (w, h, 4 + i * 2))
        objs.append("<< /Length %d >>\nstream\n%sendstream" % (len(content), content))
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(out.tell())
        out.write(("%d 0 obj\n%s\nendobj\n" % (i, body)).encode("ascii"))
    xref = out.tell()
    out.write(("xref\n0 %d\n0000000000 65535 n \n" % (len(objs) + 1)).encode("ascii"))
    for off in offsets:
        out.write(("%010d 00000 n \n" % off).encode("ascii"))
    out.write(("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
               % (len(objs) + 1, xref)).encode("ascii"))
    return out.getvalue()


def rich_pdf(pages, scan_kb=140, outline=True, rtl=False):
    """比 mini_pdf 丰富的测试 PDF（stdlib，确定性）：非嵌入标准字体文字（Helvetica / ZapfDingbats）、RGB 图像、
    非嵌入 CJK 字体（STSong-Light + UniGB-UCS2-H，逼 pdf.js 去取 cmap）、/Rotate、不同纸张、大纲、可选从右到左。
    pages = [{"kind": "text"|"image"|"cjk"|"scan", "w": 612, "h": 792, "rot": 0}, ...]；
    scan 页自带一张 scan_kb KB 的整页灰度图（像扫描书：只有读到这一页才需要它那段字节），用来造「大 PDF」测懒读。
    classic xref 表在文件末尾（不是线性化 / object stream）。tests/web_e2e.mjs 里有等价的 Node 版（在内存里造 20MB 的，不入库）。"""
    n = len(pages)
    first = 10
    scan_id = {}
    nxt = first + 2 * n
    for i, pg in enumerate(pages):
        if pg.get("kind") == "scan":
            scan_id[i] = nxt
            nxt += 1
    out_ids = list(range(nxt, nxt + (3 if outline else 0)))
    objs = {}   # id -> bytes（body，不含 "N 0 obj"）

    def stream(d, data):
        return ("<< %s /Length %d >>\nstream\n" % (d, len(data))).encode("latin-1") + data + b"\nendstream"

    objs[1] = ("<< /Type /Catalog /Pages 2 0 R /PageLayout /SinglePage%s%s >>" % (
        " /ViewerPreferences << /Direction /R2L >>" if rtl else "",
        " /Outlines %d 0 R" % out_ids[0] if outline else "")).encode("latin-1")
    objs[2] = ("<< /Type /Pages /Kids [%s] /Count %d >>" % (" ".join("%d 0 R" % (first + 2 * i) for i in range(n)), n)).encode("latin-1")
    objs[3] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
    objs[4] = b"<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light-UniGB-UCS2-H /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>"
    objs[5] = (b"<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> "
               b"/FontDescriptor 6 0 R /DW 1000 >>")
    objs[6] = (b"<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 "
               b"/Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>")
    rgb = bytearray()
    for y in range(64):
        for x in range(64):
            rgb += bytes((x * 4, 40, y * 4))
    objs[7] = stream("/Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8", bytes(rgb))
    objs[8] = b"<< /Font << /F1 3 0 R /F2 4 0 R /F3 9 0 R >> /XObject << /Im1 7 0 R >> >>"
    objs[9] = b"<< /Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats >>"
    for i, pg in enumerate(pages):
        w, h, k = pg.get("w", 612), pg.get("h", 792), pg.get("kind", "text")
        res = "/Resources 8 0 R"
        if k == "image":
            c = "q 200 0 0 200 72 %d cm /Im1 Do Q BT /F1 18 Tf 72 %d Td (image page %d) Tj ET" % (h - 320, h - 340, i + 1)
        elif k == "cjk":
            c = "BT /F2 28 Tf 72 %d Td <4E2D65876D4B8BD5> Tj ET 0 0 0 rg 72 %d 200 40 re f" % (h - 100, h - 200)
        elif k == "scan":
            c = "q %d 0 0 %d 0 0 cm /Im1 Do Q BT /F1 20 Tf 72 %d Td (Scan page %d) Tj ET" % (w, h, h // 2, i + 1)
            res = "/Resources << /Font << /F1 3 0 R >> /XObject << /Im1 %d 0 R >> >>" % scan_id[i]
            raw = bytearray(b"\xc0" * (scan_kb * 1024))
            raw[:1024 * 20] = b"\x20" * (1024 * 20)
            objs[scan_id[i]] = stream("/Type /XObject /Subtype /Image /Width 1024 /Height %d /ColorSpace /DeviceGray /BitsPerComponent 8" % scan_kb, bytes(raw))
        else:
            c = ("BT /F1 36 Tf 72 %d Td (Hello PDF page %d) Tj ET BT /F3 24 Tf 72 %d Td (abc) Tj ET 0 0 0 rg 72 %d 200 40 re f"
                 % (h - 100, i + 1, h - 140, h - 220))
        objs[first + 2 * i] = ("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] %s%s /Contents %d 0 R >>" % (
            w, h, "/Rotate %d " % pg["rot"] if pg.get("rot") else "", res, first + 2 * i + 1)).encode("latin-1")
        objs[first + 2 * i + 1] = stream("", c.encode("latin-1"))
    if outline:
        a, b, c0 = out_ids
        objs[a] = ("<< /Type /Outlines /First %d 0 R /Last %d 0 R /Count 2 >>" % (b, c0)).encode("latin-1")
        objs[b] = ("<< /Title (Chapter 1) /Parent %d 0 R /Next %d 0 R /Dest [%d 0 R /Fit] >>" % (a, c0, first)).encode("latin-1")
        objs[c0] = ("<< /Title (Chapter 2) /Parent %d 0 R /Prev %d 0 R /Dest [%d 0 R /Fit] >>" % (a, b, first + 2 * min(2, n - 1))).encode("latin-1")
    maxid = max(objs)
    out = io.BytesIO()
    out.write(b"%PDF-1.5\n%\xe2\xe3\xcf\xd3\n")
    offs = {}
    for oid in sorted(objs):                     # 页面对象在前、各页的扫描图在后：紧凑布局
        offs[oid] = out.tell()
        out.write(("%d 0 obj\n" % oid).encode("ascii") + objs[oid] + b"\nendobj\n")
    xref = out.tell()
    out.write(("xref\n0 %d\n0000000000 65535 f \n" % (maxid + 1)).encode("ascii"))
    for oid in range(1, maxid + 1):
        out.write(("%010d 00000 n \n" % offs[oid]).encode("ascii"))
    out.write(("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (maxid + 1, xref)).encode("ascii"))
    return out.getvalue()


def text_pdf(pages, w=400, h=600):
    """带文字层的小 PDF（stdlib，确定性）：朗读 / 书签测试用。pages = [[(x, y, size, text), ...], ...]，y 从页面顶端往下量；
    含非 ASCII 的行用非嵌入 CJK 字体（STSong-Light + UniGB-UCS2-H，十六进制 UCS2），纯 ASCII 的行用 Helvetica；空列表 = 没有文字层的页（只有一块色块）。"""
    n = len(pages)
    first = 7
    objs = {}

    def stream(d, data):
        return ("<< %s /Length %d >>\nstream\n" % (d, len(data))).encode("latin-1") + data + b"\nendstream"

    objs[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objs[2] = ("<< /Type /Pages /Kids [%s] /Count %d >>" % (" ".join("%d 0 R" % (first + 2 * i) for i in range(n)), n)).encode("latin-1")
    objs[3] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
    objs[4] = b"<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light-UniGB-UCS2-H /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>"
    objs[5] = (b"<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> "
               b"/FontDescriptor 6 0 R /DW 1000 >>")
    objs[6] = (b"<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 "
               b"/Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>")
    for i, lines in enumerate(pages):
        if not lines:
            c = "0.9 0.9 0.9 rg 50 100 300 400 re f"
        else:
            c = ""
            for (x, y, size, text) in lines:
                if all(ord(ch) < 128 for ch in text):
                    c += "BT /F1 %s Tf %s %s Td (%s) Tj ET\n" % (size, x, h - y, text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)"))
                else:
                    c += "BT /F2 %s Tf %s %s Td <%s> Tj ET\n" % (size, x, h - y, text.encode("utf-16-be").hex().upper())
        objs[first + 2 * i] = ("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents %d 0 R >>"
                               % (w, h, first + 2 * i + 1)).encode("latin-1")
        objs[first + 2 * i + 1] = stream("", c.encode("latin-1"))
    maxid = max(objs)
    out = io.BytesIO()
    out.write(b"%PDF-1.5\n%\xe2\xe3\xcf\xd3\n")
    offs = {}
    for oid in sorted(objs):
        offs[oid] = out.tell()
        out.write(("%d 0 obj\n" % oid).encode("ascii") + objs[oid] + b"\nendobj\n")
    xref = out.tell()
    out.write(("xref\n0 %d\n0000000000 65535 f \n" % (maxid + 1)).encode("ascii"))
    for oid in range(1, maxid + 1):
        out.write(("%010d 00000 n \n" % offs[oid] if oid in offs else "0000000000 65535 f \n").encode("ascii"))
    out.write(("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (maxid + 1, xref)).encode("ascii"))
    return out.getvalue()


def sample_text_pages():
    """sample_text.pdf 的内容（8 页）：第 1-3 页有文字（页眉 / 页码 / 脚注 / 缩进段落 / 跨页半句 / 标题 / 英文），第 5 页只有一句，4、6-8 页没有文字层。"""
    L, TOP, N = 50, 30, 24
    head = (150, TOP, 9, "示例：朗读测试书")

    def lay(text, y, indent):
        # 每行 N 个字（宽 12pt，刚好顶到右边距）；缩进段落第一行缩进 2 字
        lines = [text[:N - 2]] + [text[i:i + N] for i in range(N - 2, len(text), N)] if indent else [text[i:i + N] for i in range(0, len(text), N)]
        return [(L + (24 if indent and j == 0 else 0), y + j * 18, 12, ln) for j, ln in enumerate(lines)], y + len(lines) * 18 + 4

    a, y = lay("春天到了，山上的雪慢慢融化。溪水从石缝里流出来，带着泥土的气息。村里的孩子们早早起床，拿着竹篮去河边捡柴。", 80, True)
    b, y = lay("老人坐在门口晒太阳，他说今年的收成一定不错。孩子们听了都很高兴，因为这意味着秋天可以吃到更多的甜瓜，还有妈妈亲手在灶台边做出来的那些香喷喷的", y, True)
    p1 = [head] + a + b + [(L, 540, 7, "〔1〕这里是脚注，朗读时应该被跳过。"), (195, 575, 9, "1")]
    c, y = lay("红薯。夜里，月亮升起来，整个山谷安静得像一幅画。", 80, False)
    d, y = lay("第二天一早，他们又出发了。", y, True)
    e = [(L + 24, y + 4, 12, "Reading aloud works with English too. It is fine.")]
    p2 = [head] + c + d + e + [(195, 575, 9, "2")]
    f, y = lay("路上遇到了一位旅人，他背着一个很大的包袱。他说自己从很远的地方来，要去看望多年不见的朋友。", 130, True)
    p3 = [head, (L, 80, 22, "第二章 旅途")] + f + [(195, 575, 9, "3")]
    g, y = lay("最后一页的故事很短。", 80, True)
    p5 = [head] + g + [(195, 575, 9, "5")]
    return [p1, p2, p3, [], p5, [], [], []]


def main():
    os.makedirs(OUT, exist_ok=True)

    # 1) 正常 cbz：章节 + store/deflate + 垃圾条目 + 非图片
    p = os.path.join(OUT, "sample.cbz")
    with zipfile.ZipFile(p, "w") as z:
        z.writestr(zipfile.ZipInfo("00_cover.png", (1980, 1, 1, 0, 0, 0)),
                   png(40, 40), compress_type=zipfile.ZIP_STORED)
        for i in range(1, 4):
            z.writestr("第2话/%02d.png" % i, png(60, 90, (10, 120, 200)),
                       compress_type=zipfile.ZIP_DEFLATED)
        for i in range(1, 3):
            z.writestr("第10话/%02d.png" % i, png(60, 90, (20, 200, 60)),
                       compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("__MACOSX/._00_cover.png", b"junk")
        z.writestr(".DS_Store", b"junk")
        z.writestr("readme.txt", b"not an image")
        z.writestr("scan.pdf", b"%PDF-1.4 fake")
        z.writestr("第1话/01.png", png(60, 90, (200, 200, 10)),
                   compress_type=zipfile.ZIP_DEFLATED)
    print("wrote", p, os.path.getsize(p), "bytes")

    # 2) zip64 cbz（强制 zip64 扩展头）
    p64 = os.path.join(OUT, "sample_zip64.cbz")
    with zipfile.ZipFile(p64, "w", allowZip64=True) as z:
        zi = zipfile.ZipInfo("ch1/01.png")
        with z.open(zi, "w", force_zip64=True) as f:
            f.write(png(60, 90, (99, 99, 99)))
        zi2 = zipfile.ZipInfo("ch1/02.png")
        with z.open(zi2, "w", force_zip64=True) as f:
            f.write(png(60, 90, (11, 222, 33)))
    print("wrote", p64, os.path.getsize(p64), "bytes")

    # 3) GBK 文件名（Windows 压缩软件常见，不带 UTF-8 标志）
    pgbk = os.path.join(OUT, "sample_gbk.zip")
    with open(pgbk, "wb") as fh:
        import zlib
        data = png(50, 50, (7, 7, 200))
        name = "第一章/01.png".encode("gbk")
        method, crc, csize, usize = 8, zlib.crc32(data) & 0xFFFFFFFF, None, len(data)
        comp = zlib.compressobj(6, zlib.DEFLATED, -15)
        body = comp.compress(data) + comp.flush()
        csize = len(body)
        # local header
        lh = struct.pack("<IHHHHHIIIHH", 0x04034b50, 20, 0, method, 0, 0,
                         crc, csize, usize, len(name), 0) + name + body
        # central directory
        cd = struct.pack("<IHHHHHHIIIHHHHHII", 0x02014b50, 20, 20, 0, method, 0, 0,
                         crc, csize, usize, len(name), 0, 0, 0, 0, 0, 0) + name
        eocd = struct.pack("<IHHHHIIH", 0x06054b50, 0, 0, 1, 1, len(cd), len(lh), 0)
        fh.write(lh + cd + eocd)
    print("wrote", pgbk, os.path.getsize(pgbk), "bytes")

    # 3b) 漫画 epub：页序只能靠 OPF spine（文件名自然排序是错的），含 rtl、svg 包图、
    #     ../ 相对路径、%20 编码路径、spine 之外的缩略图（应被丢弃）。
    #     图片宽度 101..105 = 正确页序，测试靠宽度判断顺序。
    pepub = os.path.join(OUT, "sample_comic.epub")
    page = lambda body: ('<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml">'
                         '<body>%s</body></html>' % body)
    with zipfile.ZipFile(pepub, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype", (1980, 1, 1, 0, 0, 0)),
                   b"application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml",
                   '<?xml version="1.0"?><container version="1.0" '
                   'xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>'
                   '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>'
                   '</rootfiles></container>')
        z.writestr("OEBPS/content.opf",
                   '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">'
                   '<manifest>'
                   '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
                   '<item id="c" href="text/cover.xhtml" media-type="application/xhtml+xml"/>'
                   '<item id="p2" href="text/p2.xhtml" media-type="application/xhtml+xml"/>'
                   '<item id="p3" href="text/p3.xhtml" media-type="application/xhtml+xml"/>'
                   '<item id="p10" href="text/p10.xhtml" media-type="application/xhtml+xml"/>'
                   '<item id="last" href="text/last.xhtml" media-type="application/xhtml+xml"/>'
                   '<item id="i1" href="image/zz_cover.png" media-type="image/png"/>'
                   '</manifest>'
                   '<spine page-progression-direction="rtl">'
                   '<itemref idref="c"/><itemref idref="p2"/><itemref idref="p3"/>'
                   '<itemref idref="p10"/><itemref idref="last"/></spine></package>')
        z.writestr("OEBPS/nav.xhtml", page("<nav>toc</nav>"))
        z.writestr("OEBPS/text/cover.xhtml", page('<img src="../image/zz_cover.png" alt=""/>'))
        z.writestr("OEBPS/text/p2.xhtml", page(
            '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">'
            '<image width="102" height="150" xlink:href="../image/p%202.png"/></svg>'))
        z.writestr("OEBPS/text/p3.xhtml", page('<div><img class="x" src="../image/p3.png#frag"/></div>'))
        z.writestr("OEBPS/text/p10.xhtml", page("<img src='../image/p10.png'>"))
        z.writestr("OEBPS/text/last.xhtml", page('<img src="../image/a_last.png"/>'))
        for name, w in (("zz_cover.png", 101), ("p 2.png", 102), ("p3.png", 103),
                        ("p10.png", 104), ("a_last.png", 105), ("thumb.png", 20)):
            z.writestr("OEBPS/image/" + name, png(w, 150, (w, 60, 90)), compress_type=zipfile.ZIP_DEFLATED)
    print("wrote", pepub, os.path.getsize(pepub), "bytes")

    # 4) 真 .cbr（RAR3 stored，含中文章节目录）—— 网页版后端 rar 路径用
    pcbr = os.path.join(OUT, "sample.cbr")
    with open(pcbr, "wb") as fh:
        fh.write(rar3([("00_cover.png", png(120, 80, (34, 102, 136))),
                       ("第1话/01.png", png(100, 160, (17, 34, 51))),
                       ("第1话/02.png", png(100, 160, (68, 85, 102))),
                       ("第2话/01.png", png(100, 160, (119, 136, 153))),
                       ("readme.txt", b"not an image")]))
    print("wrote", pcbr, os.path.getsize(pcbr), "bytes")

    # 5) 真 PDF（3 页不同尺寸）—— 网页版后端按页渲染用
    ppdf = os.path.join(OUT, "sample.pdf")
    with open(ppdf, "wb") as fh:
        fh.write(mini_pdf([(600, 800), (700, 500), (400, 900)]))
    print("wrote", ppdf, os.path.getsize(ppdf), "bytes")

    # 6) 丰富的小 PDF（8 页：标准字体文字 / RGB 图 / 非嵌入中文字体 / 旋转 / 横版 / 小开本 / 竖长 / 扫描图）+ 大纲 —— /iv/ 的 pdf.js 阅读器用
    prich = os.path.join(OUT, "sample_rich.pdf")
    with open(prich, "wb") as fh:
        fh.write(rich_pdf([{"kind": "text"}, {"kind": "image"}, {"kind": "cjk"}, {"kind": "text", "rot": 90},
                           {"kind": "text", "w": 792, "h": 612}, {"kind": "text", "w": 300, "h": 400},
                           {"kind": "text", "w": 400, "h": 900}, {"kind": "scan"}], scan_kb=16))
    print("wrote", prich, os.path.getsize(prich), "bytes")

    # 7) 带文字层的 PDF（8 页，朗读 / 书签测试用）
    ptext = os.path.join(OUT, "sample_text.pdf")
    with open(ptext, "wb") as fh:
        fh.write(text_pdf(sample_text_pages()))
    print("wrote", ptext, os.path.getsize(ptext), "bytes")


if __name__ == "__main__":
    main()
