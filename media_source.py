# -*- coding: utf-8 -*-
"""媒体来源枚举与章节/播放列表解析（纯逻辑，无 UI 依赖）。

从 image_viewer.py 抽取出来的可单测纯函数：
文件扫描、zip 章节分组、PDF 展开为页、播放列表解析、书签 key、播放历史维护。

约定：不做任何 UI / 状态修改，输入输出通过参数传递。
"""

import os
import hashlib
import zipfile

from viewer_core import natural_key

# 支持的扩展名（与 image_viewer.py 保持一致）
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".avif", ".jfif"}
ZIP_EXTS = {".zip", ".cbz"}
PDF_EXTS = {".pdf"}
VIDEO_EXTS = {".mp4", ".mkv", ".avi", ".webm", ".mov", ".wmv", ".flv", ".m4v", ".ts", ".mpg", ".mpeg", ".3gp"}
AUDIO_EXTS = {".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".wma", ".ape"}

MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS | PDF_EXTS


def media_files_in(directory, exts=MEDIA_EXTS):
    """递归收集目录下的媒体文件，按相对路径自然排序。"""
    out = []
    for root, dirs, files in os.walk(directory):
        dirs.sort(key=natural_key)
        for f in sorted(files, key=natural_key):
            if os.path.splitext(f)[1].lower() in exts:
                out.append(os.path.join(root, f))
    out.sort(key=lambda p: natural_key(os.path.relpath(p, directory)))
    return out


def build_zip_chapters(zip_path, namelist, exts=IMAGE_EXTS | VIDEO_EXTS):
    """把 zip 内的条目按顶层目录分组为章节。

    返回 [{"title": str, "sources": [(zip_path, name), ...]}, ...]。
    无子目录的条目归入「根目录」章节。
    """
    names = [n for n in namelist
             if not n.endswith("/") and os.path.splitext(n)[1].lower() in exts]

    groups = {}
    flat = []
    for n in names:
        parts = n.replace("\\", "/").split("/")
        if len(parts) > 1 and parts[0]:
            groups.setdefault(parts[0], []).append(n)
        else:
            flat.append(n)

    def sort_names(lst):
        return sorted(lst, key=lambda n: natural_key(n.replace("\\", "/").split("/")[-1]))

    chapters = []
    if flat:
        chapters.append({"title": "根目录", "sources": [(zip_path, n) for n in sort_names(flat)]})
    for top in sorted(groups, key=natural_key):
        chapters.append({"title": top, "sources": [(zip_path, n) for n in sort_names(groups[top])]})
    return chapters


def expand_paths(paths, page_count_fn, pdf_exts=PDF_EXTS):
    """把文件路径列表转成页面来源列表（PDF 展开为每页 (path, page_index)）。"""
    sources = []
    for p in paths:
        if os.path.splitext(p)[1].lower() in pdf_exts:
            n = page_count_fn(p)
            if n > 0:
                sources.extend((p, i) for i in range(n))
        else:
            sources.append(p)
    return sources


def parse_playlist(lines, base_dir, page_count_fn, pdf_exts=PDF_EXTS, remote_parser=None):
    """解析 m3u 播放列表文本为媒体来源列表。相对路径基于 base_dir 解析。

    remote_parser: 可选回调。非本地路径的行先交给它解析（用于 "remote:provider:path"
    形式的远程条目）；返回非 None 则作为该行来源，否则当作普通路径/忽略。
    历史播放文件本地与远程混存，靠这个参数还原远程条目。
    """
    sources = []
    for line in lines:
        entry = line.strip()
        if not entry or entry.startswith("#"):
            continue
        if remote_parser is not None:
            remote = remote_parser(entry)
            if remote is not None:
                sources.append(remote)
                continue
        source = entry if os.path.isabs(entry) else os.path.normpath(os.path.join(base_dir, entry))
        if os.path.isfile(source):
            if os.path.splitext(source)[1].lower() in pdf_exts:
                n = page_count_fn(source)
                if n > 0:
                    sources.extend((source, i) for i in range(n))
            else:
                sources.append(source)
    return sources


def files_book_key(paths):
    """多文件打开时的书签 key（按文件列表哈希，保证同一组文件复用进度）。"""
    return "files:" + hashlib.sha1("|".join(paths).encode("utf-8")).hexdigest()[:16]


def playlist_book_key(path):
    return "playlist:" + os.path.abspath(path)


def _history_key(entry):
    """历史条目的去重键。

    远程条目（remote:provider:path[\\tname\\tkind]）按 key 部分精确比较（路径大小写
    敏感）；本地路径按 Windows 习惯 normcase/normpath 归一化后比较。
    """
    if entry.startswith("remote:"):
        return entry.split("\t", 1)[0]
    return os.path.normcase(os.path.normpath(os.path.abspath(entry)))


def update_history(path, history_path, limit):
    """把一条媒体记录写入最近播放 M3U（最新置顶、去重、限量）。

    path 可以是本地文件路径，也可以是远程条目字符串
    （"remote:provider:path" 或 "remote:provider:path\\tname\\tkind"）。
    若已在顶部则跳过写盘，避免重复写。仅捕获 OSError。
    """
    entry = path if path.startswith("remote:") else os.path.abspath(path)
    try:
        history = []
        if os.path.isfile(history_path):
            with open(history_path, "r", encoding="utf-8-sig") as f:
                history = [line.strip() for line in f
                           if line.strip() and not line.startswith("#")]
        key = _history_key(entry)
        if history and _history_key(history[0]) == key:
            return
        history = [e for e in history if _history_key(e) != key]
        history.insert(0, entry)
        with open(history_path, "w", encoding="utf-8") as f:
            f.write("#EXTM3U\n")
            f.write("\n".join(history[:limit]))
            f.write("\n")
    except OSError:
        pass
