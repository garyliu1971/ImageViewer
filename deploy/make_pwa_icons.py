#!/usr/bin/env python3
"""生成 /iv/ PWA 的图标（纯标准库：zlib + struct 手写 PNG，不依赖 Pillow）。

    python deploy/make_pwa_icons.py            # 写到 icons/icon-192.png、icon-512.png、maskable-512.png

图案：深色底 + 翻开的两页书（日漫右→左的味道：右页略高）+ 蓝色书脊。
maskable 版本整个画布铺满底色，图案缩在安全区（中间 60%）里。
生成结果已提交进仓库，所以平时不用跑；改图案或配色时再跑一次。
"""
import os
import struct
import sys
import zlib

BG = (15, 17, 21)          # 与 image-viewer.html 的 --bg 一致
PAGE = (231, 233, 238)     # --text
ACCENT = (76, 141, 255)    # --accent


def png(w, h, rgba_rows):
    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + bytes(r) for r in rgba_rows)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def in_round_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def shade(u, v, maskable):
    """单位正方形内 (u,v)∈[0,1) 的颜色 + alpha；None 表示透明"""
    if not maskable and not in_round_rect(u, v, 0.0, 0.0, 1.0, 1.0, 0.22):
        return None
    # 图案区：普通图标占 70%，maskable 占 50%（留出被裁圆的安全区）
    s = 0.50 if maskable else 0.70
    gx0, gy0 = 0.5 - s / 2, 0.5 - s / 2
    gu, gv = (u - gx0) / s, (v - gy0) / s          # 图案坐标 0..1
    if 0.47 <= gu <= 0.53 and 0.10 <= gv <= 0.90:    # 书脊
        return ACCENT + (255,)
    if in_round_rect(gu, gv, 0.04, 0.16, 0.47, 0.88, 0.04):   # 左页（略矮）
        return PAGE + (255,)
    if in_round_rect(gu, gv, 0.53, 0.10, 0.96, 0.90, 0.04):   # 右页
        return PAGE + (255,)
    return BG + (255,)


def render(size, maskable):
    ss = 2                                   # 2x2 超采样抗锯齿
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    c = shade((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size, maskable)
                    if c is None:
                        continue
                    a = c[3]
                    acc[0] += c[0] * a; acc[1] += c[1] * a; acc[2] += c[2] * a; acc[3] += a
            if acc[3] == 0:
                row += bytes((0, 0, 0, 0))
            else:
                row += bytes((acc[0] // acc[3], acc[1] // acc[3], acc[2] // acc[3], acc[3] // (ss * ss)))
        rows.append(row)
    return png(size, size, rows)


def main():
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
    os.makedirs(out, exist_ok=True)
    for name, size, maskable in (("icon-192.png", 192, False), ("icon-512.png", 512, False),
                                 ("maskable-512.png", 512, True)):
        path = os.path.join(out, name)
        with open(path, "wb") as f:
            f.write(render(size, maskable))
        print("wrote", os.path.normpath(path), os.path.getsize(path), "bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
