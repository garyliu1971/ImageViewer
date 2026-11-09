#!/usr/bin/env python3
"""把网页版组装成可部署到 https://<host>/iv/ 的静态目录（只在本地生成文件，不联网、不部署）。

    python deploy/build_iv_static.py                    # -> dist/iv-static/ + dist/iv-static.tgz
    python deploy/build_iv_static.py --out D:/x/iv      # 指定输出目录（新目录 / 空目录 / 本脚本上次生成的目录才允许；别的有内容的目录一律拒绝）
    python deploy/build_iv_static.py --no-tar           # 不打 .tgz

输出目录内容（与 deploy/README-iv-deploy.md 对应）：
    index.html            <- image-viewer.html 改名
    manifest.webmanifest
    sw.js                 <- 把 __BUILD__ 换成内容哈希（每次发布缓存名都会变）
    icons/icon-192.png icon-512.png maskable-512.png
    vendor/pdfjs/...      <- 仓库里 vendor/pdfjs/ 的原样拷贝（pdf.js + cmaps + standard_fonts + 许可证；不含 README / SHA256SUMS）
    vendor/libarchive/... <- 仓库里 vendor/libarchive/ 的原样拷贝（libarchive.js + worker + .wasm + 许可证；读 rar / 7z / tar 用，按需加载）
"""
import argparse
import hashlib
import os
import shutil
import sys
import tarfile

ROOT = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
MARKER = ".iv-static-build"   # 本脚本写进输出目录的标记文件：有它才允许下次清空重建
FILES = [  # (源文件, 目标相对路径)
    ("image-viewer.html", "index.html"),
    ("manifest.webmanifest", "manifest.webmanifest"),
    ("icons/icon-192.png", "icons/icon-192.png"),
    ("icons/icon-512.png", "icons/icon-512.png"),
    ("icons/maskable-512.png", "icons/maskable-512.png"),
]
VENDOR_SRC = "vendor/pdfjs"                      # 仓库内的第三方库目录；整棵树原样发布到 /iv/vendor/pdfjs/
LIBARCHIVE_SRC = "vendor/libarchive"            # libarchive.js（WASM）：rar / 7z / tar 系，第一次打开这类书才加载
VENDOR_SKIP = {"README.md", "SHA256SUMS"}        # 只给人看 / 校验用，不发布


def _walk_vendor(src):
    base = os.path.join(ROOT, *src.split("/"))
    out = []
    for dp, _dn, fns in os.walk(base):
        for fn in fns:
            rel = os.path.relpath(os.path.join(dp, fn), base).replace(os.sep, "/")
            if rel not in VENDOR_SKIP:
                out.append(src + "/" + rel)
    return sorted(out)


def vendor_files():
    """vendor/pdfjs 下要发布的文件（相对仓库根的 posix 路径，排好序）。目录不存在就是空：build 会报错，不悄悄少发。"""
    return _walk_vendor(VENDOR_SRC)


def libarchive_files():
    """vendor/libarchive 下要发布的文件（同上；目录缺 worker / wasm 时 build 报错）。"""
    return _walk_vendor(LIBARCHIVE_SRC)


def is_binary(dst):
    """原样字节发布的：图标，以及整个 vendor/（压缩过的 js、字体、cmap 都不能动一个字节，哪怕里面碰巧有换行符）。"""
    return dst.endswith(".png") or dst.startswith("vendor/")


def read(rel):
    with open(os.path.join(ROOT, rel), "rb") as f:
        return f.read()


def normalize_eol(data):
    """文本文件统一成 LF 再算哈希：同一份内容在 CRLF / LF 两种检出下得到同一个 build 号。"""
    return data.replace(b"\r\n", b"\n")


def refuse_reason(out):
    """返回不能把 out 当输出目录的理由（None = 可以）。只允许：不存在的新目录 / 空目录 / 带本脚本标记的旧输出目录。"""
    nc = os.path.normcase
    if nc(out) == nc(ROOT) or nc(ROOT).startswith(nc(out).rstrip(os.sep) + os.sep):
        return "--out 不能是仓库目录或它的上级"
    if os.path.lexists(out) and not os.path.isdir(out):
        return "--out 已存在且不是目录"
    if os.path.isdir(out) and os.listdir(out) and not os.path.isfile(os.path.join(out, MARKER)):
        return "--out 是一个有内容的目录，而且不是本脚本生成的（没有 %s 标记）；换一个新目录，或先手动清空它" % MARKER
    return None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=os.path.join(ROOT, "dist", "iv-static"))
    ap.add_argument("--no-tar", action="store_true")
    a = ap.parse_args(argv)
    out = os.path.realpath(os.path.abspath(a.out))
    # 保护：只清空「空目录 / 本脚本上次生成的目录」，其它有内容的目录（含 <repo>/deploy、<repo>/tests）一律拒绝，什么都不删
    why = refuse_reason(out)
    if why:
        print("拒绝：" + why, file=sys.stderr)
        return 2

    vfiles = vendor_files()
    if not any(f.endswith("/pdf.min.js") for f in vfiles) or not any(f.endswith("/pdf.worker.min.js") for f in vfiles):
        print("缺少 %s/pdf.min.js 或 pdf.worker.min.js：先把 pdf.js 放进仓库（见 vendor/pdfjs/README.md）" % VENDOR_SRC, file=sys.stderr)
        return 2
    lfiles = libarchive_files()
    for need in ("libarchive.js", "worker-bundle.js", "libarchive.wasm"):
        if not any(f.endswith("/" + need) for f in lfiles):
            print("缺少 %s/%s：先把 libarchive.js 放进仓库（见 vendor/libarchive/README.md）" % (LIBARCHIVE_SRC, need), file=sys.stderr)
            return 2
    blobs = {}
    for src, dst in FILES + [(f, f) for f in vfiles + lfiles]:
        data = read(src)
        blobs[dst] = data if is_binary(dst) else normalize_eol(data)   # 文本统一 LF（图标 / vendor 是二进制，原样）：CRLF / LF 检出出同样的包、同样的 build 号
    h = hashlib.sha256()
    for dst in sorted(blobs):
        h.update(dst.encode("utf-8")); h.update(blobs[dst])
    build = h.hexdigest()[:10]
    sw = normalize_eol(read("sw.js")).decode("utf-8")   # sw.js 不参与哈希（里面是占位符），但输出同样统一成 LF
    if "__BUILD__" not in sw:
        print("sw.js 里没有 __BUILD__ 占位符", file=sys.stderr)
        return 2
    blobs["sw.js"] = sw.replace("__BUILD__", build).encode("utf-8")

    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out)
    with open(os.path.join(out, MARKER), "w", encoding="utf-8") as f:
        f.write("generated by deploy/build_iv_static.py; this directory may be wiped and rebuilt by it\n")
    for dst, data in blobs.items():
        p = os.path.join(out, *dst.split("/"))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(data)
    print("build", build, "->", out)
    for dst in sorted(blobs):
        if not dst.startswith("vendor/") or dst.endswith((".min.js", ".wasm", "worker-bundle.js")):     # vendor 里一百多个 cmap / 字体不逐个列
            print("  %-26s %9d bytes" % (dst, len(blobs[dst])))
    nv = [d for d in blobs if d.startswith(VENDOR_SRC + "/")]
    print("  vendor/pdfjs: %d files, %d bytes" % (len(nv), sum(len(blobs[d]) for d in nv)))
    nl = [d for d in blobs if d.startswith(LIBARCHIVE_SRC + "/")]
    print("  vendor/libarchive: %d files, %d bytes" % (len(nl), sum(len(blobs[d]) for d in nl)))

    if not a.no_tar:
        tgz = out.rstrip("/\\") + ".tgz"
        with tarfile.open(tgz, "w:gz") as t:
            for dst in sorted(blobs):
                t.add(os.path.join(out, *dst.split("/")), arcname=dst)
        print("tar ->", tgz)
    return 0


if __name__ == "__main__":
    sys.exit(main())
