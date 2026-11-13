# -*- coding: utf-8 -*-
"""网页版本地后端（路线 B）。

让 `image-viewer.html` 在 http://127.0.0.1:PORT 下跑，从而解锁 file:// 做不到的事：

* **rar / cbr**：直接复用桌面版的 rarfile + 7-Zip/WinRAR 后端
* **PDF 漫画**：复用 PyMuPDF 按页渲染成 PNG，网页版照样能双页/去边/纸质
* **绝对路径**：目录浏览、章节、播放列表、历史不再受浏览器沙箱限制
* **共享进度**：读写同一个 `image_viewer.json`，桌面版和网页版进度互通
* 顺带：IndexedDB 可用（能记住目录句柄）、CORS 变成同源（网盘/投屏后面接）

安全边界：只绑 127.0.0.1；每次启动随机 token，HTML 里带上，API 必须带 token；
只允许读取媒体类扩展名（不会变成任意文件读取器）。

用法：
    python web_backend.py                 # 起服务并打开浏览器
    python web_backend.py --port 8765 --no-browser
    python image_viewer.py --serve        # 从桌面版菜单里启动
"""

import hashlib
import io
import json
import os
import re
import secrets
import mimetypes
import socket
import sys
import tempfile
import threading
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from media_source import (IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS, ARCHIVE_EXTS, PDF_EXTS,
                          RAR_EXTS, media_files_in, build_zip_chapters, natural_key, is_junk)
import config_store

APP_DIR = os.path.dirname(os.path.abspath(__file__))
# 打包成 exe 后：HTML 在 PyInstaller 的 _MEIPASS 里，进度文件跟着 exe 走，
# 和桌面版读写同一个 image_viewer.json。
_RES = getattr(sys, '_MEIPASS', None) or APP_DIR
_DATA = (os.path.dirname(os.path.abspath(sys.executable))
         if getattr(sys, 'frozen', False) else APP_DIR)
# 测试可用 IV_CONFIG 指到临时文件，别碰用户真实的 image_viewer.json
CONFIG_PATH = os.environ.get("IV_CONFIG") or os.path.join(_DATA, "image_viewer.json")
HTML_PATH = os.path.join(_RES, "image-viewer.html")
API_VERSION = 1

# 只允许这些扩展名被当作文件读出来（图片/视频/音频/压缩包/PDF）
SERVABLE = IMAGE_EXTS | VIDEO_EXTS | AUDIO_EXTS | ARCHIVE_EXTS | PDF_EXTS

# 这些接口拿的是「本机磁盘路径」，必须先过白名单；/api/remote/* 走的是网盘路径
# （可能是目录、也可能是远端任意文件名），不能套本地这条规则。
LOCAL_PATH_ROUTES = {"/api/archive", "/api/data", "/api/thumb", "/api/pdf", "/api/pdfpage",
                     "/api/subtitle", "/api/videoresume"}

# 视频：Content-Type 显式给出（Windows 的 mimetypes 读注册表，不可靠）。
# BROWSER_VIDEO_EXTS 是主流浏览器原生能播的容器（里面的编码仍可能不支持，由前端 canPlayType / error 事件判断）；
# 其余视频扩展名（mkv/avi/wmv...）照样可列出、可读，但前端会提示「浏览器不支持」。
VIDEO_MIME = {
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg",
    ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
    ".wmv": "video/x-ms-wmv", ".flv": "video/x-flv", ".ts": "video/mp2t",
    ".mpg": "video/mpeg", ".mpeg": "video/mpeg", ".3gp": "video/3gpp",
}
BROWSER_VIDEO_EXTS = {".mp4", ".m4v", ".webm", ".ogv", ".mov"}
SUBTITLE_EXTS = {".srt", ".vtt", ".ass", ".ssa"}
SUBTITLE_MAX_BYTES = 4 * 1024 * 1024
STREAM_CHUNK = 256 * 1024

# 浏览器选中的文件上传到后端的上限（只走 127.0.0.1，不跨机器）
UPLOAD_MAX_BYTES = 512 * 1024 * 1024

# 本机页面的在线朗读转发到这里（可用环境变量 IV_TTS_BASE 覆盖）
TTS_BASE = "https://gary-pyreader.eastasia.cloudapp.azure.com"

# 可选依赖，缺了就降级（网页版会收到 caps 提示）
try:
    import rarfile
except Exception:
    rarfile = None
try:
    import fitz  # PyMuPDF
except Exception:
    fitz = None
try:
    from PIL import Image
except Exception:
    Image = None


def unrar_candidates():
    return (r"C:\Program Files\WinRAR\UnRAR.exe", r"C:\Program Files (x86)\WinRAR\UnRAR.exe")


def sevenzip_candidates():
    return (r"C:\Program Files\7-Zip\7z.exe", r"C:\Program Files (x86)\7-Zip\7z.exe")


def configure_rar_tool():
    """给 rarfile 找解压后端：优先随程序分发的目录，其次系统安装位置，最后 PATH。

    与桌面版 image_viewer._find_rar_backend 同一套顺序，只是这里不弹 UI。
    """
    if rarfile is None:
        return False
    app_dirs = [APP_DIR]
    fixed = [
        ("UNRAR_TOOL", ("UnRAR.exe", "unrar", "unrar-free"), unrar_candidates()),
        ("UNAR_TOOL", ("unar",), ()),
        ("SEVENZIP_TOOL", ("7z.exe", "7z", "7za", "7zz"), sevenzip_candidates()),
        ("SEVENZIP2_TOOL", ("7z.exe", "7zz"), sevenzip_candidates()),
        ("BSDTAR_TOOL", ("bsdtar",), ()),
    ]
    import shutil
    for attr, names, paths in fixed:
        found = None
        for d in app_dirs:
            for n in names:
                cand = os.path.join(d, n)
                if os.path.isfile(cand):
                    found = cand
                    break
            if found:
                break
        if not found:
            for p in paths:
                if os.path.isfile(p):
                    found = p
                    break
        if not found:
            for n in names:
                found = shutil.which(n)
                if found:
                    break
        if found:
            setattr(rarfile, attr, found)
    try:
        rarfile.tool_setup(force=True)
        return True
    except Exception:
        return False


def ext_of(path):
    return os.path.splitext(path)[1].lower()


def is_servable(path):
    """只允许媒体扩展名被读出来，避免变成任意文件读取器。"""
    ext = os.path.splitext(path)[1].lower()
    return ext in SERVABLE


def list_dir(directory, recursive=True):
    """列目录。返回 {dir, entries:[{name, rel, path, size, mtime, kind}]}。

    rel 是相对 directory 的路径（网页版靠它分章节）。
    """
    directory = os.path.abspath(directory)
    if not os.path.isdir(directory):
        raise NotADirectoryError(directory)
    out = []
    if recursive:
        for p in media_files_in(directory):
            out.append(_entry(p, directory))
    else:
        for name in sorted(os.listdir(directory), key=natural_key):
            p = os.path.join(directory, name)
            if os.path.isdir(p):
                out.append({"name": name, "rel": name, "path": p,
                            "size": None, "mtime": _mtime(p), "kind": "dir"})
            elif os.path.splitext(name)[1].lower() in SERVABLE:
                out.append(_entry(p, directory))
    return {"dir": directory, "entries": out}


def _mtime(p):
    try:
        return int(os.path.getmtime(p))
    except OSError:
        return 0


def _entry(path, root=None):
    ext = os.path.splitext(path)[1].lower()
    kind = ("image" if ext in IMAGE_EXTS else
            "video" if ext in VIDEO_EXTS else
            "audio" if ext in AUDIO_EXTS else
            "pdf" if ext in PDF_EXTS else
            "archive" if ext in ARCHIVE_EXTS else "other")
    rel = os.path.relpath(path, root).replace("\\", "/") if root else path
    try:
        size = os.path.getsize(path)
    except OSError:
        size = None
    return {"name": os.path.basename(path), "rel": rel, "path": path.replace("\\", "/"),
            "size": size, "mtime": _mtime(path), "kind": kind}


# ----------------------------- 手机 / VLC 播放列表 -----------------------------
# 只在 m3u 里放 VLC 真能播的：图片 / 视频 / 音频（PDF 页是给浏览器的，不放）。
PLAY_EXTS = IMAGE_EXTS | VIDEO_EXTS | AUDIO_EXTS


def _quote_all(**kw):
    return "&".join("%s=%s" % (k, urllib.parse.quote(str(v))) for k, v in kw.items())


def media_items(path, base, token):
    """把 path（目录 / 单文件 / 压缩包）展开成 [(显示名, 绝对 URL)]。"""
    tq = urllib.parse.quote(token)

    def url_for(p, entry=None):
        qs = _quote_all(path=p, entry=entry) if entry else _quote_all(path=p)
        return "%s/api/data?%s&t=%s" % (base, qs, tq)

    out = []
    ext = os.path.splitext(path)[1].lower()
    if os.path.isdir(path):
        for p in media_files_in(path):
            if os.path.splitext(p)[1].lower() in PLAY_EXTS:
                out.append((os.path.relpath(p, path).replace("\\", "/"), url_for(p)))
    elif ext in ARCHIVE_EXTS:
        for e in archive_entries(path):
            if os.path.splitext(e["name"])[1].lower() in PLAY_EXTS:
                out.append((e["name"], url_for(path, entry=e["name"])))
    elif os.path.isfile(path) and ext in PLAY_EXTS:
        out.append((os.path.basename(path), url_for(path)))
    return out


def build_m3u(path, base, token):
    """返回 (m3u 文本, 条目列表)。空结果也合法（VLC 会显示空列表）。"""
    items = media_items(path, base, token)
    lines = ["#EXTM3U"]
    for name, url in items:
        lines.append("#EXTINF:-1,%s" % name)
        lines.append(url)
    return "\n".join(lines) + "\n", items


def open_archive(path):
    """zip/cbz 用内置，rar/cbr 用 rarfile（需要 7-Zip 或 WinRAR）。"""
    import zipfile
    ext = os.path.splitext(path)[1].lower()
    if ext in RAR_EXTS:
        if rarfile is None:
            raise RuntimeError("读取 rar/cbr 需要 rarfile 库（pip install rarfile）")
        if not configure_rar_tool():
            raise RuntimeError("读取 rar/cbr 需要 7-Zip 或 WinRAR(UnRAR)，当前环境未检测到解压工具")
        return rarfile.RarFile(path)
    return zipfile.ZipFile(path)


def archive_entries(path):
    """压缩包条目列表（过滤目录条目与打包垃圾）。"""
    with open_archive(path) as z:
        out = []
        for info in z.infolist():
            name = str(getattr(info, "filename", "") or "").replace("\\", "/")
            if name.endswith("/") or is_junk(name):
                continue
            size = int(getattr(info, "file_size", 0) or 0)
            out.append({"name": name, "size": size})
        return out


def archive_chapters(path):
    """按顶层目录分章节，同桌面版 build_zip_chapters。"""
    with open_archive(path) as z:
        return build_zip_chapters(path, z.namelist())


def archive_read(path, name):
    """读压缩包里的一个条目字节。"""
    with open_archive(path) as z:
        return z.read(name)


def pdf_page_count(path):
    if fitz is None:
        raise RuntimeError("读取 PDF 需要 PyMuPDF（pip install pymupdf）")
    doc = fitz.open(path)
    try:
        return doc.page_count
    finally:
        doc.close()


def pdf_render(path, page_index, scale=2.0):
    """渲染 PDF 某一页为 PNG 字节。"""
    if fitz is None or Image is None:
        raise RuntimeError("读取 PDF 需要 PyMuPDF + Pillow")
    doc = fitz.open(path)
    try:
        if page_index < 0 or page_index >= doc.page_count:
            raise IndexError("PDF 页码超出范围")
        pix = doc.load_page(page_index).get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        buf = io.BytesIO()
        img.save(buf, "PNG", optimize=True)
        return buf.getvalue()
    finally:
        doc.close()


def make_thumbnail(path, entry=None, width=160):
    """服务端出缩略图（比浏览器整图解码快得多）。返回 PNG 字节。"""
    if Image is None:
        raise RuntimeError("缩略图需要 Pillow")
    width = max(16, min(int(width or 160), 512))
    if entry:
        data = archive_read(path, entry)
        src = io.BytesIO(data)
    else:
        src = open(path, "rb")
    try:
        im = Image.open(src)
        im.load()
        if getattr(im, "n_frames", 1) > 1:
            im.seek(0)
        im.thumbnail((width * 2, width * 3), Image.LANCZOS)
        if im.mode not in ("RGB", "RGBA", "L"):
            im = im.convert("RGB")
        buf = io.BytesIO()
        im.save(buf, "PNG", optimize=True)
        return buf.getvalue()
    finally:
        try:
            src.close()
        except Exception:
            pass


class RangeNotSatisfiable(Exception):
    pass


def parse_range(header, size):
    """解析 HTTP Range 头（只支持单段 bytes）。

    返回 None（没有 Range / 不是 bytes 单位 / 多段 -> 按整文件 200 回）或 (start, end)（含端点）。
    无法满足（起点越界、后缀长度为 0、语法非法）-> 抛 RangeNotSatisfiable（调用方回 416）。
    """
    if not header:
        return None
    h = header.strip()
    if not h.lower().startswith("bytes="):
        return None
    spec = h[6:].strip()
    if "," in spec:                      # 多段：浏览器播放视频不会发；按规范可以忽略 Range
        return None
    a, sep, b = spec.partition("-")
    a, b = a.strip(), b.strip()
    if not sep or not (a or b) or not (a.isdigit() or a == "") or not (b.isdigit() or b == ""):
        raise RangeNotSatisfiable(header)
    if a == "":                          # 后缀：最后 N 字节
        n = int(b)
        if n == 0 or size == 0:
            raise RangeNotSatisfiable(header)
        return max(0, size - n), size - 1
    start = int(a)
    end = int(b) if b else size - 1
    if start >= size or (b and end < start):
        raise RangeNotSatisfiable(header)
    return start, min(end, size - 1)


def video_mime(path):
    ext = os.path.splitext(path)[1].lower()
    return VIDEO_MIME.get(ext) or mimetypes.guess_type(path)[0] or "application/octet-stream"


def find_sidecar_subtitles(video_path):
    """同目录下与视频同主名的字幕：foo.mp4 -> foo.srt / foo.zh.srt / foo.en.vtt ...（只看兄弟文件，便宜）。"""
    d = os.path.dirname(os.path.abspath(video_path))
    stem = os.path.splitext(os.path.basename(video_path))[0].lower()
    out = []
    try:
        names = sorted(os.listdir(d), key=natural_key)
    except OSError:
        return out
    for n in names:
        ext = os.path.splitext(n)[1].lower()
        if ext not in SUBTITLE_EXTS:
            continue
        base = os.path.splitext(n)[0].lower()
        if base == stem or base.startswith(stem + "."):
            full = os.path.join(d, n)
            if os.path.isfile(full):
                out.append({"name": n, "ext": ext[1:], "size": os.path.getsize(full)})
    return out


def read_sidecar_subtitle(video_path, name):
    """读视频旁的字幕原始字节。name 必须是 find_sidecar_subtitles 列出的纯文件名，不能带路径。"""
    if name != os.path.basename(name) or "/" in name or chr(92) in name:
        raise PermissionError("不允许读取该文件")
    if not any(s["name"] == name for s in find_sidecar_subtitles(video_path)):
        raise PermissionError("不允许读取该文件")
    full = os.path.join(os.path.dirname(os.path.abspath(video_path)), name)
    if os.path.getsize(full) > SUBTITLE_MAX_BYTES:
        raise PermissionError("字幕文件太大")
    with open(full, "rb") as f:
        return f.read()


def read_file(path, start=0, length=None):
    """按 Range 读本地文件（视频/大图用）。"""
    if not is_servable(path) or not os.path.isfile(path):
        raise PermissionError("不允许读取该文件")
    size = os.path.getsize(path)
    start = max(0, min(int(start or 0), size))
    if length is None:
        end = size - 1
    else:
        end = min(size - 1, start + int(length) - 1)
    if end < start:
        return b"", start, 0, size
    with open(path, "rb") as f:
        f.seek(start)
        data = f.read(end - start + 1)
    return data, start, end, size


def progress_store():
    """共享阅读进度：直接读写桌面版的 image_viewer.json。"""
    return config_store.load_config(CONFIG_PATH)


def progress_save(book_key, record):
    cfg = config_store.load_config(CONFIG_PATH)
    if not isinstance(record, dict):
        raise ValueError("进度记录必须是对象")
    cfg[book_key] = record
    config_store.save_config(CONFIG_PATH, cfg)
    return True


# 视频续播点：和桌面版共用 image_viewer.json 里的 "_video_resume_"（key = 规范化绝对路径，值 = 毫秒）
VIDEO_RESUME_KEY = "_video_resume_"
RESUME_MIN_MS = 3000          # 与桌面版一致：开头 3 秒内 / 结尾 3 秒内不记


def _resume_key(path):
    return os.path.normcase(os.path.abspath(path))


def video_resume_get(path):
    pos = (progress_store().get(VIDEO_RESUME_KEY) or {}).get(_resume_key(path))
    return int(pos) if isinstance(pos, (int, float)) and pos > 0 else None


def video_resume_save(path, position_ms, length_ms=0):
    """记下 / 清除续播点。返回写入后的值（None = 已清除）。只改 _video_resume_ 下这一项。"""
    cfg = config_store.load_config(CONFIG_PATH)
    resumes = cfg.get(VIDEO_RESUME_KEY)
    if not isinstance(resumes, dict):
        resumes = cfg[VIDEO_RESUME_KEY] = {}
    key = _resume_key(path)
    pos = int(position_ms or 0)
    length = int(length_ms or 0)
    if pos > RESUME_MIN_MS and (length <= 0 or pos < length - RESUME_MIN_MS):
        resumes[key] = pos
        out = pos
    else:
        resumes.pop(key, None)
        out = None
    config_store.save_config(CONFIG_PATH, cfg)
    return out


def capabilities():
    rar_ok = rarfile is not None and configure_rar_tool()
    return {
        "api": API_VERSION,
        "rar": bool(rar_ok),
        "pdf": fitz is not None,
        "pdfjs": os.path.isfile(os.path.join(_RES, "vendor", "pdfjs", "pdf.min.js")),
        "pillow": Image is not None,
        "webdav": True,
        "lan": bool(getattr(Handler, "lan", False)),
        "lan_url": getattr(Handler, "lan_url", "") or "",
        "extensions": sorted(SERVABLE),
        "video_exts": sorted(BROWSER_VIDEO_EXTS),
    }


# ----------------------------- 本地上传（给 file:// 选中的文件兼个落盘点）-----------------------------
UPLOAD_DIR = None


def upload_dir():
    global UPLOAD_DIR
    if UPLOAD_DIR is None:
        UPLOAD_DIR = os.path.join(tempfile.gettempdir(), "iv-uploads")
        os.makedirs(UPLOAD_DIR, exist_ok=True)
    return UPLOAD_DIR


def save_upload(name, data, mtime=None):
    """把浏览器选中的文件落成本地路径，这样 rar/cbr/PDF 能走同一套后端解析。

    同名同大小同 mtime 直接复用，不重复写盘。
    """
    safe = os.path.basename(str(name or "file")).replace("\x00", "")
    safe = re.sub(r"[^\w.\-\u4e00-\u9fff ]+", "_", safe) or "file"
    stem, ext = os.path.splitext(safe)
    tag = "%s-%s-%s" % (hashlib.sha1(safe.encode("utf-8", "replace")).hexdigest()[:8],
                        len(data), int(mtime or 0))
    path = os.path.join(upload_dir(), "%s.%s%s" % (stem, tag, ext))
    if not os.path.isfile(path):
        with open(path, "wb") as f:
            f.write(data)
    return path.replace("\\", "/")


# ----------------------------- 远程（WebDAV）-----------------------------
_remote_cache = {}


def remote_config():
    """读桌面版同一个配置段 _webdav_（两边共用凭据）。"""
    cfg = config_store.load_config(CONFIG_PATH) or {}
    return cfg.get("_webdav_") or {}


def remote_save_config(base_url, username, password):
    cfg = config_store.load_config(CONFIG_PATH) or {}
    cfg["_webdav_"] = {"base_url": base_url, "username": username, "password": password}
    config_store.save_config(CONFIG_PATH, cfg)
    _remote_cache.pop("webdav", None)
    return True


def remote_clear_config():
    cfg = config_store.load_config(CONFIG_PATH) or {}
    cfg.pop("_webdav_", None)
    config_store.save_config(CONFIG_PATH, cfg)
    _remote_cache.pop("webdav", None)


def get_webdav(rebuild=False):
    """根据配置构造 WebDavProvider（缓存）。没配置返回 None。"""
    if not rebuild and _remote_cache.get("webdav"):
        return _remote_cache["webdav"]
    cfg = remote_config()
    if not cfg.get("base_url"):
        return None
    import remote_source
    p = remote_source.WebDavProvider(cfg["base_url"], cfg.get("username", ""),
                                     cfg.get("password", ""))
    _remote_cache["webdav"] = p
    return p


def remote_list(path):
    p = get_webdav()
    if p is None:
        raise RuntimeError("还没配置 WebDAV（在网页版里点「☁ WebDAV」填写）")
    out = []
    for src in p.list_dir_strict(path or p.root_path, media_only=False):
        kind = "dir" if src.is_dir else (src.kind or "other")
        out.append({"name": src.name, "path": src.path, "rel": src.name,
                    "kind": kind, "size": src.size, "mtime": src.mtime})
    return {"path": path or p.root_path, "entries": out}


def remote_open(path, headers=None):
    """返回 (上游 response, 是否需要关闭)。"""
    p = get_webdav()
    if p is None:
        raise RuntimeError("还没配置 WebDAV")
    import remote_types
    src = remote_types.RemoteSource("webdav", path)
    return p.open_stream(src, headers or {})


def remote_fetch(path):
    resp = remote_open(path)
    try:
        return resp.read()
    finally:
        try:
            resp.close()
        except Exception:
            pass


def remote_thumbnail(path, width=160):
    if Image is None:
        raise RuntimeError("缩略图需要 Pillow")
    data = remote_fetch(path)
    im = Image.open(io.BytesIO(data))
    im.load()
    if getattr(im, "n_frames", 1) > 1:
        im.seek(0)
    im.thumbnail((max(16, int(width)), max(24, int(width) * 3)), Image.LANCZOS)
    if im.mode not in ("RGB", "RGBA", "L"):
        im = im.convert("RGB")
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def remote_local(path, mtime=None, size=None):
    """把远程包/PDF 下载到临时目录，后续复用本地 archive/pdf 逻辑。

    按 path+size+mtime 做缓存，同一个文件不重复下载。
    """
    tag = hashlib.sha1(("%s|%s|%s" % (path, size or "", mtime or "")).encode("utf-8", "replace")).hexdigest()[:12]
    base = os.path.basename(urllib.parse.unquote(path.rstrip("/"))) or "remote.bin"
    stem, ext = os.path.splitext(base)
    dest = os.path.join(upload_dir(), "remote-%s%s" % (tag, ext or ".bin"))
    if not os.path.isfile(dest):
        data = remote_fetch(path)
        with open(dest, "wb") as f:
            f.write(data)
    return dest.replace("\\", "/")


class Handler(BaseHTTPRequestHandler):
    server_version = "ImageViewerBackend/1.0"
    token = ""          # 启动时随机
    protocol_version = "HTTP/1.1"

    # ---------------- 小工具 ----------------
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _bytes(self, data, ctype, code=200, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _err(self, msg, code=400):
        self._json({"ok": False, "error": msg}, code)

    def _send_file(self, path, ctype, rng_header):
        """本地文件按 Range 流式发送（视频拖进度条靠它）。

        无 Range -> 200 整文件；合法 Range -> 206；不可满足 -> 416 + Content-Range: bytes */size。
        不把整段读进内存（几个 GB 的视频也行）。
        """
        size = os.path.getsize(path)
        try:
            rng = parse_range(rng_header, size)
        except RangeNotSatisfiable:
            body = b'{"ok": false, "error": "Range Not Satisfiable"}'
            self.send_response(416)
            self.send_header("Content-Range", "bytes */%d" % size)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
            return
        if rng is None:
            code, start, end = 200, 0, size - 1
        else:
            code, (start, end) = 206, rng
        length = max(0, end - start + 1) if size else 0
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "private, max-age=60")
        if code == 206:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.end_headers()
        if self.command == "HEAD" or not length:
            return
        try:
            with open(path, "rb") as f:
                f.seek(start)
                left = length
                while left > 0:
                    chunk = f.read(min(STREAM_CHUNK, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (ConnectionError, OSError):
            self.close_connection = True      # 浏览器拖进度条会中断上一个请求，属正常

    def _ok_token(self, q):
        return (q.get("t") or [""])[0] == self.token

    def log_message(self, fmt, *args):
        if os.environ.get("IV_BACKEND_VERBOSE"):
            super().log_message(fmt, *args)

    # ---------------- 路由 ----------------
    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path in ("/", "/image-viewer.html"):
            return self._serve_html()
        if u.path.startswith("/vendor/pdfjs/"):
            return self._serve_pdfjs(u.path)
        if u.path.startswith(("/tts/v1/", "/ocr/v1/")):
            return self._tts_relay(u.path)
        if u.path == "/api/ping":
            return self._json({"ok": True, "token": self.token, **capabilities()})
        if not self._ok_token(q):
            return self._err("缺少 token（请通过后端页面访问）", 403)
        try:
            return self._api(u.path, q)
        except Exception as e:
            return self._err("%s: %s" % (type(e).__name__, e))

    def do_HEAD(self):
        return self.do_GET()

    # 本机页面 -> 线上服务的中转白名单：前缀 -> (允许的接口名, POST 体上限字节, 超时秒)
    _RELAYS = {
        "/tts/v1/": (("speak", "voices", "usage"), 8192, 30),
        "/ocr/v1/": (("page", "usage"), 2 * 1024 * 1024, 45),     # AI 朗读：一页 JPEG 的 base64，最大约 1.6MB
    }

    def _tts_relay(self, route):
        """本机页面的线上服务中转（/tts/v1/* 在线朗读、/ocr/v1/* AI 朗读识别页面）：浏览器不能跨域直连线上（线上不回 CORS 预检），
        所以由本地后端把请求原样转给线上 PyReader 服务。令牌就是请求里的 Authorization，后端不保存、不检查；
        只放行白名单里的接口；请求体上限按路由区分（tts 8KB，ocr 2MB），其余限制不变。"""
        prefix = next((p for p in self._RELAYS if route.startswith(p)), None)
        if prefix is None:
            return self._err("未知接口 %s" % route, 404)
        names, max_body, timeout = self._RELAYS[prefix]
        name = route[len(prefix):]
        if name not in names:
            return self._err("未知接口 %s" % route, 404)
        import urllib.request
        base = (os.environ.get("IV_TTS_BASE") or TTS_BASE).rstrip("/")
        n = int(self.headers.get("Content-Length") or 0) if self.command == "POST" else 0
        if n > max_body:
            self.close_connection = True          # 体没读：别让残留字节被当成下一个请求
            return self._err("请求太大", 413)
        data = self.rfile.read(n) if n else None
        req = urllib.request.Request(
            "%s%s%s" % (base, prefix, name), data=data, method=self.command,
            headers={"Authorization": self.headers.get("Authorization", ""),
                     "Content-Type": self.headers.get("Content-Type", "application/json")})
        extra = {"Cache-Control": "no-store"}
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body, code, ctype = r.read(), r.status, r.headers.get("Content-Type", "application/octet-stream")
        except urllib.error.HTTPError as e:
            body, code, ctype = e.read(), e.code, e.headers.get("Content-Type", "application/json")
            if e.headers.get("Retry-After"):
                extra["Retry-After"] = e.headers.get("Retry-After")        # 429 的等待时间要让页面看到
        except Exception as e:
            return self._err("线上服务连不上：%s: %s" % (type(e).__name__, e), 502)
        return self._bytes(body, ctype, code, extra=extra)

    def _serve_pdfjs(self, path):
        """只读托管 vendor/pdfjs（浏览器端 pdf.js 要用）：限定在该目录内，拒绝 .. 穿越。"""
        root = os.path.realpath(os.path.join(_RES, "vendor", "pdfjs"))
        rel = urllib.parse.unquote(path[len("/vendor/pdfjs/"):])
        full = os.path.realpath(os.path.join(root, rel))
        try:
            inside = bool(rel) and os.path.commonpath([root, full]) == root
        except ValueError:                      # Windows 上 rel 带盘符会落到别的盘
            inside = False
        if not inside or not os.path.isfile(full):
            return self._err("not found", 404)
        ctype = ("text/javascript" if full.endswith((".js", ".mjs"))
                 else mimetypes.guess_type(full)[0] or "application/octet-stream")
        with open(full, "rb") as f:
            return self._bytes(f.read(), ctype, extra={"Cache-Control": "max-age=3600"})

    def _serve_html(self):
        try:
            with open(HTML_PATH, "rb") as f:
                html = f.read()
        except OSError as e:
            return self._err("找不到 image-viewer.html：%s" % e, 500)
        # 把 token 注入页面（file:// 直接打开时这段不存在，前端会自动降级）
        html = html.replace(
            b"</head>",
            ("<script>window.__IV_TOKEN=%s;window.__IV_BACKEND=1;</script></head>"
             % json.dumps(Handler.token)).encode("utf-8"))
        self._bytes(html, "text/html; charset=utf-8",
                    extra={"Cache-Control": "no-store"})

    def _abs_base(self):
        """绝对 URL 前缀：优先用请求里的 Host（手机访问时就是局域网 IP）。"""
        host = (self.headers.get("Host") or "").strip()
        if host:
            return "http://" + host
        return Handler.lan_url.rstrip("/") if getattr(Handler, "lan_url", "") else \
            _instance.get("url", "").rstrip("/")

    def _api(self, route, q):
        path = (q.get("path") or [""])[0]
        # 防越权：凡拿本机磁盘路径的接口都先过媒体扩展名白名单（目录列表、网盘转发除外）
        if route in LOCAL_PATH_ROUTES and path and not is_servable(path):
            raise PermissionError("不允许读取该文件")
        if route == "/api/ls":
            rec = (q.get("recursive", ["1"])[0] != "0")
            return self._json({"ok": True, **list_dir(path, recursive=rec)})
        if route == "/api/m3u":
            text, items = build_m3u(path, self._abs_base(), Handler.token)
            return self._bytes(text.encode("utf-8"),
                               "audio/x-mpegurl; charset=utf-8",
                               extra={"Cache-Control": "no-store",
                                      "X-Item-Count": str(len(items)),
                                      "Content-Disposition": 'inline; filename="playlist.m3u"'})
        if route == "/api/archive":
            ents = archive_entries(path)
            return self._json({"ok": True, "path": path.replace("\\", "/"),
                               "entries": ents, "chapters": archive_chapters(path)})
        if route == "/api/pdf":
            n = pdf_page_count(path)
            return self._json({"ok": True, "path": path.replace("\\", "/"), "pages": n})
        if route == "/api/data":
            entry = (q.get("entry") or [""])[0]
            if entry:
                data = archive_read(path, entry)
                return self._bytes(data, mimetypes.guess_type(entry)[0] or "application/octet-stream",
                                   extra={"Cache-Control": "private, max-age=60"})
            if not is_servable(path) or not os.path.isfile(path):
                raise PermissionError("不允许读取该文件")
            ctype = (video_mime(path) if ext_of(path) in VIDEO_EXTS
                     else mimetypes.guess_type(path)[0] or "application/octet-stream")
            # 真正的 Range 请求头优先（<video> 用）；保留 ?range=bytes=a-b 给不能带头的调用方
            rng = self.headers.get("Range") or (q.get("range") or [""])[0]
            return self._send_file(path, ctype, rng)
        if route == "/api/subtitle":
            name = (q.get("name") or [""])[0]
            if ext_of(path) not in VIDEO_EXTS:
                raise PermissionError("不允许读取该文件")
            if not name:
                return self._json({"ok": True, "subs": find_sidecar_subtitles(path)})
            return self._bytes(read_sidecar_subtitle(path, name), "application/octet-stream",
                               extra={"Cache-Control": "no-store"})
        if route == "/api/thumb":
            width = int((q.get("w") or ["160"])[0])
            entry = (q.get("entry") or [""])[0]
            data = make_thumbnail(path, entry or None, width)
            return self._bytes(data, "image/png", extra={"Cache-Control": "private, max-age=3600"})
        if route == "/api/pdfpage":
            page = int((q.get("page") or ["0"])[0])
            scale = float((q.get("scale") or ["2.0"])[0])
            data = pdf_render(path, page, scale)
            return self._bytes(data, "image/png", extra={"Cache-Control": "private, max-age=300"})
        if route == "/api/videoresume":
            if ext_of(path) not in VIDEO_EXTS:
                raise PermissionError("不允许读取该文件")
            return self._json({"ok": True, "ms": video_resume_get(path)})
        if route == "/api/progress":
            return self._json({"ok": True, "path": CONFIG_PATH.replace("\\", "/"),
                               "books": progress_store()})
        # ---------------- 上传（浏览器选中的文件落到本地，走同一套 rar/pdf 解析）----------------
        if route == "/api/upload":
            return self._err("/api/upload 请用 POST", 405)
        # ---------------- 远程（WebDAV）----------------
        if route == "/api/remote/config":
            cfg = remote_config()
            return self._json({"ok": True, "connected": bool(cfg.get("base_url")),
                               "base_url": cfg.get("base_url", ""),
                               "username": cfg.get("username", ""),
                               "has_password": bool(cfg.get("password"))})
        if route == "/api/remote/ls":
            return self._json({"ok": True, **remote_list((q.get("path") or [""])[0])})
        if route == "/api/remote/data":
            return self._remote_data(q)
        if route == "/api/remote/thumb":
            data = remote_thumbnail((q.get("path") or [""])[0],
                                    int((q.get("w") or ["160"])[0]))
            return self._bytes(data, "image/png",
                               extra={"Cache-Control": "private, max-age=3600"})
        if route == "/api/remote/local":
            p = (q.get("path") or [""])[0]
            local = remote_local(p, q.get("mtime", [""])[0], q.get("size", [""])[0])
            return self._json({"ok": True, "path": local})
        return self._err("未知接口 %s" % route, 404)

    def _remote_data(self, q):
        """把 WebDAV 字节转发给浏览器（图/PDF/视频都能用，保留 Range）。"""
        path = (q.get("path") or [""])[0]
        headers = {}
        rng = self.headers.get("Range") or (q.get("range") or [""])[0]
        if rng:
            headers["Range"] = rng
        resp = remote_open(path, headers)
        try:
            status = getattr(resp, "status", None) or resp.getcode()
            ctype = (resp.headers.get("Content-Type") if resp.headers else None) \
                or mimetypes.guess_type(path)[0] or "application/octet-stream"
            data = resp.read()
        finally:
            try:
                resp.close()
            except Exception:
                pass
        extra = {"Accept-Ranges": "bytes", "Cache-Control": "private, max-age=60"}
        if resp.headers:
            cr = resp.headers.get("Content-Range")
            if cr:
                extra["Content-Range"] = cr
        return self._bytes(data, ctype, code=status if status in (200, 206) else 200,
                           extra=extra)

    # ---------------- 写接口 ----------------
    def _read_json_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            return json.loads(raw.decode("utf-8")) if raw else {}
        except Exception as e:
            raise ValueError("请求体不是合法 JSON：%s" % e)

    def do_POST(self):
        self._write(urlparse(self.path).path, parse_qs(urlparse(self.path).query))

    def do_PUT(self):
        self._write(urlparse(self.path).path, parse_qs(urlparse(self.path).query))

    def _write(self, route, q):
        if route.startswith(("/tts/v1/", "/ocr/v1/")) and self.command == "POST":
            return self._tts_relay(route)
        if not self._ok_token(q):
            return self._err("缺少 token", 403)
        try:
            if route == "/api/progress":
                body = self._read_json_body()
                key = str(body.get("key") or "")
                if not key:
                    return self._err("缺少 key")
                progress_save(key, body.get("record") or {})
                return self._json({"ok": True})
            if route == "/api/videoresume":
                body = self._read_json_body()
                vpath = str(body.get("path") or "")
                if ext_of(vpath) not in VIDEO_EXTS or not is_servable(vpath):
                    raise PermissionError("不允许读取该文件")
                ms = video_resume_save(vpath, body.get("ms"), body.get("length"))
                return self._json({"ok": True, "ms": ms})
            if route == "/api/upload":
                name = (q.get("name") or ["file"])[0]
                mtime = (q.get("mtime") or ["0"])[0]
                n = int(self.headers.get("Content-Length") or 0)
                if n <= 0:
                    return self._err("空文件")
                if n > UPLOAD_MAX_BYTES:
                    return self._err("文件太大（> %d MB），请用桌面版"
                                     % (UPLOAD_MAX_BYTES // (1024 * 1024)))
                data = self.rfile.read(n)
                return self._json({"ok": True, "path": save_upload(name, data, mtime)})
            if route == "/api/remote/config":
                body = self._read_json_body()
                url = str(body.get("base_url") or "").strip()
                if not url:
                    return self._err("请填写 WebDAV 地址")
                user = str(body.get("username") or "").strip()
                pw = str(body.get("password") or "")
                import remote_source
                p = remote_source.WebDavProvider(url, user, pw)
                p.list_dir_strict(p.root_path)      # 连通性自检：失败就抛出，不保存凭据
                remote_save_config(url, user, pw)
                return self._json({"ok": True, "base_url": url, "root": p.root_path})
            if route == "/api/remote/disconnect":
                remote_clear_config()
                return self._json({"ok": True})
            return self._err("未知接口 %s" % route, 404)
        except Exception as e:
            return self._err("%s: %s" % (type(e).__name__, e))


def serve(port=0, open_browser=True, token=None, host="127.0.0.1", lan=False):
    """起服务，返回 (server, thread, url)。port=0 时随机端口。

    host="127.0.0.1" 只本机可访问；lan=True 时绑 0.0.0.0，手机/电视/VLC 同 Wi-Fi 可连。
    """
    if lan:
        host = "0.0.0.0"
    Handler.token = token or secrets.token_urlsafe(12)
    httpd = ThreadingHTTPServer((host, port), Handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True, name="iv-backend")
    t.start()
    real_port = httpd.server_address[1]
    ip = "127.0.0.1"
    if host not in ("127.0.0.1", "localhost"):
        ip = lan_ip() or "127.0.0.1"
    url = "http://%s:%d/" % (ip, real_port)
    Handler.lan = bool(host not in ("127.0.0.1", "localhost"))
    Handler.lan_url = url if Handler.lan else ""
    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    return httpd, t, url


_instance = {}


def lan_ip():
    """本机局域网 IPv4（只用来拼 URL，不真发包）。"""
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("192.168.255.255", 1))       # 不实际发送，只为让系统选出网卡
        return s.getsockname()[0]
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return ""
    finally:
        try:
            if s is not None:
                s.close()
        except Exception:
            pass


def _safe_print(msg):
    """Windows 控制台经常是 GBK：遇到 emoji/方块字不能直接 print，否则整个进程崩。"""
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        enc = getattr(sys.stdout, "encoding", None) or "utf-8"
        print(str(msg).encode(enc, "replace").decode(enc, "replace"), flush=True)


def print_qr(url):
    """终端 + PNG 二维码。没装 qrcode 就只打 URL（不报错、不联网）。

    终端只用 ASCII（##/空格）画，避开 GBK 控制台拦方块的炕；PNG 用于弹窗扫码。
    """
    try:
        import qrcode
    except Exception:
        _safe_print("（没装 qrcode，只给地址：pip install qrcode 可生成二维码）")
        return False
    try:
        q = qrcode.QRCode(border=1)
        q.add_data(url)
        q.make(fit=True)
        for row in q.get_matrix():
            _safe_print("".join("##" if v else "  " for v in row))
        png = os.path.join(tempfile.gettempdir(), "iv-web-qr.png")
        q.make_image().save(png)
        _safe_print("二维码图片：%s" % png)
        return png
    except Exception as e:
        _safe_print("二维码生成失败：%s" % e)
        return False


def start_server(port=0, open_browser=True, lan=False):
    """给桌面版用：起后端（已起则直接复用），返回 URL。"""
    if _instance.get("httpd"):
        url = _instance["url"]
        if open_browser:
            try:
                webbrowser.open(url)
            except Exception:
                pass
        return url
    httpd, t, url = serve(port, open_browser=open_browser, lan=lan)
    _instance.update(httpd=httpd, thread=t, url=url, lan=lan)
    return url


def stop_server():
    """关后端（桌面版退出时调）。"""
    httpd = _instance.get("httpd")
    if httpd:
        try:
            httpd.shutdown()
            httpd.server_close()
        except Exception:
            pass
    _instance.clear()


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="图片/漫画浏览器 网页版本地后端")
    ap.add_argument("--port", type=int, default=0, help="端口，默认随机")
    ap.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    ap.add_argument("--token", default=None, help="固定 token（默认随机）")
    ap.add_argument("--lan", action="store_true",
                    help="绑 0.0.0.0，手机/VLC/电视同 Wi-Fi 可访问（默认只本机）")
    args = ap.parse_args(argv)
    httpd, t, url = serve(args.port, open_browser=not args.no_browser,
                          token=args.token, lan=args.lan)
    print("网页版后端已启动：%s" % url, flush=True)
    if args.lan:
        print("手机/平板（同 Wi-Fi）直接输上面这个地址；VLC 用「网络串流」输", flush=True)
        print("    %sapi/m3u?path=<目录或压缩包绝对路径>&t=<token>" % url, flush=True)
        print("token（页面会自动带上，VLC 需手动拼）：%s" % Handler.token, flush=True)
        _safe_print("注意：只在可信局域网开 --lan；公网请走 VPN/Tunnel")
        png = print_qr(url)
        if png and not args.no_browser:
            try:
                os.startfile(png)          # Windows：弹图片查看器，手机扫屏幕
            except Exception:
                pass
    print("能力：%s" % json.dumps(capabilities(), ensure_ascii=False), flush=True)
    print("Ctrl+C 停止", flush=True)
    try:
        t.join()
    except KeyboardInterrupt:
        httpd.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
