# -*- coding: utf-8 -*-
"""
图片 / 漫画浏览器（桌面版）
依赖：tkinter（自带）+ Pillow
安装 Pillow： pip install Pillow

支持：文件夹 / 多张图片 / zip·cbz 压缩包；双页模式；日漫右→左方向；
断点续读；跳到指定页；自动裁白边；视频播放（mp4 等，需 VLC）。

快捷键：
  ← → / PageUp / PageDown          翻页
  空格（图片页）                    下一页
  空格（视频页）                    播放 / 暂停
  滚轮 / 触控板上下滑               缩放（以鼠标为中心）
  触控板捏合（Ctrl+滚轮）            缩放
  触控板左右滑                      翻页
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
import sys
import re
import math
import time
import json
import queue
import hashlib
import zipfile
import tempfile
import shutil
import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog, ttk

try:
    from PIL import Image, ImageTk
    RESAMPLE = Image.Resampling.LANCZOS
except ImportError:
    print("缺少 Pillow 库，请先安装： pip install Pillow")
    sys.exit(1)

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".avif", ".jfif"}
ZIP_EXTS = {".zip", ".cbz"}
VIDEO_EXTS = {".mp4", ".mkv", ".avi", ".webm", ".mov", ".wmv", ".flv", ".m4v", ".ts", ".mpg", ".mpeg", ".3gp"}

CAPTION_LANGS = ["中文", "英文", "日语"]
CAPTION_LANG_CODES = {"中文": "zh", "英文": "en", "日语": "ja"}
CAPTION_MODES = ["原声", "中文翻译"]
CAPTION_MODE_CODES = {"原声": "original", "中文翻译": "translate"}

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "image_viewer.json")

BG = "#14161a"
PANEL = "#1d2026"
BTN_BG = "#262a33"
BTN_ACTIVE = "#313741"
FG = "#e7e9ee"
MUTED = "#9aa2b1"
ACCENT = "#4c8dff"

MIN_ZOOM, MAX_ZOOM = 0.02, 40.0
MIN_VISIBLE = 60  # 平移时至少保留的可见像素


def natural_key(s):
    """自然排序：让 page2 排在 page10 之前。"""
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def clamp(v, a, b):
    return min(max(v, a), b)


class ComicViewer(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("图片 / 漫画浏览器")
        self.geometry("1250x820")
        self.configure(bg=BG)

        self.sources = []          # 页面来源：路径(str) 或 (压缩包路径, 条目名)
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
        self.book_key = None       # 断点续读的书籍标识
        self._config = self._load_config()

        self.orig = None
        self.display = None
        self.photo = None
        self.canvas_img = None

        self._drag = None
        self._click_after = None
        self._click_tick = 0         # 单次点击的毫秒时间戳，用于单击/双击判定
        self._resize_after = None
        self._haccum = 0
        self._haccum_timer = None
        self._ui_hidden = False      # 是否进入沉浸式（全部 UI：工具栏/状态栏/缩略图/视频条都隐藏）
        self._dbl_click = False      # 本次点击是否为双击
        self._dbl_tick = 0           # 双击判定时间戳（毫秒）
        self._dbl_pos = None         # (x, y) 点击位置
        self._thumbs_visible = None   # 缩略图是否可见（None=尚未载入过）
        self._video_bar_visible = None
        self._thumb_photos = []
        self._thumb_rects = []

        self.is_video = False
        self.vlc = None
        self.vlc_instance = None
        self.player = None
        self._video_timer = None
        self._video_ended = False
        self._last_seek = 0.0
        self._updating_seek = False
        self._video_cache = {}
        self._tmp_dir = tempfile.mkdtemp(prefix="image_viewer_")

        self.caption_enabled = False
        self._captioner = None
        self._caption_poll_after = None
        self._caption_await_after = None

        self._build_ui()
        self._bind_events()
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.after(120, self._show_start)

    # ---------------- UI ----------------
    def _build_ui(self):
        # 顶部工具栏（可横向滚动，避免按钮过多溢出）
        self.toolbar_outer = tk.Frame(self, bg=PANEL)
        self.toolbar_outer.pack(side="top", fill="x")
        self.toolbar_canvas = tk.Canvas(self.toolbar_outer, bg=PANEL, height=46,
                                        highlightthickness=0, bd=0)
        self.toolbar_scroll = tk.Scrollbar(self.toolbar_outer, orient="horizontal",
                                           command=self.toolbar_canvas.xview, width=10)
        self.toolbar_canvas.configure(xscrollcommand=self.toolbar_scroll.set)
        self.toolbar_canvas.pack(side="top", fill="x")
        self.toolbar_scroll.pack(side="bottom", fill="x")
        self.toolbar = tk.Frame(self.toolbar_canvas, bg=PANEL, padx=8, pady=6)
        self._toolbar_win = self.toolbar_canvas.create_window((0, 0), window=self.toolbar, anchor="nw")
        self.toolbar.bind("<Configure>", lambda e: self.toolbar_canvas.configure(
            scrollregion=self.toolbar_canvas.bbox("all")))
        self.toolbar_canvas.bind("<MouseWheel>", lambda e: self.toolbar_canvas.xview_scroll(int(-e.delta / 120), "units"))
        self.toolbar_canvas.bind("<Shift-MouseWheel>", lambda e: self.toolbar_canvas.xview_scroll(int(-e.delta / 120), "units"))

        self._btn(self.toolbar, "📂 打开文件夹", self.open_folder, primary=True)
        self._btn(self.toolbar, "🖼 打开图片", self.open_files)
        self._btn(self.toolbar, "📦 压缩包", self.open_zip, tip="打开 zip / cbz")
        self._sep(self.toolbar)
        self._btn(self.toolbar, "⏮", self.prev, tip="上一页")
        self.page_label = tk.Label(self.toolbar, text="0 / 0", bg=PANEL, fg=FG, width=10)
        self.page_label.pack(side="left", padx=4)
        self._btn(self.toolbar, "⏭", self.next, tip="下一页")
        self._btn(self.toolbar, "跳页", self.jump_to_page, tip="跳到指定页 (G)")
        self.auto_btn = self._state_btn(self.toolbar, "自动", self.toggle_auto)
        self._sep(self.toolbar)
        self._btn(self.toolbar, "↺", lambda: self.rotate(-90), tip="逆时针旋转")
        self._btn(self.toolbar, "↻", lambda: self.rotate(90), tip="顺时针旋转")
        self._sep(self.toolbar)
        self._btn(self.toolbar, "➖", lambda: self.zoom_center(0.8), tip="缩小")
        self.zoom_label = tk.Label(self.toolbar, text="100%", bg=PANEL, fg=MUTED, width=6)
        self.zoom_label.pack(side="left", padx=4)
        self._btn(self.toolbar, "➕", lambda: self.zoom_center(1.25), tip="放大")
        self._sep(self.toolbar)
        self._btn(self.toolbar, "适应窗口", lambda: self.set_fit("window"))
        self._btn(self.toolbar, "适应宽度", lambda: self.set_fit("width"))
        self._btn(self.toolbar, "适应高度", lambda: self.set_fit("height"))
        self._btn(self.toolbar, "100%", lambda: self.set_fit("actual"))
        self._sep(self.toolbar)
        # 带状态的开关按钮
        self.spread_btn = self._state_btn(self.toolbar, "双页", self.toggle_spread)
        self.dir_btn = self._state_btn(self.toolbar, "左→右", self.toggle_direction)
        self.trim_btn = self._state_btn(self.toolbar, "去边", self.toggle_trim)
        self._sep(self.toolbar)
        self._btn(self.toolbar, "▤", self.toggle_thumbs, tip="缩略图 (T)")
        self._btn(self.toolbar, "⛶", self.toggle_fullscreen, tip="全屏 (F)")
        self._btn(self.toolbar, "?", self.show_help, tip="帮助")

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
        self.play_btn = tk.Button(self.video_bar, text="⏸", command=self._toggle_play, takefocus=0,
                                  bg=BTN_BG, fg=FG, activebackground=BTN_ACTIVE, activeforeground="#fff",
                                  relief="flat", bd=0, width=4, cursor="hand2", font=("Segoe UI", 11))
        self.play_btn.pack(side="left", padx=2)
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
        self.caption_btn = self._state_btn(self.video_bar, "CC 字幕", self.toggle_captions)
        self.caption_lang_var = tk.StringVar(value="英文")
        self.caption_lang_combo = ttk.Combobox(self.video_bar, textvariable=self.caption_lang_var,
                                               values=CAPTION_LANGS, state="readonly", width=5)
        self.caption_lang_combo.pack(side="left", padx=(8, 2))
        self.caption_lang_combo.bind("<<ComboboxSelected>>", self._on_caption_lang_change)
        self.caption_mode_var = tk.StringVar(value="原声")
        self.caption_mode_combo = ttk.Combobox(self.video_bar, textvariable=self.caption_mode_var,
                                               values=CAPTION_MODES, state="readonly", width=7)
        self.caption_mode_combo.pack(side="left", padx=2)
        self.caption_mode_combo.bind("<<ComboboxSelected>>", self._on_caption_mode_change)

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

        self._sync_toggle_buttons()

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
        cy = y + int(h * 0.94) - ch
        self.caption_window.geometry("+%d+%d" % (cx, cy))

    def _btn(self, parent, text, cmd, tip=None, primary=False):
        b = tk.Button(parent, text=text, command=cmd, takefocus=0,
                      bg=ACCENT if primary else BTN_BG,
                      fg="#fff" if primary else FG,
                      activebackground="#5b9aff" if primary else BTN_ACTIVE,
                      activeforeground="#fff",
                      relief="flat", bd=0, padx=10, pady=4,
                      cursor="hand2", font=("Microsoft YaHei", 10))
        b.pack(side="left", padx=2)
        return b

    def _state_btn(self, parent, text, cmd):
        b = tk.Button(parent, text=text, command=cmd, takefocus=0,
                      bg=BTN_BG, fg=FG, activebackground=BTN_ACTIVE, activeforeground="#fff",
                      relief="flat", bd=0, padx=10, pady=4,
                      cursor="hand2", font=("Microsoft YaHei", 10))
        b.pack(side="left", padx=2)
        return b

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

    # ---------------- 配置 / 断点续读 ----------------
    def _load_config(self):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}

    def _save_config(self):
        try:
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(self._config, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

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
        }
        self._save_config()

    def _on_close(self):
        self._cancel_auto()
        self._stop_video()
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
            title="选择图片或压缩包（可多选）",
            filetypes=[("图片 / 视频 / 压缩包", "*.png *.jpg *.jpeg *.gif *.webp *.bmp *.tif *.tiff *.jfif *.mp4 *.mkv *.avi *.webm *.mov *.wmv *.flv *.m4v *.ts *.zip *.cbz"),
                       ("图片文件", "*.png *.jpg *.jpeg *.gif *.webp *.bmp *.tif *.tiff *.jfif"),
                       ("视频文件", "*.mp4 *.mkv *.avi *.webm *.mov *.wmv *.flv *.m4v *.ts"),
                       ("压缩包", "*.zip *.cbz"),
                       ("所有文件", "*.*")])
        if not paths:
            return
        zips = [p for p in paths if os.path.splitext(p)[1].lower() in ZIP_EXTS]
        imgs = [p for p in paths if p not in zips]
        if zips:
            if len(zips) > 1 or imgs:
                messagebox.showinfo("提示", "压缩包请单独打开。")
            self._load_zip_path(zips[0])
        elif imgs:
            imgs.sort(key=lambda p: natural_key(os.path.basename(p)))
            self._close_zip()
            self.book_key = "files:" + hashlib.sha1("|".join(imgs).encode("utf-8")).hexdigest()[:16]
            self._load_list(imgs)

    def open_zip(self):
        p = filedialog.askopenfilename(title="选择压缩包（zip / cbz）",
                                       filetypes=[("压缩包", "*.zip *.cbz"), ("所有文件", "*.*")])
        if p:
            self._load_zip_path(p)

    def _load_zip_path(self, p):
        try:
            with zipfile.ZipFile(p) as z:
                names = [n for n in z.namelist()
                         if not n.endswith("/") and os.path.splitext(n)[1].lower() in (IMAGE_EXTS | VIDEO_EXTS)]
            if not names:
                messagebox.showinfo("提示", "压缩包内没有图片或视频文件。")
                return
            names.sort(key=lambda n: natural_key(n.replace("\\", "/").split("/")[-1]))
            self._close_zip()
            self._zip = zipfile.ZipFile(p)
            self.book_key = p
            self._load_list([(p, n) for n in names])
        except Exception as e:
            messagebox.showerror("错误", "无法打开压缩包：%s" % e)

    def load_folder(self, d):
        files = [os.path.join(d, f) for f in os.listdir(d)
                 if os.path.splitext(f)[1].lower() in (IMAGE_EXTS | VIDEO_EXTS)]
        files.sort(key=lambda p: natural_key(os.path.basename(p)))
        if not files:
            messagebox.showinfo("提示", "该文件夹下没有找到图片或视频文件。")
            return
        self._close_zip()
        self.book_key = d
        self._load_list(files)

    def _close_zip(self):
        if self._zip:
            try:
                self._zip.close()
            except Exception:
                pass
            self._zip = None

    def _load_list(self, sources):
        self.sources = sources
        start = 0
        if self.book_key in self._config:
            try:
                cfg = self._config[self.book_key]
                start = clamp(int(cfg.get("index", 0)), 0, len(sources) - 1)
                self.spread_mode = bool(cfg.get("spread_mode", True))
                self.reading_direction = "rtl" if cfg.get("direction") == "rtl" else "ltr"
                self.trim_mode = bool(cfg.get("trim_mode", False))
                fm = cfg.get("fit_mode", "window")
                self.fit_mode = fm if fm in ("width", "height", "window", "actual") else "window"
            except Exception:
                start = 0
        self._sync_toggle_buttons()
        self._thumbs_visible = True
        if not self.thumbs_frame.winfo_manager():
            self.thumbs_frame.pack(side="bottom", fill="x", before=self.status)
        self.show_file(start)
        self._build_thumbnails()

    # ---------------- 图片读取 ----------------
    def _display_name(self, src):
        if isinstance(src, tuple):
            name = src[1].replace("\\", "/").split("/")[-1]
            return name or src[1]
        return os.path.basename(src)

    def _open_raw(self, src):
        """惰性打开（用于缩略图，避免整图解码）。"""
        if isinstance(src, tuple):
            z = self._zip or zipfile.ZipFile(src[0])
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
        if self._is_video(self.sources[nxt]):
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
    def _is_video(self, src):
        name = src[1] if isinstance(src, tuple) else src
        return os.path.splitext(name)[1].lower() in VIDEO_EXTS

    def _ensure_vlc(self):
        if self.vlc_instance is not None:
            return True
        try:
            import vlc
            self.vlc = vlc
            self.vlc_instance = vlc.Instance()
            self.player = self.vlc_instance.media_player_new()
            return True
        except Exception:
            return False

    def _video_path(self, src):
        if isinstance(src, tuple):
            if src in self._video_cache:
                return self._video_cache[src]
            name = src[1].replace("\\", "/").split("/")[-1]
            ext = os.path.splitext(name)[1].lower()
            tmp = os.path.join(self._tmp_dir, "v_" + hashlib.md5(src[1].encode("utf-8")).hexdigest()[:12] + ext)
            try:
                z = self._zip or zipfile.ZipFile(src[0])
                with open(tmp, "wb") as f:
                    f.write(z.read(src[1]))
                self._video_cache[src] = tmp
                return tmp
            except Exception:
                return None
        return src

    def _show_video(self, src):
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
        self._show_video_panel()
        try:
            self.player.stop()
            media = self.vlc_instance.media_new(path)
            self.player.set_media(media)
            self.player.set_hwnd(self.video_panel.winfo_id())
            # 字幕的 audio_set_format/audio_set_callbacks 必须在 play() 之前设置，
            # 否则原生音频输出已经起来了，回调不一定能接管。
            if self.caption_enabled:
                self._start_captions()
            self.player.play()
            self.player.audio_set_volume(int(self.vol.get()))
            self.is_video = True
            self.play_btn.configure(text="⏸")
        except Exception as e:
            self.is_video = False
            self.status.configure(text="视频播放失败：%s" % e)
            return
        self._show_video_bar()
        self._update_status()
        self._update_video_time_loop()

    def _stop_video(self):
        if self._video_timer:
            self.after_cancel(self._video_timer)
            self._video_timer = None
        self._stop_captions()
        if self.player:
            try:
                self.player.stop()
            except Exception:
                pass
        self.is_video = False
        self._hide_video_bar()

    def _show_video_bar(self):
        if not self.video_bar.winfo_manager():
            self.video_bar.pack(side="bottom", fill="x", before=self.status)

    def _hide_video_bar(self):
        if self.video_bar.winfo_manager():
            self.video_bar.pack_forget()

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
        if not self.player or not self.is_video:
            return
        try:
            if self.player.is_playing():
                self.player.pause()
                self.play_btn.configure(text="▶")
            else:
                self.player.play()
                self.play_btn.configure(text="⏸")
        except Exception:
            pass

    def _on_seek(self, val):
        if self._updating_seek:
            return
        self._last_seek = time.time()
        if not self.player or not self.is_video:
            return
        try:
            length = self.player.get_length()
            if length > 0:
                self.player.set_time(int(float(val) / 1000.0 * length))
                if self._captioner is not None:
                    self._captioner.reset()
        except Exception:
            pass

    def _on_volume(self, val):
        if self.player:
            try:
                self.player.audio_set_volume(int(float(val)))
            except Exception:
                pass

    def _update_video_time_loop(self):
        self._video_timer = None
        if not self.is_video or not self.player:
            return
        try:
            length = self.player.get_length()
            cur = self.player.get_time()
            if length > 0:
                self.time_label.configure(text="%s / %s" % (self._fmt_time(cur), self._fmt_time(length)))
                if time.time() - self._last_seek > 0.5:
                    self._updating_seek = True
                    try:
                        self.seek.set(cur / length * 1000.0)
                    finally:
                        self._updating_seek = False
            if self.player.get_state() == self.vlc.State.Ended:
                self.play_btn.configure(text="▶")
                if not self._video_ended:
                    self._video_ended = True
                    if self.index < len(self.sources) - 1:
                        self.after(300, self.next)
                return
        except Exception:
            pass
        self._video_timer = self.after(500, self._update_video_time_loop)

    def toggle_captions(self):
        self.caption_enabled = not self.caption_enabled
        self._sync_toggle_buttons()
        if self.is_video:
            if self.caption_enabled:
                self._start_captions()
            else:
                self._stop_captions()

    def _on_caption_lang_change(self, event=None):
        if self.caption_lang_var.get() == "中文":
            self.caption_mode_var.set("原声")
            self.caption_mode_combo.configure(state="disabled")
        else:
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
            self._captioner = LiveCaptioner(source_lang=lang, caption_mode=mode)
        self.caption_label.configure(text="字幕模型加载中…")
        self.caption_window.deiconify()
        self._reposition_caption_window()
        self._captioner.start_async(self.player)
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
        self.caption_label.configure(text="")
        self._reposition_caption_window()
        self._poll_captions()

    def _stop_captions(self):
        if self._caption_await_after:
            self.after_cancel(self._caption_await_after)
            self._caption_await_after = None
        if self._caption_poll_after:
            self.after_cancel(self._caption_poll_after)
            self._caption_poll_after = None
        if self._captioner is not None:
            self._captioner.stop()
        self.caption_window.withdraw()

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
        if ms < 0:
            ms = 0
        s = ms // 1000
        return "%d:%02d" % (s // 60, s % 60)

    # ---------------- 显示 ----------------
    def show_file(self, i):
        if not self.sources:
            return
        i %= len(self.sources)
        self.index = i
        self.rotation = 0
        src = self.sources[i]

        if self._is_video(src):
            self._stop_video()
            self.orig = None
            self._spread_img = None
            self.canvas.delete("img")
            self._show_video(src)
            self._highlight_thumb()
            self._save_progress()
            if self.auto_flip:
                self._schedule_auto()
            return

        self._stop_video()
        self._show_image_panel()
        self.is_video = False
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
        w, h = src.size
        if self.rotation % 180 == 90:
            w, h = h, w
        return w, h

    def _compute_zoom(self):
        if not self.orig:
            return 1.0
        cw = max(self.canvas.winfo_width(), 1)
        ch = max(self.canvas.winfo_height(), 1)
        rw, rh = self._rotated_size()
        if self.fit_mode == "width":
            z = cw / rw
        elif self.fit_mode == "height":
            z = ch / rh
        elif self.fit_mode == "window":
            z = min(cw / rw, ch / rh)
        elif self.fit_mode == "actual":
            z = 1.0
        else:
            z = self.zoom
        return clamp(z, MIN_ZOOM, MAX_ZOOM)

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
        if (dw, dh) != im.size:
            im = im.resize((dw, dh), RESAMPLE)

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
        rw, rh = rw * self.zoom, rh * self.zoom
        maxx = 0 if rw <= cw else (rw - cw) / 2 + MIN_VISIBLE
        maxy = 0 if rh <= ch else (rh - ch) / 2 + MIN_VISIBLE
        self.pan_x = clamp(self.pan_x, -maxx, maxx)
        self.pan_y = clamp(self.pan_y, -maxy, maxy)

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
        if not self.orig:
            return
        self.rotation = (self.rotation + d) % 360
        self._clamp_pan()
        self._render()

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
        self.spread_btn.configure(bg=ACCENT if self.spread_mode else BTN_BG,
                                  fg="#fff" if self.spread_mode else FG)
        self.dir_btn.configure(text="右→左" if self.reading_direction == "rtl" else "左→右",
                               bg=ACCENT if self.reading_direction == "rtl" else BTN_BG,
                               fg="#fff" if self.reading_direction == "rtl" else FG)
        self.trim_btn.configure(bg=ACCENT if self.trim_mode else BTN_BG,
                                fg="#fff" if self.trim_mode else FG)
        self.auto_btn.configure(bg=ACCENT if self.auto_flip else BTN_BG,
                                fg="#fff" if self.auto_flip else FG)
        self.caption_btn.configure(bg=ACCENT if self.caption_enabled else BTN_BG,
                                   fg="#fff" if self.caption_enabled else FG)

    def zoom_at(self, x, y, factor):
        if not self.orig:
            return
        new_zoom = clamp(self.zoom * factor, MIN_ZOOM, MAX_ZOOM)
        f = new_zoom / self.zoom
        cw = max(self.canvas.winfo_width(), 1)
        ch = max(self.canvas.winfo_height(), 1)
        self.pan_x = self.pan_x * f + (x - cw / 2) * (1 - f)
        self.pan_y = self.pan_y * f + (y - ch / 2) * (1 - f)
        self.zoom = new_zoom
        self.fit_mode = "custom"
        self._clamp_pan()
        self._render()

    def zoom_center(self, f):
        self.zoom_at(self.canvas.winfo_width() / 2, self.canvas.winfo_height() / 2, f)

    def toggle_fullscreen(self):
        entering_fullscreen = not self.attributes("-fullscreen")
        self.attributes("-fullscreen", entering_fullscreen)
        if entering_fullscreen:
            self._hide_ui()
        else:
            self._show_ui()
        if self.is_video and self.player:
            # 全屏切换后，视频可能不自动适应新尺寸，稍后重设一次 hwnd 让 VLC 重新适配
            self.after(250, self._refresh_video_hwnd)

    def _refresh_video_hwnd(self):
        if self.is_video and self.player and self.video_panel.winfo_manager():
            try:
                self.player.set_hwnd(self.video_panel.winfo_id())
            except Exception:
                pass

    def toggle_thumbs(self):
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
            self.thumbs_frame.pack(side="bottom", fill="x", before=self.status)
            self._build_thumbnails()

    def _hide_ui(self):
        """隐藏全部 UI（工具栏 / 状态栏 / 缩略图 / 视频条），仅保留画面内容。"""
        self._click_tick = 0
        if self.toolbar_outer.winfo_manager():
            self.toolbar_outer.pack_forget()
        self.status.pack_forget()
        self.thumbs_frame.pack_forget()
        self.video_bar.pack_forget()
        # 切换内容区：视频面/画布互斥显示
        if self.is_video and self.video_panel.winfo_manager():
            self.video_panel.pack(side="top", fill="both", expand=True)
        else:
            self.video_panel.pack_forget()
            self.canvas.pack(side="top", fill="both", expand=True)
        self._ui_hidden = True

    def _show_ui(self):
        """恢复全部 UI：工具栏 + 状态栏 + 缩略图 + 视频条，并按需要重绘画面。"""
        if self._ui_hidden:
            self._ui_hidden = False
            if not self.toolbar_outer.winfo_manager():
                self.toolbar_outer.pack(side="top", fill="x", before=self.content)
            self.status.pack(side="bottom", fill="x")
            if self._thumbs_visible:
                self.thumbs_frame.pack(side="bottom", fill="x", before=self.status)
            if self.is_video:
                self.video_bar.pack(side="bottom", fill="x", before=self.status)
                if self.video_panel.winfo_manager():
                    self.after(160, self._after_ui_ready)
                return
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
            self.toolbar_outer.pack(side="top", fill="x", before=self.canvas)

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

    def _on_key(self, e):
        w = self.focus_get()
        if isinstance(w, (tk.Entry, tk.Text)):
            return
        k = e.keysym
        if k in ("Right", "Next"):
            self.next()
        elif k == "space":
            if self.is_video:
                self._toggle_play()
            else:
                self.next()
        elif k in ("Left", "Prior"):
            self.prev()
        elif k in ("plus", "equal"):
            self.zoom_center(1.25)
        elif k in ("minus", "underscore"):
            self.zoom_center(0.8)
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
        elif k in ("a", "A"):
            self.toggle_auto()
        elif k == "bracketleft":
            self.adjust_auto_interval(-0.5)
        elif k == "bracketright":
            self.adjust_auto_interval(0.5)
        elif k in ("g", "G"):
            self.jump_to_page()
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
                self.attributes("-fullscreen", False)
                self._show_ui()

    def _on_resize(self, e):
        if self._resize_after:
            self.after_cancel(self._resize_after)
        self._resize_after = self.after(120, self._do_resize)

    def _do_resize(self):
        self._resize_after = None
        if not self.orig:
            if not self.is_video:
                self._show_start()
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
        self._thumb_build_after = self.after_idle(self._build_thumbnail_batch)

    def _cancel_thumbnail_build(self):
        after_id = getattr(self, "_thumb_build_after", None)
        if after_id:
            self.after_cancel(after_id)
            self._thumb_build_after = None

    def _build_thumbnail_batch(self):
        if not self._thumbs_visible or self._thumb_build_sources != self.sources:
            self._thumb_build_after = None
            return

        H, Y = 70, 48
        batch_end = min(self._thumb_build_index + 8, len(self._thumb_build_sources))
        for i in range(self._thumb_build_index, batch_end):
            src = self._thumb_build_sources[i]
            x = self._thumb_build_x
            if self._is_video(src):
                self._thumb_photos.append(None)
                self.thumbs.create_rectangle(x, Y - H / 2, x + 80, Y + H / 2,
                                             fill="#1b1e24", tags=("thumb", "t%d" % i))
                self.thumbs.create_text(x + 40, Y, text="▶", fill=ACCENT,
                                        font=("Segoe UI", 18), tags=("thumb", "t%d" % i))
                self._thumb_rects.append((x, x + 80))
                self._thumb_build_x += 80 + 8
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
    def _update_status(self):
        if not self.sources:
            return
        if self.is_video:
            name = self._display_name(self.sources[self.index])
            self.page_label.configure(text="%d / %d" % (self.index + 1, len(self.sources)))
            self.zoom_label.configure(text="视频")
            self.status.configure(text=name + "   ·   视频")
            return
        name = self._display_name(self.sources[self.index])
        if self._spread_img is not None:
            name += " + " + self._display_name(self.sources[self.index + 1])
            page = "%d-%d / %d" % (self.index + 1, self.index + 2, len(self.sources))
        else:
            page = "%d / %d" % (self.index + 1, len(self.sources))
        w, h = self._rotated_size()
        rot = (" · 旋转 %d°" % self.rotation) if self.rotation else ""
        rtl = " · 右→左" if self._is_rtl() else ""
        auto = (" · 自动翻页 %gs" % self.auto_interval) if self.auto_flip else ""
        self.page_label.configure(text=page)
        self.zoom_label.configure(text="%d%%" % int(round(self.zoom * 100)))
        self.status.configure(text="%s   ·   %d×%d   ·   %d%%%s%s%s" % (
            name, w, h, int(round(self.zoom * 100)), rot, rtl, auto))

    def _show_start(self):
        self.canvas.delete("all")
        cw = max(self.canvas.winfo_width(), 200)
        ch = max(self.canvas.winfo_height(), 120)
        self.canvas.create_text(cw / 2, ch / 2 - 30, text="🖼 图片 / 漫画浏览器",
                                fill=FG, font=("Microsoft YaHei", 22, "bold"))
        self.canvas.create_text(cw / 2, ch / 2 + 10,
                                text="打开文件夹 / 图片 / zip·cbz 压缩包 / 视频开始阅读（竖图可双页并排显示）",
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
            "+ / -                          放大 / 缩小\n"
            "拖拽                           平移图片\n"
            "快速左右滑动                   翻页（方向随阅读方向）\n"
            "点击画面左 / 右边缘             翻页（方向随阅读方向）\n"
            "点击画面中间                    显示 / 隐藏工具栏\n"
            "双击画面中间                    适应窗口 <-> 实际大小\n"
            "视频页：空格 / 点击画面中间      播放 / 暂停\n"
            "视频页：播放完自动              跳到下一张\n"
            "R / Shift+R                    顺时针 / 逆时针旋转 90°\n"
            "0 / 1 / 2 / 3                  适应窗口 / 实际大小 / 适应宽度 / 适应高度\n"
            "D                              双页模式 开 / 关（竖图并排显示两张）\n"
            "M                              阅读方向 左→右 / 右→左（日漫）\n"
            "C                              裁白边 开 / 关\n"
            "G                              跳到指定页\n"
            "A                              自动翻页 开 / 关\n"
            "[ / ]                          自动翻页每页停留时间 - / + 0.5 秒\n"
            "F / F11                        全屏\n"
            "T                              显示 / 隐藏缩略图\n"
            "?                              帮助\n"
            "Esc                            退出全屏\n"
            "\n"
            "支持：文件夹 / 多张图片 / zip·cbz 压缩包。\n"
            "支持：mp4 / mkv / avi / webm 等视频（内嵌播放，需 VLC）。\n"
            "自动记忆每本书的阅读进度、双页、方向、去边设置。\n"
        )
        tk.Label(win, text=txt, justify="left", anchor="w", bg="#1a1d24", fg=FG,
                 font=("Consolas", 11), padx=20, pady=20).pack(fill="both", expand=True)
        tk.Button(win, text="关闭", command=win.destroy, bg=BTN_BG, fg=FG,
                  activebackground=BTN_ACTIVE, relief="flat", padx=16, pady=6,
                  cursor="hand2").pack(pady=(0, 14))


def main():
    app = ComicViewer()
    app.mainloop()


if __name__ == "__main__":
    main()
