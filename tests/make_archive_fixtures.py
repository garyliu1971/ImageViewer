# -*- coding: utf-8 -*-
"""造 libarchive.js（rar / 7z / tar 系）测试用的小样本：tests/fixtures/arch_*.{tar,tgz,cbt,7z,cb7,rar,cbr}。

    python tests/make_archive_fixtures.py

样本已经提交进仓库，平时不用重跑；要重造需要 Pillow，7z 系需要 7-Zip（C:\\Program Files\\7-Zip\\7z.exe 或 PATH 里的 7z / 7zz）。
内容：4 张图（01.jpg 02.png 03.png 10.jpg，颜色各不相同、故意让自然排序和字典序不同）+ 一个 readme.txt + 一个 __MACOSX/ 垃圾条目；
另有一个带章节子目录的 tar（arch_chapters.tar：ch1/ ch2/）。

rar5：本机没有 rar 编译器，所以和 make_web_fixtures.py 里的 RAR3 一样手拼一个 **stored（不压缩）** 的 RAR5 归档
（签名 + 主头 + 每个文件一个文件头 + 数据 + 结束头，头部 CRC32 / 数据 CRC32 / vint 都按 RAR5 规范写）；7-Zip 和 libarchive 都能读。
真实世界的 rar 多为压缩 / solid，那部分的解码由 libarchive 自己的实现负责，这里只验证容器 + 页面管线。
"""
import io
import os
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")
COLORS = {"01.jpg": (200, 40, 40), "02.png": (40, 200, 40), "03.png": (40, 40, 200), "10.jpg": (200, 200, 40)}
SIZES = {"01.jpg": (60, 90), "02.png": (60, 90), "03.png": (60, 90), "10.jpg": (60, 90)}


def image(name):
    from PIL import Image
    im = Image.new("RGB", SIZES[name], COLORS[name])
    buf = io.BytesIO()
    im.save(buf, "JPEG" if name.endswith(".jpg") else "PNG")
    return buf.getvalue()


def entries(prefix=""):
    """(archive 内路径, 字节)：故意乱序放，自然排序后应为 01 02 03 10。"""
    return [
        (prefix + "10.jpg", image("10.jpg")),
        (prefix + "readme.txt", b"not an image\n"),
        (prefix + "03.png", image("03.png")),
        ("__MACOSX/" + prefix + "._01.jpg", b"junk"),
        (prefix + "01.jpg", image("01.jpg")),
        (prefix + "02.png", image("02.png")),
    ]


def write_tar(path, ents, mode="w"):
    with tarfile.open(path, mode) as t:
        for name, data in ents:
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            ti.mtime = 1700000000
            t.addfile(ti, io.BytesIO(data))


def seven_zip():
    for c in (r"C:\Program Files\7-Zip\7z.exe", shutil.which("7z"), shutil.which("7zz")):
        if c and os.path.exists(c):
            return c
    return None


def write_7z(path, ents, password=None):
    exe = seven_zip()
    if not exe:
        print("没有 7-Zip，跳过 " + os.path.basename(path), file=sys.stderr)
        return
    with tempfile.TemporaryDirectory() as t:
        names = []
        for name, data in ents:
            p = os.path.join(t, *name.split("/"))
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "wb") as f:
                f.write(data)
            names.append(name.split("/")[0])
        if os.path.exists(path):
            os.remove(path)
        pw = ["-p" + password, "-mhe=off"] if password else []       # 只加密数据、不加密文件名：目录能列出来，解压要密码
        subprocess.run([exe, "a", "-t7z", "-mx=1", "-ms=off"] + pw + [os.path.abspath(path)] + sorted(set(names)), cwd=t, check=True, stdout=subprocess.DEVNULL)


# ---------------- 手拼 RAR5（stored） ----------------
def vint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def rar5_block(htype, hflags, body, data=b""):
    """[CRC32][HeaderSize vint][type][flags][(DataSize)][body...][data]；CRC32 覆盖 HeaderSize 之后到头部结尾的全部。"""
    extra = vint(len(data)) if data else b""
    hf = hflags | (0x0002 if data else 0)
    rest = vint(htype) + vint(hf) + extra + body
    size = vint(len(rest))
    crc = zlib.crc32(size + rest) & 0xFFFFFFFF
    return struct.pack("<I", crc) + size + rest + data


def rar5(ents):
    out = bytearray(b"Rar!\x1a\x07\x01\x00")
    out += rar5_block(1, 0, vint(0))                       # 主头：archive flags = 0（非 solid、无卷）
    for name, data in ents:
        nb = name.encode("utf-8")
        body = (vint(0x04)                                 # file flags：有 CRC32
                + vint(len(data))                          # 解压后大小
                + vint(0x20)                               # 属性（普通文件）
                + struct.pack("<I", zlib.crc32(data) & 0xFFFFFFFF)
                + vint(0)                                  # compression info：版本 0 / 非 solid / method 0 = store
                + vint(0)                                  # host OS = Windows
                + vint(len(nb)) + nb)
        out += rar5_block(2, 0, body, data)
    out += rar5_block(5, 0, vint(0))                       # 结束头
    return bytes(out)


def main():
    os.makedirs(FIX, exist_ok=True)
    flat = entries()
    ch = [("ch1/" + n.split("/")[-1], d) for n, d in entries() if n.endswith((".jpg", ".png")) and not n.startswith("__")]
    ch += [("ch2/" + n, d) for n, d in [("01.jpg", image("01.jpg")), ("02.png", image("02.png"))]]
    write_tar(os.path.join(FIX, "arch_flat.tar"), flat)
    write_tar(os.path.join(FIX, "arch_flat.cbt"), flat)
    write_tar(os.path.join(FIX, "arch_flat.tgz"), flat, "w:gz")
    write_tar(os.path.join(FIX, "arch_flat.tar.gz"), flat, "w:gz")
    write_tar(os.path.join(FIX, "arch_chapters.tar"), ch)
    write_7z(os.path.join(FIX, "arch_flat.7z"), flat)
    write_7z(os.path.join(FIX, "arch_flat.cb7"), flat)
    write_7z(os.path.join(FIX, "arch_enc.7z"), flat, password="secret")
    write_tar(os.path.join(FIX, "arch_noimg.tar"), [("readme.txt", b"no pictures here\n"),("notes/a.txt", b"x")])
    with open(os.path.join(FIX, "arch_bad.rar"), "wb") as f:
        f.write(b"this is not a rar archive at all " * 40)
    for fn in ("arch_flat.rar", "arch_flat.cbr"):
        with open(os.path.join(FIX, fn), "wb") as f:
            f.write(rar5(flat))
    for fn in sorted(os.listdir(FIX)):
        if fn.startswith("arch_"):
            print("wrote %-22s %6d bytes" % (fn, os.path.getsize(os.path.join(FIX, fn))))


if __name__ == "__main__" and "--bench" not in sys.argv:
    main()


def make_bench(outdir, pages=160, size=(1000, 1400), quality=88):
    """压测用的大包（默认约 100MB 的 JPEG 页，故意用随机噪声让它不可压缩）：bench_<N>mb.{tar,7z,rar}（均为非 solid / stored）。
    不进仓库（--bench 指定输出目录）；给 tests/web_arch_bench.mjs 用。"""
    import random
    from PIL import Image
    os.makedirs(outdir, exist_ok=True)
    rnd = random.Random(7)
    ents = []
    for i in range(pages):
        raw = bytes(rnd.getrandbits(8) for _ in range(size[0] * size[1] * 3 // 64))      # 小块随机噪声再放大：快，且 JPEG 不易压
        small = Image.frombytes("RGB", (size[0] // 8, size[1] // 8), (raw * 64)[: (size[0] // 8) * (size[1] // 8) * 3])
        im = small.resize(size, Image.NEAREST)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=quality)
        ents.append(("p%04d.jpg" % (i + 1), buf.getvalue()))
    total = sum(len(d) for _, d in ents)
    mb = int(round(total / 1048576.0))
    write_tar(os.path.join(outdir, "bench_%dmb.tar" % mb), ents)
    with open(os.path.join(outdir, "bench_%dmb.cbr" % mb), "wb") as f:
        f.write(rar5(ents))
    write_7z(os.path.join(outdir, "bench_%dmb.7z" % mb), ents)
    print("bench: %d pages, %.1f MB payload -> %s" % (pages, total / 1048576.0, outdir))


if __name__ == "__main__" and len(sys.argv) > 2 and sys.argv[1] == "--bench":
    make_bench(sys.argv[2], *[int(x) for x in sys.argv[3:4]])
    sys.exit(0)
