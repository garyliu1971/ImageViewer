#!/usr/bin/env python3
"""把网页版组装成可部署到 https://<host>/iv/ 的静态目录（只在本地生成文件，不联网、不部署）。

    python deploy/build_iv_static.py                    # -> dist/iv-static/ + dist/iv-static.tgz
    python deploy/build_iv_static.py --out D:/x/iv      # 指定输出目录（会先清空）
    python deploy/build_iv_static.py --no-tar           # 不打 .tgz

输出目录内容（与 deploy/README-iv-deploy.md 对应）：
    index.html            <- image-viewer.html 改名
    manifest.webmanifest
    sw.js                 <- 把 __BUILD__ 换成内容哈希（每次发布缓存名都会变）
    icons/icon-192.png icon-512.png maskable-512.png
"""
import argparse
import hashlib
import os
import shutil
import sys
import tarfile

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
FILES = [  # (源文件, 目标相对路径)
    ("image-viewer.html", "index.html"),
    ("manifest.webmanifest", "manifest.webmanifest"),
    ("icons/icon-192.png", "icons/icon-192.png"),
    ("icons/icon-512.png", "icons/icon-512.png"),
    ("icons/maskable-512.png", "icons/maskable-512.png"),
]


def read(rel):
    with open(os.path.join(ROOT, rel), "rb") as f:
        return f.read()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=os.path.join(ROOT, "dist", "iv-static"))
    ap.add_argument("--no-tar", action="store_true")
    a = ap.parse_args(argv)
    out = os.path.abspath(a.out)
    # 保护：输出目录不能是仓库根 / 源码目录本身（会被清空）
    if out == ROOT or ROOT.startswith(out + os.sep):
        print("拒绝：--out 不能是仓库目录或它的上级", file=sys.stderr)
        return 2

    blobs = {}
    for src, dst in FILES:
        blobs[dst] = read(src)
    h = hashlib.sha256()
    for dst in sorted(blobs):
        h.update(dst.encode("utf-8")); h.update(blobs[dst])
    build = h.hexdigest()[:10]
    sw = read("sw.js").decode("utf-8")
    if "__BUILD__" not in sw:
        print("sw.js 里没有 __BUILD__ 占位符", file=sys.stderr)
        return 2
    blobs["sw.js"] = sw.replace("__BUILD__", build).encode("utf-8")

    if os.path.isdir(out):
        shutil.rmtree(out)
    for dst, data in blobs.items():
        p = os.path.join(out, *dst.split("/"))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(data)
    print("build", build, "->", out)
    for dst in sorted(blobs):
        print("  %-26s %9d bytes" % (dst, len(blobs[dst])))

    if not a.no_tar:
        tgz = out.rstrip("/\\") + ".tgz"
        with tarfile.open(tgz, "w:gz") as t:
            for dst in sorted(blobs):
                t.add(os.path.join(out, *dst.split("/")), arcname=dst)
        print("tar ->", tgz)
    return 0


if __name__ == "__main__":
    sys.exit(main())
