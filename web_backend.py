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
import netutil
import watched_store

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
REMOTE_SKIP_MAX = 256 * 1024 * 1024     # 上游忽略 Range 时，最多替它跳过这么多字节

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


_cfg_lock = threading.RLock()       # 配置是「整份读 -> 改 -> 整份写」，并发请求（比如批量标记已看）不加锁会丢更新


def progress_save(book_key, record):
    if not isinstance(record, dict):
        raise ValueError("进度记录必须是对象")
    with _cfg_lock:
        cfg = config_store.load_config(CONFIG_PATH)
        cfg[book_key] = record
        config_store.save_config(CONFIG_PATH, cfg)
    return True


# 视频续播点：和桌面版共用 image_viewer.json 里的 "_video_resume_"（key = 规范化绝对路径，值 = 毫秒）
VIDEO_RESUME_KEY = "_video_resume_"
RESUME_MIN_MS = 3000          # 与桌面版一致：开头 3 秒内 / 结尾 3 秒内不记


def _resume_key(path):
    return os.path.normcase(os.path.abspath(path))


RESUME_MAX_MS = 10 * 24 * 3600 * 1000       # 10 天，超过当作非法输入
RESUME_MAX_KEYS = 5000                       # _video_resume_ 最多留这么多条（超了丢最旧的）
REMOTE_PATH_MAX = 2048


def remote_resume_key(remote_path):
    """云端视频的续播 key：dav:<host:port>/<解码后的远端路径>。

    host 取后端已保存的 WebDAV 地址（不是浏览器传来的），不含用户名 / 密码 / query。
    以 "dav:" 开头：本机 key 是 normcase(abspath)（盘符或 / 开头），两者不可能相撞。"""
    import urllib.parse as up
    rp = str(remote_path or "")
    if not rp or len(rp) > REMOTE_PATH_MAX or any(ord(c) < 32 for c in rp):
        raise ValueError("云端路径不合法")
    cfg = remote_config()
    base = cfg.get("base_url") or ""
    if not base:
        raise RuntimeError("还没配置 WebDAV")
    host = up.urlsplit(base if "://" in base else "http://" + base).netloc.rpartition("@")[2].lower()
    dec = up.unquote(up.urlsplit(rp).path if "://" in rp else rp.split("?", 1)[0].split("#", 1)[0])
    import posixpath
    dec = posixpath.normpath("/" + dec.replace(chr(92), "/")).lstrip("/")     # 解析 . / ..，到根为止，不会跳出
    if ext_of(dec) not in VIDEO_EXTS:
        raise PermissionError("不允许读取该文件")
    return "dav:%s/%s" % (host, dec)


def _check_ms(v, name):
    if isinstance(v, bool) or not isinstance(v, (int, float, str)):
        raise ValueError("%s 不合法" % name)
    try:
        n = int(float(v)) if v != "" else 0
    except (TypeError, ValueError):
        raise ValueError("%s 不合法" % name)
    if n < 0 or n > RESUME_MAX_MS:
        raise ValueError("%s 超出范围" % name)
    return n


def video_resume_get(path=None, key=None):
    key = key or _resume_key(path)
    pos = (progress_store().get(VIDEO_RESUME_KEY) or {}).get(key)
    return int(pos) if isinstance(pos, (int, float)) and not isinstance(pos, bool) and pos > 0 else None


def video_resume_save(path=None, position_ms=0, length_ms=0, key=None):
    """记下 / 清除续播点。返回写入后的值（None = 已清除）。key 缺省时按本机路径算；云端视频传 remote_resume_key() 的结果。
    规则在 watched_store.apply_resume（与桌面版共用）：看完（结尾 3 秒内）清掉续播点并记入 _video_watched_。"""
    pos = _check_ms(position_ms or 0, "ms")
    length = _check_ms(length_ms or 0, "length")
    key = key or _resume_key(path)
    with _cfg_lock:
        cfg = config_store.load_config(CONFIG_PATH)
        out = watched_store.apply_resume(cfg, key, pos, length, max_keys=RESUME_MAX_KEYS)
        config_store.save_config(CONFIG_PATH, cfg)
    return out


def video_watched_get(path=None, key=None):
    key = key or _resume_key(path)
    return watched_store.is_watched(progress_store(), key)


def video_watched_set(flag, path=None, key=None):
    """手动标记已看 / 未看（不动续播点）。"""
    key = key or _resume_key(path)
    with _cfg_lock:
        cfg = config_store.load_config(CONFIG_PATH)
        out = watched_store.mark_watched(cfg, key, bool(flag), max_keys=RESUME_MAX_KEYS)
        config_store.save_config(CONFIG_PATH, cfg)
    return out


# ----------------------------- 媒体刮削（TMDB，见 scrape.py / docs/scrape-design.md）-----------------------------
_scrape = {}
SCRAPE_SCAN_MAX = 2000


def get_scraper():
    """惰性创建。缓存目录 = IV_SCRAPE_DIR 或 <配置文件目录>/scrape_cache（绝不写进媒体目录）。
    令牌只在每次请求时从环境变量 TMDB_TOKEN 读，不保存、不下发。"""
    sc = _scrape.get("s")
    if sc is None:
        import scrape
        d = os.environ.get("IV_SCRAPE_DIR") or os.path.join(os.path.dirname(os.path.abspath(CONFIG_PATH)), "scrape_cache")
        os.makedirs(d, exist_ok=True)
        sc = _scrape["s"] = scrape.Scraper(d, scrape.TmdbClient(lambda: os.environ.get("TMDB_TOKEN", "")))
        try:
            sc.purge()                       # 启动时顺手清过期（TMDB 条款：缓存不超过 6 个月）
        except Exception:
            pass
    return sc


def scrape_key(src):
    """请求里的 {path | remote} -> 与 /api/videoresume 相同方案的 key。只认视频扩展名，不读文件。"""
    if not isinstance(src, dict):
        raise ValueError("请求体不合法")
    if src.get("remote"):
        return remote_resume_key(src["remote"])
    path = str(src.get("path") or "")
    if not path or len(path) > REMOTE_PATH_MAX or any(ord(c) < 32 for c in path):
        raise ValueError("缺少 path / remote")
    if ext_of(path) not in VIDEO_EXTS:
        raise PermissionError("不允许读取该文件")
    return _resume_key(path)



# ----------------------------- ffmpeg 转码 / 探测 / VLC（可选；没装 ffmpeg 时整块隐藏，播放照旧）-----------------------------
import time as _time
import ffmpeg_tools

_inputs = {}                         # nonce -> {"kind": "remote"|"local", "path": ..., "exp": 到期时间}
_inputs_lock = threading.Lock()
_probe_cache = {}                    # key -> (ts, analysis)
_sub_cache = {}                      # (key, stream) -> (ts, vtt)
PROBE_TTL = 1800
_popen_external = None                         # 测试可替换（open-external 启动 VLC 用）
_popen_ffmpeg = None                          # 测试可替换（用假 ffmpeg 校验 argv）


def mint_input(kind, path, ttl):
    """签发一次性回环输入：给 ffmpeg / VLC 用的 http://127.0.0.1:PORT/api/media/in/<nonce>。
    凭据（WebDAV 账号）只在后端 -> 网盘这一段；子进程 argv 里只有这个只对「这一个文件」有效、到期 / 进程结束即作废的随机串。"""
    n = secrets.token_urlsafe(18)
    now = _time.time()
    with _inputs_lock:
        for k in [k for k, v in _inputs.items() if v["exp"] < now]:
            _inputs.pop(k, None)
        _inputs[n] = {"kind": kind, "path": path, "exp": now + ttl}
    return n


def revoke_input(n):
    with _inputs_lock:
        _inputs.pop(n, None)


def lookup_input(n):
    with _inputs_lock:
        v = _inputs.get(n)
    return v if v and v["exp"] >= _time.time() else None


class MediaSrc:
    """一个已校验的视频源：key（和续播同一套）、给 ffmpeg 的输入串、结束时要作废的 nonce。"""

    def __init__(self, key, kind, path, ff_input, nonce=None):
        self.key, self.kind, self.path, self.ff_input, self.nonce = key, kind, path, ff_input, nonce

    def close(self):
        if self.nonce:
            revoke_input(self.nonce)
            self.nonce = None


def media_src(spec, port, ttl=6 * 3600):
    """{path | remote} -> MediaSrc。本机路径必须是白名单里的视频且存在；云端路径走已配置的 WebDAV。绝不接受任意 URL。"""
    if not isinstance(spec, dict):
        raise ValueError("请求不合法")
    if spec.get("remote"):
        rk = remote_resume_key(spec["remote"])
        nonce = mint_input("remote", str(spec["remote"]), ttl)
        return MediaSrc(rk, "remote", str(spec["remote"]), "http://127.0.0.1:%d/api/media/in/%s" % (port, nonce), nonce)
    path = str(spec.get("path") or "")
    if not path or len(path) > REMOTE_PATH_MAX or any(ord(c) < 32 for c in path):
        raise ValueError("缺少 path / remote")
    if ext_of(path) not in VIDEO_EXTS or not is_servable(path):
        raise PermissionError("不允许读取该文件")
    ap = os.path.abspath(path)
    if not os.path.isfile(ap):
        raise FileNotFoundError("找不到文件")
    return MediaSrc(_resume_key(path), "local", ap, ap)


def probe_media(src):
    """ffprobe + 判断（缓存 30 分钟）。"""
    ck = src.key
    if src.kind == "local":
        try:
            st = os.stat(src.path)
            ck = "%s|%d|%d" % (src.key, st.st_mtime_ns, st.st_size)
        except OSError:
            pass
    hit = _probe_cache.get(ck)
    if hit and _time.time() - hit[0] < PROBE_TTL:
        return hit[1]
    a = ffmpeg_tools.analyze(ffmpeg_tools.run_probe(src.ff_input))
    if len(_probe_cache) > 200:
        _probe_cache.clear()
    _probe_cache[ck] = (_time.time(), a)
    return a


def vlc_launch(spec, port):
    """用本机 VLC 打开（仅 Windows）。云端文件给 VLC 的是后端自己的回环 URL（12 小时有效、只对这一个文件），不含账号密码。"""
    if os.name != "nt":
        raise OSError("「用 VLC 打开」目前只支持 Windows")
    vlc = ffmpeg_tools.find_vlc()
    if not vlc:
        raise FileNotFoundError("没找到 VLC（装好后重试，或用环境变量 IV_VLC_PATH 指向 vlc.exe）")
    src = media_src(spec, port, ttl=12 * 3600)
    target = src.path if src.kind == "local" else src.ff_input + "/" + urllib.parse.quote(os.path.basename(src.path.replace("\\", "/")) or "video")
    import subprocess as _sp
    fn = _popen_external or _sp.Popen
    flags = getattr(_sp, "DETACHED_PROCESS", 0) | getattr(_sp, "CREATE_NEW_PROCESS_GROUP", 0)
    fn([vlc, target], stdin=_sp.DEVNULL, stdout=_sp.DEVNULL, stderr=_sp.DEVNULL, close_fds=True, creationflags=flags)
    return {"vlc": vlc, "kind": src.kind}


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
        "ffmpeg": ffmpeg_tools.info(),
        "vlc": bool(os.name == "nt" and ffmpeg_tools.find_vlc()),
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

    def _send_file(self, path, ctype, rng_header, cache=False):
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
        if cache:
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
        if u.path.startswith("/api/media/in/"):
            return self._media_in(u.path)
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
            with netutil.urlopen(req, timeout=timeout) as r:
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
            return self._send_file(path, ctype, rng, cache=ext_of(path) in VIDEO_EXTS)
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
        if route.startswith("/api/scrape/"):
            return self._scrape_get(route, q)
        if route == "/api/media/probe":
            return self._media_probe(q)
        if route == "/api/media/stream":
            return self._media_stream(q)
        if route == "/api/media/subtitle":
            return self._media_subtitle(q)
        if route == "/api/videoresume":
            remote = (q.get("remote") or [""])[0]
            if remote:                                       # 云端视频：key 由后端按已配置的 WebDAV 地址算
                rk = remote_resume_key(remote)
                return self._json({"ok": True, "ms": video_resume_get(key=rk), "watched": video_watched_get(key=rk)})
            if ext_of(path) not in VIDEO_EXTS:
                raise PermissionError("不允许读取该文件")
            return self._json({"ok": True, "ms": video_resume_get(path), "watched": video_watched_get(path)})
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
        """把 WebDAV 字节流式转发给浏览器（图/PDF/视频都能用，保留 Range）。

        Basic 凭据只在后端 -> 网盘这一段使用，绝不下发给浏览器（也不转发 WWW-Authenticate，
        免得浏览器弹原生登录框）。<video src> 因此不需要任何认证头。
        """
        import urllib.error
        path = (q.get("path") or [""])[0]
        headers = {}
        rng = self.headers.get("Range") or (q.get("range") or [""])[0]
        if rng:
            headers["Range"] = rng
        try:
            resp = remote_open(path, headers)
        except urllib.error.HTTPError as e:
            if e.code == 416:
                self.send_response(416)
                self.send_header("Content-Range", (e.headers.get("Content-Range") if e.headers else None) or "bytes */*")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            msg = {401: "网盘拒绝访问（账号或密码不对？）", 403: "网盘拒绝访问", 404: "网盘上没有这个文件"}.get(
                e.code, "网盘返回 HTTP %d" % e.code)
            return self._err(msg, 404 if e.code == 404 else 502)
        try:
            status = getattr(resp, "status", None) or resp.getcode()
            up = resp.headers
            ctype = (up.get("Content-Type") if up else None) or ""
            if ext_of(path) in VIDEO_EXTS:
                ctype = video_mime(path)          # 网盘常回 application/octet-stream，<video> 要明确类型
            elif not ctype or ctype == "application/octet-stream":
                ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
            clen = up.get("Content-Length") if up else None
            clen = int(clen) if clen is not None and str(clen).isdigit() else None
            cr = up.get("Content-Range") if up else None
            if ext_of(path) in SUBTITLE_EXTS and (clen is None or clen > SUBTITLE_MAX_BYTES):
                # 字幕文件很小：太大（或不知道多大且读过上限）直接拒绝，别把奇怪的东西灌给浏览器
                if clen is not None:
                    return self._err("字幕文件太大（%d KB，上限 %d MB）" % (clen // 1024, SUBTITLE_MAX_BYTES >> 20), 413)
                head = resp.read(SUBTITLE_MAX_BYTES + 1)
                if len(head) > SUBTITLE_MAX_BYTES:
                    return self._err("字幕文件太大（上限 %d MB）" % (SUBTITLE_MAX_BYTES >> 20), 413)
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(head)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(head)
                return
            code, skip, out_len = (206 if status == 206 else 200), 0, clen
            if rng and status == 200:
                # 上游不支持 Range（AList 某些网盘 / CDN 会忽略它，回 200 整文件）：
                # 知道总长就自己切片（跳过前面的字节）回 206，这样视频还能拖；不知道总长就老实回 200 流。
                if clen is not None:
                    try:
                        r = parse_range(rng, clen)
                    except RangeNotSatisfiable:
                        self.send_response(416)
                        self.send_header("Content-Range", "bytes */%d" % clen)
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                    if r is not None:
                        if r[0] > REMOTE_SKIP_MAX:
                            return self._err("网盘不支持 Range 且文件太大，无法从中间开始播放（可从头播放）", 502)
                        code, skip, out_len = 206, r[0], r[1] - r[0] + 1
                        cr = "bytes %d-%d/%d" % (r[0], r[1], clen)
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            if out_len is not None:
                self.send_header("Content-Length", str(out_len))
            else:
                self.close_connection = True          # 没有长度：以关连接表示结束，别让浏览器一直等
                self.send_header("Connection", "close")
            self.send_header("Accept-Ranges", "bytes" if (out_len is not None) else "none")
            self.send_header("Cache-Control", "private, max-age=60")
            if cr and code == 206:
                self.send_header("Content-Range", cr)
            self.end_headers()
            if self.command == "HEAD":
                return
            try:
                left = skip
                while left > 0:
                    got = resp.read(min(STREAM_CHUNK, left))
                    if not got:
                        break
                    left -= len(got)
                remain = out_len
                while remain is None or remain > 0:
                    chunk = resp.read(STREAM_CHUNK if remain is None else min(STREAM_CHUNK, remain))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    if remain is not None:
                        remain -= len(chunk)
                if remain:
                    self.close_connection = True       # 上游中途断了：长度对不上，关连接让浏览器重试
            except (ConnectionError, OSError):
                self.close_connection = True
        finally:
            try:
                resp.close()
            except Exception:
                pass


    # ---------------- ffmpeg 转码 / 探测 ----------------
    def _is_loopback(self):
        return (self.client_address[0] or "") in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

    def _media_in(self, upath):
        """ffmpeg / VLC 回来取原始字节的一次性回环入口：不要 token（nonce 就是凭证），只认回环地址，Range 照常。"""
        if not self._is_loopback():
            return self._err("只允许本机访问", 403)
        n = upath[len("/api/media/in/"):].split("/", 1)[0]
        v = lookup_input(n)
        if not v:
            return self._err("链接已失效", 404)
        try:
            if v["kind"] == "remote":
                return self._remote_data({"path": [v["path"]]})
            return self._send_file(v["path"], video_mime(v["path"]), self.headers.get("Range"))
        except Exception as e:
            return self._err("%s: %s" % (type(e).__name__, e), 502)

    def _media_need_ffmpeg(self):
        if not ffmpeg_tools.info().get("available"):
            self._json({"ok": False, "code": "no_ffmpeg", "error": "没找到 ffmpeg（winget install Gyan.FFmpeg；装好后重启后端，PATH 只对新开的终端生效）"}, 501)
            return False
        return True

    def _media_spec(self, q, body=None):
        if body is not None:
            return {"path": body.get("path"), "remote": body.get("remote")}
        return {"path": (q.get("path") or [""])[0], "remote": (q.get("remote") or [""])[0]}

    def _media_probe(self, q, body=None):
        if not self._media_need_ffmpeg():
            return
        port = self.server.server_address[1]
        try:
            src = media_src(self._media_spec(q, body), port, ttl=300)
        except (ValueError, PermissionError, FileNotFoundError, RuntimeError) as e:
            return self._err("%s: %s" % (type(e).__name__, e), 400 if not isinstance(e, FileNotFoundError) else 404)
        try:
            a = probe_media(src)
        except Exception as e:
            return self._err("探测失败：%s" % e, 502)
        finally:
            src.close()
        return self._json({"ok": True, "probe": a, "transcode": {"max": ffmpeg_tools.MAX_CONCURRENT, "live": ffmpeg_tools.live_count()}})

    def _media_stream(self, q):
        if self.command == "HEAD":
            return self._err("不支持 HEAD", 405)
        if not self._media_need_ffmpeg():
            return
        port = self.server.server_address[1]
        try:
            src = media_src(self._media_spec(q), port)
        except (ValueError, PermissionError, FileNotFoundError, RuntimeError) as e:
            return self._err("%s: %s" % (type(e).__name__, e), 400 if not isinstance(e, FileNotFoundError) else 404)
        slot = False
        proc = None
        sent = False
        try:
            mode = (q.get("mode") or ["auto"])[0]
            if mode not in ffmpeg_tools.MODES:
                return self._err("mode 不合法")
            try:
                start = float((q.get("start") or ["0"])[0] or 0)
                audio = (q.get("audio") or [""])[0]
                audio = int(audio) if audio != "" else None
            except ValueError:
                return self._err("start / audio 不合法")
            if not (0 <= start <= 3 * 24 * 3600) or (audio is not None and not 0 <= audio < 64):
                return self._err("start / audio 超出范围")
            stereo = (q.get("stereo") or ["0"])[0] == "1"
            a = probe_media(src)
            if audio is None:
                audio = a.get("audio_index", 0)
            if mode == "auto":
                mode = {"direct": "remux", "remux": "remux", "transcode_audio": "audio", "transcode_video": "video"}.get(a["action"])
                if not mode:
                    return self._err("这个文件没法转码：%s" % a.get("reason"), 422)
            venc = ffmpeg_tools.video_encoder() if mode == "video" else None
            argv = ffmpeg_tools.build_stream_argv(ffmpeg_tools.find_tool("ffmpeg"), src.ff_input, mode, audio_index=audio, start=start,
                                                  venc=venc or "libx264", stereo=stereo)
            try:
                ffmpeg_tools.acquire_slot()
                slot = True
            except ffmpeg_tools.Busy as e:
                return self._err(str(e), 503)
            proc = ffmpeg_tools.popen(argv, _popen_ffmpeg or __import__("subprocess").Popen)
            watchdog = threading.Timer(ffmpeg_tools.FIRST_BYTE_TIMEOUT, ffmpeg_tools.kill, args=(proc,))
            watchdog.daemon = True
            watchdog.start()
            try:
                first = proc.stdout.read(65536)
            finally:
                watchdog.cancel()
            if not first:
                proc.wait()
                return self._err("ffmpeg 没有输出：%s" % (ffmpeg_tools.err_tail(proc) or "（超时或源文件打不开）"), 502)
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Accept-Ranges", "none")
            self.send_header("X-IV-Transcode", mode)
            self.send_header("X-IV-Encoder", venc or "")
            self.send_header("Connection", "close")
            self.close_connection = True
            self.end_headers()
            sent = True
            try:
                self.wfile.write(first)
                while True:
                    chunk = proc.stdout.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            except (ConnectionError, OSError):
                pass                                   # 浏览器断开（拖进度条 / 关播放器）：下面 finally 杀进程
        except Exception as e:
            try:
                if not sent:
                    self._err("转码失败：%s: %s" % (type(e).__name__, e), 502)
            except Exception:
                pass
        finally:
            if proc is not None:
                ffmpeg_tools.kill(proc)
            if slot:
                ffmpeg_tools.release_slot()
            src.close()

    def _media_subtitle(self, q):
        if not self._media_need_ffmpeg():
            return
        port = self.server.server_address[1]
        try:
            src = media_src(self._media_spec(q), port, ttl=600)
        except (ValueError, PermissionError, FileNotFoundError, RuntimeError) as e:
            return self._err("%s: %s" % (type(e).__name__, e), 400 if not isinstance(e, FileNotFoundError) else 404)
        slot = False
        try:
            try:
                n = int((q.get("stream") or [""])[0])
                start = float((q.get("start") or ["0"])[0] or 0)
            except ValueError:
                return self._err("stream / start 不合法")
            a = probe_media(src)
            subs = a["subtitles"]
            if not 0 <= n < len(subs):
                return self._err("没有这个字幕流", 404)
            if not subs[n]["extractable"]:
                return self._err("图形字幕（%s）没法转成文字字幕" % subs[n]["codec"], 422)
            ck = (src.key, n)
            hit = _sub_cache.get(ck)
            if hit and _time.time() - hit[0] < PROBE_TTL:
                vtt = hit[1]
            else:
                try:
                    ffmpeg_tools.acquire_slot()
                    slot = True
                except ffmpeg_tools.Busy as e:
                    return self._err(str(e), 503)
                vtt = ffmpeg_tools.extract_subtitle(src.ff_input, n)
                if len(_sub_cache) >= 8:
                    _sub_cache.pop(next(iter(_sub_cache)))
                _sub_cache[ck] = (_time.time(), vtt)
            out = ffmpeg_tools.shift_vtt(vtt, start) if start > 0 else vtt
            return self._bytes(out.encode("utf-8"), "text/vtt; charset=utf-8", extra={"Cache-Control": "private, max-age=60"})
        except Exception as e:
            return self._err("提取字幕失败：%s" % e, 502)
        finally:
            if slot:
                ffmpeg_tools.release_slot()
            src.close()

    # ---------------- 刮削接口 ----------------
    def _scrape_err(self, e):
        import scrape
        if isinstance(e, scrape.TmdbError):
            return self._json({"ok": False, "error": str(e), "code": e.code}, 502 if e.code != "no_token" else 503)
        raise e

    def _scrape_get(self, route, q):
        import scrape
        sc = get_scraper()
        try:
            if route == "/api/scrape/status":
                return self._json({"ok": True, **sc.status()})
            if route == "/api/scrape/item":
                src = {"path": (q.get("path") or [""])[0], "remote": (q.get("remote") or [""])[0]}
                return self._json({"ok": True, "item": sc.item(scrape_key(src))})
            if route == "/api/scrape/search":
                return self._json({"ok": True, "results": sc.search_manual(
                    (q.get("q") or [""])[0], (q.get("year") or [""])[0], (q.get("type") or ["movie"])[0])})
            if route == "/api/scrape/job":
                j = sc.job((q.get("id") or [""])[0])
                return self._json({"ok": bool(j), "job": j}, 200 if j else 404)
            if route == "/api/scrape/image":
                size = (q.get("size") or ["w342"])[0]
                data = sc.image((q.get("p") or [""])[0], size)
                ctype = "image/png" if data[:4] == bytes([0x89, 0x50, 0x4E, 0x47]) else "image/jpeg"
                return self._bytes(data, ctype, extra={"Cache-Control": "private, max-age=86400"})
        except scrape.TmdbError as e:
            return self._scrape_err(e)
        return self._err("未知接口 %s" % route, 404)

    def _scrape_post(self, route):
        import scrape
        sc = get_scraper()
        body = self._read_json_body()
        try:
            if route == "/api/scrape/match":
                return self._json({"ok": True, "item": sc.match(scrape_key(body), force=bool(body.get("force")))})
            if route == "/api/scrape/pin":
                if "ignore" in body:
                    if not isinstance(body["ignore"], bool):
                        return self._err("ignore 必须是布尔值")
                    return self._json({"ok": True, "item": sc.set_ignore(scrape_key(body), body["ignore"], str(body.get("scope") or "auto"))})
                tid = body.get("tmdb_id")
                item = sc.pin(scrape_key(body), body.get("media_type"), tid, str(body.get("scope") or "auto"))
                return self._json({"ok": True, "item": item})
            if route == "/api/scrape/peek":
                items = body.get("items")
                if not isinstance(items, list) or len(items) > 500:
                    return self._err("items 需为最多 500 个 {path|remote}")
                out = []
                for i in items:
                    try:
                        k = scrape_key(i)
                    except Exception as e:
                        out.append({"error": "%s" % e})
                        continue
                    orig = urllib.parse.unquote(str(i.get("remote") or "")) if i.get("remote") else str(i.get("path") or "")
                    r = sc.peek(k, orig)
                    r["resume_ms"] = video_resume_get(key=k)
                    r["watched"] = video_watched_get(key=k)
                    out.append(r)
                return self._json({"ok": True, "items": out, "token_configured": sc.client.has_token()})
            if route == "/api/scrape/cancel":
                sc.cancel_job(str(body.get("id") or ""))
                return self._json({"ok": True})
            if route == "/api/scrape/purge":
                return self._json({"ok": True, "removed": sc.purge(bool(body.get("all")))})
            if route == "/api/scrape/scan":
                items = body.get("items")
                if not isinstance(items, list) or not items or len(items) > SCRAPE_SCAN_MAX:
                    return self._err("items 需为 1~%d 个 {path|remote}" % SCRAPE_SCAN_MAX)
                if not sc.client.has_token():
                    return self._json({"ok": False, "error": "未配置 TMDB_TOKEN", "code": "no_token"}, 503)
                keys = list(dict.fromkeys(scrape_key(i) for i in items))
                return self._json({"ok": True, "job": sc.job(sc.start_scan(keys))})
        except scrape.TmdbError as e:
            return self._scrape_err(e)
        return self._err("未知接口 %s" % route, 404)

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
            if route.startswith("/api/scrape/"):
                return self._scrape_post(route)
            if route == "/api/media/probe":
                return self._media_probe({}, self._read_json_body())
            if route == "/api/open-external":
                if not self._is_loopback():
                    return self._err("只允许本机页面调用", 403)
                try:
                    return self._json({"ok": True, **vlc_launch(self._media_spec({}, self._read_json_body()), self.server.server_address[1])})
                except FileNotFoundError as e:
                    return self._err(str(e), 404)
                except PermissionError as e:
                    return self._err(str(e), 403)
                except OSError as e:
                    return self._err(str(e), 501)
            if route == "/api/progress":
                body = self._read_json_body()
                key = str(body.get("key") or "")
                if not key:
                    return self._err("缺少 key")
                progress_save(key, body.get("record") or {})
                return self._json({"ok": True})
            if route == "/api/videoresume":
                body = self._read_json_body()
                if body.get("remote"):
                    rk = remote_resume_key(body.get("remote"))
                else:
                    vpath = str(body.get("path") or "")
                    if ext_of(vpath) not in VIDEO_EXTS or not is_servable(vpath):
                        raise PermissionError("不允许读取该文件")
                    rk = _resume_key(vpath)
                if "watched" in body:                        # 手动标记已看 / 未看（只动 _video_watched_）
                    if not isinstance(body["watched"], bool):
                        raise ValueError("watched 必须是布尔值")
                    w = video_watched_set(body["watched"], key=rk)
                    return self._json({"ok": True, "watched": w, "ms": video_resume_get(key=rk)})
                ms = video_resume_save(key=rk, position_ms=body.get("ms"), length_ms=body.get("length"))
                return self._json({"ok": True, "ms": ms, "watched": video_watched_get(key=rk)})
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
    ffmpeg_tools.kill_all()                       # 还在跑的转码进程一并收掉
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
