# -*- coding: utf-8 -*-
"""
图片 / 漫画浏览器（桌面版）
依赖：tkinter（自带）+ Pillow
安装 Pillow： pip install Pillow

支持：文件夹 / 多张图片 / zip·cbz·rar·cbr 压缩包；双页模式；日漫右→左方向；
断点续读；跳到指定页；自动裁白边；视频播放（mp4 等，需 VLC）。

快捷键：
  ← → / PageUp / PageDown          翻页
  空格（图片页）                    下一页
  空格（视频页）                    播放 / 暂停
  滚轮 / 触控板上下滑               缩放（以鼠标为中心）
  触控板捏合（Ctrl+滚轮）            缩放
  触控板左右滑                      翻页
  工具栏缩放滑块                     拖拽调整缩放百分比
  点击缩放百分比                     重置画面（适应窗口 / 视频 100%）
  + / -                             放大 / 缩小
  拖拽                              平移
  点击画面左 / 右边缘                翻页（方向随阅读方向）
  双击画面中间                       适应窗口 <-> 实际大小
  R / Shift+R                       顺时针 / 逆时针旋转 90°
  0 / 1 / 2 / 3                     适应窗口 / 实际大小 / 适应宽度 / 适应高度
  D                                 双页模式 开 / 关
  M                                 阅读方向 左→右 / 右→左（日漫）
  C                                 裁白边 开 / 关
  G                                 跳到指定页
  A                                 自动翻页 开 / 关
  [ / ]                             自动翻页每页停留时间 - / + 0.5 秒
  F / F11                           全屏
  T                                 显示 / 隐藏缩略图
  ?                                 帮助
"""

import os
import io
import importlib
import re
import sys
import math
import time
import random
import queue
import zipfile
try:
    import rarfile
except ImportError:
    rarfile = None
import tempfile
import shutil
import threading
import webbrowser
import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog, ttk

from viewer_core import (MIN_ZOOM, MAX_ZOOM, MIN_VISIBLE, clamp, natural_key,
                         compute_zoom, rotated_size, clamp_pan, zoom_at_pan,
                         zoom_slider_value, zoom_slider_pos)

from media_source import (IMAGE_EXTS, RAR_EXTS, ARCHIVE_EXTS, PDF_EXTS,
                          VIDEO_EXTS, AUDIO_EXTS, media_files_in, build_zip_chapters,
                          expand_paths, parse_playlist, files_book_key,
                          playlist_book_key, update_history)
from config_store import load_config, save_config
from browser_view import fmt_size, fmt_mtime, kind_label, grid_layout, hit_test, sort_entries

from video_player import (fmt_time, build_vlc_args, build_video_media_options,
                          video_tmp_name, video_resume_key, RegionZoom)
from remote_types import RemoteSource
import alist_manager

# ---- 高 DPI 适配（必须在创建任何窗口之前调用） ----
# 本机是 150% 缩放的 1920x1080 屏。进程不做 DPI 感知时，Windows 会把界面按
# 1280x720 逻辑分辨率渲染再位图放大到 1920x1080，结果：全屏只按 1280x720 计算、
# 画面发虚。声明 DPI 感知后 Tk 能拿到真实分辨率，全屏与画面都按 1920x1080 渲染。
import ctypes
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(1)   # PROCESS_SYSTEM_DPI_AWARE
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()     # 旧版 Windows 回退
    except Exception:
        pass


# ---- rar / cbr 支持 ----
# rarfile 只负责解析 rar 头部（拿文件列表），真正解压靠外部命令行工具：
# UnRAR / unar / 7-Zip / bsdtar。这里自动探测可用的工具并配置好 rarfile。
_rarfile_ready = None   # None = 未探测；True/False = 探测结果


def _find_rar_backend():
    """探测并配置 rarfile 的解压工具，返回 True 表示有可用后端。"""
    if rarfile is None:
        return False
    # 应用自身目录（打包后解压工具可随程序一起分发），优先级最高
    app_dirs = []
    for base in (getattr(sys, "_MEIPASS", None),
                 os.path.dirname(os.path.abspath(sys.executable))):
        if base:
            app_dirs.append(base)
    # (rarfile 工具名, 可执行文件候选名, 系统固定安装位置)
    fixed = [
        ("UNRAR_TOOL", ("UnRAR.exe", "unrar", "unrar-free"),
         (r"C:\Program Files\WinRAR\UnRAR.exe", r"C:\Program Files (x86)\WinRAR\UnRAR.exe")),
        ("UNAR_TOOL", ("unar",), ()),
        ("SEVENZIP_TOOL", ("7z.exe", "7z", "7za", "7zz"),
         (r"C:\Program Files\7-Zip\7z.exe", r"C:\Program Files (x86)\7-Zip\7z.exe")),
        ("SEVENZIP2_TOOL", ("7z.exe", "7zz"),
         (r"C:\Program Files\7-Zip\7z.exe", r"C:\Program Files (x86)\7-Zip\7z.exe")),
        ("BSDTAR_TOOL", ("bsdtar",), ()),
    ]
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


def _rarfile_available():
    global _rarfile_ready
    if _rarfile_ready is None:
        _rarfile_ready = _find_rar_backend()
    return _rarfile_ready


try:
    from PIL import Image, ImageTk, ExifTags
    RESAMPLE = Image.Resampling.LANCZOS
except ImportError:
    print("缺少 Pillow 库，请先安装： pip install Pillow")
    sys.exit(1)

class _LazyModule:
    """首次用到属性时才真正 import（numpy≈180ms、pymupdf≈80ms，启动时用不上）。
    未安装时 bool() 为 False，调用方用 `if not np:` 判断，语义同原来的 `is None`。"""

    def __init__(self, *names):
        self._names = names
        self._mod = None
        self._tried = False

    def _load(self):
        if not self._tried:
            self._tried = True
            for name in self._names:
                try:
                    self._mod = importlib.import_module(name)
                    break
                except ImportError:
                    continue
        return self._mod

    def __bool__(self):
        return self._load() is not None

    def __getattr__(self, attr):
        mod = self._load()
        if mod is None:
            raise ImportError("缺少依赖：" + "/".join(self._names))
        return getattr(mod, attr)


np = _LazyModule("numpy")
fitz = _LazyModule("pymupdf")   # PyMuPDF，用于读取 PDF 漫画


# 首屏按钮先用不含 emoji 的文字：Tk 第一次渲染彩色 emoji 要加载字体，约 400ms，
# 会把窗口显示整整推迟；窗口出来后再由 _apply_emoji 换回带图标的文字。
_EMOJI_RE = re.compile(r"[\U0001F000-\U0001FAFF☀-➿⬀-⯿⏩-⏺]️?\s*")


def _plain_text(text):
    return _EMOJI_RE.sub("", text).strip() or "·"


def _remote():
    """网盘模块（urllib.request / http.server 等较重）按需加载。"""
    import remote_source
    return remote_source


def _seek_dbg(msg):
    """临时诊断：进度缩略图生成失败时的排查日志（写 seek_thumbs.log）。"""
    try:
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "seek_thumbs.log")
        with open(p, "a", encoding="utf-8") as f:
            f.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), msg))
    except Exception:
        pass

CAPTION_LANGS = ["中文", "英文", "日语", "韩语", "粤语"]
CAPTION_LANG_CODES = {"中文": "zh", "英文": "en", "日语": "ja", "韩语": "ko", "粤语": "yue"}
CAPTION_MODES = ["原声", "中文翻译", "AI 翻译"]
CAPTION_MODE_CODES = {"原声": "original", "中文翻译": "translate", "AI 翻译": "ai_translate"}

APP_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(APP_DIR, "image_viewer.json")
HISTORY_PLAYLIST_PATH = os.path.join(APP_DIR, "播放历史.m3u")
HISTORY_LIMIT = 100


def _remote_history_line(src):
    """远程条目在播放历史里的持久化格式：remote:provider:path<tab>name<tab>kind。

    本地文件靠路径本身就能还原；Jellyfin 的 path 只是 item id（不含文件名/类型），
    所以额外把 name/kind 一起存下来，重新打开历史时才能正确显示与播放。
    """
    line = src.key()
    if src.name:
        line += "\t" + str(src.name).replace("\t", " ").replace("\n", " ")
    if src.kind:
        line += "\t" + str(src.kind)
    return line


def _remote_from_history_line(entry):
    """把播放历史里的远程条目还原成 RemoteSource；非远程条目返回 None。"""
    if not entry.startswith("remote:"):
        return None
    fields = entry.split("\t")
    rest = fields[0][len("remote:"):]
    provider, sep, path = rest.partition(":")
    if not sep or not provider or not path:
        return None
    name = fields[1] if len(fields) > 1 and fields[1] else None
    kind = fields[2] if len(fields) > 2 and fields[2] else None
    return RemoteSource(provider, path, name=name, kind=kind)

RATE_OPTS = ["0.5", "0.75", "1.0", "1.25", "1.5", "2.0", "2.5", "3.0", "4.0",
             "5.0", "6.0", "8.0", "10.0", "12.0", "15.0", "20.0", "30.0",
             "40.0", "50.0", "60.0"]

# 视频截图：抓取最近 N 帧做亚像素对齐 + 堆叠超分，合并成一张更清晰的高清图
SCREENSHOT_FRAMES = 5
SCREENSHOT_MAX_EDGE = 4096   # 合成图长边上限，避免 4K 源翻倍后内存/文件过大


def _is_same_subtitle(a: str, b: str) -> bool:
    """判断两个字幕路径是否指向同一条文件（用于 _choose_subtitle 去重）。
    """
    if not a or not b:
        return a == b
    try:
        return os.path.normcase(os.path.normpath(a)) == os.path.normcase(
            os.path.normpath(b))
    except Exception:
        return False
BG = "#14161a"
PANEL = "#1d2026"
BTN_BG = "#262a33"
BTN_ACTIVE = "#313741"
FG = "#e7e9ee"
MUTED = "#9aa2b1"
ACCENT = "#4c8dff"

def _register_shift(ref_gray, frm_gray):
    """用相位相关估算 frm 相对 ref 的亚像素平移 (dx, dy)（单位：像素）。

    ref_gray / frm_gray 为 float 灰度图，尺寸相同。返回的 (dx, dy) 表示
    frm(x, y) ≈ ref(x - dx, y - dy)，即 frm 的内容相对 ref 移动了 (dx, dy)。
    """
    if not np:
        return 0.0, 0.0
    a = ref_gray.astype(np.float32)
    b = frm_gray.astype(np.float32)
    h, w = a.shape
    # 轻量窗口，抑制 FFT 周期边界带来的伪影，让相关峰更干净
    wy = np.hanning(h).astype(np.float32)[:, None]
    wx = np.hanning(w).astype(np.float32)[None, :]
    win = np.sqrt(wy * wx)
    fa = np.fft.fft2(a * win)
    fb = np.fft.fft2(b * win)
    r = fa * np.conj(fb)
    r /= (np.abs(r) + 1e-12)
    corr = np.abs(np.fft.fftshift(np.fft.ifft2(r)))
    cy, cx = np.unravel_index(int(np.argmax(corr)), corr.shape)
    idy = float(h // 2 - cy)
    idx = float(w // 2 - cx)
    # 峰值处做抛物线插值，得到亚像素精度（峰值须在内部）
    if 0 < cy < h - 1:
        d = corr[cy - 1, cx] - 2.0 * corr[cy, cx] + corr[cy + 1, cx]
        if abs(d) > 1e-12:
            idy -= 0.5 * (corr[cy - 1, cx] - corr[cy + 1, cx]) / d
    if 0 < cx < w - 1:
        d = corr[cy, cx - 1] - 2.0 * corr[cy, cx] + corr[cy, cx + 1]
        if abs(d) > 1e-12:
            idx -= 0.5 * (corr[cy, cx - 1] - corr[cy, cx + 1]) / d
    return float(idx), float(idy)


def _merge_frames(frames, scale=2):
    """把多帧做亚像素对齐后堆叠超分，输出一张 scale 倍分辨率的 RGB float 图。

    frames：等尺寸的 float32 RGB numpy 数组列表，第一帧作为参考帧。
    相邻帧通常只差几像素，用相位相关估算平移；再用 shift-and-add 把每帧的
    亚像素采样落到高分辨率网格上，平均后得到更清晰、噪声更少的合成图。
    """
    n = len(frames)
    ref = frames[0]
    h, w, c = ref.shape

    def _lum(a):
        return (0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]).astype(np.float32)

    if n == 1 or not np:
        return np.repeat(np.repeat(ref, scale, axis=0), scale, axis=1)

    refg = _lum(ref)
    shifts = [(0.0, 0.0)]
    for f in frames[1:]:
        shifts.append(_register_shift(refg, _lum(f)))

    out_h, out_w = h * scale, w * scale
    acc = np.zeros((out_h, out_w, 3), np.float32)
    wsum = np.zeros((out_h, out_w), np.float32)
    # 输出像素中心对应到参考帧坐标
    yy = (np.arange(out_h, dtype=np.float32) + 0.5) / scale
    xx = (np.arange(out_w, dtype=np.float32) + 0.5) / scale
    wy = np.hanning(h).astype(np.float32)
    wx = np.hanning(w).astype(np.float32)
    for f, (dx, dy) in zip(frames, shifts):
        # 源帧的软边界权重：越靠边权重越低（移出画面的部分不可信），加底值避免零权重
        wsrc = 0.2 + 0.8 * np.sqrt(wy[:, None] * wx[None, :])
        tile = 256
        for y0 in range(0, out_h, tile):
            y1 = min(y0 + tile, out_h)
            sy = yy[y0:y1, None] + dy
            sx = xx[None, :] + dx
            yf = np.floor(sy)
            xf = np.floor(sx)
            fy = (sy - yf).astype(np.float32)
            fx = (sx - xf).astype(np.float32)
            y0i = np.clip(yf.astype(np.int64), 0, h - 1)
            x0i = np.clip(xf.astype(np.int64), 0, w - 1)
            y1i = np.clip(y0i + 1, 0, h - 1)
            x1i = np.clip(x0i + 1, 0, w - 1)
            wgt = (wsrc[y0i, x0i] * (1 - fy) * (1 - fx)
                   + wsrc[y0i, x1i] * (1 - fy) * fx
                   + wsrc[y1i, x0i] * fy * (1 - fx)
                   + wsrc[y1i, x1i] * fy * fx)
            val = (f[y0i, x0i] * ((1 - fy) * (1 - fx))[..., None]
                   + f[y0i, x1i] * ((1 - fy) * fx)[..., None]
                   + f[y1i, x0i] * (fy * (1 - fx))[..., None]
                   + f[y1i, x1i] * (fy * fx)[..., None])
            acc[y0:y1] += val * wgt[..., None]
            wsum[y0:y1] += wgt
    return acc / np.maximum(wsum, 1e-6)[..., None]


class ComicViewer(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("图片 / 漫画浏览器")
        self.geometry("1250x820")
        self.configure(bg=BG)

        self.sources = []          # 页面来源：路径(str)、压缩包条目(路径, 条目名) 或 PDF 页(路径, 页码)
        self._chapters = None      # 章节：[{"title": str, "sources": list}]；None 表示无章节
        self._chapter_index = 0
        self.index = -1
        self.rotation = 0
        self.zoom = 1.0
        self.fit_mode = "window"   # window | width | height | actual | custom
        self.pan_x = 0.0
        self.pan_y = 0.0
        self.spread_mode = True    # 双页模式
        self.reading_direction = "ltr"   # ltr=左→右, rtl=右→左(日漫)
        self.trim_mode = False     # 裁白边
        self.auto_flip = False     # 自动翻页
        self.auto_interval = 3.0   # 自动翻页每页停留秒数
        self._auto_after = None
        self._spread_img = None    # 双页合成图（None 表示单页）
        self._zip = None           # 当前打开的压缩包
        self._pdf_doc = None       # 当前打开的 PDF 文档（PyMuPDF）
        self._pdf_path = None      # 当前 PDF 文档的路径
        self.book_key = None       # 断点续读的书籍标识
        self._config = self._load_config()

        self.orig = None
        self.display = None
        self.photo = None
        self.canvas_img = None
        self._compare_img = None

        self._drag = None
        self._click_after = None
        self._click_tick = 0         # 单次点击的毫秒时间戳，用于单击/双击判定
        self._resize_after = None
        self._haccum = 0
        self._haccum_timer = None
        self._hseek_accum = 0
        self._hseek_timer = None
        self._zoom_slider_guard = False   # 同步滑块位置时抑制回读回调
        self._zoom_slider_after = None    # 拖拽滑块重绘的节流定时器
        self._ui_hidden = False      # 是否进入沉浸式（全部 UI：工具栏/状态栏/缩略图/视频条都隐藏）
        self._dbl_click = False      # 本次点击是否为双击
        self._dbl_tick = 0           # 双击判定时间戳（毫秒）
        self._dbl_pos = None         # (x, y) 点击位置
        self._thumbs_visible = None   # 缩略图是否可见（None=尚未载入过）
        self._video_bar_visible = None
        # 视频播放自动隐藏 UI（参考 ACG Player）：播放时隐藏菜单栏/工具栏/控制条，
        # 鼠标滑到窗口上边缘显示顶部菜单、滑到下边缘显示控制条，最大化播放画面。
        self._menubar = None                  # 原生菜单栏引用（隐藏/恢复用）
        self._autohide_enabled = self._config.get("_ui_", {}).get("autohide", True)
        self._autohide_poll = None            # 指针位置轮询 after id
        self._autohide_last_show = 0.0        # 最近一次显示 UI 的时间戳
        self._autohide_hidden = False         # 底部控制条当前是否被自动隐藏（视频铺满窗口）
        self._ov_top = None                   # 浮动顶部菜单覆盖层（Toplevel，参考 ACG Player）
        self._ov_reposition_after = None      # 覆盖层重新定位的去抖 after id
        self._seek_preview_win = None         # 进度条悬停/拖动时的画面预览小窗
        self._seek_preview_label = None
        self._seeking = False                 # 是否正在拖动进度条
        self._seek_hovering = False           # 鼠标是否悬停在进度条上
        self._seek_preview_hover = False      # 鼠标是否悬停在预览图上
        self._seek_preview_time = 0           # 当前预览对应的时间（ms）
        self._seek_preview_x = 0              # 当前预览锚定的进度条 x（像素）
        self._seek_hide_after = None          # 延迟隐藏预览的去抖 after id
        self._seek_thumbs = []                # [(time_ms, PhotoImage)] 预生成缩略图
        self._seek_thumbs_src = None          # 缩略图对应的视频 src
        self._seek_thumbs_busy = False
        self._thumb_player = None             # 用于生成缩略图的第二播放器（离屏）
        self._thumb_state = None
        self._thumb_gen_after = None
        self._thumb_photos = []
        self._thumb_rects = []

        self.is_video = False
        self.vlc = None
        self.vlc_instance = None
        self.player = None
        self._video_timer = None
        self._stop_event = None  # 后台线程 stop() 的完成信号（见 _stop_player）
        self._video_ended = False
        self._screenshot_busy = False  # 视频截图进行中（防止重入）
        self._last_seek = 0.0
        self._updating_seek = False
        self._resume_seek_ms = None
        self._ab_start_ms = None
        self._ab_end_ms = None
        video_cfg = self._config.get("_video_", {})
        self._repeat_one = bool(video_cfg.get("repeat_one", False))
        self._repeat_playlist = bool(video_cfg.get("repeat_playlist", False))
        self._shuffle_playlist = bool(video_cfg.get("shuffle_playlist", False))
        self._video_zoom = clamp(float(video_cfg.get("zoom", 1.0)), 0.5, 4.0)
        self._video_fs_fit = True   # 全屏时自动铺满（scale=0 自适应），手动缩放会临时覆盖
        self._video_rotation = 0   # 视频旋转角度 0/90/180/270（不记忆，每次打开新视频重置）
        adj = video_cfg.get("adjust", {}) or {}
        self._video_adjust = {
            "brightness": clamp(float(adj.get("brightness", 1.0)), 0.0, 2.0),
            "contrast": clamp(float(adj.get("contrast", 1.0)), 0.0, 2.0),
            "hue": clamp(float(adj.get("hue", 0.0)), -180.0, 180.0),
            "saturation": clamp(float(adj.get("saturation", 1.0)), 0.0, 3.0),
            "gamma": clamp(float(adj.get("gamma", 1.0)), 0.01, 10.0),
        }
        # 视频局部放大（区域放大）状态
        self.rz = RegionZoom()      # 区域放大纯状态（开关/中心/边长比例）
        self._rz_drag = None        # 拖拽中的起始状态
        self._rz_panel = None       # 区域放大控制面板（Toplevel）
        self._transparent_ticks = 0  # 播放初期重试鼠标穿透的计数
        self._video_cache = {}
        self._remote_providers = {}   # 远程 provider 缓存：名称 -> RemoteProvider
        self._remote_proxy = None     # 当前远程视频的本地流代理
        self._remote_hls = False      # 当前远程视频是否走 HLS 直连（不起代理）
        self._rthumb_gen = 0          # 远程缩略图任务代号；每次重建缩略图条 +1，旧任务自动作废
        self._rthumb_jobs = None
        self._rthumb_results = queue.Queue()
        self._rthumb_pending = 0
        self._rthumb_poll_after = None
        self._rthumb_started_gen = -1
        self._last_browse = {}        # 每个远程 provider 最后浏览的目录路径
        self._alist_proc = None       # 本程序拉起的 AList 进程
        self._tmp_dir = tempfile.mkdtemp(prefix="image_viewer_")

        self.caption_enabled = False
        # 字幕用 audio_set_callbacks 接管过本播放器的音频后，回调无法真正解绑
        # （解绑为 None 会崩溃，只能换空回调），之后该播放器永远无声；
        # 因此下次播放且字幕关闭时需要重建播放器。
        self._audio_hijacked = False
        self.caption_pos = self._config.get("_ui_", {}).get("caption_pos", "bottom")  # "bottom" | "top"
        self._captioner = None
        self._caption_poll_after = None
        self._caption_await_after = None

        # 视频增强：外挂字幕 / 播放速率 / 播放列表 / 图片对比模式
        self._sub_path = None          # 外接字幕文件路径（str），None=未设置
        self._sub_path_auto = False    # 当前字幕是否由同名自动发现
        self._sub_load_enabled = self._config.get("_video_", {}).get("auto_sub", True)  # 打开视频时自动加载同名字幕
        self._rate = 1.0               # 播放速率（0.5 ~ 60.0）
        self._speed_idx = 2            # 速度档位索引（默认 1.0）
        # 播放列表：[(源名, 实际路径/元组), ...]
        self._playlist = []
        self._playlist_index0 = None   # 播放列表里的起始索引
        self._compare_mode = False     # 图片对比模式（两图并排）
        self.book_filter = False       # 模拟纸质书质感（纸张纹理/书脊/光影）
        self._grain_tile = None        # 纸张纹理噪声缓存
        self._sub_load_guard = False   # _load_subtitle_for 内加载字幕时的重入保护

        # 投屏（DLNA / Chromecast）
        self._cast_items = {}          # 设备名 -> dlna_cast.DlnaRenderer
        self._cast_dialog = None       # 投屏设备选择窗口
        self._cast_listbox = None      # 设备列表控件
        self._cast_status_label = None
        self._cast_name = None         # 当前投屏的设备名，None=本地播放
        self._cast_mode = None         # None=本地播放, "dlna"=DLNA 投屏
        self._dlna = None              # dlna_cast.DlnaRenderer
        self._dlna_server = None       # dlna_cast.LocalMediaServer
        self._dlna_playing = False     # DLNA 播放/暂停状态
        self._dlna_total = 0           # DLNA 缓存的总时长（秒）
        self._dlna_pos = 0             # 本地计时的当前秒数
        self._dlna_sync_tick = 0       # 校准计数器

        self._emoji_pending = []       # [(按钮, 带 emoji 的完整文字)]，窗口显示后再换上
        self._build_ui()
        self._build_menu()
        self._bind_events()
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        # 等窗口第一次真正画出来（<Expose>）再换 emoji；1.5s 兜底防止窗口一直没被绘制（如启动即最小化）
        self._emoji_bind = self.bind("<Expose>", self._on_first_expose, add="+")
        self.after(1500, self._apply_emoji)
        self.after(120, lambda: self._show_start(icon=False))   # 首屏不带 emoji，见 _apply_emoji

    # ---------------- UI ----------------
    def _build_ui(self):
        # 顶部工具栏（可横向滚动，避免按钮过多溢出）
        self.toolbar_outer = tk.Frame(self, bg=PANEL)
        self.toolbar_outer.pack(side="top", fill="x")
        self.toolbar_canvas = tk.Canvas(self.toolbar_outer, bg=PANEL,
                                        highlightthickness=0, bd=0)
        self.toolbar_scroll = tk.Scrollbar(self.toolbar_outer, orient="horizontal",
                                           command=self.toolbar_canvas.xview, width=10)
        self.toolbar_canvas.configure(xscrollcommand=self.toolbar_scroll.set)
        self.toolbar_canvas.pack(side="top", fill="x")
        self.toolbar_scroll.pack(side="bottom", fill="x")
        self.toolbar = tk.Frame(self.toolbar_canvas, bg=PANEL, padx=8, pady=6)
        self._toolbar_win = self.toolbar_canvas.create_window((0, 0), window=self.toolbar, anchor="nw")
        self.toolbar.bind("<Configure>", self._resize_toolbar_canvas)
        self.toolbar_canvas.bind("<MouseWheel>", lambda e: self.toolbar_canvas.xview_scroll(int(-e.delta / 120), "units"))
        self.toolbar_canvas.bind("<Shift-MouseWheel>", lambda e: self.toolbar_canvas.xview_scroll(int(-e.delta / 120), "units"))

        self._btn(self.toolbar, "📂 打开文件夹", self.open_folder, primary=True)
        self._btn(self.toolbar, "🖼 打开图片", self.open_files)
        self._btn(self.toolbar, "📦 压缩包", self.open_archive, tip="打开 zip / cbz / rar / cbr")
        self._sep(self.toolbar)
        self._btn(self.toolbar, "⏮", self.prev, tip="上一页")
        self.page_label = tk.Label(self.toolbar, text="0 / 0", bg=PANEL, fg=FG, width=10)
        self.page_label.pack(side="left", padx=4)
        self._btn(self.toolbar, "⏭", self.next, tip="下一页")
        self._sep(self.toolbar)
        self.zoom_out_btn = self._btn(self.toolbar, "➖", self.zoom_out, tip="缩小")
        self.zoom_slider = ttk.Scale(self.toolbar, from_=0, to=1000, orient="horizontal",
                                     command=self._on_zoom_slider, length=140, takefocus=0)
        self.zoom_slider.pack(side="left", padx=4)
        self.zoom_slider.set(self._zoom_slider_pos(1.0))
        self.zoom_label = tk.Label(self.toolbar, text="100%", bg=PANEL, fg=FG, width=7,
                                   cursor="hand2", font=("Microsoft YaHei", 10, "bold"))
        self.zoom_label.pack(side="left", padx=2)
        self.zoom_label.bind("<Button-1>", self._on_zoom_label_click)
        self.zoom_in_btn = self._btn(self.toolbar, "➕", self.zoom_in, tip="放大")
        self._sep(self.toolbar)
        self._btn(self.toolbar, "⛶ 全屏", self.toggle_fullscreen, tip="全屏 (回车 / F / F11)")
        self._btn(self.toolbar, "? 帮助", self.show_help, tip="帮助")

        # 章节导航条（默认隐藏，打开含子文件夹/子目录的多章节书时显示）
        self.chapter_bar = tk.Frame(self, bg=PANEL, padx=8, pady=3)
        self.chapter_prev_btn = self._btn(self.chapter_bar, "⏮ 上一话", self.prev_chapter)
        self.chapter_combo = ttk.Combobox(self.chapter_bar, state="readonly", width=26,
                                          font=("Microsoft YaHei", 10))
        self.chapter_combo.pack(side="left", padx=4)
        self.chapter_combo.bind("<<ComboboxSelected>>", self._on_chapter_selected)
        self.chapter_next_btn = self._btn(self.chapter_bar, "下一话 ⏭", self.next_chapter)

        # 状态栏
        self.status = tk.Label(self, text="请打开一个图片文件夹 / 压缩包开始阅读", bg=PANEL, fg=MUTED,
                               anchor="w", padx=10, pady=4, font=("Microsoft YaHei", 9))
        self.status.pack(side="bottom", fill="x")

        # 缩略图条（默认隐藏）
        self.thumbs_frame = tk.Frame(self, bg=PANEL)
        self.thumbs = tk.Canvas(self.thumbs_frame, height=96, bg=PANEL,
                                highlightthickness=0, bd=0)
        self.thumbs_scroll = tk.Scrollbar(self.thumbs_frame, orient="horizontal",
                                          command=self.thumbs.xview)
        self.thumbs.configure(xscrollcommand=self.thumbs_scroll.set)
        self.thumbs.pack(side="top", fill="x")
        self.thumbs_scroll.pack(side="bottom", fill="x")

        # 内容区：主画布 + 视频面板（互斥显示）
        self.content = tk.Frame(self, bg=BG)
        self.content.pack(side="top", fill="both", expand=True)
        self.canvas = tk.Canvas(self.content, bg=BG, highlightthickness=0, bd=0, cursor="hand2")
        self.canvas.pack(side="top", fill="both", expand=True)
        self.video_panel = tk.Frame(self.content, bg="black")

        # 视频控制条（默认隐藏）
        self.video_bar = tk.Frame(self, bg=PANEL, padx=8, pady=4)
        self.play_btn = tk.Button(self.video_bar, text="||", command=self._toggle_play, takefocus=0,
                                  bg=BTN_BG, fg=FG, activebackground=BTN_ACTIVE, activeforeground="#fff",
                                  relief="flat", bd=0, width=4, cursor="hand2", font=("Segoe UI", 11))
        self.play_btn.pack(side="left", padx=2)
        self._emoji_pending.append((self.play_btn, "⏸"))
        self.time_label = tk.Label(self.video_bar, text="0:00 / 0:00", bg=PANEL, fg=FG,
                                   font=("Consolas", 10))
        self.time_label.pack(side="left", padx=6)
        self.seek = ttk.Scale(self.video_bar, from_=0, to=1000, orient="horizontal", command=self._on_seek)
        self.seek.pack(side="left", fill="x", expand=True, padx=6)
        tk.Label(self.video_bar, text="音量", bg=PANEL, fg=MUTED,
                 font=("Microsoft YaHei", 9)).pack(side="left", padx=(8, 2))
        self.vol = ttk.Scale(self.video_bar, from_=0, to=100, orient="horizontal", command=self._on_volume)
        self.vol.set(100)
        self.vol.pack(side="left", fill="x", padx=6, ipadx=40)
        # 其余不常用开关（外挂字幕/循环/画面缩放/字幕位置）已移到「视图」菜单
        self.rate_minus_btn = self._state_btn(self.video_bar, "慢", lambda: self.rate_change(-1))
        self.rate_label = tk.Label(self.video_bar, text="1.0×", bg=PANEL, fg=FG,
                                   font=("Consolas", 10, "bold"))
        self.rate_label.pack(side="left", padx=(6, 6))
        self.rate_plus_btn = self._state_btn(self.video_bar, "快", lambda: self.rate_change(1))

        self.caption_btn = self._state_btn(self.video_bar, "CC 字幕", self.toggle_captions)
        self.caption_lang_var = tk.StringVar(value="英文")
        self.caption_lang_combo = ttk.Combobox(self.video_bar, textvariable=self.caption_lang_var,
                                               values=CAPTION_LANGS, state="readonly", width=5)
        self.caption_lang_combo.pack(side="left", padx=(8, 2))
        self.caption_lang_combo.bind("<<ComboboxSelected>>", self._on_caption_lang_change)
        # 当视频的区域放大模式开启时，阻止语言下拉框使用上下键切换项，
        # 改为把上下键路由为放大框的平移操作。
        self.caption_lang_combo.bind("<Up>", lambda e: (self._rz_pan_key("Up"), "break")[1] if (self.is_video and self._region_zoom) else None)
        self.caption_lang_combo.bind("<Down>", lambda e: (self._rz_pan_key("Down"), "break")[1] if (self.is_video and self._region_zoom) else None)
        self.caption_mode_var = tk.StringVar(value="原声")
        self.caption_mode_combo = ttk.Combobox(self.video_bar, textvariable=self.caption_mode_var,
                                               values=CAPTION_MODES, state="readonly", width=9)
        self.caption_mode_combo.pack(side="left", padx=2)
        self.caption_mode_combo.bind("<<ComboboxSelected>>", self._on_caption_mode_change)
        # 同样阻止模式下拉框上下键干扰区域放大平移
        self.caption_mode_combo.bind("<Up>", lambda e: (self._rz_pan_key("Up"), "break")[1] if (self.is_video and self._region_zoom) else None)
        self.caption_mode_combo.bind("<Down>", lambda e: (self._rz_pan_key("Down"), "break")[1] if (self.is_video and self._region_zoom) else None)
        self.cast_btn = self._state_btn(self.video_bar, "📺 投屏", self.toggle_cast)
        self.shot_btn = self._state_btn(self.video_bar, "📷 截图", self._video_screenshot)
        self.browse_btn = self._state_btn(self.video_bar, "📁 目录", self._back_to_browse)
        self.browse_btn.pack_forget()   # 播放远程视频时显示，其余隐藏

        # VLC 硬件加速（D3D11）在 video_panel 的原生窗口上直接画视频画面，会盖住
        # 任何叠在它上面的 Tk 子控件 -- Tk 的 lift()/z-order 对这种系统合成层面
        # 的表面完全无效。所以字幕框不能是 video_panel 的子控件，得做成一个独立
        # 的置顶 Toplevel 窗口，跟着 video_panel 的屏幕坐标走。
        self.caption_window = tk.Toplevel(self)
        self.caption_window.overrideredirect(True)
        self.caption_window.attributes("-topmost", True)
        self.caption_window.withdraw()
        self.caption_label = tk.Label(self.caption_window, text="", bg="#000000", fg="#ffffff",
                                      font=("Microsoft YaHei", 14), wraplength=900, justify="center",
                                      padx=10, pady=4)
        self.caption_label.pack()
        self.video_panel.bind("<Configure>", lambda e: self._reposition_caption_window())

        # 离屏渲染窗口：第二播放器在这里截图生成进度缩略图（不显示）
        self._thumb_win = tk.Toplevel(self)
        self._thumb_win.overrideredirect(True)
        self._thumb_win.geometry("200x120+9000+9000")
        self._thumb_frame = tk.Frame(self._thumb_win, bg="black", width=200, height=120)
        self._thumb_frame.pack()

        # 进度条悬停时的画面预览小窗（缩略图 + 时间）
        self.seek_preview_win = tk.Toplevel(self)
        self.seek_preview_win.overrideredirect(True)
        self.seek_preview_win.attributes("-topmost", True)
        self.seek_preview_win.withdraw()
        self.seek_preview_win.configure(bg="#000000")
        self.seek_preview_label = tk.Label(self.seek_preview_win, bg="#000000", fg="#ffffff",
                                           font=("Consolas", 12), padx=8, pady=6, compound="bottom",
                                           cursor="hand2")
        self.seek_preview_label.pack()
        self.seek_preview_label.bind("<Button-1>", self._on_seek_preview_click)
        self.seek_preview_label.bind("<Enter>", self._on_seek_preview_enter)
        self.seek_preview_label.bind("<Leave>", self._on_seek_preview_leave)

        self._sync_toggle_buttons()

    def _build_menu(self):
        menubar = tk.Menu(self)

        file_menu = tk.Menu(menubar, tearoff=0)
        view = tk.Menu(menubar, tearoff=0)
        net_menu = tk.Menu(menubar, tearoff=0)
        help_menu = tk.Menu(menubar, tearoff=0)
        self._populate_menus(file_menu, view, help_menu)
        net_menu.add_command(label="一键连接网盘 (AList)...", command=self._one_click_alist)
        net_menu.add_command(label="打开 AList 网页后台", command=self._open_alist_web)
        net_menu.add_separator()
        net_menu.add_command(label="连接 WebDAV 网盘...", command=self._open_webdav_dialog)
        net_menu.add_command(label="连接 Jellyfin / Emby 服务器...", command=self._open_jellyfin_dialog)
        net_menu.add_separator()
        net_menu.add_command(label="浏览 WebDAV...", command=lambda: self._browse_remote_menu("webdav"))
        net_menu.add_command(label="浏览 Jellyfin...", command=lambda: self._browse_remote_menu("jellyfin"))
        menubar.add_cascade(label="文件", menu=file_menu)
        menubar.add_cascade(label="视图", menu=view)
        menubar.add_cascade(label="网盘", menu=net_menu)
        menubar.add_cascade(label="帮助", menu=help_menu)

        self._menubar = menubar
        self._file_menu = file_menu
        self._view_menu = view
        self._net_menu = net_menu
        self._help_menu = help_menu
        self.configure(menu=menubar)
        self._build_video_menu_overlay()

    def _populate_menus(self, file_menu, view, help_menu):
        """往三个菜单里填入命令（原生菜单栏与浮动菜单复用同一份）。"""
        file_menu.add_command(label="打开文件夹", command=self.open_folder)
        file_menu.add_command(label="打开图片", command=self.open_files)
        file_menu.add_command(label="打开压缩包 (zip/cbz/rar/cbr)", command=self.open_archive)
        file_menu.add_command(label="打开 PDF", command=self.open_pdf)
        file_menu.add_command(label="打开播放列表 (m3u/m3u8)", command=self.open_playlist)
        file_menu.add_command(label="打开历史播放", command=self.open_history_playlist)
        file_menu.add_command(label="详细信息", command=self.show_details)
        file_menu.add_command(label="网页版（本地服务，支持 rar/cbr・PDF）...",
                              command=self.open_web_server)
        file_menu.add_separator()
        file_menu.add_command(label="退出", command=self._on_close)

        view.add_command(label="全屏 / 退出全屏", command=self.toggle_fullscreen,
                         accelerator="Enter / F / F11")
        view.add_command(label="显示 / 隐藏缩略图", command=self.toggle_thumbs, accelerator="T")
        view.add_command(label="播放时自动隐藏菜单/工具栏 开/关", command=self.toggle_autohide)
        view.add_command(label="上一张", command=self.prev)
        view.add_command(label="下一张", command=self.next)
        view.add_command(label="上一话", command=self.prev_chapter)
        view.add_command(label="下一话", command=self.next_chapter)
        view.add_separator()
        view.add_command(label="跳到指定页", command=self.jump_to_page, accelerator="G")
        view.add_command(label="自动翻页 开 / 关", command=self.toggle_auto, accelerator="A")
        view.add_command(label="双页模式 开 / 关", command=self.toggle_spread, accelerator="D")
        view.add_command(label="阅读方向 左→右 / 右→左", command=self.toggle_direction, accelerator="M")
        view.add_command(label="裁白边 开 / 关", command=self.toggle_trim, accelerator="C")
        view.add_command(label="纸质书质感 开 / 关", command=self.toggle_book_filter, accelerator="B")
        view.add_separator()
        view.add_command(label="适应窗口", command=lambda: self.set_fit("window"))
        view.add_command(label="适应宽度", command=lambda: self.set_fit("width"))
        view.add_command(label="适应高度", command=lambda: self.set_fit("height"))
        view.add_command(label="实际大小 (100%)", command=lambda: self.set_fit("actual"))
        view.add_separator()
        view.add_command(label="顺时针旋转 90°", command=lambda: self.rotate(90), accelerator="R")
        view.add_command(label="逆时针旋转 90°", command=lambda: self.rotate(-90), accelerator="Shift+R")
        view.add_separator()
        view.add_command(label="外挂字幕 (.srt/.ass)", command=self._choose_subtitle, accelerator="S")
        view.add_command(label="播放速率 +1 档", command=lambda: self.rate_change(1))
        view.add_command(label="播放速率 -1 档", command=lambda: self.rate_change(-1))
        view.add_command(label="A-B 循环 开始/结束/清除", command=self.toggle_ab_repeat)
        view.add_command(label="单曲循环", command=self.toggle_repeat_one)
        view.add_command(label="播放列表循环", command=self.toggle_repeat_playlist)
        view.add_command(label="播放列表随机", command=self.toggle_shuffle_playlist)
        view.add_command(label="下一轨（播放列表）", command=self._playlist_forward)
        view.add_command(label="上一轨（播放列表）", command=self._playlist_back)
        view.add_command(label="图片对比模式（两图并排）", command=self.toggle_compare)
        view.add_separator()
        view.add_command(label="变速...", command=self._choose_rate)
        view.add_command(label="画面放大 +25%", command=lambda: self.change_video_zoom(0.25))
        view.add_command(label="画面缩小 -25%", command=lambda: self.change_video_zoom(-0.25))
        view.add_command(label="重置画面缩放", command=self.reset_video_zoom)
        view.add_command(label="区域放大 开/关", command=self.toggle_region_zoom, accelerator="Z")
        view.add_command(label="画面调节（亮度/对比度…）", command=self.open_video_adjust, accelerator="E")
        view.add_command(label="重置画面调节", command=self.reset_video_adjust)
        view.add_command(label="字幕位置 顶部/底部", command=self.toggle_caption_pos)
        view.add_separator()
        view.add_command(label="投屏到电视 / 设备", command=self.toggle_cast)
        view.add_separator()
        view.add_command(label="视频截图（多帧合成高清）", command=self._video_screenshot, accelerator="P")

        help_menu.add_command(label="使用帮助", command=self.show_help, accelerator="?")
        help_menu.add_command(label="AI 字幕翻译设置", command=self._open_ai_settings)
        help_menu.add_command(label="打开/关闭同名字幕自动加载", command=self.toggle_subtitle_load)

    def _reposition_caption_window(self):
        if not self.caption_window.winfo_viewable():
            return
        vp = self.video_panel
        if not vp.winfo_ismapped():
            return
        self.caption_window.update_idletasks()
        x = vp.winfo_rootx()
        y = vp.winfo_rooty()
        w = vp.winfo_width()
        h = vp.winfo_height()
        cw = self.caption_label.winfo_reqwidth()
        ch = self.caption_label.winfo_reqheight()
        cx = x + max(0, (w - cw) // 2)
        if self.caption_pos == "top":
            cy = y + int(h * 0.06)
        else:
            cy = y + int(h * 0.94) - ch
        self.caption_window.geometry("+%d+%d" % (cx, cy))

    def _raise_caption_window(self):
        """全屏后重新把字幕窗口置顶抬升。先关再开 -topmost 强制 Windows 重排
        z-order，避免字幕被视频输出盖住。"""
        if not self.caption_window.winfo_viewable():
            return
        self.caption_window.attributes("-topmost", False)
        self.caption_window.attributes("-topmost", True)
        self.caption_window.lift()
        self._reposition_caption_window()

    def _set_btn_text(self, b, text):
        """改按钮文字；若该按钮的 emoji 还没换上（首屏推迟中），只更新待换文字，不触发 emoji 字体加载。"""
        for k, (pb, _t) in enumerate(self._emoji_pending):
            if pb is b:
                self._emoji_pending[k] = (b, text)
                return
        b.configure(text=text)

    def _on_first_expose(self, _event=None):
        if self._emoji_bind:
            self.unbind("<Expose>", self._emoji_bind)
            self._emoji_bind = None
            self.after(30, self._apply_emoji)

    def _apply_emoji(self):
        pending, self._emoji_pending = self._emoji_pending, []
        for b, text in pending:
            try:
                b.configure(text=text)
            except tk.TclError:
                pass
        if not self.sources:
            self._show_start()    # 补上起始页标题的 emoji

    def _btn(self, parent, text, cmd, tip=None, primary=False):
        shown = _plain_text(text)
        b = tk.Button(parent, text=shown, command=cmd, takefocus=0,
                      bg=ACCENT if primary else BTN_BG,
                      fg="#fff" if primary else FG,
                      activebackground="#5b9aff" if primary else BTN_ACTIVE,
                      activeforeground="#fff",
                      relief="flat", bd=0, padx=10, pady=4,
                      cursor="hand2", font=("Microsoft YaHei", 10))
        b.pack(side="left", padx=2)
        if shown != text:
            self._emoji_pending.append((b, text))
        return b

    def _state_btn(self, parent, text, cmd):
        shown = _plain_text(text)
        b = tk.Button(parent, text=shown, command=cmd, takefocus=0,
                      bg=BTN_BG, fg=FG, activebackground=BTN_ACTIVE, activeforeground="#fff",
                      relief="flat", bd=0, padx=10, pady=4,
                      cursor="hand2", font=("Microsoft YaHei", 10))
        b.pack(side="left", padx=2)
        if shown != text:
            self._emoji_pending.append((b, text))
        return b

    def _resize_toolbar_canvas(self, event=None):
        self.toolbar_canvas.configure(
            height=self.toolbar.winfo_reqheight(),
            scrollregion=self.toolbar_canvas.bbox("all"))

    def _sep(self, parent):
        tk.Frame(parent, bg="#3a3f47", width=1, height=22).pack(side="left", padx=6, pady=2)

    def _bind_events(self):
        c = self.canvas
        c.bind("<ButtonPress-1>", self._on_press)
        c.bind("<B1-Motion>", self._on_motion)
        c.bind("<ButtonRelease-1>", self._on_release)
        c.bind("<Double-Button-1>", self._on_double)
        c.bind("<MouseWheel>", self._on_wheel)
        c.bind("<Shift-MouseWheel>", self._on_hwheel)
        c.bind("<Button-4>", lambda e: self.zoom_at(e.x, e.y, 1.25))
        c.bind("<Button-5>", lambda e: self.zoom_at(e.x, e.y, 0.8))
        c.bind("<Configure>", self._on_resize)

        self.thumbs.bind("<Button-1>", self._on_thumb_click)
        self.thumbs.bind("<MouseWheel>", lambda e: self.thumbs.xview_scroll(int(-e.delta / 120), "units"))

        self.bind_all("<Key>", self._on_key)
        self.bind_all("<F11>", lambda e: self.toggle_fullscreen())
        self.bind("<Configure>", self._on_window_configure)
        # 视频页：滚轮 / 触控板手势 / 单击
        self.bind_all("<MouseWheel>", self._on_video_wheel)
        self.bind_all("<Shift-MouseWheel>", self._on_video_hwheel)
        self.video_panel.bind("<ButtonPress-1>", self._on_video_press)
        self.video_panel.bind("<B1-Motion>", self._on_video_motion)
        self.video_panel.bind("<ButtonRelease-1>", self._on_video_release)
        self.seek.bind("<Enter>", self._on_seek_enter)
        self.seek.bind("<Motion>", self._on_seek_hover)
        self.seek.bind("<Leave>", self._on_seek_leave)
        self.seek.bind("<ButtonPress-1>", self._on_seek_press)
        self.seek.bind("<ButtonRelease-1>", self._on_seek_release)

    # ---------------- 配置 / 断点续读 ----------------
    def _load_config(self):
        return load_config(CONFIG_PATH)

    def _save_config(self):
        save_config(CONFIG_PATH, self._config)

    def _save_progress(self):
        if not self.book_key or not self.sources:
            return
        self._config[self.book_key] = {
            "index": self.index,
            "spread_mode": self.spread_mode,
            "direction": self.reading_direction,
            "trim_mode": self.trim_mode,
            "fit_mode": self.fit_mode,
            "zoom": self.zoom,
            "rotation": self.rotation,
            "book_filter": self.book_filter,
        }
        if self._chapters:
            self._config[self.book_key]["chapter"] = self._chapter_index
        self._save_config()

    def _on_close(self):
        self._cancel_auto()
        self._close_cast_dialog()
        self._stop_video()
        self._stop_remote_proxy()
        alist_manager.stop_alist(self._alist_proc)
        wb = getattr(self, "_web_backend", None)
        if wb is not None:
            try:
                wb.stop_server()
            except Exception:
                pass
        self._save_progress()
        self._close_zip()
        try:
            shutil.rmtree(self._tmp_dir, ignore_errors=True)
        except Exception:
            pass
        self.destroy()

    # ---------------- 文件加载 ----------------
    def open_folder(self):
        d = filedialog.askdirectory(title="选择图片文件夹")
        if d:
            self.load_folder(d)

    def open_files(self):
        paths = filedialog.askopenfilenames(
            title="选择图片 / 视频 / PDF / 压缩包（可多选）",
            filetypes=[("图片 / 视频 / PDF / 压缩包", "*.png *.jpg *.jpeg *.gif *.webp *.bmp *.tif *.tiff *.jfif *.mp4 *.mkv *.avi *.webm *.mov *.wmv *.flv *.m4v *.ts *.pdf *.zip *.cbz *.rar *.cbr"),
                       ("图片文件", "*.png *.jpg *.jpeg *.gif *.webp *.bmp *.tif *.tiff *.jfif"),
                       ("视频文件", "*.mp4 *.mkv *.avi *.webm *.mov *.wmv *.flv *.m4v *.ts"),
                       ("PDF 文件", "*.pdf"),
                       ("压缩包", "*.zip *.cbz *.rar *.cbr"),
                       ("所有文件", "*.*")])
        if not paths:
            return
        pdfs = [p for p in paths if os.path.splitext(p)[1].lower() in PDF_EXTS]
        zips = [p for p in paths if os.path.splitext(p)[1].lower() in ARCHIVE_EXTS]
        imgs = [p for p in paths if p not in pdfs and p not in zips]
        if pdfs:
            if len(pdfs) > 1 or zips or imgs:
                messagebox.showinfo("提示", "PDF 请单独打开。")
            self._load_pdf_path(pdfs[0])
        elif zips:
            if len(zips) > 1 or imgs:
                messagebox.showinfo("提示", "压缩包请单独打开。")
            self._load_archive_path(zips[0])
        elif imgs:
            imgs.sort(key=lambda p: natural_key(os.path.basename(p)))
            self._close_zip()
            self._reset_chapters()
            self._playlist = []
            self._playlist_index0 = None
            self.book_key = files_book_key(imgs)
            self._load_list(imgs)

    def open_archive(self):
        p = filedialog.askopenfilename(title="选择压缩包（zip / cbz / rar / cbr）",
                                       filetypes=[("压缩包", "*.zip *.cbz *.rar *.cbr"), ("所有文件", "*.*")])
        if p:
            self._load_archive_path(p)

    def open_pdf(self):
        p = filedialog.askopenfilename(title="选择 PDF 文件（漫画）",
                                       filetypes=[("PDF 文件", "*.pdf"), ("所有文件", "*.*")])
        if p:
            self._load_pdf_path(p)

    def open_playlist(self):
        path = filedialog.askopenfilename(
            title="选择播放列表",
            filetypes=[("播放列表", "*.m3u *.m3u8"), ("所有文件", "*.*")])
        if not path:
            return
        self._load_playlist_path(path)

    def open_web_server(self):
        """启动本地后端并在默认浏览器里打开网页版。

        网页版本身只能读浏览器能解的格式；挂上这个后端后，rar/cbr（走桌面版
        同款 rarfile + 7-Zip）、PDF（PyMuPDF 按页渲染）、磁盘路径浏览、
        服务端缩略图、以及与桌面版共用 image_viewer.json 进度，都能用。
        """
        try:
            import web_backend
        except Exception as error:
            messagebox.showerror("错误", "启动网页版失败（缺少 web_backend）：%s" % error)
            return
        try:
            url = web_backend.start_server(open_browser=True)
        except Exception as error:
            messagebox.showerror("错误", "启动网页版后端失败：%s" % error)
            return
        self._web_backend = web_backend
        caps = web_backend.capabilities()
        miss = []
        if not caps.get("rar"):
            miss.append("rar/cbr（需 pip install rarfile 且本机有 7-Zip 或 WinRAR）")
        if not caps.get("pdf"):
            miss.append("PDF（需 pip install pymupdf）")
        extra = "\n\n当前不支持：\n・" + "\n・".join(miss) if miss else ""
        self.status.configure(text="网页版已启动：%s（进度与桌面版互通）" % url)
        messagebox.showinfo("网页版",
                            "已在默认浏览器打开：\n%s\n\n关掉本提示窗不影响桌面版；退出本程序时后端会停。%s"
                            % (url, extra))

    def open_history_playlist(self):
        if not os.path.isfile(HISTORY_PLAYLIST_PATH):
            messagebox.showinfo("提示", "尚无播放历史。打开本地或网盘/Jellyfin 媒体后会自动创建。")
            return
        self._load_playlist_path(HISTORY_PLAYLIST_PATH)

    def _load_playlist_path(self, path):
        try:
            with open(path, "r", encoding="utf-8-sig") as playlist_file:
                lines = playlist_file.readlines()
        except UnicodeDecodeError:
            try:
                with open(path, "r", encoding="gb18030") as playlist_file:
                    lines = playlist_file.readlines()
            except Exception as error:
                messagebox.showerror("错误", "无法读取播放列表：%s" % error)
                return
        except Exception as error:
            messagebox.showerror("错误", "无法读取播放列表：%s" % error)
            return

        sources = parse_playlist(lines, os.path.dirname(path), self._pdf_page_count,
                                 remote_parser=_remote_from_history_line)
        if not sources:
            messagebox.showinfo("提示", "播放列表中没有可访问的媒体文件。")
            return

        self._close_zip()
        self.book_key = playlist_book_key(path)
        self._playlist = list(sources)
        self._playlist_index0 = 0
        self._reset_chapters()
        self._load_list(sources)

    def _record_history(self, src):
        """将实际播放的媒体写入最近播放 M3U，最新记录置顶。

        本地文件存绝对路径；远程（网盘/Jellyfin）用 _remote_history_line 的编码，
        这样从历史里重新打开也能直接连回原位置，不用重新一层层浏览。
        """
        if isinstance(src, RemoteSource):
            update_history(_remote_history_line(src), HISTORY_PLAYLIST_PATH, HISTORY_LIMIT)
            return
        if isinstance(src, tuple):
            if self._is_pdf_src(src):
                src = src[0]   # PDF 按整本书记录
            else:
                return
        if not os.path.isfile(src):
            return
        update_history(src, HISTORY_PLAYLIST_PATH, HISTORY_LIMIT)

    # ---------------- 网盘 / 远程源 ----------------
    def _get_provider(self, name):
        """按名称取远程 provider（懒加载 WebDAV / Jellyfin 配置）。"""
        if name in self._remote_providers:
            return self._remote_providers[name]
        if name == "webdav":
            cfg = self._config.get("_webdav_")
            if cfg and cfg.get("base_url"):
                try:
                    p = _remote().WebDavProvider(cfg["base_url"],
                                       cfg.get("username", ""),
                                       cfg.get("password", ""))
                    self._remote_providers[name] = p
                    return p
                except Exception:
                    return None
        elif name == "jellyfin":
            cfg = self._config.get("_jellyfin_")
            if cfg and cfg.get("base_url") and cfg.get("token"):
                p = _remote().JellyfinProvider(cfg["base_url"], cfg["token"],
                                     cfg.get("user_id", ""),
                                     username=cfg.get("username", ""),
                                     device_id=cfg.get("device_id"))
                self._remote_providers[name] = p
                return p
        return None

    def _open_webdav_dialog(self):
        cfg = self._config.get("_webdav_", {})
        dlg = tk.Toplevel(self)
        dlg.title("连接 WebDAV 网盘")
        dlg.transient(self)
        dlg.resizable(False, False)
        body = ttk.Frame(dlg, padding=12)
        body.pack(fill="both", expand=True)
        ttk.Label(body, text="地址（含路径，如 https://dav.jianguoyun.com/dav）").grid(
            row=0, column=0, columnspan=2, sticky="w")
        url_var = tk.StringVar(value=cfg.get("base_url", ""))
        ttk.Entry(body, textvariable=url_var, width=48).grid(
            row=1, column=0, columnspan=2, sticky="we", pady=(0, 6))
        ttk.Label(body, text="用户名").grid(row=2, column=0, sticky="w")
        ttk.Label(body, text="密码").grid(row=3, column=0, sticky="w")
        user_var = tk.StringVar(value=cfg.get("username", ""))
        pass_var = tk.StringVar(value=cfg.get("password", ""))
        ttk.Entry(body, textvariable=user_var, width=48).grid(row=2, column=1, sticky="we", pady=2)
        ttk.Entry(body, textvariable=pass_var, width=48, show="*").grid(row=3, column=1, sticky="we", pady=2)
        ttk.Label(body, text="凭据将保存在本地配置文件中（明文）。", foreground="#888").grid(
            row=4, column=0, columnspan=2, sticky="w", pady=(4, 0))

        def do_connect():
            url = url_var.get().strip()
            if not url:
                messagebox.showwarning("提示", "请填写 WebDAV 地址。", parent=dlg)
                return
            try:
                p = _remote().WebDavProvider(url, user_var.get().strip(), pass_var.get())
                p.list_dir_strict(p.root_path)   # 连通性自检（失败会抛出，不再被当成空目录）
            except Exception as e:
                messagebox.showerror("连接失败", "无法连接 WebDAV：%s" % e, parent=dlg)
                return
            self._config["_webdav_"] = {
                "base_url": url,
                "username": user_var.get().strip(),
                "password": pass_var.get(),
            }
            self._save_config()
            self._remote_providers["webdav"] = p
            dlg.destroy()
            self._remote_browser(p, p.root_path)

        btns = ttk.Frame(body)
        btns.grid(row=5, column=0, columnspan=2, sticky="e", pady=(10, 0))
        ttk.Button(btns, text="连接", command=do_connect).pack(side="left")
        ttk.Button(btns, text="取消", command=dlg.destroy).pack(side="left", padx=6)
        dlg.grab_set()

    def _open_jellyfin_dialog(self):
        cfg = self._config.get("_jellyfin_", {})
        dlg = tk.Toplevel(self)
        dlg.title("连接 Jellyfin / Emby")
        dlg.transient(self)
        dlg.resizable(False, False)
        body = ttk.Frame(dlg, padding=12)
        body.pack(fill="both", expand=True)
        ttk.Label(body, text="服务器地址（如 http://192.168.1.5:8096）").grid(
            row=0, column=0, columnspan=2, sticky="w")
        url_var = tk.StringVar(value=cfg.get("base_url", ""))
        ttk.Entry(body, textvariable=url_var, width=48).grid(
            row=1, column=0, columnspan=2, sticky="we", pady=(0, 6))
        ttk.Label(body, text="用户名").grid(row=2, column=0, sticky="w")
        ttk.Label(body, text="密码").grid(row=3, column=0, sticky="w")
        user_var = tk.StringVar(value=cfg.get("username", ""))
        pass_var = tk.StringVar(value="")
        ttk.Entry(body, textvariable=user_var, width=48).grid(row=2, column=1, sticky="we", pady=2)
        ttk.Entry(body, textvariable=pass_var, width=48, show="*").grid(row=3, column=1, sticky="we", pady=2)
        ttk.Label(body, text="登录成功后 token 会保存在本地配置文件中（密码不保存）。", foreground="#888").grid(
            row=4, column=0, columnspan=2, sticky="w", pady=(4, 0))

        def do_connect():
            url = url_var.get().strip()
            username = user_var.get().strip()
            if not url:
                messagebox.showwarning("提示", "请填写服务器地址。", parent=dlg)
                return
            try:
                token, user_id, device_id = _remote().JellyfinProvider.authenticate(
                    url, username, pass_var.get())
                if not token or not user_id:
                    raise RuntimeError("登录返回缺少 token 或用户 ID")
                p = _remote().JellyfinProvider(url, token, user_id,
                                     username=username, device_id=device_id)
                p.list_dir_strict("")   # 连通性自检（列顶层媒体库）
            except Exception as e:
                messagebox.showerror("连接失败", "无法连接 Jellyfin/Emby：%s" % e, parent=dlg)
                return
            self._config["_jellyfin_"] = {
                "base_url": url,
                "username": username,
                "token": token,
                "user_id": user_id,
                "device_id": device_id,
            }
            self._save_config()
            self._remote_providers["jellyfin"] = p
            dlg.destroy()
            self._poster_wall(p, p.root_path)

        btns = ttk.Frame(body)
        btns.grid(row=5, column=0, columnspan=2, sticky="e", pady=(10, 0))
        ttk.Button(btns, text="连接", command=do_connect).pack(side="left")
        ttk.Button(btns, text="取消", command=dlg.destroy).pack(side="left", padx=6)
        dlg.grab_set()

    def _browse_remote_menu(self, name="webdav"):
        p = self._get_provider(name)
        if not p:
            if name == "jellyfin":
                self._open_jellyfin_dialog()
            else:
                self._open_webdav_dialog()
            return
        start = self._last_browse.get(name, p.root_path)
        if name == "jellyfin":
            self._poster_wall(p, start)
        else:
            self._remote_browser(p, start)

    def _back_to_browse(self):
        """播放中返回远程目录浏览（先停播放，续播点已保存）。"""
        if not self.sources:
            return
        src = self.sources[self.index]
        if not isinstance(src, RemoteSource):
            return
        p = self._get_provider(src.provider)
        if not p:
            return
        name = src.provider
        start = self._last_browse.get(name, p.root_path)
        if self.is_video:
            self._stop_video()
        if name == "jellyfin":
            self._poster_wall(p, start)
        else:
            self._remote_browser(p, start)

    def _one_click_alist(self):
        """一键连接网盘：启动/管理本地 AList，并通过其 WebDAV 连接。"""
        exe = alist_manager.find_alist()
        if not exe:
            if messagebox.askyesno(
                    "未找到 AList",
                    "本机没有找到 alist.exe。\n\n是否打开 AList 下载页？\n"
                    "下载后请把 alist.exe 放到本程序所在目录。",
                    parent=self):
                webbrowser.open("https://github.com/AlistGo/alist/releases/latest")
            return
        alist_dir = os.path.dirname(exe)
        # 数据目录用 AList 默认的 ./data（与手动双击 alist.exe 一致，避免两套密码）
        cfg = self._config.setdefault("_alist_", {})
        pw = cfg.get("password")
        first = not pw
        if first:
            pw = alist_manager.generate_password()
            # v3.9+ 需先停服务再设密码；首次服务未启动，直接设置
            if not alist_manager.set_admin_password(exe, pw, cwd=alist_dir):
                messagebox.showerror("AList 初始化失败",
                                     "无法设置 AList 管理员密码。\n请确认 alist.exe 可执行。",
                                     parent=self)
                return
            cfg["password"] = pw
            self._save_config()
        if not alist_manager.is_running():
            try:
                self._alist_proc = alist_manager.start_alist(exe, cwd=alist_dir)
            except Exception as e:
                messagebox.showerror("AList 启动失败", str(e), parent=self)
                return
        if not alist_manager.wait_ready():
            messagebox.showerror("AList 启动失败",
                                 "AList 服务未能就绪（端口 %d）。" % alist_manager.ALIST_PORT,
                                 parent=self)
            return
        self._config["_webdav_"] = {
            "base_url": alist_manager.WEBDAV_URL,
            "username": "admin",
            "password": pw,
        }
        self._save_config()
        self._remote_providers.pop("webdav", None)  # 重建 provider
        p = self._get_provider("webdav")
        if not p:
            messagebox.showerror("连接失败", "无法建立 WebDAV 连接。", parent=self)
            return
        if first:
            messagebox.showinfo(
                "AList 已就绪（首次使用）",
                "AList 是「无界面」的网盘网关，请按下面 3 步添加网盘账号：\n\n"
                "1. 浏览器已自动打开 http://127.0.0.1:5244\n"
                "   （没打开就手动在浏览器输入这个地址）\n"
                "2. 登录：用户名 admin，密码 %s\n"
                "3. 左侧「存储」→「添加」→ 选你的网盘（百度/夸克/移动云盘…）\n"
                "   → 按提示扫码或填 cookie → 保存\n\n"
                "添加完成后，回本程序点菜单「网盘 → 浏览 WebDAV」即可看到并播放。" % pw,
                parent=self)
            webbrowser.open(alist_manager.WEB_URL)
            return   # 首次先让用户去添加网盘，不打开空目录窗口
        self._remote_browser(p, p.root_path)

    def _open_alist_web(self):
        """打开 AList 网页后台（用于添加/管理网盘账号）。"""
        if not alist_manager.is_running():
            messagebox.showinfo("AList 未运行",
                                 "请先点「网盘 → 一键连接网盘 (AList)」启动 AList。",
                                 parent=self)
            return
        webbrowser.open(alist_manager.WEB_URL)

    # ---------------- 网盘浏览器（列表 / 网格 两种视图） ----------------
    _RB_TILE_W, _RB_TILE_H, _RB_LABEL_H, _RB_GAP, _RB_MARGIN = 150, 120, 34, 12, 14
    _RB_THUMB_WORKERS = 4
    _RB_PHOTO_CACHE_MAX = 600

    def _remote_browser(self, provider, path):
        """WebDAV 等 provider 的目录浏览：列表（名称/类型/大小/修改时间，可点表头排序）
        和网格（缩略图平铺）两种视图可切换；目录读取与缩略图都在后台线程，不卡界面。"""
        dlg = tk.Toplevel(self)
        dlg.transient(self)
        dlg.geometry("1000x660")
        TW, TH, LH, GAP, M = (self._RB_TILE_W, self._RB_TILE_H, self._RB_LABEL_H,
                              self._RB_GAP, self._RB_MARGIN)
        mode0 = (self._config.get("_remote_view_") or {}).get("mode", "list")
        state = {"path": path, "stack": [], "entries": [], "sel": None,
                 "sort": ("name", False), "gen": 0, "alive": True, "loading": False,
                 "rects": [], "photos": {}, "requested": set(), "poll_after": None,
                 "relayout_after": None, "grid_w": 0, "thumb_after": None, "want": set(),
                 "events": queue.Queue(), "jobs": queue.Queue()}
        mode_var = tk.StringVar(value=mode0 if mode0 in ("list", "grid") else "list")

        # ---- 顶栏：路径 + 视图切换 ----
        top = ttk.Frame(dlg, padding=(8, 6))
        top.pack(fill="x")
        path_lbl = ttk.Label(top, text="")
        path_lbl.pack(side="left")
        ttk.Radiobutton(top, text="网格", value="grid", variable=mode_var,
                        style="Toolbutton", command=lambda: set_mode()).pack(side="right")
        ttk.Radiobutton(top, text="列表", value="list", variable=mode_var,
                        style="Toolbutton", command=lambda: set_mode()).pack(side="right", padx=(0, 2))

        # ---- 底栏（先 pack，保证内容区缩放时按钮始终可见）----
        btns = ttk.Frame(dlg, padding=8)
        btns.pack(side="bottom", fill="x")
        status = ttk.Label(dlg, text="", foreground="#6b7480")
        status.pack(side="bottom", fill="x", padx=10)

        content = ttk.Frame(dlg, padding=(8, 0))
        content.pack(fill="both", expand=True)

        # ---- 列表视图 ----
        list_frame = ttk.Frame(content)
        cols = (("name", "名称", 460, "w"), ("kind", "类型", 70, "w"),
                ("size", "大小", 100, "e"), ("mtime", "修改时间", 150, "w"))
        tree = ttk.Treeview(list_frame, columns=[c[0] for c in cols], show="headings",
                            selectmode="browse")
        for key, title, width, anchor in cols:
            tree.heading(key, text=title, command=lambda k=key: sort_by(k))
            tree.column(key, width=width, anchor=anchor, stretch=(key == "name"))
        tsb = ttk.Scrollbar(list_frame, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=tsb.set)
        tree.pack(side="left", fill="both", expand=True)
        tsb.pack(side="right", fill="y")

        # ---- 网格视图 ----
        grid_frame = ttk.Frame(content)
        canvas = tk.Canvas(grid_frame, bg="#14161a", highlightthickness=0)
        gsb = ttk.Scrollbar(grid_frame, orient="vertical", command=canvas.yview)
        canvas.configure(yscrollcommand=lambda *a: on_yscroll(*a))
        canvas.pack(side="left", fill="both", expand=True)
        gsb.pack(side="right", fill="y")

        def selected_entry():
            i = state["sel"]
            return state["entries"][i] if i is not None and i < len(state["entries"]) else None

        def close():
            state["alive"] = False
            for k in ("poll_after", "relayout_after", "thumb_after"):
                if state[k]:
                    try:
                        self.after_cancel(state[k])
                    except Exception:
                        pass
                    state[k] = None
            dlg.destroy()

        # ---------- 数据加载（后台线程） ----------
        def load(new_path):
            state["gen"] += 1
            gen = state["gen"]
            state["path"] = new_path
            state["loading"] = True
            state["sel"] = None
            state["entries"] = []
            state["rects"] = []
            state["want"] = set()
            state["requested"].clear()
            tree.delete(*tree.get_children())
            canvas.delete("all")
            path_lbl.configure(text=(new_path or "/"))
            dlg.title("浏览网盘 - " + (new_path or "/"))
            status.configure(text="加载中…")

            def work():
                try:
                    lister = getattr(provider, "list_dir_strict", provider.list_dir)
                    entries, err = lister(new_path), None
                except Exception as ex:
                    entries, err = [], str(ex)
                if state["alive"]:
                    state["events"].put(("list", gen, entries, err))
            threading.Thread(target=work, daemon=True).start()

        def apply_list(entries, err):
            state["loading"] = False
            col, desc = state["sort"]
            state["entries"] = sort_entries(entries, col, desc)
            n = len(state["entries"])
            if err:
                status.configure(text="读取失败：" + err)
            else:
                status.configure(text=("共 %d 项" % n) if n else "此目录为空")
            self._last_browse[provider.name] = state["path"]
            refresh()

        # ---------- 渲染 ----------
        def refresh():
            if mode_var.get() == "grid":
                fill_grid()
            else:
                fill_list()

        def fill_list():
            tree.delete(*tree.get_children())
            for i, e in enumerate(state["entries"]):
                tree.insert("", "end", iid=str(i), values=(
                    e.name, kind_label(e), "" if e.is_dir else fmt_size(e.size),
                    fmt_mtime(e.mtime)))
            if state["sel"] is not None and state["sel"] < len(state["entries"]):
                tree.selection_set(str(state["sel"]))
                tree.see(str(state["sel"]))

        def fill_grid():
            state["relayout_after"] = None
            canvas.delete("all")
            width = max(canvas.winfo_width(), TW + 2 * M)
            state["grid_w"] = width
            entries = state["entries"]
            rects, total = grid_layout(len(entries), width, TW, TH, LH, GAP, M)
            state["rects"] = rects
            for i, (e, (x0, y0, x1, y1)) in enumerate(zip(entries, rects)):
                canvas.create_rectangle(x0, y0, x1, y1, fill="#1e222a", outline="#2a303c",
                                        tags=("r%d" % i,))
                photo = state["photos"].get(e.path) if e.kind == "image" else None
                if photo is not None:
                    canvas.create_image((x0 + x1) / 2, (y0 + y1) / 2, image=photo,
                                        tags=("i%d" % i,))
                else:
                    draw_glyph(i, e, x0, y0, x1, y1)
                canvas.create_text((x0 + x1) / 2, y1 + 4, text=e.name, fill="#e8eaee",
                                   font=("Segoe UI", 9), width=TW, anchor="n",
                                   tags=("t%d" % i,))
            canvas.configure(scrollregion=(0, 0, width, max(total, 1)))
            highlight()
            queue_thumbs()

        def draw_glyph(i, e, x0, y0, x1, y1):
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            if e.is_dir:
                canvas.create_rectangle(cx - 34, cy - 20, cx + 34, cy + 22,
                                        fill="#5a4a2a", outline="", tags=("g%d" % i,))
                canvas.create_rectangle(cx - 34, cy - 30, cx - 4, cy - 18,
                                        fill="#6a5832", outline="", tags=("g%d" % i,))
            else:
                glyph = {"audio": "♪", "video": "▶"}.get(e.kind, "▣")
                canvas.create_text(cx, cy, text=glyph, fill="#5a6472",
                                   font=("Segoe UI", 28), tags=("g%d" % i,))

        def highlight():
            for i in range(len(state["rects"])):
                on = (i == state["sel"])
                canvas.itemconfigure("r%d" % i, outline="#4a90e2" if on else "#2a303c",
                                     width=3 if on else 1)

        def scroll_to_sel():
            i = state["sel"]
            if i is None or i >= len(state["rects"]):
                return
            x0, y0, x1, y1 = state["rects"][i]
            region = canvas.cget("scrollregion").split()
            total = float(region[3]) if len(region) == 4 else 0
            if total <= 0:
                return
            top_y, bot_y = canvas.canvasy(0), canvas.canvasy(canvas.winfo_height())
            if y0 < top_y:
                canvas.yview_moveto(max(0.0, (y0 - M) / total))
            elif y1 + LH > bot_y:
                canvas.yview_moveto(min(1.0, (y1 + LH + M - canvas.winfo_height()) / total))

        # ---------- 缩略图（后台线程池） ----------
        def queue_thumbs():
            state["thumb_after"] = None
            if mode_var.get() != "grid" or not state["alive"]:
                return
            gen = state["gen"]
            h = max(canvas.winfo_height(), 1)
            lo, hi = canvas.canvasy(0) - h, canvas.canvasy(h) + h
            want = set()
            for e, (x0, y0, x1, y1) in zip(state["entries"], state["rects"]):
                if e.kind != "image" or y1 + LH < lo or y0 > hi:
                    continue
                want.add(e.path)
                if e.path in state["photos"] or e.path in state["requested"]:
                    continue
                state["requested"].add(e.path)
                state["jobs"].put((gen, e))
            state["want"] = want

        def on_yscroll(*a):
            gsb.set(*a)
            if state["thumb_after"] is None and state["alive"]:
                state["thumb_after"] = self.after(80, queue_thumbs)

        def thumb_worker():
            while state["alive"]:
                try:
                    gen, e = state["jobs"].get(timeout=0.5)
                except queue.Empty:
                    continue
                if gen != state["gen"] or not state["alive"]:
                    continue
                if e.path not in state["want"]:      # 已滚出可见范围：丢弃，回来时会重新排队
                    state["requested"].discard(e.path)
                    continue
                try:
                    data = provider.fetch_image(e)
                    if not data:
                        continue
                    img = Image.open(io.BytesIO(data))
                    img.thumbnail((TW - 8, TH - 8))
                    if img.mode != "RGB":
                        img = img.convert("RGB")
                    state["events"].put(("thumb", gen, e.path, img))
                except Exception:
                    pass

        def apply_thumb(path_key, img):
            try:
                photo = ImageTk.PhotoImage(img)
            except Exception:
                return
            if len(state["photos"]) >= self._RB_PHOTO_CACHE_MAX:
                keep = {e.path for e in state["entries"]}   # 只淘汰别的目录留下的，屏幕上的不能丢
                for k in [k for k in state["photos"] if k not in keep]:
                    del state["photos"][k]
            state["photos"][path_key] = photo
            if mode_var.get() != "grid":
                return
            for i, e in enumerate(state["entries"]):
                if e.path == path_key and i < len(state["rects"]):
                    x0, y0, x1, y1 = state["rects"][i]
                    canvas.delete("g%d" % i)
                    canvas.create_image((x0 + x1) / 2, (y0 + y1) / 2, image=photo,
                                        tags=("i%d" % i,))
                    canvas.tag_raise("t%d" % i)
                    break

        def poll():
            state["poll_after"] = None
            if not state["alive"]:
                return
            try:
                while True:
                    ev = state["events"].get_nowait()
                    try:
                        if ev[0] == "list":
                            if ev[1] == state["gen"]:
                                apply_list(ev[2], ev[3])
                        elif ev[0] == "thumb" and ev[1] == state["gen"]:
                            apply_thumb(ev[2], ev[3])
                    except Exception:
                        pass
            except queue.Empty:
                pass
            if state["alive"]:
                state["poll_after"] = self.after(60, poll)

        # ---------- 交互 ----------
        def set_mode():
            mode = mode_var.get()
            self._config["_remote_view_"] = {"mode": mode}
            self._save_config()
            if mode == "grid":
                list_frame.pack_forget()
                grid_frame.pack(fill="both", expand=True)
                dlg.update_idletasks()
            else:
                grid_frame.pack_forget()
                list_frame.pack(fill="both", expand=True)
            refresh()

        def sort_by(col):
            cur, desc = state["sort"]
            state["sort"] = (col, (not desc) if cur == col else False)
            sel_entry = selected_entry()
            state["entries"] = sort_entries(state["entries"], *state["sort"])
            state["sel"] = state["entries"].index(sel_entry) if sel_entry in state["entries"] else None
            arrow = " ▼" if state["sort"][1] else " ▲"
            for key, title, _w, _a in cols:
                tree.heading(key, text=title + (arrow if key == state["sort"][0] else ""))
            refresh()

        def on_enter(_ev=None):
            e = None if state["loading"] else selected_entry()
            if e is None:
                return
            if e.is_dir:
                state["stack"].append(state["path"])
                load(e.path)
            else:
                self._load_remote_list([e])
                close()

        def on_import():
            self._load_remote_folder(provider, state["path"])
            close()

        def on_up(_ev=None):
            if state["loading"]:
                return
            load(state["stack"].pop() if state["stack"] else provider.root_path)

        def on_tree_select(_ev=None):
            sel = tree.selection()
            state["sel"] = int(sel[0]) if sel else None

        def on_canvas_click(ev):
            canvas.focus_set()
            i = hit_test(state["rects"], canvas.canvasx(ev.x), canvas.canvasy(ev.y), LH)
            state["sel"] = i
            highlight()

        def on_canvas_double(ev):
            on_canvas_click(ev)
            on_enter()

        def on_canvas_key(ev):
            n = len(state["entries"])
            if not n:
                return
            cols_n = max(1, (state["grid_w"] - 2 * M + GAP) // (TW + GAP))
            cur = state["sel"]
            step = {"Left": -1, "Right": 1, "Up": -cols_n, "Down": cols_n}[ev.keysym]
            nxt = 0 if cur is None else min(max(cur + step, 0), n - 1)
            state["sel"] = nxt
            highlight()
            scroll_to_sel()

        def on_canvas_configure(ev):
            if mode_var.get() != "grid" or ev.width == state["grid_w"]:
                return
            if state["relayout_after"]:
                try:
                    self.after_cancel(state["relayout_after"])
                except Exception:
                    pass
            state["relayout_after"] = self.after(120, fill_grid)

        ttk.Button(btns, text="进入 / 播放", command=on_enter).pack(side="left")
        ttk.Button(btns, text="导入此文件夹", command=on_import).pack(side="left", padx=4)
        ttk.Button(btns, text="返回上级", command=on_up).pack(side="left", padx=4)
        ttk.Button(btns, text="关闭", command=close).pack(side="right")

        tree.bind("<<TreeviewSelect>>", on_tree_select)
        tree.bind("<Double-Button-1>", lambda e: on_enter() if tree.identify_region(e.x, e.y) == "cell" else None)
        tree.bind("<Return>", on_enter)
        tree.bind("<BackSpace>", on_up)
        canvas.bind("<Button-1>", on_canvas_click)
        canvas.bind("<Double-Button-1>", on_canvas_double)
        canvas.bind("<Return>", on_enter)
        canvas.bind("<BackSpace>", on_up)
        for key in ("Left", "Right", "Up", "Down"):
            canvas.bind("<%s>" % key, on_canvas_key)
        canvas.bind("<Configure>", on_canvas_configure)
        canvas.bind("<MouseWheel>",
                    lambda e: canvas.yview_scroll(-1 if e.delta > 0 else 1, "units"))
        dlg.protocol("WM_DELETE_WINDOW", close)

        for _ in range(self._RB_THUMB_WORKERS):
            threading.Thread(target=thumb_worker, daemon=True).start()
        state["poll_after"] = self.after(60, poll)
        set_mode_initial = grid_frame if mode_var.get() == "grid" else list_frame
        set_mode_initial.pack(fill="both", expand=True)
        dlg.update_idletasks()
        load(path)

    @staticmethod
    def _fmt_size(n):
        return fmt_size(n)

    def _load_remote_folder(self, provider, path):
        entries = provider.list_dir(path)
        playable = [e for e in entries if not e.is_dir]
        if not playable:
            messagebox.showinfo("提示", "该目录下没有可播放的媒体文件。")
            return
        self._close_zip()
        self._reset_chapters()
        self._playlist = []
        self._playlist_index0 = None
        self.book_key = "remote:" + provider.name + ":" + path
        self._load_list(playable)

    def _load_remote_list(self, entries):
        self._close_zip()
        self._reset_chapters()
        self._playlist = []
        self._playlist_index0 = None
        self.book_key = "remote:" + entries[0].provider + ":" + entries[0].path
        self._load_list(entries)

    def _remote_play_url(self, src):
        """返回 VLC 可读的播放 URL：转码流直接返回 HLS 地址，否则起本地流代理。"""
        provider = self._get_provider(src.provider)
        if not provider:
            return None
        self._stop_remote_proxy()
        self._remote_hls = False
        direct = provider.direct_play_url(src)
        if direct:
            self._remote_hls = True
            return direct
        try:
            proxy = _remote().RemoteStreamProxy(provider, src)
            proxy.start()
        except Exception:
            return None
        self._remote_proxy = proxy
        return proxy.local_url

    def _stop_remote_proxy(self):
        if self._remote_proxy:
            try:
                self._remote_proxy.stop()
            except Exception:
                pass
            self._remote_proxy = None

    # ---------------- 海报墙（媒体库封面网格） ----------------
    def _poster_wall(self, provider, path):
        dlg = tk.Toplevel(self)
        dlg.title("媒体库")
        dlg.transient(self)
        dlg.geometry("960x660")
        dlg.configure(bg="#14161a")

        top = ttk.Frame(dlg, padding=6)
        top.pack(fill="x")
        path_lbl = ttk.Label(top, text="")
        path_lbl.pack(side="left", padx=6)
        ttk.Button(top, text="播放此文件夹", command=lambda: nav_import()).pack(side="right", padx=4)
        ttk.Button(top, text="关闭", command=lambda: close()).pack(side="right")
        ttk.Button(top, text="返回上级", command=lambda: nav_up()).pack(side="right", padx=4)

        canvas = tk.Canvas(dlg, bg="#14161a", highlightthickness=0)
        vsb = ttk.Scrollbar(dlg, orient="vertical", command=canvas.yview)
        canvas.configure(yscrollcommand=vsb.set)
        vsb.pack(side="right", fill="y")
        canvas.pack(side="left", fill="both", expand=True)
        hint_lbl = ttk.Label(dlg, text="", foreground="#8892a0")
        hint_lbl.pack(side="bottom", fill="x", padx=8, pady=4)

        state = {"path": path, "stack": [], "entries": [], "cards": [],
                 "photos": [], "imgs": {}, "queue": queue.Queue(), "gen": 0,
                 "poll_after": None, "relayout_after": None, "alive": True}

        def close():
            state["alive"] = False
            for k in ("poll_after", "relayout_after"):
                if state[k]:
                    try:
                        self.after_cancel(state[k])
                    except Exception:
                        pass
                    state[k] = None
            dlg.destroy()

        def layout():
            """按当前 canvas 宽度重排卡片（不重新拉取目录/海报，海报用缓存）。"""
            canvas.delete("all")
            state["cards"] = []
            state["photos"] = []   # 释放上一轮 PhotoImage，避免 resize 累积内存
            entries = state["entries"]
            if not entries:
                canvas.create_text(320, 120, text="（空）", fill="#5a6472",
                                   font=("Segoe UI", 16))
                canvas.configure(scrollregion=(0, 0, 640, 240))
                hint_lbl.configure(text="此目录为空")
                return
            hint_lbl.configure(text="共 %d 项 · 单击目录卡片进入 · 单击影片/音乐播放 · 顶部按钮：返回上级 / 播放此文件夹" % len(entries))
            cw = max(canvas.winfo_width(), 320)
            PW, PH, GAP, M = 132, 198, 14, 18
            ROW = PH + 52 + GAP
            x, y = M, M
            for i, e in enumerate(entries):
                if x + PW > cw - M:
                    x = M
                    y += ROW
                outline = "#8a6d3b" if e.is_dir else "#2a303c"
                canvas.create_rectangle(x, y, x + PW, y + PH, fill="#1e222a",
                                        outline=outline, width=2 if e.is_dir else 1,
                                        tags=("c%d" % i,))
                img = state["imgs"].get(i)
                if img is not None:
                    try:
                        photo = ImageTk.PhotoImage(img)
                        state["photos"].append(photo)
                        canvas.create_image((x + PW) / 2, (y + PH) / 2, image=photo,
                                            tags=("c%d" % i,))
                    except Exception:
                        pass
                elif e.is_dir:
                    canvas.create_rectangle(x + 24, y + PH // 2 - 28, x + PW - 24, y + PH // 2 + 10,
                                            fill="#5a4a2a", outline="", tags=("g%d" % i,))
                    canvas.create_rectangle(x + 24, y + PH // 2 - 38, x + 66, y + PH // 2 - 26,
                                            fill="#6a5832", outline="", tags=("g%d" % i,))
                    canvas.create_text(x + PW / 2, y + PH // 2 + 32, text="目录", fill="#c9b06a",
                                       font=("Segoe UI", 10, "bold"), tags=("g%d" % i,))
                else:
                    glyph = "♪" if e.kind == "audio" else "▶"
                    canvas.create_text(x + PW / 2, y + PH / 2, text=glyph, fill="#5a6472",
                                       font=("Segoe UI", 30), tags=("g%d" % i,))
                canvas.create_text(x + PW / 2, y + PH + 12, text=e.name, fill="#e8eaee",
                                   font=("Segoe UI", 9), width=PW + 8, anchor="n",
                                   tags=("t%d" % i,))
                year = e.extra.get("year")
                if year:
                    canvas.create_text(x + PW / 2, y + PH + 38, text=str(year),
                                       fill="#8892a0", font=("Segoe UI", 9),
                                       tags=("t%d" % i,))
                state["cards"].append((x, y, x + PW, y + PH))
                x += PW + GAP
            canvas.configure(scrollregion=(0, 0, cw, y + ROW + M))

        def render():
            state["gen"] += 1
            gen = state["gen"]
            self._last_browse[provider.name] = state["path"]
            state["entries"] = provider.list_dir(state["path"])
            state["imgs"] = {}
            state["photos"] = []
            path_lbl.configure(text=state["path"] or "/")
            layout()
            threading.Thread(target=self._poster_fetcher,
                             args=(state, provider, gen), daemon=True).start()
            state["poll_after"] = self.after(90, lambda: self._poster_poll(state, canvas))

        def nav_up():
            state["path"] = state["stack"].pop() if state["stack"] else provider.root_path
            render()

        def nav_import():
            self._load_remote_folder(provider, state["path"])
            close()

        def on_click(ev):
            cx = canvas.canvasx(ev.x)
            cy = canvas.canvasy(ev.y)
            for i, (x0, y0, x1, y1) in enumerate(state["cards"]):
                if x0 <= cx <= x1 and y0 <= cy <= y1:
                    ent = state["entries"][i]
                    if ent.is_dir:
                        state["stack"].append(state["path"])
                        state["path"] = ent.path
                        render()
                    else:
                        self._load_remote_list([ent])
                        close()
                    return

        def on_configure(e=None):
            if state["relayout_after"]:
                self.after_cancel(state["relayout_after"])
            state["relayout_after"] = self.after(120, layout)

        canvas.bind("<Button-1>", on_click)
        canvas.bind("<MouseWheel>",
                    lambda e: canvas.yview_scroll(-1 if e.delta > 0 else 1, "units"))
        dlg.protocol("WM_DELETE_WINDOW", close)
        dlg.update()                # 先完成布局，让 canvas.winfo_width() 拿到真实宽度
        render()
        canvas.bind("<Configure>", on_configure)   # 之后用户拉伸窗口时重排网格
        dlg.lift()
        dlg.focus_force()

    def _poster_fetcher(self, state, provider, gen):
        for i, e in enumerate(state["entries"]):
            if state["gen"] != gen or not state["alive"]:
                return
            if e.is_dir:
                continue   # 目录卡片保留「目录」图标，不拉海报
            try:
                data = provider.fetch_image(e)
                if not data:
                    continue
                img = Image.open(io.BytesIO(data))
                img.thumbnail((264, 396))
                if img.mode != "RGB":
                    img = img.convert("RGB")
                if state["gen"] == gen and state["alive"]:
                    state["queue"].put((gen, i, img))
            except Exception:
                pass

    def _poster_poll(self, state, canvas):
        state["poll_after"] = None
        if not state["alive"]:
            return
        try:
            while True:
                gen, i, img = state["queue"].get_nowait()
                if gen == state["gen"] and i < len(state["cards"]):
                    self._poster_apply(state, canvas, i, img)
        except queue.Empty:
            pass
        if state["alive"]:
            state["poll_after"] = self.after(90, lambda: self._poster_poll(state, canvas))

    def _poster_apply(self, state, canvas, i, img):
        if not state["alive"] or i >= len(state["cards"]):
            return
        state["imgs"][i] = img   # 缓存原始图，窗口重排时免重新拉取
        try:
            photo = ImageTk.PhotoImage(img)
        except Exception:
            return
        state["photos"].append(photo)
        x0, y0, x1, y1 = state["cards"][i]
        canvas.delete("g%d" % i)
        canvas.create_image((x0 + x1) / 2, (y0 + y1) / 2, image=photo, tags=("c%d" % i,))

    @staticmethod
    def _open_archive(path):
        """按扩展名打开 zip / rar 压缩包，返回 namelist/read/close 兼容对象。"""
        ext = os.path.splitext(path)[1].lower()
        if ext in RAR_EXTS:
            if not _rarfile_available():
                raise RuntimeError(
                    "读取 rar/cbr 需要 rarfile 库以及 7-Zip 或 WinRAR(UnRAR) 等解压工具，"
                    "当前环境未检测到，请安装后再试。")
            return rarfile.RarFile(path)
        return zipfile.ZipFile(path)

    def _load_archive_path(self, p):
        try:
            with self._open_archive(p) as z:
                chapters = build_zip_chapters(p, z.namelist())
            if not chapters:
                messagebox.showinfo("提示", "压缩包内没有图片或视频文件。")
                return

            self._close_zip()
            self._zip = self._open_archive(p)
            if len(chapters) > 1:
                self._load_chapters(chapters, book_key=p)
            else:
                self._reset_chapters()
                self._playlist = []
                self._playlist_index0 = None
                self.book_key = p
                self._load_list(chapters[0]["sources"])
        except Exception as e:
            messagebox.showerror("错误", "无法打开压缩包：%s" % e)

    def load_folder(self, d):
        root_files = [os.path.join(d, f) for f in os.listdir(d)
                      if os.path.isfile(os.path.join(d, f))
                      and os.path.splitext(f)[1].lower() in (IMAGE_EXTS | VIDEO_EXTS | PDF_EXTS)]
        root_files.sort(key=lambda p: natural_key(os.path.basename(p)))

        subdirs = []
        for name in os.listdir(d):
            p = os.path.join(d, name)
            if os.path.isdir(p):
                files = self._media_files_in(p)
                if files:
                    subdirs.append((name, files))
        subdirs.sort(key=lambda t: natural_key(t[0]))

        chapters = []
        root_src = self._expand_sources(root_files)
        if root_src:
            chapters.append({"title": "根目录", "sources": root_src})
        for name, files in subdirs:
            src = self._expand_sources(files)
            if src:
                chapters.append({"title": name, "sources": src})

        if not chapters:
            messagebox.showinfo("提示", "该文件夹下没有找到图片、视频或 PDF 文件。")
            return

        self._close_zip()
        if len(chapters) > 1:
            self._load_chapters(chapters, book_key=d)
        else:
            self._reset_chapters()
            self._playlist = []
            self._playlist_index0 = None
            self.book_key = d
            self._load_list(chapters[0]["sources"])

    def _close_zip(self):
        if self._zip:
            try:
                self._zip.close()
            except Exception:
                pass
            self._zip = None
        self._close_pdf()

    def _close_pdf(self):
        if self._pdf_doc is not None:
            try:
                self._pdf_doc.close()
            except Exception:
                pass
            self._pdf_doc = None
            self._pdf_path = None

    def _pdf_document(self, path):
        """打开并缓存 PDF 文档（按路径复用，避免每页反复打开大文件）。"""
        if not fitz:
            return None
        if self._pdf_path == path and self._pdf_doc is not None:
            return self._pdf_doc
        self._close_pdf()
        try:
            self._pdf_doc = fitz.open(path)
            self._pdf_path = path
            return self._pdf_doc
        except Exception:
            return None

    def _pdf_page_count(self, path):
        if not fitz:
            return 0
        try:
            doc = self._pdf_document(path)
            return doc.page_count if doc is not None else 0
        except Exception:
            return 0

    def _render_pdf_page(self, path, page_index, scale=2.0):
        """把 PDF 的某一页渲染成 PIL 图像（scale 约等于 72*scale DPI）。"""
        doc = self._pdf_document(path)
        if doc is None:
            raise RuntimeError("缺少 PyMuPDF 库或无法打开 PDF")
        page = doc.load_page(page_index)
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)

    def _load_pdf_path(self, p):
        if not fitz:
            messagebox.showerror("错误", "缺少 PyMuPDF 库，无法打开 PDF。\n请在命令行运行：pip install pymupdf")
            return
        self._close_zip()
        n = self._pdf_page_count(p)
        if n <= 0:
            messagebox.showinfo("提示", "无法读取 PDF 或该文件没有页面。")
            return
        self._playlist = []
        self._playlist_index0 = None
        self.book_key = p
        self._reset_chapters()
        self._load_list([(p, i) for i in range(n)])

    # ---------------- 章节管理 ----------------
    def _reset_chapters(self):
        self._chapters = None
        self._chapter_index = 0
        if hasattr(self, "chapter_bar") and self.chapter_bar.winfo_manager():
            self.chapter_bar.pack_forget()

    def _media_files_in(self, directory):
        """递归收集目录下的图片/视频/PDF，按相对路径自然排序。"""
        return media_files_in(directory)

    def _expand_sources(self, paths):
        """把文件路径列表转成页面来源列表（PDF 展开为每页）。"""
        return expand_paths(paths, self._pdf_page_count)

    def _load_chapters(self, chapters, book_key):
        if not chapters:
            self._reset_chapters()
            return
        self._chapters = chapters
        self.book_key = book_key
        ci = 0
        if book_key in self._config:
            try:
                ci = clamp(int(self._config[book_key].get("chapter", 0)), 0, len(chapters) - 1)
            except Exception:
                ci = 0
        self._chapter_index = ci
        self._playlist = []
        self._playlist_index0 = None
        self._load_list(chapters[ci]["sources"], restore_index=True)
        self._refresh_chapter_ui()

    def _chapter_prefix(self):
        if self._chapters and 0 <= self._chapter_index < len(self._chapters):
            return self._chapters[self._chapter_index]["title"] + " · "
        return ""

    def _refresh_chapter_ui(self):
        if self._chapters and len(self._chapters) > 1:
            titles = [c["title"] for c in self._chapters]
            self.chapter_combo.configure(values=titles)
            self.chapter_combo.current(self._chapter_index)
            if not self.chapter_bar.winfo_manager():
                self.chapter_bar.pack(side="top", fill="x", before=self.content)
            self.chapter_prev_btn.configure(state="normal" if self._chapter_index > 0 else "disabled")
            self.chapter_next_btn.configure(
                state="normal" if self._chapter_index < len(self._chapters) - 1 else "disabled")
        else:
            self._reset_chapters()

    def switch_chapter(self, ci):
        if not self._chapters:
            return
        ci = clamp(ci, 0, len(self._chapters) - 1)
        if ci == self._chapter_index:
            return
        self._chapter_index = ci
        self._load_list(self._chapters[ci]["sources"], restore_index=False)
        self._refresh_chapter_ui()

    def next_chapter(self):
        if self._chapters:
            self.switch_chapter(self._chapter_index + 1)

    def prev_chapter(self):
        if self._chapters:
            self.switch_chapter(self._chapter_index - 1)

    def _on_chapter_selected(self, event=None):
        if self._chapters:
            idx = self.chapter_combo.current()
            if idx >= 0:
                self.switch_chapter(idx)

    def _load_list(self, sources, restore_index=True):
        self.sources = sources
        start = 0
        if self.book_key in self._config:
            try:
                cfg = self._config[self.book_key]
                if restore_index:
                    start = clamp(int(cfg.get("index", 0)), 0, len(sources) - 1)
                self.spread_mode = bool(cfg.get("spread_mode", True))
                self.reading_direction = "rtl" if cfg.get("direction") == "rtl" else "ltr"
                self.trim_mode = bool(cfg.get("trim_mode", False))
                self._compare_mode = bool(cfg.get("compare_mode", False))
                self.book_filter = bool(cfg.get("book_filter", False))
                fm = cfg.get("fit_mode", "window")
                self.fit_mode = fm if fm in ("width", "height", "window", "actual") else "window"
            except Exception:
                start = 0
        self._sync_toggle_buttons()
        self._thumbs_visible = True
        if not self.thumbs_frame.winfo_manager():
            self._pack_thumbs()
        self.show_file(start)
        self._build_thumbnails()

    # ---------------- 图片读取 ----------------
    def _display_name(self, src):
        if isinstance(src, RemoteSource):
            return src.name
        if isinstance(src, tuple):
            if self._is_pdf_src(src):
                return "%s · 第 %d 页" % (os.path.basename(src[0]), src[1] + 1)
            name = src[1].replace("\\", "/").split("/")[-1]
            return name or src[1]
        return os.path.basename(src)

    def _open_raw(self, src):
        """惰性打开（用于缩略图，避免整图解码）。"""
        if isinstance(src, RemoteSource):
            provider = self._get_provider(src.provider)
            if not provider:
                raise RuntimeError("未找到网盘配置：" + src.provider)
            resp = provider.open_stream(src, None)
            try:
                data = resp.read()
            finally:
                try:
                    resp.close()
                except Exception:
                    pass
            return Image.open(io.BytesIO(data))
        if isinstance(src, tuple):
            if self._is_pdf_src(src):
                return self._render_pdf_page(src[0], src[1])
            z = self._zip or self._open_archive(src[0])
            return Image.open(io.BytesIO(z.read(src[1])))
        return Image.open(src)

    def _open_image(self, src):
        im = self._open_raw(src)
        im.load()
        if im.mode not in ("RGB", "RGBA", "L"):
            im = im.convert("RGB")
        if self.trim_mode:
            im = self._trim_white(im)
        return im

    @staticmethod
    def _is_portrait(im):
        w, h = im.size
        return h > w

    @staticmethod
    def _trim_white(im, threshold=240, pad=4):
        """裁掉四周近白的边。"""
        try:
            gray = im.convert("L")
            bbox = gray.point(lambda p: 255 if p < threshold else 0).getbbox()
            if not bbox:
                return im
            l, t, r, b = bbox
            l = max(0, l - pad)
            t = max(0, t - pad)
            r = min(im.width, r + pad)
            b = min(im.height, b + pad)
            if r - l < 12 or b - t < 12:
                return im
            return im.crop((l, t, r, b))
        except Exception:
            return im

    def _make_spread(self):
        """双页模式：当前页为竖图时，尝试与下一页合并成一张横图。"""
        if not (self.spread_mode and self.orig and self._is_portrait(self.orig)):
            return None
        nxt = self.index + 1
        if nxt >= len(self.sources):
            return None
        if self._is_video(self.sources[nxt]) or self._is_audio(self.sources[nxt]):
            return None
        try:
            im2 = self._open_image(self.sources[nxt])
        except Exception:
            return None
        if not self._is_portrait(im2):
            return None
        a = self.orig.convert("RGB") if self.orig.mode != "RGB" else self.orig
        b = im2.convert("RGB") if im2.mode != "RGB" else im2
        w1, h1 = a.size
        w2, h2 = b.size
        H = max(h1, h2)
        canvas = Image.new("RGB", (w1 + w2, H), (0, 0, 0))
        if self.reading_direction == "rtl":
            # 日漫右→左：当前页在右，下一页在左
            canvas.paste(b, (0, (H - h2) // 2))
            canvas.paste(a, (w2, (H - h1) // 2))
        else:
            canvas.paste(a, (0, (H - h1) // 2))
            canvas.paste(b, (w1, (H - h2) // 2))
        return canvas

    # ---------------- 视频 -------------
    @staticmethod
    def _is_pdf_src(src):
        return isinstance(src, tuple) and os.path.splitext(src[0])[1].lower() in PDF_EXTS

    def _is_video(self, src):
        if self._is_pdf_src(src):
            return False
        if isinstance(src, RemoteSource):
            if src.kind:
                return src.kind == "video"
            return not src.is_dir and os.path.splitext(src.name)[1].lower() in VIDEO_EXTS
        name = src[1] if isinstance(src, tuple) else src
        return os.path.splitext(name)[1].lower() in VIDEO_EXTS

    def _is_audio(self, src):
        if self._is_pdf_src(src):
            return False
        if isinstance(src, RemoteSource):
            if src.kind:
                return src.kind == "audio"
            return not src.is_dir and os.path.splitext(src.name)[1].lower() in AUDIO_EXTS
        name = src[1] if isinstance(src, tuple) else src
        return os.path.splitext(name)[1].lower() in AUDIO_EXTS

    def _ensure_vlc(self):
        if self.vlc_instance is not None:
            return True
        try:
            import vlc
            self.vlc = vlc
            # 关掉硬件加速解码（D3D11）：这台机器上开字幕时 stop() 会在 libvlc
            # 内部卡死不返回，日志里能看到 D3D11 vout 本身也报过错
            # ("SetThumbNailClip failed")，怀疑是这张 GPU/驱动跟 VLC 的硬件
            # 加速视频输出路径收尾时的同步有问题，跟音频回调无关。
            # 视频输出改用 wingdi（GDI 软件渲染）而不是 direct3d11/direct3d9：
            # 这台机器的 GPU 驱动在 D3D vout 的 stop 收尾时会死锁（复现：播放中
            # 打开另一个视频，卡死在 libvlc_media_player_stop）。GDI 纯 CPU 渲染
            # 不经过 GPU 驱动，绕开这个死锁；代价是高清视频软渲染更吃 CPU，但
            # 漫画里的短视频通常够用。
            args = build_vlc_args(self._video_rotation)
            self.vlc_instance = vlc.Instance(args)
            self.player = self.vlc_instance.media_player_new()
            return True
        except Exception:
            return False

    def _video_path(self, src):
        if isinstance(src, RemoteSource):
            return self._remote_play_url(src)
        if isinstance(src, tuple):
            if src in self._video_cache:
                return self._video_cache[src]
            tmp = video_tmp_name(src[1], self._tmp_dir)
            try:
                z = self._zip or self._open_archive(src[0])
                with open(tmp, "wb") as f:
                    f.write(z.read(src[1]))
                self._video_cache[src] = tmp
                return tmp
            except Exception:
                return None
        return src

    def _show_video(self, src):
        # 兜底：先停掉可能残留的自动隐藏轮询并恢复 UI，避免失败分支遗留隐藏状态。
        self._stop_autohide()
        if self._audio_hijacked and not self.caption_enabled:
            self._audio_hijacked = False
            self._recreate_vlc()
        if not self._ensure_vlc():
            self.is_video = False
            self.status.configure(text="无法播放视频（缺少 VLC）：" + self._display_name(src))
            return
        path = self._video_path(src)
        if not path:
            self.is_video = False
            self.status.configure(text="无法读取视频：" + self._display_name(src))
            return
        if self.auto_flip:
            # 视频页暂停自动翻页，避免没看完就跳走
            self.auto_flip = False
            self._cancel_auto()
            self._sync_toggle_buttons()
        self._video_ended = False
        self._ab_start_ms = None
        self._ab_end_ms = None
        self.rz.enabled = False
        self._hide_rz_panel()
        self._transparent_ticks = 0
        self._resume_seek_ms = self._get_resume_position(src)
        # 打开新视频时按文件名自动加载外接字幕；速率在用户调整后持久化
        self._load_subtitle_for(self.sources[self.index])
        self._apply_rate_now()
        self._show_video_panel()
        try:
            # 关掉 D3D11VA 硬件解码：必须作为 media 选项传才生效（Instance 上的
            # --avcodec-hw=none 在 VLC 3.0.20 里不生效；而且 set_hwnd() 会把
            # avcodec-hw 重置为空）。否则切视频时解码器收尾会死锁。
            opts = build_video_media_options(self._rate, self._sub_path)
            media = self.vlc_instance.media_new(path, *opts)
            self.player.set_media(media)
            self.player.set_hwnd(self.video_panel.winfo_id())
            # 字幕的 audio_set_format/audio_set_callbacks 必须在 play() 之前设置，
            # 否则原生音频输出已经起来了，回调不一定能接管。
            if self.caption_enabled:
                self._start_captions()
            self.player.play()
            self._apply_rate_now()
            self.player.audio_set_volume(int(self.vol.get()))
            # 旧代码曾用 audio_set_mute(True) 静音缩略图播放器，把整个进程的 WASAPI
            # 会话静音，且 Windows 按 exe 记住了该静音状态（重启后仍静音）。新代码已
            # 改用 :no-audio 不再触发，但已记住的静音仍需显式解除，否则主播放器无声。
            self.player.audio_set_mute(False)
            self.is_video = True
            self._apply_region_zoom()   # 清掉上一段视频残留的裁剪框，再按 zoom/区域放大应用
            self._apply_video_adjust()
            self._set_btn_text(self.play_btn, "⏸")
            # VLC 的原生视频窗口会抢走键盘/滚轮焦点，导致快捷键和触控板手势失效；
            # 等它播放起来后把焦点拉回 Tk 主窗口，事件才会走我们的分发。
            self.after(300, self._refocus_main)
            # 把 VLC 原生子窗口设为鼠标穿透，否则画面上的点击/拖拽传不到 Tk。
            self.after(400, self._make_video_window_transparent)
            self.after(1200, self._make_video_window_transparent)
        except Exception as e:
            self.is_video = False
            self.status.configure(text="视频播放失败：%s" % e)
            return
        self._show_video_bar()
        self._start_autohide()
        self._start_seek_thumbs(src, path)
        self._update_status()
        self._update_video_time_loop()

    def _refocus_main(self):
        """视频播放后把键盘焦点从 VLC 原生窗口拉回 Tk 主窗口。"""
        try:
            self.focus_force()
        except Exception:
            pass

    def _make_video_window_transparent(self):
        """把 VLC 的原生视频子窗口设为鼠标穿透。

        set_hwnd 后 VLC 会在 video_panel 里创建原生子窗口画视频，该窗口会吞掉
        落在画面上的鼠标事件（--no-mouse-events 只影响键盘/滚轮焦点，不会让窗口
        鼠标穿透）。这里做两件事：
          1) 设 WS_EX_TRANSPARENT（影响绘制顺序，辅助穿透）；
          2) 子类化每个子窗口的 WndProc，WM_NCHITTEST 返回 HTTRANSPARENT，
             让鼠标命中测试穿透到下层 Tk 窗口，从而点击/拖拽能传到 video_panel。
        """
        if not self.is_video:
            return
        # 重入/并发护栏：此函数会遍历并子类化 video_panel 下的原生子窗口，
        # 若与窗口消息回调（proc）或自身重入并发，会死锁（主线程 SetWindowLongW
        # 等目标线程、回调又回链到 Tk）。若已有一次在跑，直接放弃本次。
        if getattr(self, "_transparent_busy", False):
            return
        self._transparent_busy = True
        try:
            hwnd = self.video_panel.winfo_id()
            if not hwnd:
                return
            user32 = ctypes.windll.user32
            GW_CHILD = 5
            GW_HWNDNEXT = 2
            GWL_EXSTYLE = -20
            WS_EX_TRANSPARENT = 0x00000020
            GWLP_WNDPROC = -4
            WM_NCHITTEST = 0x0084
            HTTRANSPARENT = -1

            user32.GetWindow.restype = ctypes.c_void_p
            user32.GetWindow.argtypes = [ctypes.c_void_p, ctypes.c_uint]
            user32.GetWindowLongW.restype = ctypes.c_long
            user32.GetWindowLongW.argtypes = [ctypes.c_void_p, ctypes.c_int]
            user32.SetWindowLongW.restype = ctypes.c_long
            user32.SetWindowLongW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_long]
            user32.GetWindowLongPtrW.restype = ctypes.c_ssize_t
            user32.GetWindowLongPtrW.argtypes = [ctypes.c_void_p, ctypes.c_int]
            user32.SetWindowLongPtrW.restype = ctypes.c_ssize_t
            user32.SetWindowLongPtrW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_ssize_t]
            user32.CallWindowProcW.restype = ctypes.c_ssize_t
            user32.CallWindowProcW.argtypes = [ctypes.c_ssize_t, ctypes.c_void_p, ctypes.c_uint,
                                               ctypes.c_ssize_t, ctypes.c_ssize_t]

            WNDPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, ctypes.c_void_p, ctypes.c_uint,
                                         ctypes.c_ssize_t, ctypes.c_ssize_t)
            hooks = getattr(self, "_wndproc_hooks", None)
            if hooks is None:
                hooks = {}
                self._wndproc_hooks = hooks

            def walk(h):
                cur = user32.GetWindow(h, GW_CHILD)
                while cur:
                    st = user32.GetWindowLongW(cur, GWL_EXSTYLE)
                    user32.SetWindowLongW(cur, GWL_EXSTYLE, st | WS_EX_TRANSPARENT)
                    if cur not in hooks:
                        old_proc = user32.GetWindowLongPtrW(cur, GWLP_WNDPROC)
                        if old_proc:
                            def make_proc(old):
                                def proc(hw, msg, wp, lp):
                                    if msg == WM_NCHITTEST:
                                        return HTTRANSPARENT
                                    return user32.CallWindowProcW(old, hw, msg, wp, lp)
                                return WNDPROC(proc)
                            cb = make_proc(old_proc)
                            user32.SetWindowLongPtrW(cur, GWLP_WNDPROC,
                                                     ctypes.cast(cb, ctypes.c_void_p).value)
                            hooks[cur] = (old_proc, cb)
                    walk(cur)
                    cur = user32.GetWindow(cur, GW_HWNDNEXT)
            walk(hwnd)
        except Exception:
            pass
        finally:
            self._transparent_busy = False

    def _video_resume_key(self, src):
        if isinstance(src, RemoteSource):
            return src.key()
        return video_resume_key(src)

    def _get_resume_position(self, src):
        key = self._video_resume_key(src)
        if not key:
            return None
        position = self._config.get("_video_resume_", {}).get(key)
        return int(position) if isinstance(position, (int, float)) and position > 0 else None

    def _save_resume_position(self):
        if not self.is_video or not self.player or self._video_is_stopping():
            return
        key = self._video_resume_key(self.sources[self.index])
        if not key:
            return
        try:
            position = self.player.get_time()
            length = self.player.get_length()
            resumes = self._config.setdefault("_video_resume_", {})
            if position > 3000 and (length <= 0 or position < length - 3000):
                resumes[key] = position
            else:
                resumes.pop(key, None)
            self._save_config()
        except Exception:
            pass

    def _save_video_options(self):
        self._config.setdefault("_video_", {}).update({
            "repeat_one": self._repeat_one,
            "repeat_playlist": self._repeat_playlist,
            "shuffle_playlist": self._shuffle_playlist,
            "zoom": self._video_zoom,
            "adjust": dict(self._video_adjust),
        })
        self._save_config()

    def zoom_in(self):
        if self.is_video:
            if self.rz.enabled:
                self._rz_zoom_step(-0.1)
            else:
                self.change_video_zoom(0.25)
        else:
            self.zoom_center(1.25)

    def zoom_out(self):
        if self.is_video:
            if self.rz.enabled:
                self._rz_zoom_step(0.1)
            else:
                self.change_video_zoom(-0.25)
        else:
            self.zoom_center(0.8)

    def change_video_zoom(self, delta):
        if self._cast_mode == "dlna":
            return  # DLNA 投屏不支持画面缩放
        self._video_zoom = clamp(round(self._video_zoom + delta, 2), 0.5, 4.0)
        if self.attributes("-fullscreen"):
            self._video_fs_fit = False  # 全屏下手动缩放时改用显式倍率，不再自动铺满
        self._apply_video_zoom()
        self._save_video_options()
        self._update_status()

    def reset_video_zoom(self):
        self._video_zoom = 1.0
        if self.attributes("-fullscreen"):
            self._video_fs_fit = False
        self._apply_video_zoom()
        self._save_video_options()
        self._update_status()

    def _apply_video_zoom(self):
        if not self.player or not self.is_video or self._video_is_stopping():
            return
        try:
            # 区域放大：裁剪框由 _apply_region_zoom 设置，这里 scale=0 让裁剪区铺满。
            if self.rz.enabled:
                self.player.video_set_scale(0)
            # 全屏下默认自动铺满：scale=0 让 libVLC 按屏幕自适应（保持比例、完整显示）。
            # 用户在全屏里手动 +/− 缩放后 _video_fs_fit 变 False，改用显式倍率。
            elif self.attributes("-fullscreen") and self._video_fs_fit:
                self.player.video_set_scale(0)
            # 窗口化播放时若底部控制条已自动隐藏（视频铺满窗口），同样用 scale=0 自适应铺满。
            elif not self.attributes("-fullscreen") and self._autohide_hidden:
                self.player.video_set_scale(0)
            else:
                self.player.video_set_scale(self._video_zoom)
        except Exception:
            pass

    def _apply_region_zoom(self):
        """区域放大：用裁剪框 crop 出局部区域再铺满；关闭时清除裁剪。"""
        if not self.player or not self.is_video or self._video_is_stopping():
            return
        try:
            if self.rz.enabled:
                w, h = self.player.video_get_size()
                if w <= 0 or h <= 0:
                    return
                crop = self.rz.crop_geometry(w, h)
                self.player.video_set_crop_geometry(crop)
            else:
                self.player.video_set_crop_geometry("")
            self._apply_video_zoom()
        except Exception:
            pass

    def toggle_region_zoom(self):
        if not self.is_video or self._cast_mode == "dlna":
            return
        self.rz.enabled = not self.rz.enabled
        if self.rz.enabled:
            self.rz.reset()
            self._show_rz_panel()
            self._make_video_window_transparent()   # 确保放大框可被鼠标拖拽（窗口可能已重建）
            self._apply_region_zoom()
            self._update_status()
            self.status.configure(text="区域放大：方向键 / WASD 平移 · 滚轮 / +- 缩放 · 面板按钮也可用 · Z 退出")
        else:
            self._hide_rz_panel()
            self._apply_region_zoom()
            self._update_status()

    def _rz_zoom_step(self, d_scale):
        self.rz.zoom_step(d_scale)
        self._apply_region_zoom()
        self._update_status()

    def _rz_reset_center(self):
        self.rz.reset_center()
        self._apply_region_zoom()
        self._update_status()

    def _rz_pan(self, dx, dy):
        self.rz.pan(dx * 0.08, dy * 0.08)
        self._apply_region_zoom()
        self._update_status()

    def _show_rz_panel(self):
        """弹出区域放大控制面板（独立 Toplevel，按钮不依赖视频区的鼠标事件）。"""
        p = getattr(self, "_rz_panel", None)
        if p is not None:
            try:
                if p.winfo_exists():
                    p.lift()
                    return
            except Exception:
                pass
        win = tk.Toplevel(self)
        win.title("区域放大")
        win.configure(bg="#1a1d24")
        win.attributes("-topmost", True)
        win.resizable(False, False)
        self._rz_panel = win

        def mk(parent, txt, cmd, w=2):
            return tk.Button(parent, text=txt, command=cmd, width=w, takefocus=0,
                             bg=BTN_BG, fg=FG, activebackground=BTN_ACTIVE, activeforeground="#fff",
                             relief="flat", bd=0, pady=6, font=("Microsoft YaHei", 11),
                             cursor="hand2")

        grid = tk.Frame(win, bg="#1a1d24")
        grid.pack(padx=8, pady=8)
        mk(grid, "↑", lambda: self._rz_pan(0, -1)).grid(row=0, column=1, padx=2, pady=2)
        mk(grid, "←", lambda: self._rz_pan(-1, 0)).grid(row=1, column=0, padx=2, pady=2)
        mk(grid, "·", None, w=2).grid(row=1, column=1, padx=2, pady=2)
        mk(grid, "→", lambda: self._rz_pan(1, 0)).grid(row=1, column=2, padx=2, pady=2)
        mk(grid, "↓", lambda: self._rz_pan(0, 1)).grid(row=2, column=1, padx=2, pady=2)
        mk(grid, "＋", lambda: self._rz_zoom_step(-0.1), w=2).grid(row=0, column=3, padx=2, pady=2)
        mk(grid, "－", lambda: self._rz_zoom_step(0.1), w=2).grid(row=1, column=3, padx=2, pady=2)
        row2 = tk.Frame(win, bg="#1a1d24")
        row2.pack(pady=(0, 8))
        mk(row2, "居中", lambda: self._rz_reset_center(), w=4).pack(side="left", padx=4)
        mk(row2, "退出", lambda: self.toggle_region_zoom(), w=4).pack(side="left", padx=4)

        win.update_idletasks()
        try:
            x = self.video_panel.winfo_rootx() + self.video_panel.winfo_width() - win.winfo_reqwidth() - 24
            y = self.video_panel.winfo_rooty() + self.video_panel.winfo_height() - win.winfo_reqheight() - 24
            win.geometry("+%d+%d" % (max(0, x), max(0, y)))
        except Exception:
            pass

    def _hide_rz_panel(self):
        p = getattr(self, "_rz_panel", None)
        if p is not None:
            try:
                p.destroy()
            except Exception:
                pass
            self._rz_panel = None

    def _apply_video_adjust(self):
        """把亮度/对比度/饱和度/色相/伽马应用到 VLC（浮点版，默认 1.0）。"""
        if not self.player or not self.is_video or self._video_is_stopping():
            return
        try:
            B = self.vlc.VideoAdjustOption
            a = self._video_adjust
            self.player.video_set_adjust_float(B.Brightness, a["brightness"])
            self.player.video_set_adjust_float(B.Contrast, a["contrast"])
            self.player.video_set_adjust_float(B.Hue, a["hue"])
            self.player.video_set_adjust_float(B.Saturation, a["saturation"])
            self.player.video_set_adjust_float(B.Gamma, a["gamma"])
        except Exception:
            pass

    def reset_video_adjust(self):
        self._video_adjust = {"brightness": 1.0, "contrast": 1.0, "hue": 0.0,
                              "saturation": 1.0, "gamma": 1.0}
        self._apply_video_adjust()
        self._save_video_options()
        self._update_status()

    def open_video_adjust(self):
        """弹出画面调节对话框：亮度/对比度/饱和度/色相/伽马滑块，实时预览。"""
        if not self.is_video:
            return
        win = tk.Toplevel(self)
        win.title("画面调节（亮度 / 对比度 / 饱和度 / 色相 / 伽马）")
        win.configure(bg="#1a1d24")
        win.transient(self)
        win.resizable(False, False)
        items = [
            ("brightness", "亮度", 0.0, 2.0, 0.05),
            ("contrast", "对比度", 0.0, 2.0, 0.05),
            ("saturation", "饱和度", 0.0, 3.0, 0.05),
            ("hue", "色相", -180.0, 180.0, 5.0),
            ("gamma", "伽马", 0.1, 3.0, 0.05),
        ]
        vars_ = {}
        for key, label, lo, hi, res in items:
            row = tk.Frame(win, bg="#1a1d24")
            row.pack(fill="x", padx=18, pady=7)
            tk.Label(row, text=label, width=6, bg="#1a1d24", fg=FG,
                     anchor="w", font=("Microsoft YaHei", 10)).pack(side="left")
            var = tk.DoubleVar(value=self._video_adjust[key])
            vars_[key] = var
            def on_change(val, key=key):
                try:
                    self._video_adjust[key] = float(val)
                except Exception:
                    return
                self._apply_video_adjust()
            tk.Scale(row, from_=lo, to=hi, resolution=res, orient="horizontal",
                     variable=var, command=on_change, showvalue=True,
                     bg="#2a2f38", fg=FG, troughcolor="#3a3f47",
                     activebackground="#5b9aff", highlightthickness=0,
                     length=300).pack(side="left", fill="x", expand=True)
        btns = tk.Frame(win, bg="#1a1d24")
        btns.pack(pady=(6, 14))
        def do_reset():
            self.reset_video_adjust()
            for key, var in vars_.items():
                var.set(self._video_adjust[key])
        def save_and_close():
            self._save_video_options()
            win.destroy()
        win.protocol("WM_DELETE_WINDOW", save_and_close)
        tk.Button(btns, text="重置", command=do_reset, bg=BTN_BG, fg=FG,
                  activebackground=BTN_ACTIVE, relief="flat", padx=14, pady=6,
                  cursor="hand2").pack(side="left", padx=8)
        tk.Button(btns, text="关闭", command=save_and_close, bg=BTN_BG, fg=FG,
                  activebackground=BTN_ACTIVE, relief="flat", padx=14, pady=6,
                  cursor="hand2").pack(side="left", padx=8)

    def toggle_ab_repeat(self):
        if not self.is_video:
            return
        try:
            current = self.player.get_time()
        except Exception:
            return
        if self._ab_start_ms is None:
            self._ab_start_ms = current
            self.status.configure(text="已设置 A 点：" + self._fmt_time(current))
        elif self._ab_end_ms is None and current > self._ab_start_ms + 200:
            self._ab_end_ms = current
            self.status.configure(text="A-B 循环：%s - %s" % (
                self._fmt_time(self._ab_start_ms), self._fmt_time(current)))
        else:
            self._ab_start_ms = None
            self._ab_end_ms = None
            self.status.configure(text="已清除 A-B 循环")
        self._sync_toggle_buttons()

    def toggle_repeat_one(self):
        self._repeat_one = not self._repeat_one
        self._save_video_options()
        self._sync_toggle_buttons()

    def toggle_repeat_playlist(self):
        self._repeat_playlist = not self._repeat_playlist
        self._save_video_options()
        self._sync_toggle_buttons()

    def toggle_shuffle_playlist(self):
        self._shuffle_playlist = not self._shuffle_playlist
        self._save_video_options()
        self._sync_toggle_buttons()

    def _load_subtitle_for(self, src):
        """按需为视频加载同名字幕：优先同目录的 .srt/.ass/.sub/.ssa 文件；
        找不到时若已设了别的字幕则清空，避免残留。调用前会设置
        _sub_load_guard 防止再触发对外接字幕的显式加载。"""
        if not src or not self._sub_load_enabled or self._sub_load_guard:
            return
        if isinstance(src, RemoteSource):
            return   # 网盘视频的同名字幕后续再支持
        name = (src[1] if isinstance(src, tuple) else src)
        if not os.path.dirname(name):
            # zip 内条目无法根据条目名找同名外部文件
            return
        stem = os.path.splitext(name)[0]
        parent = os.path.dirname(name)
        self._sub_load_guard = True
        try:
            for ext in (".srt", ".ass", ".ssa", ".sub", ".scc", ".smi", ".sbv"):
                cand = os.path.join(parent, stem + ext)
                if os.path.exists(cand):
                    self.set_external_subtitle(cand)
                    return
            if self._sub_path_auto:
                self.set_external_subtitle(None)
        finally:
            self._sub_load_guard = False

    def set_external_subtitle(self, file_path):
        """设置 / 清空外接字幕文件。设置后下次打开视频（含翻页）会自动生效。

        file_path 为 None 表示关闭外接字幕。"""
        old = self._sub_path
        self._sub_path = file_path or None
        self._sub_path_auto = bool(file_path and self._sub_load_guard)
        # 通过 _load_subtitle_for 内部加载时不触发改片（防重入），仅用户手动
        # 切换字幕时才重新起片，以免在 _show_video 执行中途反复自调用。
        if self._sub_load_guard:
            if file_path:
                self.caption_enabled = False
                self._sync_toggle_buttons()
            return
        # 外接字幕后，AI 实时识别字幕应关闭，避免两条字幕重叠
        if file_path:
            self.caption_enabled = False
            self._sync_toggle_buttons()
        if self.is_video and old != self._sub_path:
            self._show_video(self.sources[self.index])

    def toggle_subtitle_load(self):
        """切换视频打开时是否自动加载同名外接字幕。"""
        self._sub_load_enabled = not self._sub_load_enabled
        self._config.setdefault("_video_", {})["auto_sub"] = self._sub_load_enabled
        self._save_config()

    def _set_rate(self, rate):
        """设置播放速率（0.5 ~ 60.0），持久化 _speed_idx 并应用给 VLC。"""
        self._rate = clamp(rate, 0.5, 60.0)
        idx = 0
        while idx < len(RATE_OPTS) - 1 and self._rate > float(RATE_OPTS[idx]):
            idx += 1
        self._speed_idx = idx
        if self.is_video:
            self.zoom_label.configure(text="%s倍" % self._rate)
        if self.player and not self._video_is_stopping():
            try:
                if self._video_is_stopping():
                    return
                self.player.set_rate(self._rate)
            except Exception:
                pass

    def _run_rate(self, delta=1):
        """+/- 快捷键：按 _speed_idx 步长调整播放速率。"""
        idx = self._speed_idx + delta
        if idx < 0:
            idx = 0
        if idx > len(RATE_OPTS) - 1:
            idx = len(RATE_OPTS) - 1
        self._set_rate(float(RATE_OPTS[idx]))

    def rate_change(self, delta):
        """+/− 快捷键：以步长调整播放速率（1:加快，-1:减慢）。"""
        if self._cast_mode == "dlna":
            self.status.configure(text="投屏模式不支持倍速（DLNA 限制）")
            return
        self._run_rate(delta)

    def _choose_rate(self):
        rate = simpledialog.askfloat(
            "变速", "输入播放速率（0.5 - 60.0）：",
            initialvalue=self._rate, minvalue=0.5, maxvalue=60.0, parent=self)
        if rate is not None:
            self._set_rate(rate)

    def _apply_rate_now(self):
        """打开视频时立即把速率应用给 VLC（set_hwnd 之后调用）。"""
        if self.player and not self._video_is_stopping():
            try:
                head = min(self._speed_idx, len(RATE_OPTS) - 1)
                self.player.set_rate(float(RATE_OPTS[head]))
            except Exception:
                pass

    def _add_to_playlist(self, src):
        """把当前源加入播放列表（去重同名）。
        """
        for s in self._playlist:
            if s == src:
                self._playlist_index0 = self._playlist.index(src)
                self._update_status()
                return
        self._playlist.append(src)
        self._playlist_index0 = len(self._playlist) - 1

    def _playlist_forward(self):
        """播放列表下一轨并播放。
        """
        if not self._playlist:
            return
        if self._playlist_index0 is None:
            # 列表里还没记录位置，找当前源
            for i, s in enumerate(self._playlist):
                if s == self.sources[self.index]:
                    self._playlist_index0 = i
                    break
            else:
                self._playlist_index0 = None
                return
        nxt = min(self._playlist_index0 + 1, len(self._playlist) - 1)
        self._playlist_index0 = nxt
        self._playlist_show(self._playlist[nxt])

    def _playlist_back(self):
        """播放列表上一轨并播放。
        """
        if not self._playlist:
            return
        if self._playlist_index0 is None:
            for i, s in enumerate(self._playlist):
                if s == self.sources[self.index]:
                    self._playlist_index0 = i
                    break
            else:
                self._playlist_index0 = None
                return
        nxt = max(self._playlist_index0 - 1, 0)
        self._playlist_index0 = nxt
        self._playlist_show(self._playlist[nxt])

    def _playlist_show(self, src):
        """切换到播放列表里某一项并播放（保持播放列表连续性）。
        """
        self.sources = list(self._playlist)
        self._playlist_index0 = self._playlist.index(src)
        self.show_file(self._playlist_index0)

    # ---------------- 投屏（DLNA / Chromecast） -------------
    def toggle_cast(self):
        """投屏按钮：打开设备选择 / 取消当前投屏。"""
        if not self.is_video:
            self.status.configure(text="投屏仅在视频页可用：请先打开一个视频")
            return
        if self._cast_mode == "dlna":
            self._cancel_cast()
        elif self._cast_dialog is not None and self._cast_dialog.winfo_exists():
            self._cast_dialog.lift()
            self._cast_dialog.focus_force()
        else:
            self._open_cast_dialog()

    def _open_cast_dialog(self):
        if self._cast_dialog is not None and self._cast_dialog.winfo_exists():
            self._cast_dialog.destroy()
        dlg = tk.Toplevel(self)
        dlg.title("投屏 - 选择设备")
        dlg.configure(bg=PANEL)
        dlg.resizable(False, False)
        dlg.transient(self)
        self._cast_dialog = dlg

        self._cast_status_label = tk.Label(dlg, text="正在搜索局域网里的投屏设备…", bg=PANEL, fg=FG,
                 font=("Microsoft YaHei", 10))
        self._cast_status_label.pack(padx=16, pady=(12, 4), anchor="w")
        self._cast_listbox = tk.Listbox(dlg, width=44, height=9, bg=BG, fg=FG,
                                        selectbackground=ACCENT, selectforeground="#fff",
                                        relief="flat", bd=0, font=("Microsoft YaHei", 11),
                                        highlightthickness=0, activestyle="none")
        self._cast_listbox.pack(padx=16, pady=4, fill="both", expand=True)
        btns = tk.Frame(dlg, bg=PANEL)
        btns.pack(padx=16, pady=(0, 12), fill="x")
        tk.Button(btns, text="投到选中设备", command=self._cast_select, takefocus=0,
                  bg=ACCENT, fg="#fff", activebackground="#5b9aff", activeforeground="#fff",
                  relief="flat", bd=0, padx=12, pady=5, cursor="hand2",
                  font=("Microsoft YaHei", 10)).pack(side="left", padx=2)
        tk.Button(btns, text="刷新", command=self._cast_rescan, takefocus=0,
                  bg=BTN_BG, fg=FG, activebackground=BTN_ACTIVE, activeforeground="#fff",
                  relief="flat", bd=0, padx=12, pady=5, cursor="hand2",
                  font=("Microsoft YaHei", 10)).pack(side="left", padx=2)
        tk.Button(btns, text="取消", command=self._close_cast_dialog, takefocus=0,
                  bg=BTN_BG, fg=FG, activebackground=BTN_ACTIVE, activeforeground="#fff",
                  relief="flat", bd=0, padx=12, pady=5, cursor="hand2",
                  font=("Microsoft YaHei", 10)).pack(side="left", padx=2)
        self._cast_listbox.bind("<Double-Button-1>", lambda e: self._cast_select())
        dlg.protocol("WM_DELETE_WINDOW", self._close_cast_dialog)
        self._cast_scan()
        # 约 6 秒后若仍无设备，提示常见原因，避免用户干等
        self.after(6000, self._cast_check_empty)

    def _cast_check_empty(self):
        if (self._cast_dialog is None or not self._cast_dialog.winfo_exists()
                or self._cast_listbox is None):
            return
        n = self._cast_listbox.size()
        if n == 0:
            self._cast_status_label.configure(
                text="未发现设备：请确认电视/盒子已开机、与电脑连同一 WiFi、支持 DLNA/Chromecast")
        else:
            self._cast_status_label.configure(
                text="发现 %d 个设备，选中后点「投到选中设备」" % n)

    def _close_cast_dialog(self):
        if self._cast_dialog is not None:
            try:
                self._cast_dialog.destroy()
            except Exception:
                pass
            self._cast_dialog = None
        self._cast_listbox = None
        self._cast_status_label = None

    def _cast_scan(self):
        """后台线程 SSDP 扫描 DLNA 渲染器（会阻塞几秒，不能放主线程）。"""
        if self._cast_listbox is not None and self._cast_listbox.winfo_exists():
            self._cast_listbox.delete(0, "end")
        self._cast_items.clear()

        def _scan():
            try:
                import dlna_cast
                renderers = dlna_cast.discover_renderers(timeout=4)
                for r in renderers:
                    self._cast_items[r.name] = r
                    self.after(0, self._cast_listbox_insert, r.name)
            except Exception:
                pass

        threading.Thread(target=_scan, daemon=True).start()

    def _cast_listbox_insert(self, name):
        if self._cast_listbox is not None and self._cast_listbox.winfo_exists():
            if name not in self._cast_listbox.get(0, "end"):
                self._cast_listbox.insert("end", name)

    def _cast_rescan(self):
        self._cast_scan()

    def _cast_select(self):
        if self._cast_dialog is None or not self._cast_dialog.winfo_exists():
            return
        sel = self._cast_listbox.curselection()
        if not sel:
            return
        name = self._cast_listbox.get(sel[0])
        renderer = self._cast_items.get(name)
        if renderer is None:
            return
        self._apply_cast(renderer, name)
        self._close_cast_dialog()

    def _apply_cast(self, renderer, name=None):
        """投屏到 DLNA 设备；renderer 为 None 时取消投屏、恢复本地播放。

        DLNA 投屏：停本地 VLC → 起本地 HTTP 服务器暴露视频 → SOAP
        SetAVTransportURI + Play 把视频推给投影仪，之后播放/暂停/进度条
        都通过 SOAP 控制投影仪，本地 VLC 不再参与。
        """
        if renderer is None:
            self._cast_stop()
            self._cast_name = None
            self._sync_toggle_buttons()
            self._show_video(self.sources[self.index])
            self.status.configure(text="已取消投屏，恢复本地播放")
            return
        if not self.is_video or not self.player:
            return
        src = self.sources[self.index]
        if isinstance(src, RemoteSource):
            self._apply_cast_remote(renderer, name, src)
            return
        path = self._video_path(src)
        if not path:
            self.status.configure(text="投屏失败：无法读取视频文件")
            return
        self._save_resume_position()
        self._stop_video()
        try:
            import dlna_cast
            srv = dlna_cast.LocalMediaServer(path)
            url = srv.start()
        except Exception as e:
            self.status.configure(text="投屏失败（无法启动媒体服务）：%s" % e)
            self._show_video(src)
            return
        try:
            renderer.set_uri(url, self._display_name(src))
            renderer.play()
        except Exception as e:
            try:
                srv.stop()
            except Exception:
                pass
            self.status.configure(text="投屏失败：%s" % e)
            self._show_video(src)
            return
        self._dlna = renderer
        self._dlna_server = srv
        self._dlna_playing = True
        self._dlna_total = 0
        self._dlna_pos = 0
        self._dlna_sync_tick = 0
        self._cast_name = name
        self._cast_mode = "dlna"
        self.is_video = True
        self._set_btn_text(self.play_btn, "⏸")
        self._show_video_bar()
        self._start_autohide()
        self._sync_toggle_buttons()
        self._update_status()
        self._update_video_time_loop()
        self.status.configure(text="已投屏到：%s（播放/暂停/进度条控制投影仪）" % name)

    def _apply_cast_remote(self, renderer, name, src):
        """把远程视频投屏到 DLNA：复用本地流代理的局域网 URL。"""
        _p = self._get_provider(src.provider)
        if self._remote_hls or (_p and _p.direct_play_url(src)):
            self.status.configure(text="转码流（HLS）暂不支持投屏")
            return
        self._save_resume_position()
        self._cancel_seek_thumbs()
        self._seeking = False
        self._hide_seek_preview()
        self.is_video = False
        self.rz.enabled = False
        self._hide_rz_panel()
        self._stop_captions()
        self._stop_autohide()
        self._stop_player()
        self._hide_video_bar()
        # 保留代理，DLNA 设备从局域网拉流
        if not self._remote_proxy:
            provider = self._get_provider(src.provider)
            if not provider:
                self.status.configure(text="投屏失败：未找到网盘配置")
                return
            proxy = _remote().RemoteStreamProxy(provider, src)
            try:
                proxy.start()
            except Exception as e:
                self.status.configure(text="投屏失败（无法启动媒体服务）：%s" % e)
                return
            self._remote_proxy = proxy
        try:
            renderer.set_uri(self._remote_proxy.lan_url, self._display_name(src))
            renderer.play()
        except Exception as e:
            self._stop_remote_proxy()
            self._show_video(src)
            self.status.configure(text="投屏失败：%s" % e)
            return
        self._dlna = renderer
        self._dlna_server = None
        self._dlna_playing = True
        self._dlna_total = 0
        self._dlna_pos = 0
        self._dlna_sync_tick = 0
        self._cast_name = name
        self._cast_mode = "dlna"
        self.is_video = True
        self._set_btn_text(self.play_btn, "⏸")
        self._show_video_bar()
        self._start_autohide()
        self._sync_toggle_buttons()
        self._update_status()
        self._update_video_time_loop()
        self.status.configure(text="已投屏到：%s（播放/暂停/进度条控制投影仪）" % name)

    def _cast_stop(self):
        """停止 DLNA 投屏（stop + 关 HTTP 服务器），不恢复本地播放。"""
        if self._dlna:
            try:
                self._dlna.stop()
            except Exception:
                pass
            self._dlna = None
        if self._dlna_server:
            try:
                self._dlna_server.stop()
            except Exception:
                pass
            self._dlna_server = None
        self._cast_mode = None
        self._dlna_playing = False

    def _save_dlna_position(self):
        """把投影仪当前播放位置写入续播配置，供取消投屏后本地续播。"""
        if not self._dlna or not self.sources:
            return
        try:
            pos = self._dlna.get_position()
            if pos and pos[0] > 1000:
                key = self._video_resume_key(self.sources[self.index])
                if key:
                    self._config.setdefault("_video_resume_", {})[key] = pos[0]
                    self._save_config()
        except Exception:
            pass

    def _cancel_cast(self):
        self._save_dlna_position()
        self._apply_cast(None)

    def _stop_video(self):
        if self._video_timer:
            self.after_cancel(self._video_timer)
            self._video_timer = None
        self._seeking = False
        self._hide_seek_preview()
        self._cancel_seek_thumbs()
        if self._cast_mode == "dlna":
            # DLNA 投屏模式：保存投影仪位置，停 DLNA，不碰 VLC
            self._save_dlna_position()
            self._cast_stop()
            self._cast_name = None
            self._sync_toggle_buttons()
            self.is_video = False
            self._stop_captions()
            self._stop_autohide()
            self._hide_video_bar()
            return
        # 先置位：_stop_player 会 pump Tk 事件，期间若有残留的 after 回调
        # （如 _refresh_video_hwnd / _update_video_time_loop）会因 is_video=False
        # 而直接返回，避免在后台 stop 进行中误触 player。
        self._save_resume_position()
        self.is_video = False
        self.rz.enabled = False
        self._hide_rz_panel()
        self._stop_captions()
        self._stop_autohide()
        self._stop_player()
        self._stop_remote_proxy()
        self._hide_video_bar()

    def _stop_player(self, player=None):
        """安全地停掉 VLC 播放器，避免卡死 Tk 主线程。

        libvlc 的 stop() 是同步的；当视频通过 set_hwnd() 嵌入到 Tk 窗口时，若在
        Tk 主线程里直接调用，会死锁：stop() 内部 vout_Close 会 vlc_join 等 vout
        线程退出，而 vout 线程又在等主线程处理窗口消息（主线程此刻阻塞在 stop()
        里，永远没机会处理）。

        解法：把 stop() 放到后台线程，主线程在这期间持续 pump Tk 事件，让 vout
        线程能正常收尾。加超时只是兜底，正常情况下 <1s 就会返回。
        """
        player = player or self.player
        if player is None:
            return
        # 已有 stop 在后台进行中：直接等它完成，避免并发 stop。
        if self._stop_event is not None and not self._stop_event.is_set():
            self._wait_stop()
            return
        self._stop_event = threading.Event()

        def _do_stop():
            try:
                player.stop()
            except Exception:
                pass
            finally:
                self._stop_event.set()

        threading.Thread(target=_do_stop, daemon=True).start()
        self._wait_stop()

    def _wait_stop(self):
        deadline = time.time() + 8.0
        while not self._stop_event.is_set() and time.time() < deadline:
            try:
                self.update()
            except Exception:
                pass
            time.sleep(0.01)

    def _video_is_stopping(self):
        """后台是否正在执行 player.stop()。此时不能碰 player 的其它 libvlc
        接口（如 get_length/get_time/pause），否则会跟 stop() 抢 libvlc 内部锁，
        把主线程卡死在 get_length() 等调用里（实测复现）。"""
        return self._stop_event is not None and not self._stop_event.is_set()

    def _show_video_bar(self):
        if not self.video_bar.winfo_manager():
            self.video_bar.pack(side="bottom", fill="x", before=self.status)

    def _hide_video_bar(self):
        if self.video_bar.winfo_manager():
            self.video_bar.pack_forget()

    # ---------------- 视频播放自动隐藏 UI（参考 ACG Player） ----------------
    def _set_menu_visible(self, show):
        """显示 / 隐藏顶部原生菜单栏。"""
        try:
            self.configure(menu=self._menubar if show else "")
        except Exception:
            pass

    def _build_video_menu_overlay(self):
        """浮动顶部菜单覆盖层：文件/视图/帮助（Toplevel，不随视频缩放）。"""
        ov = tk.Toplevel(self)
        ov.overrideredirect(True)
        ov.attributes("-topmost", True)
        ov.withdraw()
        ov.configure(bg=PANEL)
        bar = tk.Frame(ov, bg=PANEL, padx=6, pady=2)
        bar.pack(fill="x")

        # Menubutton 要求 menu 是自己的子菜单；这里为浮动菜单创建独立 Menu 对象
        # （与原生菜单栏的菜单分开，但命令内容相同）。
        def mk_menubutton(label):
            mb = tk.Menubutton(bar, text=label, takefocus=0,
                               bg=PANEL, fg=FG, activebackground=BTN_ACTIVE,
                               activeforeground="#fff", relief="flat", bd=0,
                               padx=10, pady=2, cursor="hand2",
                               font=("Microsoft YaHei", 10))
            mb.pack(side="left", padx=2)
            return mb

        mb_file = mk_menubutton("文件")
        mb_view = mk_menubutton("视图")
        mb_help = mk_menubutton("帮助")
        mb_net = mk_menubutton("网盘")
        ov_file = tk.Menu(mb_file, tearoff=0)
        ov_view = tk.Menu(mb_view, tearoff=0)
        ov_help = tk.Menu(mb_help, tearoff=0)
        ov_net = tk.Menu(mb_net, tearoff=0)
        self._populate_menus(ov_file, ov_view, ov_help)
        ov_net.add_command(label="返回目录", command=self._back_to_browse)
        ov_net.add_separator()
        ov_net.add_command(label="浏览 Jellyfin", command=lambda: self._browse_remote_menu("jellyfin"))
        ov_net.add_command(label="浏览 WebDAV", command=lambda: self._browse_remote_menu("webdav"))
        mb_file.configure(menu=ov_file)
        mb_view.configure(menu=ov_view)
        mb_help.configure(menu=ov_help)
        mb_net.configure(menu=ov_net)
        self._ov_file_menu = ov_file
        self._ov_view_menu = ov_view
        self._ov_help_menu = ov_help
        self._ov_net_menu = ov_net
        self._ov_top = ov

    def _ov_top_show(self, show):
        """显示 / 隐藏浮动顶部菜单覆盖层（幂等，避免反复 deiconify/geometry 干扰点击）。"""
        if self._ov_top is None:
            return
        if show:
            if not self._ov_top.winfo_viewable():
                self._reposition_video_overlays()
                self._ov_top.deiconify()
            self._ov_top.lift()
        else:
            self._ov_top.withdraw()

    def _reposition_video_overlays(self):
        """让浮动菜单覆盖层贴合主窗口顶部（随窗口移动/缩放）。"""
        if self._ov_top is None:
            return
        self.update_idletasks()
        x = self.winfo_rootx()
        y = self.winfo_rooty()
        w = max(self.winfo_width(), 1)
        th = self._ov_top.winfo_reqheight()
        self._ov_top.geometry("%dx%d+%d+%d" % (w, th, x, y))

    def _on_window_configure(self, e=None):
        if not self.is_video:
            return
        if self._ov_reposition_after:
            self.after_cancel(self._ov_reposition_after)
        self._ov_reposition_after = self.after(80, self._reposition_video_overlays)

    def _menu_is_open(self):
        """是否有下拉菜单正在展开（展开时不要收起浮动菜单）。"""
        try:
            for m in (self._ov_file_menu, self._ov_view_menu, self._ov_help_menu):
                if m.winfo_ismapped():
                    return True
        except Exception:
            pass
        return False

    def _enter_video_chrome(self):
        """视频模式：隐藏顶部 docked 原生菜单栏/工具栏/章节条，让视频上沿铺满。"""
        self._set_menu_visible(False)
        if self.toolbar_outer.winfo_manager():
            self.toolbar_outer.pack_forget()
        if self.chapter_bar.winfo_manager():
            self.chapter_bar.pack_forget()

    def _exit_video_chrome(self):
        """退出视频：恢复顶部 docked UI。"""
        self._set_menu_visible(True)
        if not self.toolbar_outer.winfo_manager():
            self.toolbar_outer.pack(side="top", fill="x", before=self.content)
        if self._chapters and len(self._chapters) > 1 and not self.chapter_bar.winfo_manager():
            self.chapter_bar.pack(side="top", fill="x", before=self.content)

    def _autohide_bottom(self, show):
        """显示 / 隐藏底部 UI：视频控制条 + 状态栏（保留原 pack 行为）。"""
        if show:
            if not self.status.winfo_manager():
                self.status.pack(side="bottom", fill="x")
            if not self.video_bar.winfo_manager():
                self.video_bar.pack(side="bottom", fill="x", before=self.status)
        else:
            if self.video_bar.winfo_manager():
                self.video_bar.pack_forget()
            if self.status.winfo_manager():
                self.status.pack_forget()

    def _start_autohide(self):
        """进入视频播放时启动：顶部用浮动菜单，底部控制条短暂显示后自动隐藏。"""
        if self._autohide_poll:
            self.after_cancel(self._autohide_poll)
            self._autohide_poll = None
        if not self._autohide_enabled:
            return
        self._enter_video_chrome()
        self._ov_top_show(True)
        self._autohide_last_show = time.time()
        self._autohide_hidden = False
        self._autohide_poll = self.after(250, self._autohide_tick)

    def _stop_autohide(self):
        """停止轮询：收起浮动菜单，恢复顶部 docked UI 与状态栏。"""
        if self._autohide_poll:
            self.after_cancel(self._autohide_poll)
            self._autohide_poll = None
        self._autohide_hidden = False
        self._ov_top_show(False)
        if self._ui_hidden:
            # 全屏沉浸式由 _show_ui 统一恢复，这里不干预
            return
        self._exit_video_chrome()
        if not self.status.winfo_manager():
            self.status.pack(side="bottom", fill="x")

    def _autohide_tick(self):
        self._autohide_poll = None
        if not (self.is_video and self._autohide_enabled):
            return
        root_x, root_y = self.winfo_rootx(), self.winfo_rooty()
        w, h = self.winfo_width(), self.winfo_height()
        px, py = self.winfo_pointerx(), self.winfo_pointery()
        inside = root_x <= px <= root_x + w and root_y <= py <= root_y + h
        rel_y = py - root_y
        top_band = 48        # 顶部悬停触发区（浮动菜单高度约 30px）
        bottom_band = 112    # 底部悬停触发区（视频条 + 状态栏大约高度）
        if (inside and rel_y <= top_band) or self._menu_is_open():
            self._ov_top_show(True)
            self._autohide_bottom(False)
            self._autohide_last_show = time.time()
            changed = not self._autohide_hidden
            self._autohide_hidden = True
        elif inside and rel_y >= h - bottom_band:
            self._ov_top_show(False)
            self._autohide_bottom(True)
            self._autohide_last_show = time.time()
            changed = self._autohide_hidden
            self._autohide_hidden = False
        else:
            changed = False
            if time.time() - self._autohide_last_show > 2.2:
                self._ov_top_show(False)
                self._autohide_bottom(False)
                self._autohide_last_show = 0.0
                changed = not self._autohide_hidden
                self._autohide_hidden = True
        if changed:
            self.update_idletasks()
            self._apply_video_zoom()
        self._autohide_poll = self.after(250, self._autohide_tick)

    def toggle_autohide(self):
        """切换「播放时自动隐藏菜单/工具栏」。"""
        self._autohide_enabled = not self._autohide_enabled
        self._config.setdefault("_ui_", {})["autohide"] = self._autohide_enabled
        self._save_config()
        if not self.is_video:
            return
        if self._autohide_enabled:
            self._start_autohide()
        else:
            self._stop_autohide()
            if not self._ui_hidden and not self.video_bar.winfo_manager():
                self.video_bar.pack(side="bottom", fill="x", before=self.status)
            self._apply_video_zoom()

    def _show_video_panel(self):
        if not self.video_panel.winfo_manager():
            self.canvas.pack_forget()
            self.video_panel.pack(side="top", fill="both", expand=True)
            self.update_idletasks()

    def _show_image_panel(self):
        if not self.canvas.winfo_manager():
            self.video_panel.pack_forget()
            self.canvas.pack(side="top", fill="both", expand=True)
            self.update_idletasks()

    def _toggle_play(self):
        if self._cast_mode == "dlna":
            if not self._dlna:
                return
            try:
                if self._dlna_playing:
                    self._dlna.pause()
                    self._dlna_playing = False
                    self._set_btn_text(self.play_btn, "▶")
                else:
                    self._dlna.play()
                    self._dlna_playing = True
                    self._set_btn_text(self.play_btn, "⏸")
            except Exception:
                pass
            return
        if not self.player or not self.is_video or self._video_is_stopping():
            return
        try:
            if self.player.is_playing():
                self.player.pause()
                self._set_btn_text(self.play_btn, "▶")
            else:
                self.player.play()
                self._set_btn_text(self.play_btn, "⏸")
        except Exception:
            pass

    def _on_seek(self, val):
        if self._updating_seek:
            return
        self._last_seek = time.time()
        if self._cast_mode == "dlna":
            if self._dlna and self._dlna_total > 0:
                try:
                    target = int(float(val) / 1000.0 * self._dlna_total)
                    self._dlna_pos = target
                    self._dlna.seek(target)
                except Exception:
                    pass
            return
        if not self.player or not self.is_video or self._video_is_stopping():
            return
        try:
            length = self.player.get_length()
            if length > 0:
                self.player.set_time(int(float(val) / 1000.0 * length))
                if self._captioner is not None:
                    self._captioner.reset()
        except Exception:
            pass

    # ---------------- 进度条悬停预览（参考 ACG Player） ----------------
    def _on_seek_enter(self, e):
        self._seek_hovering = True
        self._show_seek_preview_at(e.x)

    def _on_seek_hover(self, e):
        self._seek_hovering = True
        self._show_seek_preview_at(e.x)

    def _on_seek_leave(self, e):
        self._seek_hovering = False
        if not self._seeking and not self._seek_preview_hover:
            self._schedule_seek_preview_hide()

    def _on_seek_press(self, e):
        self._seeking = True
        self._show_seek_preview_at(e.x)

    def _on_seek_release(self, e):
        self._seeking = False
        if not self._seek_hovering and not self._seek_preview_hover:
            self._schedule_seek_preview_hide()

    def _video_length(self):
        try:
            if self._cast_mode == "dlna":
                return self._dlna_total
            if self.player and not self._video_is_stopping():
                return self.player.get_length()
        except Exception:
            pass
        return 0

    def _seek_preview_from_x(self, x):
        w = max(self.seek.winfo_width(), 1)
        frac = clamp(x / w, 0.0, 1.0)
        length = self._video_length()
        t = int(frac * length) if length > 0 else 0
        return t, length, self._nearest_seek_thumb(t)

    def _nearest_seek_thumb(self, t):
        best, best_d = None, None
        for pos, photo in self._seek_thumbs:
            d = abs(pos - t)
            if best_d is None or d < best_d:
                best_d, best = d, photo
        return best

    def _show_seek_preview_at(self, x):
        if not (self.is_video and self.seek.winfo_ismapped()):
            return
        t, length, photo = self._seek_preview_from_x(x)
        self._seek_preview_time = t
        self._seek_preview_x = x
        if self._seek_hide_after:
            self.after_cancel(self._seek_hide_after)
            self._seek_hide_after = None
        text = "%s / %s" % (self._fmt_time(t), self._fmt_time(length))
        if photo is not None:
            self.seek_preview_label.configure(image=photo, text=text)
            self.seek_preview_label.image = photo
        else:
            self.seek_preview_label.configure(image="", text=text)
            self.seek_preview_label.image = None
        self._position_seek_preview()
        self.seek_preview_win.deiconify()
        self.seek_preview_win.lift()

    def _position_seek_preview(self):
        self.update_idletasks()
        w = self.seek_preview_win.winfo_reqwidth()
        h = self.seek_preview_win.winfo_reqheight()
        anchor_x = self.seek.winfo_rootx() + getattr(self, "_seek_preview_x", self.seek.winfo_width() // 2)
        x = anchor_x - w // 2
        left = self.winfo_rootx()
        right = left + max(self.winfo_width(), 1) - w
        x = max(left, min(x, right))
        # 紧贴在进度条上方（8px 间距），鼠标稍向上移即到预览图
        y = self.seek.winfo_rooty() - h - 8
        self.seek_preview_win.geometry("+%d+%d" % (x, y))

    def _hide_seek_preview(self):
        if self._seek_hide_after:
            self.after_cancel(self._seek_hide_after)
            self._seek_hide_after = None
        self.seek_preview_win.withdraw()

    def _schedule_seek_preview_hide(self):
        if self._seek_hide_after:
            self.after_cancel(self._seek_hide_after)
        self._seek_hide_after = self.after(520, self._hide_seek_preview)

    def _on_seek_preview_enter(self, e):
        self._seek_preview_hover = True
        if self._seek_hide_after:
            self.after_cancel(self._seek_hide_after)
            self._seek_hide_after = None

    def _on_seek_preview_leave(self, e):
        self._seek_preview_hover = False
        if not self._seeking:
            self._schedule_seek_preview_hide()

    def _on_seek_preview_click(self, e):
        self._seek_to_time(self._seek_preview_time)
        self._hide_seek_preview()

    def _seek_to_time(self, t):
        if self._cast_mode == "dlna":
            if self._dlna:
                try:
                    self._dlna_pos = t
                    self._dlna.seek(t)
                except Exception:
                    pass
            return
        if not self.player or not self.is_video or self._video_is_stopping():
            return
        try:
            self.player.set_time(int(t))
            if self._captioner is not None:
                self._captioner.reset()
            self._last_seek = time.time()
        except Exception:
            pass

    # ---------------- 预生成进度缩略图（第二播放器离屏截图，不打断播放） ----------------
    def _start_seek_thumbs(self, src, path):
        self._cancel_seek_thumbs()
        if not self.is_video or self._cast_mode == "dlna":
            return
        if self._is_audio(src):
            return   # 纯音频没有视频帧，跳过进度缩略图
        if getattr(self, "_remote_hls", False):
            return   # HLS 转码流逐段拉取，生成缩略图代价高，跳过
        if self._seek_thumbs_src == src and self._seek_thumbs:
            return
        self._seek_thumbs_src = src
        self._seek_thumbs = []
        self._seek_thumbs_busy = True
        _seek_dbg("start remote=%s hls=%s kind=%s name=%r path=%s" % (
            isinstance(src, RemoteSource), getattr(self, "_remote_hls", False),
            getattr(src, "kind", "?"), getattr(src, "name", "?"), path))
        try:
            tp = self.vlc_instance.media_player_new()
            # 不能用 tp.audio_set_mute(True)：VLC 在 Windows 上的静音是按进程的
            # WASAPI 会话设置的，会把主播放器也静音，且 Windows 会按 exe 记住该
            # 静音状态（重启后仍静音）。改为 media 选项直接不开音频输出。
            # 与主播放器一致关掉 D3D11VA 硬件解码（:avcodec-hw=none），否则
            # 缩略图播放器走硬件解码，video_take_snapshot 会报
            # SetThumbNailClip failed / 截图失败。
            media = self.vlc_instance.media_new(path, ":no-audio", ":avcodec-hw=none")
            tp.set_media(media)
            self.update_idletasks()
            tp.set_hwnd(self._thumb_frame.winfo_id())
            tp.play()
            # 不要立刻 set_pause(1)：远程流（alist 代理）要先缓冲+解码出第一帧，
            # 立即暂停会让 vout 不产帧，video_take_snapshot 返回 -1。
            # 改为在 _seek_thumb_step 里等第一帧出来后再暂停。
        except Exception:
            self._seek_thumbs_busy = False
            return
        self._thumb_player = tp
        self._thumb_state = {"idx": 0, "total": 12, "waits": 0, "vout_ready": False}
        self._thumb_gen_after = self.after(400, self._seek_thumb_step)

    def _cancel_seek_thumbs(self):
        if self._thumb_gen_after:
            self.after_cancel(self._thumb_gen_after)
            self._thumb_gen_after = None
        self._seek_thumbs_busy = False
        tp, self._thumb_player = self._thumb_player, None
        self._thumb_state = None
        if tp is not None:
            try:
                tp.stop()
                tp.release()
            except Exception:
                pass

    def _seek_thumb_step(self):
        self._thumb_gen_after = None
        tp = self._thumb_player
        st = self._thumb_state
        if tp is None or st is None or not self.is_video:
            self._cancel_seek_thumbs()
            return
        if self.sources and self._seek_thumbs_src != self.sources[self.index]:
            self._cancel_seek_thumbs()
            return
        if not st.get("vout_ready"):
            # 等第一帧解码出来（远程流缓冲慢），否则截图时 vout 还没画面
            try:
                size = tp.video_get_size()
            except Exception:
                size = (0, 0)
            if size and size[0] > 0 and size[1] > 0:
                st["vout_ready"] = True
                st["waits"] = 0
                _seek_dbg("vout ready size=%s" % (size,))
                # 关键：不要暂停。实测暂停后对远程流 seek，wingdi vout 停在
                # 空帧，video_take_snapshot 拿不到画面（文件不生成或整张全黑）。
                # 保持播放让 vout 持续产帧，seek 后等一会儿再截图才有效。
            else:
                st["waits"] += 1
                if st["waits"] > 40:
                    _seek_dbg("giveup vout-not-ready waits=%d" % st["waits"])
                    self._cancel_seek_thumbs()
                    return
                self._thumb_gen_after = self.after(250, self._seek_thumb_step)
                return
        try:
            length = tp.get_length()
        except Exception:
            length = -1
        if length <= 0:
            st["waits"] += 1
            if st["waits"] > 24:
                _seek_dbg("giveup length<=0 waits=%d src=%r" % (st["waits"], getattr(self._seek_thumbs_src, "name", "?")))
                self._cancel_seek_thumbs()
                return
            self._thumb_gen_after = self.after(300, self._seek_thumb_step)
            return
        st["waits"] = 0
        idx = st["idx"]
        if idx >= st["total"]:
            self._cancel_seek_thumbs()
            return
        pos = int(length * idx / st["total"])
        try:
            tp.set_time(pos)
        except Exception:
            pass
        # 远程流 seek 后要重新缓冲，给足时间；本地文件几乎瞬时
        delay = 700 if isinstance(self._seek_thumbs_src, RemoteSource) else 220
        self._thumb_gen_after = self.after(delay, self._seek_thumb_snap, idx, pos)

    def _thumb_image_ok(self, p):
        """截图是否有效：文件存在、非空、且不是整张纯黑。

        实测 video_take_snapshot 的返回值不可靠（可能有画面也返回 -1），
        远程流暂停时还可能写出整张全黑的 PNG，所以以文件内容为准。"""
        try:
            if not (os.path.exists(p) and os.path.getsize(p) > 0):
                return False
            im = Image.open(p)
            _lo, hi = im.convert("L").getextrema()
            return hi > 12   # 全黑/几乎全黑视为失败
        except Exception:
            return False

    def _seek_thumb_snap(self, idx, pos, attempt=0):
        self._thumb_gen_after = None
        tp = self._thumb_player
        st = self._thumb_state
        if tp is None or st is None or not self.is_video:
            self._cancel_seek_thumbs()
            return
        p = os.path.join(self._tmp_dir, "seek_thumb_%d.png" % idx)
        try:
            if os.path.exists(p):
                os.remove(p)
        except Exception:
            pass
        try:
            tp.video_take_snapshot(0, p, 240, 135)
        except Exception as ex:
            _seek_dbg("snap idx=%d pos=%d attempt=%d exc=%r" % (idx, pos, attempt, ex))
        # 不迷信返回值：以「文件有效且非全黑」为准；失败就短间隔重试等帧就绪
        if self._thumb_image_ok(p):
            if attempt:
                _seek_dbg("snap idx=%d pos=%d ok after %d retries" % (idx, pos, attempt))
            self._thumb_gen_after = self.after(60, self._seek_thumb_load, idx, pos, p)
            return
        if attempt < 5:
            self._thumb_gen_after = self.after(320, self._seek_thumb_snap, idx, pos, attempt + 1)
            return
        _seek_dbg("snap idx=%d pos=%d giveup after %d tries" % (idx, pos, attempt + 1))
        st["idx"] = idx + 1
        self._thumb_gen_after = self.after(80, self._seek_thumb_step)

    def _seek_thumb_load(self, idx, pos, p):
        self._thumb_gen_after = None
        try:
            if os.path.exists(p) and os.path.getsize(p) > 0:
                img = Image.open(p)
                self._seek_thumbs.append((pos, ImageTk.PhotoImage(img)))
        except Exception:
            pass
        if self._thumb_state is not None:
            self._thumb_state["idx"] = idx + 1
        self._thumb_gen_after = self.after(80, self._seek_thumb_step)

    def _on_volume(self, val):
        if self._cast_mode == "dlna":
            return  # DLNA 音量由投影仪控制
        if self.player and not self._video_is_stopping():
            try:
                self.player.audio_set_volume(int(float(val)))
                self.player.audio_set_mute(False)   # 解除旧代码残留的进程级静音
            except Exception:
                pass

    def _pump(self, seconds):
        """在视频截图期间持续泵 Tk 事件，让 VLC 渲染线程有机会出帧。"""
        deadline = time.time() + seconds
        while time.time() < deadline:
            try:
                self.update()
            except Exception:
                pass
            time.sleep(0.01)

    def _screenshot_path(self):
        """决定截图保存位置：本地视频存同目录「截图」文件夹；压缩包内视频存
        用户图片目录下的「视频截图」。"""
        src = self.sources[self.index]
        name = self._display_name(src)
        stem = os.path.splitext(name)[0] or "video"
        if isinstance(src, tuple) or not os.path.dirname(src):
            base = os.path.join(os.path.expanduser("~"), "Pictures", "视频截图")
        else:
            base = os.path.join(os.path.dirname(src), "截图")
        try:
            os.makedirs(base, exist_ok=True)
        except Exception:
            base = self._tmp_dir
        ts = time.strftime("%Y%m%d_%H%M%S")
        out = os.path.join(base, "%s_%s.png" % (stem, ts))
        i = 1
        while os.path.exists(out):
            out = os.path.join(base, "%s_%s_%d.png" % (stem, ts, i))
            i += 1
        return out

    def _video_screenshot(self):
        """视频截图：抓取最近 N 帧，亚像素对齐后合并成一张更清晰的高清图。"""
        if not self.is_video or not self.player or self._video_is_stopping():
            self.status.configure(text="截图仅在视频页可用：请先打开一个视频")
            return
        if self._cast_mode == "dlna":
            self.status.configure(text="投屏模式不支持本地截图")
            return
        if self.sources and self._is_audio(self.sources[self.index]):
            self.status.configure(text="音频不支持视频截图")
            return
        if self._screenshot_busy:
            return
        self._screenshot_busy = True
        self.status.configure(text="正在合成截图…")
        self.update_idletasks()
        try:
            was_playing = False
            try:
                was_playing = bool(self.player.is_playing())
            except Exception:
                pass
            if was_playing:
                try:
                    self.player.pause()
                    self._set_btn_text(self.play_btn, "▶")
                except Exception:
                    pass
            try:
                cur = self.player.get_time()
                length = self.player.get_length()
            except Exception:
                cur, length = 0, 0
            try:
                fps = float(self.player.get_fps() or 0.0)
            except Exception:
                fps = 0.0
            # 相邻帧间隔：约一帧，保证抓到的几帧确实不同、又有亚像素运动信息
            offset_ms = max(20, int(round(1000.0 / fps))) if fps > 0 else 40

            frames = []
            for i in range(SCREENSHOT_FRAMES):
                t = max(0, cur - i * offset_ms)
                if length > 0:
                    t = min(t, max(0, length - 120))
                try:
                    self.player.set_time(int(t))
                except Exception:
                    pass
                self._pump(0.15)
                tmp = os.path.join(self._tmp_dir, "shot_%d.png" % i)
                try:
                    if os.path.exists(tmp):
                        os.remove(tmp)
                except Exception:
                    pass
                try:
                    ok = self.player.video_take_snapshot(0, tmp, 0, 0)
                except Exception:
                    ok = -1
                # snapshot 写入可能异步，短暂等待后重试读取
                if ok == 0:
                    for _ in range(20):
                        if os.path.exists(tmp) and os.path.getsize(tmp) > 0:
                            break
                        self._pump(0.02)
                try:
                    if ok == 0 and os.path.exists(tmp) and os.path.getsize(tmp) > 0:
                        im = Image.open(tmp).convert("RGB")
                        if not np:
                            if not frames:
                                frames.append(im)
                            continue
                        arr = np.asarray(im, dtype=np.float32)
                        if frames and arr.shape != frames[0].shape:
                            continue
                        frames.append(arr)
                except Exception:
                    pass

            # 恢复原来的播放位置与状态
            try:
                self.player.set_time(int(cur))
            except Exception:
                pass
            if was_playing:
                try:
                    self.player.play()
                    self._set_btn_text(self.play_btn, "⏸")
                except Exception:
                    pass

            if not frames:
                self.status.configure(text="截图失败：未能从视频抓取画面")
                return
            if not np:
                # 未安装 numpy：退化为保存单帧截图
                img = frames[0]
            else:
                # 长边翻倍超过上限时退化为原生分辨率合成，避免 8K 内存/文件过大
                h, w = frames[0].shape[:2]
                scale = 2 if (2 * max(h, w) <= SCREENSHOT_MAX_EDGE) else 1
                merged = _merge_frames(frames, scale=scale)
                img = Image.fromarray(np.clip(merged, 0, 255).astype(np.uint8), "RGB")
            out = self._screenshot_path()
            img.save(out)
            self.status.configure(text="已截图：%s" % out)
            self._notify_screenshot(out)
        finally:
            self._screenshot_busy = False

    def _notify_screenshot(self, out):
        try:
            if messagebox.askyesno("截图完成", "已保存：%s\n\n是否打开所在文件夹？" % out, parent=self):
                folder = os.path.dirname(out)
                if sys.platform.startswith("win"):
                    os.startfile(folder)
                else:
                    import subprocess
                    subprocess.Popen(["xdg-open", folder])
        except Exception:
            pass

    def _update_video_time_loop(self):
        self._video_timer = None
        if self._cast_mode == "dlna":
            self._update_dlna_time_loop()
            return
        if not self.is_video or not self.player or self._video_is_stopping():
            return
        try:
            length = self.player.get_length()
            cur = self.player.get_time()
            if length > 0:
                if self._resume_seek_ms is not None:
                    self.player.set_time(min(self._resume_seek_ms, max(0, length - 3000)))
                    self._resume_seek_ms = None
                self.time_label.configure(text="%s / %s" % (self._fmt_time(cur), self._fmt_time(length)))
                if time.time() - self._last_seek > 0.5:
                    self._updating_seek = True
                    try:
                        self.seek.set(cur / length * 1000.0)
                    finally:
                        self._updating_seek = False
                if self._ab_end_ms is not None and cur >= self._ab_end_ms:
                    self.player.set_time(self._ab_start_ms)
                    self._last_seek = time.time()
            if self.player.get_state() == self.vlc.State.Ended:
                self._set_btn_text(self.play_btn, "▶")
                if not self._video_ended:
                    self._video_ended = True
                    self._play_next_at_end()
                return
        except Exception:
            pass
        self._video_timer = self.after(500, self._update_video_time_loop)

        # 注：不再在 500ms 轮询里周期性重挂鼠标穿透。每秒遍历并 SetWindowLongW
        # 子类化 VLC 原生子窗口，会与最小化/还原/焦点切换时的窗口消息（proc 回调）
        # 竞争，实测把主线程死锁在 SetWindowLongW / CallWindowProcW 上（窗口半宽、
        # 无法拖拽）。穿透改为只在窗口重建的确定性时机重挂（见 _refresh_video_hwnd
        # / 打开视频后 400ms+1200ms / 区域放大）。

        # 刷新视频条上的字幕/速率按钮状态（~2Hz，轻量，避免手动在各处重绘）
        try:
            self._sync_subtitle_button()
            self.rate_label.configure(text="%.1f\u00d7" % self._rate)
        except Exception:
            pass

    def _update_dlna_time_loop(self):
        """DLNA 投屏模式下的进度条轮询（1Hz，本地计时 + 定期校准）。

        极米的 GetPositionInfo 响应不稳定（实测 8 秒后经常超时返回 None），
        所以不能用它每秒更新进度条；改为本地计时每秒 +1，每 5 秒向投影仪
        校准一次，兼顾流畅与准确。
        """
        self._video_timer = None
        if self._cast_mode != "dlna" or not self._dlna or not self.is_video:
            return
        try:
            if self._dlna_playing:
                self._dlna_pos += 1
            self._dlna_sync_tick += 1
            if self._dlna_sync_tick >= 5:
                self._dlna_sync_tick = 0
                pos = self._dlna.get_position()
                if pos:
                    self._dlna_pos, total, _state = pos
                    if total > 0:
                        self._dlna_total = total
            if self._dlna_total > 0:
                cur = min(self._dlna_pos, self._dlna_total)
                self.time_label.configure(
                    text="%s / %s" % (self._fmt_time(cur), self._fmt_time(self._dlna_total)))
                if time.time() - self._last_seek > 0.5:
                    self._updating_seek = True
                    try:
                        self.seek.set(cur / self._dlna_total * 1000.0)
                    finally:
                        self._updating_seek = False
        except Exception:
            pass
        self._video_timer = self.after(1000, self._update_dlna_time_loop)
        try:
            self.rate_label.configure(text="%.1f\u00d7" % self._rate)
        except Exception:
            pass

    def toggle_captions(self):
        if self._cast_mode == "dlna":
            self.status.configure(text="投屏模式下本地字幕不跟投（DLNA 限制）")
            return
        self.caption_enabled = not self.caption_enabled
        self._sync_toggle_buttons()
        if self.is_video:
            if self.caption_enabled:
                self._start_captions()
            else:
                # 关闭字幕时保留声音：进入透传模式（只停识别，不停输出流）
                self._stop_captions(keep_audio=True)

    def toggle_caption_pos(self):
        self.caption_pos = "top" if self.caption_pos != "top" else "bottom"
        self._config.setdefault("_ui_", {})["caption_pos"] = self.caption_pos
        self._save_config()
        if self.is_video:
            self._reposition_caption_window()

    def _choose_subtitle(self):
        """弹出文件选择：选择/清空外接字幕文件 .srt/.ass/.sub/.ssa。"""
        if not self.sources:
            return
        names = [
            ("字幕文件", "*.srt *.ass *.ssa *.sub *.scc *.smi *.sbv"),
            ("所有文件", "*.*"),
        ]
        path = filedialog.askopenfilename(
            title="选择外接字幕文件",
            filetypes=names)
        if path and not _is_same_subtitle(path, self._sub_path):
            self.set_external_subtitle(path)

    def _sync_subtitle_button(self):
        """刷新视频条上依赖字幕/速率状态的控件。"""
        if self.rate_label.winfo_exists():
            self.rate_label.configure(text="%.1f×" % self._rate)

    def _on_caption_lang_change(self, event=None):
        lang = self.caption_lang_var.get()
        if lang == "中文":
            self.caption_mode_var.set("原声")
            self.caption_mode_combo.configure(state="disabled")
        else:
            if lang in ("韩语", "粤语"):
                # 韩语/粤语没有离线 Argos 翻译模型，只保留「原声」和「AI 翻译」
                self.caption_mode_combo.configure(values=["原声", "AI 翻译"])
                if self.caption_mode_var.get() == "中文翻译":
                    self.caption_mode_var.set("原声")
            else:
                self.caption_mode_combo.configure(values=CAPTION_MODES)
            self.caption_mode_combo.configure(state="readonly")
        self._restart_captions_if_active()

    def _on_caption_mode_change(self, event=None):
        self._restart_captions_if_active()

    def _restart_captions_if_active(self):
        if self.caption_enabled and self.is_video:
            self._stop_captions()
            self._start_captions()

    def _start_captions(self):
        lang = CAPTION_LANG_CODES.get(self.caption_lang_var.get(), "en")
        mode = CAPTION_MODE_CODES.get(self.caption_mode_var.get(), "original")
        if (self._captioner is None
                or self._captioner.source_lang != lang
                or self._captioner.caption_mode != mode):
            from caption_engine import LiveCaptioner
            self._captioner = LiveCaptioner(
                source_lang=lang, caption_mode=mode,
                ai_cfg=self._config.get("_ai_", {}),
            )
        self._audio_hijacked = True
        self.caption_label.configure(text="字幕模型加载中…")
        self.caption_window.deiconify()
        self._reposition_caption_window()
        self._captioner.start_async(self.player, stop_fn=self._stop_player)
        if self._caption_await_after:
            self.after_cancel(self._caption_await_after)
        self._caption_await_after = self.after(150, self._await_caption_start)

    def _await_caption_start(self):
        self._caption_await_after = None
        if self._captioner is None:
            return
        result = self._captioner.poll()
        if result is None:
            self._caption_await_after = self.after(150, self._await_caption_start)
            return
        ok, error = result
        if not ok:
            self.status.configure(text=error or "字幕启动失败")
            self.caption_enabled = False
            self._sync_toggle_buttons()
            self.caption_window.withdraw()
            return
        # 若回调是在播放中设置的（播放中开字幕，或首次异步加载模型导致
        # play 先于 audio_set_callbacks），_finish_start 已先 stop，这里
        # play 并 seek 回原进度，让 libvlc 真正把音频交给回调接管。
        if getattr(self._captioner, "_needs_play", False):
            self._resume_video_after_captions()
        self.caption_label.configure(text="")
        self._reposition_caption_window()
        self._poll_captions()

    def _resume_video_after_captions(self):
        """字幕回调就绪后恢复播放。_finish_start 已在设置回调前 stop 掉播放
        （那是安全时机），这里 play 并 seek 回原进度即可。"""
        if not self.player or not self.is_video:
            return
        try:
            self.player.play()
            cur = getattr(self._captioner, "_resume_time", 0)
            if cur > 0:
                self.player.set_time(cur)
            self.player.audio_set_volume(int(self.vol.get()))
            self.player.audio_set_mute(False)   # 解除旧代码残留的进程级静音
        except Exception:
            pass
        # stop 期间时间刷新循环被暂停了（_video_is_stopping 让其提前返回且不重排），
        # 恢复播放后重新拉起它，否则进度条/时间标签不再更新。
        if self._video_timer:
            self.after_cancel(self._video_timer)
            self._video_timer = None
        self._update_video_time_loop()

    def _stop_captions(self, keep_audio=False):
        if self._caption_await_after:
            self.after_cancel(self._caption_await_after)
            self._caption_await_after = None
        if self._caption_poll_after:
            self.after_cancel(self._caption_poll_after)
            self._caption_poll_after = None
        if self._captioner is not None:
            self._captioner.stop(keep_audio=keep_audio)
        self.caption_window.withdraw()

    def _open_ai_settings(self):
        from caption_engine import AI_PRESETS
        ai = self._config.get("_ai_", {})
        dlg = tk.Toplevel(self)
        dlg.title("AI 翻译设置")
        dlg.configure(bg=PANEL)
        dlg.transient(self)
        dlg.resizable(False, False)

        frm = tk.Frame(dlg, bg=PANEL, padx=14, pady=12)
        frm.pack(fill="both", expand=True)

        def row(i, text):
            tk.Label(frm, text=text, bg=PANEL, fg=FG,
                     font=("Microsoft YaHei", 9)).grid(row=i, column=0, sticky="w", pady=4)

        row(0, "服务商预设")
        preset_var = tk.StringVar(value="自定义")
        preset_combo = ttk.Combobox(frm, textvariable=preset_var,
                                    values=list(AI_PRESETS.keys()), state="readonly", width=16)
        preset_combo.grid(row=0, column=1, sticky="ew", pady=4, padx=(10, 0))

        row(1, "API Key")
        key_var = tk.StringVar(value=ai.get("api_key", ""))
        tk.Entry(frm, textvariable=key_var, show="*", width=42).grid(
            row=1, column=1, sticky="ew", pady=4, padx=(10, 0))

        row(2, "API Base")
        base_var = tk.StringVar(value=ai.get("api_base", "https://api.deepseek.com"))
        tk.Entry(frm, textvariable=base_var, width=42).grid(
            row=2, column=1, sticky="ew", pady=4, padx=(10, 0))

        row(3, "模型")
        model_var = tk.StringVar(value=ai.get("model", "deepseek-chat"))
        tk.Entry(frm, textvariable=model_var, width=42).grid(
            row=3, column=1, sticky="ew", pady=4, padx=(10, 0))

        def apply_preset(_e=None):
            b, m = AI_PRESETS.get(preset_var.get(), ("", ""))
            if b:
                base_var.set(b)
            if m:
                model_var.set(m)

        preset_combo.bind("<<ComboboxSelected>>", apply_preset)
        cur_base = ai.get("api_base", "").rstrip("/")
        for name, (b, _m) in AI_PRESETS.items():
            if b and b.rstrip("/") == cur_base:
                preset_var.set(name)
                break

        def save():
            self._config["_ai_"] = {
                "api_key": key_var.get().strip(),
                "api_base": base_var.get().strip().rstrip("/"),
                "model": model_var.get().strip(),
            }
            self._save_config()
            dlg.destroy()

        btns = tk.Frame(frm, bg=PANEL)
        btns.grid(row=4, column=0, columnspan=2, pady=(12, 0))
        tk.Button(btns, text="保存", command=save, bg=ACCENT, fg="#fff",
                  relief="flat", padx=16, cursor="hand2").pack(side="left", padx=4)
        tk.Button(btns, text="取消", command=dlg.destroy, bg=BTN_BG, fg=FG,
                  relief="flat", padx=16, cursor="hand2").pack(side="left", padx=4)

        dlg.grab_set()
        dlg.update_idletasks()
        x = self.winfo_rootx() + (self.winfo_width() - dlg.winfo_width()) // 2
        y = self.winfo_rooty() + (self.winfo_height() - dlg.winfo_height()) // 2
        dlg.geometry("+%d+%d" % (max(0, x), max(0, y)))

    def _poll_captions(self):
        self._caption_poll_after = None
        if self._captioner is None or not self.is_video:
            return
        latest = None
        try:
            while True:
                _kind, text = self._captioner.queue.get_nowait()
                latest = text
        except queue.Empty:
            pass
        if latest is not None:
            self.caption_label.configure(text=latest)
            self._reposition_caption_window()
        self._caption_poll_after = self.after(150, self._poll_captions)

    @staticmethod
    def _fmt_time(ms):
        return fmt_time(ms)

    # ---------------- 显示 ----------------
    def show_file(self, i):
        if not self.sources:
            return
        i %= len(self.sources)
        if self.is_video:
            # 在索引改变前保存旧视频的续播点，避免写入即将打开的新文件。
            self._stop_video()
        self.index = i
        self.rotation = 0
        src = self.sources[i]
        self._record_history(src)

        if self._is_video(src) or self._is_audio(src):
            self.orig = None
            self._spread_img = None
            self._video_rotation = 0   # 打开新视频时重置旋转，不记忆上一段的角度
            self._thumbs_hide_for_video()   # 视频页隐藏缩略图条
            self.canvas.delete("img")
            if isinstance(src, RemoteSource):
                self.browse_btn.pack(side="left", padx=2)
            else:
                self.browse_btn.pack_forget()
            self._show_video(src)
            self._highlight_thumb()
            self._save_progress()
            if self.auto_flip:
                self._schedule_auto()
            return

        self._show_image_panel()
        self.is_video = False
        self.browse_btn.pack_forget()
        self._thumbs_restore()   # 回到图片页按偏好恢复缩略图条
        try:
            self.orig = self._open_image(src)
        except Exception as e:
            self.status.configure(text="无法打开图片：%s（%s）" % (self._display_name(src), e))
            return
        self._spread_img = self._make_spread()

        if self.fit_mode == "custom":
            self.fit_mode = "window"
        self.pan_x = self.pan_y = 0.0
        self.update_idletasks()
        self._render()
        self._highlight_thumb()
        self._save_progress()
        if self.auto_flip:
            self._schedule_auto()

    def _rotated_size(self):
        src = self._spread_img if self._spread_img is not None else self.orig
        if not src:
            return 1, 1
        return rotated_size(src.size[0], src.size[1], self.rotation)

    def _compute_zoom(self):
        if not self.orig:
            return 1.0
        cw = max(self.canvas.winfo_width(), 1)
        ch = max(self.canvas.winfo_height(), 1)
        rw, rh = self._rotated_size()
        return compute_zoom(self.fit_mode, self.zoom, cw, ch, rw, rh)

    def _render(self):
        if not self.orig:
            return
        src = self._spread_img if self._spread_img is not None else self.orig
        self.zoom = self._compute_zoom()
        rw, rh = self._rotated_size()
        dw = max(1, int(round(rw * self.zoom)))
        dh = max(1, int(round(rh * self.zoom)))

        im = src
        if self.rotation:
            im = im.rotate(self.rotation, expand=True)
        if self._compare_mode and getattr(self, "_compare_img", None) is not None:
            im = self._compare_img
        if (dw, dh) != im.size:
            im = im.resize((dw, dh), RESAMPLE)

        if self.book_filter:
            is_spread = (self._spread_img is not None) or (
                self._compare_mode and getattr(self, "_compare_img", None) is not None)
            im = self._apply_book_filter(im, is_spread)

        self.display = im
        self.photo = ImageTk.PhotoImage(im)
        self.canvas.delete("img")
        cx = self.canvas.winfo_width() / 2 + self.pan_x
        cy = self.canvas.winfo_height() / 2 + self.pan_y
        self.canvas_img = self.canvas.create_image(cx, cy, image=self.photo,
                                                   anchor="center", tags="img")
        self._update_status()

    def _reposition(self):
        if self.canvas_img:
            cx = self.canvas.winfo_width() / 2 + self.pan_x
            cy = self.canvas.winfo_height() / 2 + self.pan_y
            self.canvas.coords(self.canvas_img, cx, cy)

    def _clamp_pan(self):
        if not self.orig:
            return
        cw = max(self.canvas.winfo_width(), 1)
        ch = max(self.canvas.winfo_height(), 1)
        rw, rh = self._rotated_size()
        self.pan_x, self.pan_y = clamp_pan(self.pan_x, self.pan_y, cw, ch, rw, rh, self.zoom)

    # ---------------- 操作 ----------------
    def next(self):
        if not self.sources:
            return
        if self.spread_mode and self._spread_img is not None:
            self.show_file(min(self.index + 2, len(self.sources) - 1))
        else:
            self.show_file(min(self.index + 1, len(self.sources) - 1))

    def prev(self):
        if not self.sources:
            return
        if self.spread_mode and self._spread_img is not None:
            self.show_file(max(self.index - 2, 0))
        else:
            self.show_file(max(self.index - 1, 0))

    def rotate(self, d):
        if self.is_video:
            self._rotate_video(d)
            return
        if not self.orig:
            return
        self.rotation = (self.rotation + d) % 360
        self._clamp_pan()
        self._render()

    def _rotate_video(self, d):
        """旋转视频：transform 滤镜是 Instance 级选项，改角度需重建 VLC 实例。"""
        if self._cast_mode == "dlna":
            return  # DLNA 投屏不支持本地旋转
        self._video_rotation = (self._video_rotation + d) % 360
        self._save_video_options()
        if self.is_video:
            self._save_resume_position()  # 记住当前位置，重开后断点续播
            self._recreate_vlc()
            self._show_video(self.sources[self.index])

    def _recreate_vlc(self):
        """停掉并释放旧 player/实例，按新的旋转角度重建 VLC。"""
        stop_done = True
        if self.player is not None:
            self._stop_player()
            # stop 超时（D3D11 收尾死锁兜底）时不强行 release，避免 use-after-free；
            # 旧实例交给后台 stop 线程收尾，这里只丢弃引用。
            stop_done = (self._stop_event is not None and self._stop_event.is_set())
            if stop_done:
                try:
                    self.player.release()
                except Exception:
                    pass
            self.player = None
        if self.vlc_instance is not None:
            if stop_done:
                try:
                    self.vlc_instance.release()
                except Exception:
                    pass
            self.vlc_instance = None
        self.vlc = None
        self._ensure_vlc()

    def set_fit(self, mode):
        if not self.orig:
            return
        self.fit_mode = mode
        self.pan_x = self.pan_y = 0.0
        self._render()

    def jump_to_page(self):
        if not self.sources:
            return
        n = simpledialog.askinteger("跳转", "输入页码（1 - %d）：" % len(self.sources),
                                    minvalue=1, maxvalue=len(self.sources), parent=self)
        if n is not None:
            self.show_file(n - 1)

    def toggle_spread(self):
        self.spread_mode = not self.spread_mode
        self._sync_toggle_buttons()
        if self.orig:
            self._spread_img = self._make_spread()
            self.pan_x = self.pan_y = 0.0
            self._render()
        self._save_progress()

    def toggle_direction(self):
        self.reading_direction = "rtl" if self.reading_direction == "ltr" else "ltr"
        self._sync_toggle_buttons()
        if self.orig:
            self._spread_img = self._make_spread()
            self._render()
        self._save_progress()

    def toggle_trim(self):
        self.trim_mode = not self.trim_mode
        self._sync_toggle_buttons()
        if self.sources and not self.is_video:
            self.show_file(self.index)
        self._save_progress()

    def toggle_book_filter(self):
        self.book_filter = not self.book_filter
        self._sync_toggle_buttons()
        if self.sources and not self.is_video:
            self._render()
        self._save_progress()

    @staticmethod
    def _to_rgb(im):
        if im.mode == "RGB":
            return im
        if im.mode == "RGBA":
            bg = Image.new("RGB", im.size, (255, 255, 255))
            bg.paste(im, mask=im.getchannel("A"))
            return bg
        return im.convert("RGB")

    def _paper_grain(self, size):
        """生成低强度细颗粒纸张纹理（缓存 256px 噪点块再平铺）。"""
        if self._grain_tile is None:
            tile = Image.effect_noise((256, 256), 10)
            self._grain_tile = (np.asarray(tile, dtype=np.float32) - 128.0) / 128.0
        w, h = size
        tile = self._grain_tile
        th, tw = tile.shape
        reps_h = (h + th - 1) // th
        reps_w = (w + tw - 1) // tw
        tiled = np.tile(tile, (reps_h, reps_w))[:h, :w]
        return (tiled * 0.03).astype(np.float32)[..., None]

    def _apply_book_filter(self, im, is_spread):
        """模拟纸质书质感：光影 + 书脊阴影 + 页边厚度阴影 + 纸张纹理。
        全部按亮度乘法处理，不改变图片内容，只叠加阅读氛围。"""
        if not np:
            return im
        im = self._to_rgb(im)
        w, h = im.size
        try:
            arr = np.asarray(im, dtype=np.float32)
            x = np.linspace(-1.0, 1.0, w, dtype=np.float32)
            y = np.linspace(-1.0, 1.0, h, dtype=np.float32)
            x2 = x * x
            y2 = y * y

            # 光影：轻微暗角（中心自然、四周略暗）
            mask = 1.0 - 0.06 * (y2[:, None] + x2[None, :])

            # 书脊阴影：双页（或对比模式）时压暗中间
            if is_spread:
                mask = mask - 0.20 * np.exp(-x2 / 0.015)[None, :]

            # 页边厚度阴影：左右两侧 + 底部
            side = 0.10 * np.exp(-((np.abs(x) - 1.0) ** 2) / 0.02)
            bottom = 0.08 * np.exp(-((y - 1.0) ** 2) / 0.03)
            mask = mask - (side[None, :] + bottom[:, None])

            arr = np.clip(arr * np.clip(mask, 0.55, 1.2)[..., None], 0, 255)

            # 纸张纹理
            arr = np.clip(arr * (1.0 + self._paper_grain((w, h))), 0, 255)
            return Image.fromarray(arr.astype(np.uint8), "RGB")
        except Exception:
            return im

    def toggle_compare(self):
        """切换图片对比模式（连续两图并排显示）。
        """
        self._compare_mode = not self._compare_mode
        self._config.setdefault("_ui_", {})["compare_mode"] = self._compare_mode
        self._save_config()
        if self.sources and not self.is_video:
            self._render()

    def _render_compare(self):
        """把连续两张图并排渲染进画布（对比模式）。
        """
        if not self.orig or self.is_video:
            return
        if self.index >= len(self.sources) - 1:
            return
        try:
            a = self.orig
            b = self._open_image(self.sources[self.index + 1])
        except Exception:
            return
        aa = a.convert("RGB")
        bb = b.convert("RGB")
        w1, h1 = aa.size
        w2, h2 = bb.size
        H = max(h1, h2)
        merged = Image.new("RGB", (w1 + w2, H), "#000")
        merged.paste(aa, (0, (H - h1) // 2))
        merged.paste(bb, (w1, (H - h2) // 2))
        self._compare_img = merged
        self._render()

    def toggle_auto(self):
        if self.auto_flip:
            self.auto_flip = False
            self._cancel_auto()
        else:
            if not self.sources:
                return
            self.auto_flip = True
            self._schedule_auto()
        self._sync_toggle_buttons()
        self._update_status()

    def adjust_auto_interval(self, delta):
        self.auto_interval = clamp(round(self.auto_interval + delta, 1), 0.5, 60.0)
        if self.auto_flip:
            self._schedule_auto()
        self._update_status()

    def _schedule_auto(self):
        self._cancel_auto()
        self._auto_after = self.after(int(self.auto_interval * 1000), self._auto_tick)

    def _cancel_auto(self):
        if self._auto_after:
            self.after_cancel(self._auto_after)
            self._auto_after = None

    def _auto_tick(self):
        self._auto_after = None
        if not self.auto_flip or not self.sources:
            return
        if self.index >= len(self.sources) - 1:
            # 到最后一页自动停止
            self.auto_flip = False
            self._sync_toggle_buttons()
            self._update_status()
            return
        self.next()  # show_file 内部会重新调度下一次计时

    def _sync_toggle_buttons(self):
        # 只有视频条上的「CC 字幕」还需要颜色状态；其余开关已移到菜单里
        self.caption_btn.configure(bg=ACCENT if self.caption_enabled else BTN_BG,
                                   fg="#fff" if self.caption_enabled else FG)
        if hasattr(self, "cast_btn"):
            self._set_btn_text(self.cast_btn, "📺 投屏中" if self._cast_name else "📺 投屏")
            self.cast_btn.configure(
                bg=ACCENT if self._cast_name else BTN_BG,
                fg="#fff" if self._cast_name else FG)

    def _play_next_at_end(self):
        if self._repeat_one:
            self.show_file(self.index)
            return
        if self._playlist and self._playlist_index0 is not None:
            if self._shuffle_playlist and len(self._playlist) > 1:
                choices = [i for i in range(len(self._playlist)) if i != self._playlist_index0]
                self._playlist_index0 = random.choice(choices)
                self._playlist_show(self._playlist[self._playlist_index0])
                return
            if self._playlist_index0 + 1 < len(self._playlist):
                self._playlist_index0 += 1
                self._playlist_show(self._playlist[self._playlist_index0])
                return
            if self._repeat_playlist:
                self._playlist_index0 = 0
                self._playlist_show(self._playlist[0])
                return
        if self.index < len(self.sources) - 1:
            self.show_file(self.index + 1)

    def zoom_at(self, x, y, factor):
        if not self.orig:
            return
        new_zoom = clamp(self.zoom * factor, MIN_ZOOM, MAX_ZOOM)
        f = new_zoom / self.zoom
        cw = max(self.canvas.winfo_width(), 1)
        ch = max(self.canvas.winfo_height(), 1)
        self.pan_x, self.pan_y = zoom_at_pan(self.pan_x, self.pan_y, x, y, cw, ch, f)
        self.zoom = new_zoom
        self.fit_mode = "custom"
        self._clamp_pan()
        self._render()

    def zoom_center(self, f):
        self.zoom_at(self.canvas.winfo_width() / 2, self.canvas.winfo_height() / 2, f)

    # ---------------- 缩放滑块（scale 百分比条） ----------------
    def _zoom_range(self):
        # 视频缩放范围 0.5x..4x，图片 2%..4000%
        return (0.5, 4.0) if self.is_video else (MIN_ZOOM, MAX_ZOOM)

    def _zoom_slider_value(self, pos):
        """滑块 0..1000 -> 真实缩放倍率（对数刻度，拖动手感均匀）。"""
        lo, hi = self._zoom_range()
        return zoom_slider_value(pos, lo, hi)

    def _zoom_slider_pos(self, z):
        """真实缩放倍率 -> 滑块 0..1000（对数刻度）。"""
        lo, hi = self._zoom_range()
        return zoom_slider_pos(z, lo, hi)

    def _sync_zoom_slider(self):
        if not hasattr(self, "zoom_slider"):
            return
        z = self._video_zoom if self.is_video else self.zoom
        self._zoom_slider_guard = True
        try:
            self.zoom_slider.set(self._zoom_slider_pos(z))
        finally:
            self._zoom_slider_guard = False

    def _on_zoom_slider(self, val):
        if getattr(self, "_zoom_slider_guard", False):
            return
        if not (self.orig or self.is_video):
            return
        z = self._zoom_slider_value(val)
        if self.is_video:
            self._video_zoom = clamp(round(z, 2), 0.5, 4.0)
            if self.attributes("-fullscreen"):
                self._video_fs_fit = False   # 手动缩放后不再自动铺满
            self._apply_video_zoom()
            self._save_video_options()
            self._update_status()
            return
        # 图片页：即时更新百分比，重绘做轻量节流避免大图卡顿
        old = max(self.zoom, 1e-6)
        self.zoom = clamp(z, MIN_ZOOM, MAX_ZOOM)
        f = self.zoom / old
        self.pan_x *= f
        self.pan_y *= f
        self.fit_mode = "custom"
        self._clamp_pan()
        self.zoom_label.configure(text="%d%%" % int(round(self.zoom * 100)))
        if self._zoom_slider_after:
            self.after_cancel(self._zoom_slider_after)
        self._zoom_slider_after = self.after(25, self._zoom_slider_render)

    def _zoom_slider_render(self):
        self._zoom_slider_after = None
        if not self.is_video and self.orig:
            self._render()

    def _on_zoom_label_click(self, _e):
        # 点击百分比 => 重置画面（图片：适应窗口；视频：恢复 100%）
        if self.is_video:
            self.reset_video_zoom()
        elif self.orig:
            self.set_fit("window")

    def toggle_fullscreen(self):
        entering_fullscreen = not self.attributes("-fullscreen")
        self.attributes("-fullscreen", entering_fullscreen)
        if entering_fullscreen:
            self._video_fs_fit = True  # 每次进入全屏都重新自动铺满
            self._hide_ui()
        else:
            self._show_ui()
        if self.is_video and self.player:
            self._apply_region_zoom()
            # 全屏切换后，视频可能不自动适应新尺寸，稍后重设一次 hwnd 让 VLC 重新适配
            self.after(250, self._refresh_video_hwnd)
            # 字幕窗口是独立置顶 Toplevel，全屏会打乱 z-order，重新置顶抬升
            self.after(300, self._raise_caption_window)

    def _refresh_video_hwnd(self):
        if (self.is_video and self.player and not self._video_is_stopping()
                and self.video_panel.winfo_manager()):
            try:
                self.player.set_hwnd(self.video_panel.winfo_id())
                self._apply_region_zoom()  # set_hwnd 后重新应用裁剪/缩放，确保铺满与区域放大不丢失
            except Exception:
                pass
            # set_hwnd 重建原生子窗口后，重新设为鼠标穿透
            self.after(300, self._make_video_window_transparent)

    def _pack_thumbs(self):
        """打包缩略图条；status 可能已被 pack_forget（隐藏 UI / 视频沉浸模式），
        此时 before=status 会抛 TclError，需先把 status 放回去（保证 status 在最底部）。"""
        if self._ui_hidden:
            return  # _show_ui 恢复时会处理
        if not self.status.winfo_manager():
            self.status.pack(side="bottom", fill="x")
        self.thumbs_frame.pack(side="bottom", fill="x", before=self.status)

    def _thumbs_hide_for_video(self):
        """视频播放时隐藏缩略图条（保留 _thumbs_visible 偏好，退出视频后恢复）。"""
        if self.thumbs_frame.winfo_manager():
            self.thumbs_frame.pack_forget()

    def _thumbs_restore(self):
        """图片页按用户偏好恢复缩略图条。"""
        if self._thumbs_visible and not self.thumbs_frame.winfo_manager():
            self._pack_thumbs()

    def toggle_thumbs(self):
        if self.is_video:
            return  # 视频页不显示缩略图条
        if self._thumbs_visible:
            # 关闭缩略图：隐藏条，清空图形
            self._thumbs_visible = False
            self.thumbs_frame.pack_forget()
            self._cancel_thumbnail_build()
            self._thumb_photos = []
            self._thumb_rects = []
        else:
            # 打开缩略图：重建
            self._thumbs_visible = True
            self._pack_thumbs()
            self._build_thumbnails()

    def _hide_ui(self):
        """隐藏全部 UI（工具栏 / 状态栏 / 缩略图 / 视频条 / 浮动菜单），仅保留画面内容。"""
        self._click_tick = 0
        if self.toolbar_outer.winfo_manager():
            self.toolbar_outer.pack_forget()
        self.status.pack_forget()
        self.thumbs_frame.pack_forget()
        self.video_bar.pack_forget()
        self._ov_top_show(False)
        # 切换内容区：视频面/画布互斥显示
        if self.is_video and self.video_panel.winfo_manager():
            self.video_panel.pack(side="top", fill="both", expand=True)
        else:
            self.video_panel.pack_forget()
            self.canvas.pack(side="top", fill="both", expand=True)
        self._ui_hidden = True

    def _show_ui(self):
        """恢复 UI：图片页恢复 docked 布局；视频页顶部用浮动菜单、底部恢复控制条。"""
        if not self._ui_hidden:
            return
        self._ui_hidden = False
        if self.is_video:
            if self._autohide_enabled:
                self._enter_video_chrome()
                self._ov_top_show(True)
            else:
                self._exit_video_chrome()
            if not self.status.winfo_manager():
                self.status.pack(side="bottom", fill="x")
            if not self.video_bar.winfo_manager():
                self.video_bar.pack(side="bottom", fill="x", before=self.status)
            self._autohide_last_show = time.time()
            self._autohide_hidden = False
            if self.video_panel.winfo_manager():
                self.after(160, self._after_ui_ready)
            return
        if not self.toolbar_outer.winfo_manager():
            self.toolbar_outer.pack(side="top", fill="x", before=self.content)
        self.status.pack(side="bottom", fill="x")
        if self._thumbs_visible:
            self.thumbs_frame.pack(side="bottom", fill="x", before=self.status)
        if self.canvas.winfo_manager():
            self.after(160, self._after_ui_ready)

    def _after_ui_ready(self):
        """UI 恢复、布局稳定后，按进入隐藏前的状态重做适配。"""
        if self.is_video:
            self._refresh_video_hwnd()
        else:
            self._do_resize()

    # ---------------- 事件 ----------------
    def _is_rtl(self):
        return self.reading_direction == "rtl"

    def _on_press(self, e):
        self._drag = dict(x=e.x, y=e.y, panx=self.pan_x, pany=self.pan_y,
                          moved=False, start=time.time())

    def _on_motion(self, e):
        if not self._drag:
            return
        dx = e.x - self._drag["x"]
        dy = e.y - self._drag["y"]
        if abs(dx) + abs(dy) > 4:
            self._drag["moved"] = True
        self.pan_x = self._drag["panx"] + dx
        self.pan_y = self._drag["pany"] + dy
        self._reposition()

    def _on_release(self, e):
        if not self._drag:
            return
        moved = self._drag["moved"]
        start = self._drag.get("start", 0)
        sx, sy = self._drag["x"], self._drag["y"]
        self._drag = None
        if moved:
            self._clamp_pan()
            self._reposition()
            # 快速左右滑动 => 翻页（方向随阅读方向）
            dt = (time.time() - start) * 1000
            dx = e.x - sx
            dy = e.y - sy
            if dt < 320 and abs(dx) > 60 and abs(dx) > abs(dy) * 1.5:
                forward = (dx > 0) if self._is_rtl() else (dx < 0)
                (self.next if forward else self.prev)()
            return
        # 未移动 => 点击（边缘翻页，方向随阅读方向）
        cw = max(self.canvas.winfo_width(), 1)
        if self._is_rtl():
            left, right = self.next, self.prev
        else:
            left, right = self.prev, self.next
        if e.x < cw * 0.18:
            left()
            return
        if e.x > cw * 0.82:
            right()
            return
        if self.is_video:
            self._toggle_play()
            return
        # 中间区域：延迟执行，以便与双击区分
        if self._click_after:
            self.after_cancel(self._click_after)
        self._click_after = self.after(260, self._toggle_toolbar)

    def _on_double(self, e):
        if self._click_after:
            self.after_cancel(self._click_after)
            self._click_after = None
        if not self.orig:
            return
        if self.fit_mode == "custom":
            self.set_fit("window")
        else:
            self.set_fit("actual")

    def _toggle_toolbar(self):
        if self.toolbar_outer.winfo_manager():
            self.toolbar_outer.pack_forget()
        else:
            self.toolbar_outer.pack(side="top", fill="x", before=self.content)

    def _on_wheel(self, e):
        # 垂直滚动 / 触控板上下滑 / 捏合(Ctrl+滚轮) => 缩放
        factor = math.exp(e.delta * 0.0015)
        self.zoom_at(e.x, e.y, factor)

    def _on_hwheel(self, e):
        # 触控板左右滑 / 水平滚轮 => 翻页（去抖）
        self._haccum += e.delta
        if self._haccum_timer:
            self.after_cancel(self._haccum_timer)
        self._haccum_timer = self.after(180, lambda: setattr(self, "_haccum", 0))
        if abs(self._haccum) >= 60:
            self._haccum = 0
            if self._haccum_timer:
                self.after_cancel(self._haccum_timer)
                self._haccum_timer = None
            forward = (e.delta < 0) if self._is_rtl() else (e.delta > 0)
            (self.next if forward else self.prev)()

    def _on_video_wheel(self, e):
        # 视频页：滚轮 => 音量；区域放大模式下 => 缩放放大框大小
        if e.state & 0x0004:
            return
        if self.rz.enabled:
            self._rz_zoom_step(-0.1 if e.delta > 0 else 0.1)
        else:
            self._apply_video_wheel(e.delta)

    def _apply_video_wheel(self, delta):
        if not self.is_video:
            return
        step = 5 if delta > 0 else -5
        new = clamp(self.vol.get() + step, 0, 100)
        self.vol.set(new)
        self._on_volume(new)

    def _on_video_hwheel(self, e):
        self._apply_video_hwheel(e.delta)

    def _apply_video_hwheel(self, delta):
        # 视频页：触控板左右滑 => 快进 / 快退（去抖，每 120 单位 = 5 秒）
        if not self.is_video or not self.player:
            return
        self._hseek_accum += delta
        if self._hseek_timer:
            self.after_cancel(self._hseek_timer)
        self._hseek_timer = self.after(200, self._reset_hseek)
        while abs(self._hseek_accum) >= 120:
            direction = 1 if self._hseek_accum > 0 else -1
            self._seek_relative(direction * 5)
            self._hseek_accum -= direction * 120

    def _reset_hseek(self):
        self._hseek_timer = None
        self._hseek_accum = 0

    def _seek_relative(self, seconds):
        if not self.player or not self.is_video:
            return
        try:
            length = self.player.get_length()
            if length <= 0:
                return
            cur = self.player.get_time()
            self.player.set_time(clamp(cur + int(seconds * 1000), 0, length))
            self._last_seek = time.time()
            if self._captioner is not None:
                self._captioner.reset()
        except Exception:
            pass

    def _on_video_press(self, e):
        # 区域放大模式：开始拖拽平移放大框；否则单击 => 播放 / 暂停
        if not self.is_video:
            return
        if self.rz.enabled:
            self._rz_drag = dict(x=e.x, y=e.y, cx=self.rz.cx, cy=self.rz.cy, moved=False)
        else:
            self._toggle_play()

    def _on_video_motion(self, e):
        if not (self.is_video and self.rz.enabled and self._rz_drag):
            return
        dx = e.x - self._rz_drag["x"]
        dy = e.y - self._rz_drag["y"]
        if abs(dx) + abs(dy) > 3:
            self._rz_drag["moved"] = True
        pw = max(self.video_panel.winfo_width(), 1)
        ph = max(self.video_panel.winfo_height(), 1)
        self.rz.cx = self._rz_drag["cx"] + dx / pw
        self.rz.cy = self._rz_drag["cy"] + dy / ph
        self.rz.clamp_center()
        self._apply_region_zoom()

    def _on_video_release(self, e):
        self._rz_drag = None

    def _rz_pan_key(self, k):
        """区域放大模式下用方向键 / WASD 平移放大框（键盘可靠，不受 VLC 原生窗口影响）。"""
        step = 0.1
        if k in ("Left", "a", "A"):
            self.rz.pan(-step, 0)
        elif k in ("Right", "d", "D"):
            self.rz.pan(step, 0)
        elif k in ("Up", "w", "W"):
            self.rz.pan(0, -step)
        elif k in ("Down", "s", "S"):
            self.rz.pan(0, step)
        self._apply_region_zoom()
        self._update_status()

    def _on_key(self, e):
        w = self.focus_get()
        # 只保护对话框(Toplevel)里的输入框；主窗口里的组合框等不拦截快捷键
        if isinstance(w, (tk.Entry, tk.Text)) and w.winfo_toplevel() is not self:
            return
        k = e.keysym
        if self.is_video and self.rz.enabled and k in ("Left", "Right", "Up", "Down", "w", "W", "a", "A", "s", "S", "d", "D"):
            self._rz_pan_key(k)
        elif self.is_video and k in ("Left", "Right"):
            self._seek_relative((30 if (e.state & 0x0004) else 5) * (1 if k == "Right" else -1))
        elif k in ("Right", "Next"):
            self.next()
        elif k == "space":
            if self.is_video:
                self._toggle_play()
            else:
                self.next()
        elif k in ("Left", "Prior"):
            self.prev()
        elif k in ("plus", "equal"):
            self.zoom_in()
        elif k in ("minus", "underscore"):
            self.zoom_out()
        elif k == "0":
            self.set_fit("window")
        elif k == "1":
            self.set_fit("actual")
        elif k == "2":
            self.set_fit("width")
        elif k == "3":
            self.set_fit("height")
        elif k in ("r", "R"):
            self.rotate(-90 if (e.state & 0x0001) else 90)
        elif k in ("d", "D"):
            self.toggle_spread()
        elif k in ("m", "M"):
            self.toggle_direction()
        elif k in ("c", "C"):
            self.toggle_trim()
        elif k in ("b", "B"):
            self.toggle_book_filter()
        elif k in ("s", "S"):
            if self.is_video:
                self._choose_subtitle()
        elif k in ("p", "P", "Print"):
            if self.is_video:
                self._video_screenshot()
        elif k in ("e", "E"):
            if self.is_video:
                self.open_video_adjust()
        elif k in ("z", "Z"):
            self.toggle_region_zoom()
        elif k in ("a", "A"):
            self.toggle_auto()
        elif k == "bracketleft":
            self.adjust_auto_interval(-0.5)
        elif k == "bracketright":
            self.adjust_auto_interval(0.5)
        elif k in ("g", "G"):
            self.jump_to_page()
        elif k in ("Return", "KP_Enter"):
            self.toggle_fullscreen()
        elif k in ("f", "F"):
            self.toggle_fullscreen()
        elif k in ("t", "T"):
            self.toggle_thumbs()
        elif k == "Home":
            self.show_file(0)
        elif k == "End":
            self.show_file(len(self.sources) - 1)
        elif k == "question":
            self.show_help()
        elif k == "Escape":
            if self.attributes("-fullscreen"):
                self.toggle_fullscreen()

    def _on_resize(self, e):
        if self._resize_after:
            self.after_cancel(self._resize_after)
        self._resize_after = self.after(120, self._do_resize)

    def _do_resize(self):
        self._resize_after = None
        if not self.orig:
            if not self.is_video:
                self._show_start(icon=not self._emoji_pending)
            return
        if self.fit_mode != "custom":
            self._render()
        else:
            self._clamp_pan()
            self._reposition()

    # ---------------- 缩略图 ----------------
    def _build_thumbnails(self):
        self._cancel_thumbnail_build()
        self.thumbs.delete("all")
        self._thumb_photos = []
        self._thumb_rects = []
        self._thumb_build_sources = list(self.sources)
        self._thumb_build_index = 0
        self._thumb_build_x = 6
        self._rthumb_gen += 1
        self._rthumb_jobs = queue.Queue()
        self._rthumb_pending = 0
        self._thumb_build_after = self.after_idle(self._build_thumbnail_batch)

    def _cancel_thumbnail_build(self):
        after_id = getattr(self, "_thumb_build_after", None)
        if after_id:
            self.after_cancel(after_id)
            self._thumb_build_after = None

    # ---- 远程图片缩略图（后台线程取图，界面线程只负责贴图） ----
    _RTHUMB_W = 96

    def _thumb_async_placeholder(self, i, x, H, Y, W, glyph):
        """占位块：先画深色底 + 图标，后台线程出图后在 _rthumb_poll 里替换。"""
        self._thumb_photos.append(None)
        self.thumbs.create_rectangle(x, Y - H / 2, x + W, Y + H / 2, fill="#1b1e24",
                                     tags=("thumb", "t%d" % i, "rp%d" % i))
        self.thumbs.create_text(x + W / 2, Y, text=glyph, fill="#5a6472",
                                font=("Segoe UI", 18), tags=("thumb", "t%d" % i, "rp%d" % i))
        self._thumb_rects.append((x, x + W))
        self._thumb_build_x += W + 8

    def _rthumb_submit(self, i, provider, src):
        """提交一个后台缩略图任务（provider 为 None 表示本地 zip 内文件）。"""
        self._rthumb_jobs.put((i, provider, src))
        self._rthumb_pending += 1
        if self._rthumb_started_gen != self._rthumb_gen:
            self._rthumb_started_gen = self._rthumb_gen
            threading.Thread(target=self._rthumb_worker,
                             args=(self._rthumb_gen, self._rthumb_jobs), daemon=True).start()
        if self._rthumb_poll_after is None:
            self._rthumb_poll_after = self.after(100, self._rthumb_poll)

    def _thumb_remote_tile(self, i, src, x, H, Y):
        self._thumb_async_placeholder(i, x, H, Y, self._RTHUMB_W, "▣")
        provider = self._get_provider(src.provider)
        if not provider or src.is_dir:
            return
        self._rthumb_submit(i, provider, src)

    def _thumb_local_archive_tile(self, i, src, x, H, Y):
        """本地 zip/cbz 内文件：后台线程独立打开压缩包解出缩略图，不卡界面。"""
        self._thumb_async_placeholder(i, x, H, Y, self._RTHUMB_W, "▤")
        self._rthumb_submit(i, None, src)

    def _thumb_rar_placeholder(self, i, x, H, Y):
        """rar/cbr 固实压缩解压任意一个文件都要从头解包，缩略图不做，
        只放静态占位块（点击仍可跳转到对应页）。"""
        W = 80
        self._thumb_photos.append(None)
        self.thumbs.create_rectangle(x, Y - H / 2, x + W, Y + H / 2, fill="#1b1e24",
                                     tags=("thumb", "t%d" % i))
        self.thumbs.create_text(x + W / 2, Y, text="RAR", fill="#5a6472",
                                font=("Segoe UI", 9, "bold"), tags=("thumb", "t%d" % i))
        self._thumb_rects.append((x, x + W))
        self._thumb_build_x += W + 8

    def _rthumb_worker(self, gen, jobs):
        while gen == self._rthumb_gen:
            try:
                i, provider, src = jobs.get(timeout=0.5)
            except queue.Empty:
                if self._thumb_build_after is None:   # 缩略图条已建完且任务耗尽
                    return
                continue
            im = None
            try:
                if provider is not None:
                    data = provider.fetch_image(src, self._RTHUMB_W * 2)
                    if data:
                        im = Image.open(io.BytesIO(data))
                else:
                    # 本地 zip/cbz 内文件：独立打开压缩包（不共享主线程的 self._zip）
                    z = self._open_archive(src[0])
                    try:
                        data = z.read(src[1])
                    finally:
                        z.close()
                    im = Image.open(io.BytesIO(data))
                if im is not None:
                    im.thumbnail((self._RTHUMB_W, 70))
                    if im.mode not in ("RGB", "RGBA", "L"):
                        im = im.convert("RGB")
                    im.load()
            except Exception:
                im = None
            self._rthumb_results.put((gen, i, im))

    def _rthumb_poll(self):
        self._rthumb_poll_after = None
        try:
            while True:
                gen, i, im = self._rthumb_results.get_nowait()
                if gen != self._rthumb_gen:
                    continue
                self._rthumb_pending -= 1
                if im is None or i >= len(self._thumb_photos):
                    continue
                try:
                    ph = ImageTk.PhotoImage(im)
                except Exception:
                    continue
                self._thumb_photos[i] = ph
                x0, x1 = self._thumb_rects[i]
                self.thumbs.delete("rp%d" % i)
                self.thumbs.create_image((x0 + x1) / 2, 48, image=ph, anchor="center",
                                         tags=("thumb", "t%d" % i))
        except queue.Empty:
            pass
        if self._rthumb_pending > 0:
            self._rthumb_poll_after = self.after(100, self._rthumb_poll)

    def _build_thumbnail_batch(self):
        if not self._thumbs_visible or self._thumb_build_sources != self.sources:
            self._thumb_build_after = None
            return

        H, Y = 70, 48
        batch_end = min(self._thumb_build_index + 8, len(self._thumb_build_sources))
        for i in range(self._thumb_build_index, batch_end):
            src = self._thumb_build_sources[i]
            x = self._thumb_build_x
            if self._is_video(src) or self._is_audio(src):
                self._thumb_photos.append(None)
                self.thumbs.create_rectangle(x, Y - H / 2, x + 80, Y + H / 2,
                                             fill="#1b1e24", tags=("thumb", "t%d" % i))
                glyph = "▶" if self._is_video(src) else "♪"
                self.thumbs.create_text(x + 40, Y, text=glyph, fill=ACCENT,
                                        font=("Segoe UI", 18), tags=("thumb", "t%d" % i))
                self._thumb_rects.append((x, x + 80))
                self._thumb_build_x += 80 + 8
                continue
            if isinstance(src, RemoteSource):
                # 远程图片不在界面线程里下载：先放占位块，后台线程取到缩略图再替换
                self._thumb_remote_tile(i, src, x, H, Y)
                continue
            if isinstance(src, tuple) and not self._is_pdf_src(src):
                # 本地压缩包内文件：rar/cbr 固实解压慢，降级为占位块；zip/cbz 后台生成
                if os.path.splitext(src[0])[1].lower() in RAR_EXTS:
                    self._thumb_rar_placeholder(i, x, H, Y)
                else:
                    self._thumb_local_archive_tile(i, src, x, H, Y)
                continue
            ph = None
            try:
                im = self._open_raw(src)
                im.thumbnail((200, H))
                if im.mode not in ("RGB", "RGBA", "L"):
                    im = im.convert("RGB")
                ph = ImageTk.PhotoImage(im)
            except Exception:
                pass
            self._thumb_photos.append(ph)
            if ph:
                self.thumbs.create_image(x + ph.width() / 2, Y, image=ph,
                                         anchor="center", tags=("thumb", "t%d" % i))
                w = ph.width()
            else:
                self.thumbs.create_rectangle(x, Y - H / 2, x + 48, Y + H / 2,
                                             fill="#333", tags=("thumb", "t%d" % i))
                w = 48
            self._thumb_rects.append((x, x + w))
            self._thumb_build_x += w + 8

        self._thumb_build_index = batch_end
        self.thumbs.configure(scrollregion=(0, 0, self._thumb_build_x + 6, 96))
        if batch_end < len(self._thumb_build_sources):
            self._thumb_build_after = self.after_idle(self._build_thumbnail_batch)
        else:
            self._thumb_build_after = None

    def _on_thumb_click(self, e):
        cx = self.thumbs.canvasx(e.x)
        for i, (x0, x1) in enumerate(self._thumb_rects):
            if x0 <= cx <= x1:
                self.show_file(i)
                return

    def _highlight_thumb(self):
        self.thumbs.delete("hl")
        idxs = [self.index]
        if self._spread_img is not None and self.index + 1 < len(self._thumb_rects):
            idxs.append(self.index + 1)
        first = None
        for i in idxs:
            if 0 <= i < len(self._thumb_rects):
                x0, x1 = self._thumb_rects[i]
                self.thumbs.create_rectangle(x0 - 2, 10, x1 + 2, 86,
                                             outline=ACCENT, width=2, tags="hl")
                if first is None:
                    first = x0
        if first is not None:
            total = self.thumbs.bbox("all")
            if total:
                self.thumbs.xview_moveto(max(0.0, (first - 20) / total[2]))

    # ---------------- 信息 ----------------
    def show_details(self):
        if not self.sources:
            return
        src = self.sources[self.index]
        if isinstance(src, RemoteSource):
            if src.is_dir:
                kind = "目录"
            elif src.kind == "audio":
                kind = "音频"
            elif src.kind == "video":
                kind = "视频"
            else:
                kind = "图片"
            details = [
                "文件名: " + src.name,
                "来源: " + src.provider,
                "远程路径: " + src.path,
            ]
            if src.size:
                details.append("大小: %s（%d 字节）" % (self._fmt_size(src.size), src.size))
            details.append("类型: " + kind)
            messagebox.showinfo("详细信息", "\n".join(details), parent=self)
            return
        name = self._display_name(src)
        details = ["文件名: " + name]
        if isinstance(src, tuple):
            details.append("来源: " + src[0])
            if self._is_pdf_src(src):
                details.append("页码: 第 %d 页（共 %d 页）" % (src[1] + 1, self._pdf_page_count(src[0]) or 0))
            else:
                details.append("压缩包条目: " + src[1])
        else:
            try:
                details.append("路径: " + os.path.abspath(src))
                details.append("大小: %s 字节" % os.path.getsize(src))
            except OSError:
                pass

        if self._is_video(src):
            duration = None
            path = self._video_path(src)
            if path and self._ensure_vlc():
                try:
                    media = self.vlc_instance.media_new(path)
                    media.parse()
                    duration = media.get_duration()
                except Exception:
                    pass
            details.append("类型: 视频")
            if duration is not None and duration >= 0:
                details.append("时长: " + self._fmt_time(duration))
        else:
            try:
                with self._open_raw(src) as image:
                    details.extend([
                        "类型: " + (image.format or "未知"),
                        "尺寸: %d × %d" % image.size,
                        "颜色模式: " + image.mode,
                    ])
                    exif = image.getexif()
                    for tag, value in exif.items():
                        tag_name = ExifTags.TAGS.get(tag, str(tag))
                        details.append("EXIF %s: %s" % (tag_name, value))
            except Exception as error:
                details.append("无法读取图像元数据: %s" % error)
        messagebox.showinfo("详细信息", "\n".join(details), parent=self)

    def _update_status(self):
        if not self.sources:
            return
        self._sync_zoom_slider()
        if self.is_video:
            name = self._display_name(self.sources[self.index])
            is_audio = self._is_audio(self.sources[self.index])
            self.page_label.configure(text="%d / %d" % (self.index + 1, len(self.sources)))
            if is_audio:
                self.zoom_label.configure(text="音频")
                self.zoom_out_btn.configure(state="disabled")
                self.zoom_in_btn.configure(state="disabled")
                self.status.configure(text=self._chapter_prefix() + name + "   ·   音频")
            else:
                self.zoom_label.configure(text="画面 %d%%" % round(self._video_zoom * 100))
                self.zoom_out_btn.configure(state="normal")
                self.zoom_in_btn.configure(state="normal")
                self.status.configure(text=self._chapter_prefix() + name + "   ·   视频   ·   画面 %d%%" % round(self._video_zoom * 100))
            return
        name = self._chapter_prefix() + self._display_name(self.sources[self.index])
        if self._spread_img is not None:
            name += " + " + self._display_name(self.sources[self.index + 1])
            page = "%d-%d / %d" % (self.index + 1, self.index + 2, len(self.sources))
        else:
            page = "%d / %d" % (self.index + 1, len(self.sources))
        w, h = self._rotated_size()
        rot = (" · 旋转 %d°" % self.rotation) if self.rotation else ""
        rtl = " · 右→左" if self._is_rtl() else ""
        auto = (" · 自动翻页 %gs" % self.auto_interval) if self.auto_flip else ""
        book = " · 纸质" if self.book_filter else ""
        self.page_label.configure(text=page)
        self.zoom_label.configure(text="%d%%" % int(round(self.zoom * 100)))
        self.zoom_out_btn.configure(state="normal")
        self.zoom_in_btn.configure(state="normal")
        self.status.configure(text="%s   ·   %d×%d   ·   %d%%%s%s%s%s" % (
            name, w, h, int(round(self.zoom * 100)), rot, rtl, auto, book))

    def _show_start(self, icon=True):
        self.canvas.delete("all")
        cw = max(self.canvas.winfo_width(), 200)
        ch = max(self.canvas.winfo_height(), 120)
        self.canvas.create_text(cw / 2, ch / 2 - 30, text=("🖼 " if icon else "") + "图片 / 漫画浏览器",
                                fill=FG, font=("Microsoft YaHei", 22, "bold"))
        self.canvas.create_text(cw / 2, ch / 2 + 10,
                                text="打开文件夹 / 图片 / zip·cbz·rar·cbr 压缩包 / 视频开始阅读（竖图可双页并排显示）",
                                fill=MUTED, font=("Microsoft YaHei", 12))
        self.canvas.create_text(cw / 2, ch / 2 + 44,
                                text="← → 翻页 · 滚轮缩放 · R 旋转 · D 双页 · M 方向 · C 去边 · G 跳页 · A 自动 · ? 帮助",
                                fill="#6b7280", font=("Microsoft YaHei", 11))

    def show_help(self):
        win = tk.Toplevel(self)
        win.title("帮助")
        win.configure(bg="#1a1d24")
        win.transient(self)
        win.geometry("600x620")
        txt = (
            "键盘与操作说明\n\n"
            "← / → / PageUp / PageDown      上一页 / 下一页\n"
            "空格（图片页）/ Home / End      下一页 / 第一页 / 最后一页\n"
            "滚轮 / 触控板上下滑             缩放（以鼠标为中心）\n"
            "触控板捏合（Ctrl+滚轮）          缩放\n"
            "触控板左右滑                   翻页（方向随阅读方向）\n"
            "工具栏缩放滑块                   拖拽调整缩放百分比\n"
            "点击缩放百分比                   重置（图片：适应窗口 / 视频：100%）\n"
            "+ / -                          放大 / 缩小\n"
            "拖拽                           平移图片\n"
            "快速左右滑动                   翻页（方向随阅读方向）\n"
            "点击画面左 / 右边缘             翻页（方向随阅读方向）\n"
            "点击画面中间                    显示 / 隐藏工具栏\n"
            "双击画面中间                    适应窗口 <-> 实际大小\n"
            "视频页：空格 / 点击画面中间      播放 / 暂停\n"
            "视频页：播放时自动隐藏菜单/工具栏，鼠标移到上/下边缘显示（视图菜单可开关）\n"
            "视频页：P / 截图按钮             截图（多帧合成，更清晰）\n"
            "视频页：播放完自动              跳到下一张\n"
            "R / Shift+R                    旋转 90°（图片与视频都支持）\n"
            "E                              视频：画面调节（亮度/对比度/饱和度/色相/伽马）\n"
            "Z                              视频：区域放大（方向键/WASD 平移，滚轮/+/- 缩放，再按 Z 退出）\n"
            "0 / 1 / 2 / 3                  适应窗口 / 实际大小 / 适应宽度 / 适应高度\n"
            "D                              双页模式 开 / 关（竖图并排显示两张）\n"
            "M                              阅读方向 左→右 / 右→左（日漫）\n"
            "C                              裁白边 开 / 关\n"
            "G                              跳到指定页\n"
            "A                              自动翻页 开 / 关\n"
            "[ / ]                          自动翻页每页停留时间 - / + 0.5 秒\n"
            "回车 / F / F11                 全屏\n"
            "T                              显示 / 隐藏缩略图\n"
            "?                              帮助\n"
            "Esc                            退出全屏\n"
            "\n"
            "支持：文件夹 / 多张图片 / zip·cbz·rar·cbr 压缩包。\n"
            "支持：mp4 / mkv / avi / webm 等视频（内嵌播放，需 VLC）。\n"
            "自动记忆每本书的阅读进度、双页、方向、去边设置。\n"
        )
        tk.Label(win, text=txt, justify="left", anchor="w", bg="#1a1d24", fg=FG,
                 font=("Consolas", 11), padx=20, pady=20).pack(fill="both", expand=True)
        tk.Button(win, text="关闭", command=win.destroy, bg=BTN_BG, fg=FG,
                  activebackground=BTN_ACTIVE, relief="flat", padx=16, pady=6,
                  cursor="hand2").pack(pady=(0, 14))


def main():
    # 原生崩溃（非法指令/访问越界等）时把各线程 Python 栈写入 crash.log，便于定位。
    try:
        import faulthandler
        crash_log = os.path.join(os.path.dirname(os.path.abspath(__file__)), "crash.log")
        faulthandler.enable(file=open(crash_log, "a", encoding="utf-8"))
    except Exception:
        pass
    app = ComicViewer()
    app.mainloop()


if __name__ == "__main__":
    main()
