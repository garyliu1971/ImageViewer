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


if __name__ == "__main__":
    main()
