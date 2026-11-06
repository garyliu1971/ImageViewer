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

# 浏览器选中的文件上传到后端的上限（只走 127.0.0.1，不跨机器）
UPLOAD_MAX_BYTES = 512 * 1024 * 1024

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


def capabilities():
    rar_ok = rarfile is not None and configure_rar_tool()
    return {
        "api": API_VERSION,
        "rar": bool(rar_ok),
        "pdf": fitz is not None,
        "pillow": Image is not None,
        "webdav": True,
        "extensions": sorted(SERVABLE),
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

    def _api(self, route, q):
        path = (q.get("path") or [""])[0]
        # 防越权：凡拿磁盘路径的接口都先过媒体扩展名白名单（目录列表除外）
        if route != "/api/ls" and path and not is_servable(path):
            raise PermissionError("不允许读取该文件")
        if route == "/api/ls":
            rec = (q.get("recursive", ["1"])[0] != "0")
            return self._json({"ok": True, **list_dir(path, recursive=rec)})
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
            rng = (q.get("range") or [""])[0]
            start, length = 0, None
            if rng.startswith("bytes="):
                a, _, b = rng[6:].partition("-")
                start = int(a or 0)
                length = (int(b) - start + 1) if b else None
            data, s, e, total = read_file(path, start, length)
            ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
            if rng and (s or e < total - 1):
                return self._bytes(data, ctype, code=206, extra={
                    "Content-Range": "bytes %d-%d/%d" % (s, e, total),
                    "Accept-Ranges": "bytes"})
            return self._bytes(data, ctype, extra={"Accept-Ranges": "bytes"})
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


def serve(port=0, open_browser=True, token=None):
    """起服务，返回 (server, thread, url)。port=0 时随机端口。"""
    Handler.token = token or secrets.token_urlsafe(12)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True, name="iv-backend")
    t.start()
    url = "http://127.0.0.1:%d/" % httpd.server_address[1]
    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    return httpd, t, url


_instance = {}


def start_server(port=0, open_browser=True):
    """给桌面版用：起后端（已起则直接复用），返回 URL。"""
    if _instance.get("httpd"):
        url = _instance["url"]
        if open_browser:
            try:
                webbrowser.open(url)
            except Exception:
                pass
        return url
    httpd, t, url = serve(port, open_browser=open_browser)
    _instance.update(httpd=httpd, thread=t, url=url)
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
    args = ap.parse_args(argv)
    httpd, t, url = serve(args.port, open_browser=not args.no_browser, token=args.token)
    print("网页版后端已启动：%s" % url, flush=True)
    print("能力：%s" % json.dumps(capabilities(), ensure_ascii=False), flush=True)
    print("Ctrl+C 停止", flush=True)
    try:
        t.join()
    except KeyboardInterrupt:
        httpd.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
