# -*- coding: utf-8 -*-
"""生成网页版（image-viewer.html）手动测试样本。

用法： python tests/make_web_demo.py
产物： 网页版测试样本/
        漫画/00_封面.png            横图（验证双页自动退回单页）
        漫画/第1话/01..08.png        竖图 + 白边（验证裁白边）
        漫画/第2话/01..05.png
        漫画/第10话/01..03.png       验证章节自然排序（第2话 排在 第10话 前面）
        漫画/说明.txt                应被跳过
        漫画.cbz                     同样内容 + __MACOSX/.DS_Store/scan.pdf 垃圾条目
        漫画.zip                     中文目录名用 GBK 编码（旧压缩软件常见）
        单图/超宽图.png              6000×900（验证 4000px 降采样上限）
        不支持/扫描.tif  书.pdf  漫画.rar   （验证「请用桌面版」提示）
"""
import io
import os
import struct
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "网页版测试样本")

try:
    from PIL import Image, ImageDraw
except ImportError:
    Image = None


def page(w, h, text, margin=0.12, bg=(247, 244, 236), ink=(26, 26, 26)):
    """一页漫画样图：四周留白边，中间一块深色「画面」+ 页码。"""
    if Image:
        im = Image.new("RGB", (w, h), bg)
        d = ImageDraw.Draw(im)
        mx, my = int(w * margin), int(h * margin * 0.75)
        d.rectangle([mx, my, w - mx, h - my], fill=ink)
        # 一点「网点」质感，方便看缩放清晰度
        for y in range(my + 20, h - my, 46):
            d.line([mx + 14, y, w - mx - 14, y], fill=(46, 46, 46), width=2)
        d.text((mx + 12, my + 8), text, fill=(230, 230, 230))
        d.rectangle([mx - 6, my - 6, w - mx + 6, h - my + 6], outline=(206, 202, 192))
        buf = io.BytesIO()
        im.save(buf, "PNG", optimize=True)
        return buf.getvalue()
    # 没有 Pillow 时退化成纯色 PNG（IHDR 固定 13 字节，像素在 IDAT）
    import zlib
    raw = b"".join(b"\x00" + bytes(ink) * w for _ in range(h))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")


def gbk_zip(path, entries):
    """手工写一个不带 UTF-8 标志位的 zip（条目名 GBK），验证解码回退。"""
    import zlib
    locals_, cents = [], []
    off = 0
    for name_gbk, data in entries:
        comp = zlib.compressobj(6, zlib.DEFLATED, -15)
        body = comp.compress(data) + comp.flush()
        crc = zlib.crc32(data) & 0xFFFFFFFF
        lh = struct.pack("<IHHHHHIIIHH", 0x04034b50, 20, 0, 8, 0, 0, crc,
                         len(body), len(data), len(name_gbk), 0) + name_gbk + body
        cd = struct.pack("<IHHHHHHIIIHHHHHII", 0x02014b50, 20, 20, 0, 8, 0, 0, crc,
                         len(body), len(data), len(name_gbk), 0, 0, 0, 0, 0, off) + name_gbk
        locals_.append(lh)
        cents.append(cd)
        off += len(lh)
    cd = b"".join(cents)
    eocd = struct.pack("<IHHHHIIH", 0x06054b50, 0, 0, len(cents), len(cents), len(cd), off, 0)
    with open(path, "wb") as f:
        f.write(b"".join(locals_) + cd + eocd)


def main():
    for d in ("漫画/第1话", "漫画/第2话", "漫画/第10话", "单图", "不支持"):
        os.makedirs(os.path.join(OUT, d), exist_ok=True)

    tree = []
    cover = page(1400, 820, "cover - landscape")
    open(os.path.join(OUT, "漫画", "00_封面.png"), "wb").write(cover)
    tree.append(("00_封面.png", cover))
    for ch, n, tint in (("第1话", 8, (26, 26, 26)), ("第2话", 5, (30, 24, 20)), ("第10话", 3, (20, 26, 34))):
        for i in range(1, n + 1):
            name = "%02d.png" % i
            data = page(900, 1300, "%s %02d" % (ch, i), ink=tint)
            open(os.path.join(OUT, "漫画", ch, name), "wb").write(data)
            tree.append(("%s/%s" % (ch, name), data))
    open(os.path.join(OUT, "漫画", "说明.txt"), "w", encoding="utf-8").write("这个应该被跳过\n")

    # 漫画.cbz：带垃圾条目 + 一个 pdf 条目
    p = os.path.join(OUT, "漫画.cbz")
    with zipfile.ZipFile(p, "w") as z:
        for name, data in tree:
            z.writestr(name, data, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("__MACOSX/._00_封面.png", b"junk")
        z.writestr(".DS_Store", b"junk")
        z.writestr("附录/scan.pdf", b"%PDF-1.4 not a real pdf")
    print("cbz  ", p, os.path.getsize(p) // 1024, "KB")

    # GBK 条目名
    pgbk = os.path.join(OUT, "漫画_gbk.zip")
    gbk_zip(pgbk, [("第一章/01.png".encode("gbk"), tree[1][1]),
                   ("第一章/02.png".encode("gbk"), tree[2][1]),
                   ("第二章/01.png".encode("gbk"), tree[9][1])])
    print("gbk  ", pgbk, os.path.getsize(pgbk) // 1024, "KB")

    big = page(6000, 900, "6000x900 - 验证 4000px 降采样上限", margin=0.02)
    open(os.path.join(OUT, "单图", "超宽图.png"), "wb").write(big)
    print("big  ", os.path.join(OUT, "单图", "超宽图.png"), len(big) // 1024, "KB")

    # 故意放几个网页版不支持的，验证提示
    if Image:
        buf = io.BytesIO()
        Image.new("RGB", (600, 800), (240, 240, 240)).save(buf, "TIFF")
        open(os.path.join(OUT, "不支持", "扫描.tif"), "wb").write(buf.getvalue())
    open(os.path.join(OUT, "不支持", "漫画.pdf"), "wb").write(b"%PDF-1.4\nfake\n")
    open(os.path.join(OUT, "不支持", "漫画.rar"), "wb").write(b"Rar!\x1a\x07\x00fake\n")

    print("\n完成。用浏览器打开 image-viewer.html，然后：")
    print("  文件夹按钮 -> 选  %s\\漫画" % OUT)
    print("  压缩包按钮 -> 选  %s" % p)


if __name__ == "__main__":
    main()
