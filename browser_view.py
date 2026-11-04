"""网盘浏览器的纯逻辑（无 Tk 依赖，便于单测）：格式化、网格布局、命中测试、排序。"""
import time

from viewer_core import natural_key

KIND_LABELS = {"folder": "目录", "image": "图片", "video": "视频", "audio": "音频"}


def fmt_size(n):
    if n is None:
        return ""
    n = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            if unit == "B":
                return "%d B" % int(n)
            return "%.1f %s" % (n, unit)
        n /= 1024


def _http_date_ts(value):
    """RFC 1123 日期 → 时间戳。email.utils 导入要 ~30ms，启动时用不上，故按需导入。"""
    from email.utils import parsedate_to_datetime
    return parsedate_to_datetime(value).timestamp()


def fmt_mtime(value):
    """WebDAV 的 getlastmodified（RFC 1123）→ 本地时间 'YYYY-MM-DD HH:MM'；无法解析返回空串。"""
    if not value:
        return ""
    try:
        ts = _http_date_ts(value)
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))
    except Exception:
        return ""


def mtime_key(value):
    """排序用的时间戳；无法解析按 0。"""
    if not value:
        return 0.0
    try:
        return _http_date_ts(value)
    except Exception:
        return 0.0


def kind_label(entry):
    return KIND_LABELS.get("folder" if entry.is_dir else entry.kind, "")


def grid_layout(count, width, tile_w, tile_h, label_h, gap, margin):
    """流式网格布局。返回 (rects, total_height)，rects[i] = (x0, y0, x1, y1) 为缩略图区域，
    标签画在其下方 label_h 像素内；一行放不下就换行，每行至少放一个。"""
    usable = max(width - 2 * margin, tile_w)
    cols = max(1, (usable + gap) // (tile_w + gap))
    row_h = tile_h + label_h + gap
    rects = []
    for i in range(count):
        r, c = divmod(i, cols)
        x = margin + c * (tile_w + gap)
        y = margin + r * row_h
        rects.append((x, y, x + tile_w, y + tile_h))
    rows = (count + cols - 1) // cols
    total = margin * 2 + rows * row_h - (gap if rows else 0)
    return rects, total


def hit_test(rects, x, y, label_h=0):
    """返回命中的下标（命中范围含下方标签区），否则 None。"""
    for i, (x0, y0, x1, y1) in enumerate(rects):
        if x0 <= x <= x1 and y0 <= y <= y1 + label_h:
            return i
    return None


def sort_entries(entries, column, descending=False):
    """目录始终排在文件前面；column 取 name/kind/size/mtime。"""
    keyfns = {
        "name": lambda e: natural_key(e.name),
        "kind": lambda e: (kind_label(e), natural_key(e.name)),
        "size": lambda e: (e.size or 0, natural_key(e.name)),
        "mtime": lambda e: (mtime_key(e.mtime), natural_key(e.name)),
    }
    fn = keyfns.get(column, keyfns["name"])
    dirs = sorted([e for e in entries if e.is_dir], key=fn, reverse=descending)
    files = sorted([e for e in entries if not e.is_dir], key=fn, reverse=descending)
    return dirs + files
