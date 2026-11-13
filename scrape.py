# -*- coding: utf-8 -*-
"""媒体刮削引擎（第 1 步：解析文件名 -> TMDB 搜索 -> 取详情 -> 本地缓存 / 手动锁定）。

只用标准库。数据源只有 TMDB 官方 API（令牌只从环境变量 TMDB_TOKEN 读，绝不写盘 / 不进日志 / 不下发浏览器）。
缓存放在后端数据目录，不写进媒体目录。详见 docs/scrape-design.md。

本模块不依赖 web_backend（便于单测）；web_backend 只做 HTTP 胶水。
"""

import difflib
import hashlib
import ipaddress
import json
import os
import re
import socket
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

APP_VERSION = "1.0"
USER_AGENT = "ImageViewer/%s (personal media browser; TMDB API client)" % APP_VERSION
DEFAULT_API_BASE = "https://api.themoviedb.org/3"
DEFAULT_IMAGE_BASE = "https://image.tmdb.org/t/p"
# TMDB 条款：缓存数据不得保存超过 6 个月。留余量取 150 天，过期即当作没有并清掉。
TTL_SECONDS = 150 * 86400
MIN_INTERVAL = 0.05           # 节流：<= 20 请求/秒
IMAGE_SIZES = ("w92", "w154", "w185", "w342", "w500", "w780", "original")
IMAGE_PATH_RE = re.compile(r"^/[A-Za-z0-9_-]{6,80}\.(jpg|png)$")
MATCH_MIN_SCORE = 0.45        # 低于它视为「没匹配上」（仍给候选）
MAX_CANDIDATES = 3
CONFIDENT_SCORE = 0.8        # 低于它 -> needs_review
CLOSE_MARGIN = 0.08          # 第一名与第二名差距小于它 -> needs_review


# ============================================================ 文件名解析
VIDEO_EXT_RE = re.compile(
    r"\.(mkv|mp4|m4v|avi|wmv|flv|mov|webm|ogv|ts|m2ts|mpg|mpeg|rmvb|rm|3gp|iso)$", re.I)

NOISE = set("""
bluray blu bdrip brrip bdremux remux web webdl webrip hdtv hdrip dvdrip dvd dvdscr dvdr hdcam cam tc
x264 x265 h264 h265 xvid divx avc hevc vc1 av1 10bit 8bit hi10p hi10 hdr hdr10 hdr10+ dv dovi uhd fhd
aac ac3 eac3 dts dd ddp flac truehd atmos mp3 opus
proper repack internal extended unrated remastered imax 3d hsbs hou subbed dubbed multi dual complete
nf amzn dsnp hmax atvp hulu iqiyi
chs cht big5 gb jpn eng chi kor sub
国语 国粤 粤语 中字 中英 双语 简体 繁体 简繁 简中 繁中 内封 内嵌 外挂 字幕 无字 高清 超清 蓝光 原盘 国配 台配 日语 英语
完整版 导演剪辑 修复版 特效字幕 官方中字
""".split())
RES_RE = re.compile(r"^(\d{3,4}[pi]|[248]k|\d{3,4}x\d{3,4})$", re.I)
YEAR_RE = re.compile(r"^(19[2-9]\d|20[0-3]\d)$")
CJK_RE = re.compile(r"[぀-ヿ㐀-鿿]")
CN_NUM = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7,
          "八": 8, "九": 9}

SEASON_DIR_RES = [
    re.compile(r"^(?:season|series)[ ._-]*(\d{1,2})$", re.I),
    re.compile(r"^s[ ._-]?(\d{1,2})$", re.I),
    re.compile(r"^第\s*([0-9一二三四五六七八九十两]{1,3})\s*[季部]$"),
]
SPECIALS_RE = re.compile(r"^(specials?|sp|特别篇|特典|番外)$", re.I)
GENERIC_STEM_RE = re.compile(r"^(video|movie|film|cd\d|disc\d|part\d|sample|trailer|vts_\d+.*|index|main|复制.*)$", re.I)


def cn_to_int(s):
    """一 / 十 / 十二 / 二十三 -> int；失败返回 None。"""
    s = s.strip()
    if s.isdigit():
        return int(s)
    if not s or any(c not in CN_NUM and c != "十" for c in s):
        return None
    if "十" in s:
        a, _, b = s.partition("十")
        tens = CN_NUM[a] if a else 1
        return tens * 10 + (CN_NUM[b] if b else 0)
    return CN_NUM[s] if len(s) == 1 else None


def _pre_normalize(s):
    """把会被「点号分词」搞坏的写法先改成单个 token。"""
    s = re.sub(r"(?i)(?<![A-Za-z0-9])[hx][ .]?26[45](?![0-9])", " x264 ", s)
    s = re.sub(r"(?i)(?<![A-Za-z])(aac|ddp?|dts|ac3|eac3|flac|truehd|atmos)[ .]?\d(?:\.\d)?(?![A-Za-z0-9])", r" \1 ", s)
    s = re.sub(r"(?<![0-9])[257]\.[01](?![0-9])", " ", s)
    s = re.sub(r"(?i)web[ .-]dl", " webdl ", s)
    s = re.sub(r"(?i)blu[ .-]ray", " bluray ", s)
    # 全角括号 -> 半角
    return s.translate(str.maketrans("（）【】［］", "()[][]"))


def _markers_from_cjk(s):
    """第N集 / 第N季 / Season N -> 占位 token，避免被当成标题。"""
    def ep(m):
        n = cn_to_int(m.group(1))
        return " @E%d@ " % n if n is not None else m.group(0)

    def se(m):
        n = cn_to_int(m.group(1))
        return " @S%d@ " % n if n is not None else m.group(0)
    s = re.sub(r"第\s*([0-9一二三四五六七八九十两零〇]{1,4})\s*[集话話期]", ep, s)
    s = re.sub(r"第\s*([0-9一二三四五六七八九十两]{1,3})\s*[季部]", se, s)
    s = re.sub(r"(?i)(?<![A-Za-z])season[ ._-]*(\d{1,2})(?![0-9])", lambda m: " @S%d@ " % int(m.group(1)), s)
    return s


def _tokenize(stem):
    """stem -> (tokens, years_in_brackets)。tokens 里 [05] 形式的集号已变成 __E5__ 占位。"""
    s = _pre_normalize(stem)
    # 开头的字幕组 / 标签 [xxx] 直接丢
    s = re.sub(r"^(\s*\[[^\]]*\])+\s*", " ", s)
    s = _markers_from_cjk(s)
    # [05] / [05v2] 形式的集号（动漫常见）
    s = re.sub(r"\[\s*(\d{1,3})(?:v\d)?\s*\]", lambda m: " @E%d@ " % int(m.group(1)), s)
    # (2019) 的年份保留，其余括号内容丢弃
    s = re.sub(r"[\(\[]\s*((?:19|20)\d{2})\s*[\)\]]", r" \1 ", s)
    s = re.sub(r"\[[^\]]*\]|\([^)]*\)", " ", s)
    # 分词：. _ 空白 -> 空格；无空格的 a-b-c 把连字符也当分隔符
    s = s.replace("_", " ")
    if " " not in s.strip():
        s = s.replace(".", " ")
    else:
        s = re.sub(r"(?<=\w)\.(?=\w)", " ", s)
    if " " not in s.strip():
        s = s.replace("-", " ")
    return [t for t in re.split(r"\s+", s.strip()) if t]


def _is_noise(tok):
    t = tok.lower().strip("[]()-")
    if not t:
        return False
    if RES_RE.match(t) or t in NOISE:
        return True
    head = t.split("-", 1)[0]
    return head in NOISE and head != t and len(head) > 1


def _clean_title(words):
    t = " ".join(words).strip(" -_.·")
    t = re.sub(r"\s+-\s+", " - ", t)
    t = re.sub(r"\s{2,}", " ", t)
    return t.strip(" -_.·")


def _split_variants(title):
    """中英混排标题拆成 [中文部分, 英文部分, 整体]（去重、保序）。"""
    out = []
    if CJK_RE.search(title):
        cjk = re.sub(r"[A-Za-z][A-Za-z0-9'’:,.!?& -]*", " ", title)
        lat = CJK_RE.sub(" ", title)
        cjk = re.sub(r"\s+", " ", cjk).strip(" -_.·/|")
        lat = re.sub(r"\s+", " ", lat).strip(" -_.·/|")
        if cjk and lat and len(lat) >= 3:
            out += [cjk, lat]
    for part in re.split(r"\s+[/|]\s+", title):
        if part.strip() and part.strip() not in out:
            out.append(part.strip())
    if title not in out:
        out.append(title)
    return out


def _parse_stem(stem):
    """解析一个名字（文件主名或目录名）-> dict(title, year, season, episode)。"""
    toks = _tokenize(stem)
    season = episode = None
    year = None
    title_words = []
    if len(toks) == 1 and re.match(r"^\d{1,3}$", toks[0]):       # 纯数字主名 = 集号
        return {"title": "", "year": None, "season": None, "episode": int(toks[0])}
    ep_priority = 9
    cut = False
    i = 0
    n = len(toks)
    while i < n:
        tok = toks[i]
        low = tok.lower()
        m = re.match(r"^s(\d{1,2})[ ._-]?e(\d{1,4})(?:[-e]\d+)*$", low)
        if m:
            season, episode, ep_priority, cut = int(m.group(1)), int(m.group(2)), 0, True
            break
        m = re.match(r"^(\d{1,2})x(\d{2,3})$", low)
        if m:
            season, episode, ep_priority, cut = int(m.group(1)), int(m.group(2)), 0, True
            break
        m = re.match(r"^@e(\d+)@$", low)
        if m and (title_words or i > 0):
            episode, ep_priority, cut = int(m.group(1)), 1, True
            # 后面可能还有 season 占位（"第二季 第5集" 顺序反的情况在 __S 分支处理）
            for t2 in toks[i + 1:]:
                m2 = re.match(r"^@s(\d+)@$", t2.lower())
                if m2:
                    season = int(m2.group(1))
            break
        m = re.match(r"^e(?:p|pisode)?[ ._-]?(\d{1,3})(?:v\d)?$", low)
        if m and title_words:
            episode, ep_priority, cut = int(m.group(1)), 1, True
            break
        if m:                                   # 开头就是 E05 / EP01：没有标题可挂，记下集号
            episode, ep_priority = int(m.group(1)), 1
            i += 1
            continue
        m = re.match(r"^@s(\d+)@$", low) or re.match(r"^s(\d{1,2})$", low)
        if m and title_words:
            season = int(m.group(1))
            # 同名后面紧跟集号：S2 - 05 / 第二季 第5集 / S2 E05
            j = i + 1
            while j < n:
                t2 = toks[j].lower()
                m2 = re.match(r"^@e(\d+)@$", t2) or re.match(r"^e(?:p)?(\d{1,3})$", t2)
                if m2:
                    episode, ep_priority = int(m2.group(1)), 1
                    break
                if t2 == "-" and j + 1 < n and re.match(r"^\d{1,3}(v\d)?$", toks[j + 1]):
                    episode, ep_priority = int(re.match(r"\d+", toks[j + 1]).group()), 2
                    break
                j += 1
            cut = True
            break
        if tok == "-" and i + 1 < n and title_words and re.match(r"^\d{1,3}(v\d)?$", toks[i + 1]):
            nxt = int(re.match(r"\d+", toks[i + 1]).group())
            episode, ep_priority, cut = nxt, 2, True
            break
        if YEAR_RE.match(tok) and title_words:
            year = int(tok)
            cut = True
            # 年份后面仍可能有集号（Show 2019 S01E02 / Show (2019) - 03）
            for k in range(i + 1, n):
                t3 = toks[k].lower()
                m3 = re.match(r"^s(\d{1,2})[ ._-]?e(\d{1,4})$", t3)
                if m3:
                    season, episode, ep_priority = int(m3.group(1)), int(m3.group(2)), 0
                    break
                m3 = re.match(r"^@e(\d+)@$", t3)
                if m3:
                    episode, ep_priority = int(m3.group(1)), 1
                    break
                if t3 == "-" and k + 1 < n and re.match(r"^\d{1,3}(v\d)?$", toks[k + 1]):
                    episode, ep_priority = int(re.match(r"\d+", toks[k + 1]).group()), 2
                    break
            break
        m = re.match(r"^((?:19|20)\d{2})-[A-Za-z0-9]+$", tok)       # Name.2019-GRP
        if m and title_words:
            year, cut = int(m.group(1)), True
            break
        if _is_noise(tok):
            if title_words:
                cut = True
                break
            i += 1                      # 开头的噪声直接跳过
            continue
        if re.match(r"^@[es]\d+@$", low):     # 开头的集号/季占位，没有标题可挂：先记下
            m = re.match(r"^@([es])(\d+)@$", low)
            if m.group(1) == "e":
                episode, ep_priority = int(m.group(2)), 1
            else:
                season = int(m.group(2))
            i += 1
            continue
        title_words.append(tok)
        i += 1
    # 年份：如果标题后没出现年份，在剩余 token 里补找一个（Name 1080p 2019 的情形）
    if year is None:
        for t in toks[i:]:
            if YEAR_RE.match(t):
                year = int(t)
                break
    # 标题末尾孤立的 "-"
    while title_words and title_words[-1] in ("-", "--"):
        title_words.pop()
    title = _clean_title(title_words)
    # 标题全是年份：电影名就是年份（1917 / 2012）
    if not title and year is not None and not cut:
        title, year = str(year), None
    # 纯数字主名：集号（01 / 003）
    if not title and episode is None and len(toks) == 1 and re.match(r"^\d{1,3}$", toks[0]):
        episode = int(toks[0])
    return {"title": title, "year": year, "season": season, "episode": episode}


def season_from_dir(name):
    n = name.strip()
    if SPECIALS_RE.match(n):
        return 0
    for rx in SEASON_DIR_RES:
        m = rx.match(n)
        if m:
            return cn_to_int(m.group(1))
    return None


def parse_video(filename, parents=()):
    """解析视频文件名（+ 上层目录名，最近的在前）。

    返回 {kind: 'movie'|'episode', title_candidates: [...], year, season, episode,
          show_dir_levels: 剧集目录在文件所在目录之上的层数（0 = 文件所在目录就是剧名目录；
                           -1 = 没有可用目录）}。"""
    stem = VIDEO_EXT_RE.sub("", os.path.basename(str(filename).replace("\\", "/")))
    f = _parse_stem(stem)
    parents = [p for p in (parents or []) if p and p not in ("/", "\\")]
    # 目录上下文：季目录 -> 剧名目录
    season_dir = None
    show_idx = 0
    if parents:
        s = season_from_dir(parents[0])
        if s is not None:
            season_dir, show_idx = s, 1
    dir_title = dir_year = None
    show_levels = -1
    for idx in range(show_idx, min(len(parents), show_idx + 1)):
        d = _parse_stem(parents[idx])
        if d["title"] and not GENERIC_STEM_RE.match(d["title"]):
            dir_title, dir_year, show_levels = d["title"], d["year"], idx
            if d["season"] is not None and season_dir is None:
                season_dir = d["season"]
    season = f["season"] if f["season"] is not None else season_dir
    episode = f["episode"]
    ftitle = f["title"] if f["title"] and not GENERIC_STEM_RE.match(f["title"]) else ""
    is_episode = episode is not None or season_dir is not None or f["season"] is not None
    cands = []
    for t in ([ftitle] if ftitle else []) + ([dir_title] if dir_title else []):
        for v in _split_variants(t):
            if v and v not in cands:
                cands.append(v)
    year = f["year"] or dir_year
    return {"kind": "episode" if is_episode else "movie",
            "title_candidates": cands, "year": year, "season": season, "episode": episode,
            "show_dir_levels": show_levels}


def names_from_key(key):
    """视频 key -> (文件名, [上层目录名, ...] 近到远，最多 3 层)。
    key 即 /api/videoresume 用的 key：本机 = normcase(abspath)，云端 = dav:<host>/<路径>。"""
    k = str(key)
    if k.startswith("dav:"):
        k = k.split("/", 1)[1] if "/" in k else ""
        parts = [p for p in k.split("/") if p]
    else:
        parts = [p for p in re.split(r"[\\/]+", k) if p and not re.match(r"^[A-Za-z]:$", p)]
    if not parts:
        return "", []
    return parts[-1], list(reversed(parts[:-1]))[:3]


def group_key_for(key, parsed):
    """剧集共用的「系列 key」（锁定一次整季 / 整部都生效）。电影没有。"""
    if parsed.get("kind") != "episode" or parsed.get("show_dir_levels", -1) < 0:
        return None
    k = str(key)
    sep = "/" if (k.startswith("dav:") or "/" in k and "\\" not in k) else "\\"
    segs = k.split(sep)
    cut = parsed["show_dir_levels"] + 1          # 去掉文件名 + N 层季目录
    if len(segs) <= cut:
        return None
    return "grp:" + sep.join(segs[:-cut])


# ============================================================ TMDB 客户端
class TmdbError(Exception):
    """对外安全的错误（绝不含令牌）。"""

    def __init__(self, msg, status=None, code="error"):
        super().__init__(msg)
        self.status = status
        self.code = code


def _is_private_host(host):
    h = (host or "").strip("[]").lower()
    if h in ("localhost", "") or h.endswith(".local") or "." not in h and ":" not in h:
        return True
    try:
        ip = ipaddress.ip_address(h)
        return ip.is_private or ip.is_loopback or ip.is_link_local
    except ValueError:
        return False


def validate_base(url, what):
    """网关 / 反代地址校验：只允许 https，或内网 / 回环的 http；不许带账号密码、query、fragment。"""
    u = urllib.parse.urlsplit(str(url or ""))
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ValueError("%s 必须是 http(s) 地址" % what)
    if u.username is not None or u.password is not None or "@" in u.netloc:
        raise ValueError("%s 不能包含账号密码" % what)
    if u.query or u.fragment:
        raise ValueError("%s 不能带 query / fragment" % what)
    if u.scheme == "http" and not _is_private_host(u.hostname):
        raise ValueError("%s 为公网地址时必须用 https（令牌会发往该地址）" % what)
    return str(url).rstrip("/")


_direct_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _open(req, timeout):
    """内网 / 回环地址强制直连；公网走系统代理（urllib 默认行为）。"""
    host = urllib.parse.urlsplit(req.full_url).hostname
    if _is_private_host(host):
        return _direct_opener.open(req, timeout=timeout)
    return urllib.request.urlopen(req, timeout=timeout)


class TmdbClient:
    def __init__(self, token_fn, api_base=None, image_base=None, min_interval=MIN_INTERVAL,
                 timeout=12, sleep=time.sleep):
        self._token_fn = token_fn
        # 令牌只会发往 api_base（可用 TMDB_API_BASE 指向自己信任的网关 / 反代）；图片请求从不带令牌。
        self.api_base = validate_base(api_base or os.environ.get("TMDB_API_BASE") or DEFAULT_API_BASE, "TMDB_API_BASE")
        ib = image_base or os.environ.get("TMDB_IMAGE_BASE")
        self._image_override = validate_base(ib, "TMDB_IMAGE_BASE") if ib else None
        self._image_base = None
        self.min_interval = min_interval
        self.timeout = timeout
        self._sleep = sleep
        self._last = 0.0
        self._lock = threading.Lock()

    @property
    def image_base(self):
        """优先 TMDB_IMAGE_BASE；否则取 /configuration 的 secure_base_url（失败回退官方默认）。"""
        if self._image_override:
            return self._image_override
        if self._image_base is None:
            try:
                sb = (self.configuration().get("images") or {}).get("secure_base_url") or ""
                self._image_base = validate_base(sb.rstrip("/"), "image base")
            except Exception:
                self._image_base = DEFAULT_IMAGE_BASE
        return self._image_base

    def has_token(self):
        return bool((self._token_fn() or "").strip())

    def _throttle(self):
        with self._lock:
            wait = self._last + self.min_interval - time.monotonic()
            if wait > 0:
                self._sleep(wait)
            self._last = time.monotonic()

    def _request(self, url, accept):
        if not url.startswith(self.api_base + "/") and url != self.api_base:
            raise TmdbError("拒绝向非配置主机发送令牌")        # 防御：令牌只发往 api_base
        token = (self._token_fn() or "").strip()
        if not token:
            raise TmdbError("未配置 TMDB_TOKEN", code="no_token")
        last = None
        for attempt in range(4):
            self._throttle()
            req = urllib.request.Request(url, headers={
                "Authorization": "Bearer " + token, "Accept": accept, "User-Agent": USER_AGENT})
            try:
                with _open(req, self.timeout) as r:
                    return r.read()
            except urllib.error.HTTPError as e:
                code = e.code
                retry_after = e.headers.get("Retry-After") if e.headers else None
                try:
                    e.close()
                except Exception:
                    pass
                if code == 401:
                    raise TmdbError("TMDB 令牌无效或已失效 (401)", 401, "bad_token")
                if code == 404:
                    raise TmdbError("TMDB 找不到该条目 (404)", 404, "not_found")
                if code == 429 or code >= 500:
                    try:
                        delay = min(float(retry_after), 10.0) if retry_after else 0.5 * (2 ** attempt)
                    except ValueError:
                        delay = 1.0
                    last = TmdbError("TMDB 限流 / 服务繁忙 (%d)" % code, code,
                                     "rate_limited" if code == 429 else "server")
                    self._sleep(max(delay, 0.0))
                    continue
                raise TmdbError("TMDB 请求失败 (%d)" % code, code)
            except (urllib.error.URLError, socket.timeout, ConnectionError, OSError) as e:
                last = TmdbError("连不上 TMDB（%s）" % type(e).__name__, None, "network")
                self._sleep(0.3 * (attempt + 1))
        raise last or TmdbError("TMDB 请求失败")

    def get_json(self, path, **params):
        qs = urllib.parse.urlencode({k: v for k, v in params.items() if v not in (None, "")})
        url = self.api_base + path + ("?" + qs if qs else "")
        raw = self._request(url, "application/json")
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            raise TmdbError("TMDB 返回了无法解析的内容")

    def get_image(self, size, file_path):
        if size not in IMAGE_SIZES or not IMAGE_PATH_RE.match(file_path or ""):
            raise ValueError("图片参数不合法")
        # 图片 CDN 不需要令牌：不带 Authorization，免得泄给第三方 CDN
        url = "%s/%s%s" % (self.image_base, size, file_path)
        last = None
        for attempt in range(3):
            self._throttle()
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            try:
                with _open(req, self.timeout) as r:
                    data = r.read(8 * 1024 * 1024 + 1)
                    if len(data) > 8 * 1024 * 1024:
                        raise TmdbError("图片过大")
                    return data
            except urllib.error.HTTPError as e:
                code = e.code
                try:
                    e.close()
                except Exception:
                    pass
                if code == 404:
                    raise TmdbError("图片不存在", 404, "not_found")
                last = TmdbError("图片下载失败 (%d)" % code, code)
                self._sleep(0.5 * (attempt + 1))
            except (urllib.error.URLError, socket.timeout, ConnectionError, OSError) as e:
                last = TmdbError("连不上图片服务器（%s）" % type(e).__name__, None, "network")
                self._sleep(0.3 * (attempt + 1))
        raise last

    # ---- 具体接口 ----
    def configuration(self):
        return self.get_json("/configuration")

    def search(self, media_type, query, language, year=None):
        if media_type == "movie":
            return self.get_json("/search/movie", query=query, language=language, year=year,
                                 include_adult="false")
        return self.get_json("/search/tv", query=query, language=language,
                             first_air_date_year=year, include_adult="false")

    def details(self, media_type, tmdb_id, language):
        return self.get_json("/%s/%d" % (media_type, int(tmdb_id)), language=language)

    def season(self, tmdb_id, season, language):
        return self.get_json("/tv/%d/season/%d" % (int(tmdb_id), int(season)), language=language)


# ============================================================ 缓存 + 编排
def _now():
    return time.time()


def _norm(s):
    return re.sub(r"[\W_]+", "", (s or "").casefold())


def title_score(cands, result, year):
    """候选标题 vs 一条 TMDB 搜索结果 -> 0..~1.2 的分。"""
    names = [result.get("title"), result.get("name"), result.get("original_title"),
             result.get("original_name")]
    names = [_norm(n) for n in names if n]
    best = 0.0
    for c in cands:
        nc = _norm(c)
        if not nc:
            continue
        for nm in names:
            if not nm:
                continue
            if nc == nm:
                s = 1.0
            else:
                s = difflib.SequenceMatcher(None, nc, nm).ratio()
                if len(nc) >= 2 and (nc in nm or nm in nc):
                    s = max(s, 0.6 + 0.3 * min(len(nc), len(nm)) / max(len(nc), len(nm)))
            best = max(best, s)
    ry = (result.get("release_date") or result.get("first_air_date") or "")[:4]
    if year and ry.isdigit():
        d = abs(int(ry) - int(year))
        best += 0.15 if d == 0 else (0.05 if d == 1 else -0.15)
    best += min(float(result.get("popularity") or 0), 100.0) / 2000.0
    return round(best, 4)


def _has_cjk(s):
    return bool(s and CJK_RE.search(s))


class Scraper:
    def __init__(self, data_dir, client, now=_now):
        self.dir = data_dir
        self.client = client
        self.now = now
        self.db_path = os.path.join(data_dir, "scrape.db")
        self.img_dir = os.path.join(data_dir, "img")
        self._lock = threading.RLock()
        self._tl = threading.local()
        self._jobs = {}
        self._job_lock = threading.Lock()
        os.makedirs(self.img_dir, exist_ok=True)
        with self._conn() as c:
            c.execute("CREATE TABLE IF NOT EXISTS tmdb_cache(ck TEXT PRIMARY KEY, body TEXT, at REAL)")
            c.execute("CREATE TABLE IF NOT EXISTS matches(key TEXT PRIMARY KEY, body TEXT, at REAL)")
            c.execute("CREATE TABLE IF NOT EXISTS pins(key TEXT PRIMARY KEY, body TEXT, at REAL)")

    # ---- sqlite ----
    def _conn(self):
        c = sqlite3.connect(self.db_path, timeout=15)
        return _Conn(c)

    def _cache_get(self, ck):
        with self._lock, self._conn() as c:
            row = c.execute("SELECT body, at FROM tmdb_cache WHERE ck=?", (ck,)).fetchone()
            if not row:
                return None
            if self.now() - row[1] > TTL_SECONDS:
                c.execute("DELETE FROM tmdb_cache WHERE ck=?", (ck,))
                return None
            return json.loads(row[0])

    def _cache_put(self, ck, obj):
        with self._lock, self._conn() as c:
            c.execute("INSERT OR REPLACE INTO tmdb_cache VALUES(?,?,?)",
                      (ck, json.dumps(obj, ensure_ascii=False), self.now()))

    def _cached(self, ck, fetch):
        v = self._cache_get(ck)
        if v is None:
            if getattr(self._tl, "offline", False):
                raise TmdbError("缓存里没有（离线模式）", code="offline")
            v = fetch()
            self._cache_put(ck, v)
        return v

    # ---- 状态 / 清理 ----
    def status(self):
        with self._lock, self._conn() as c:
            n_cache = c.execute("SELECT COUNT(*) FROM tmdb_cache").fetchone()[0]
            n_match = c.execute("SELECT COUNT(*) FROM matches").fetchone()[0]
            n_pin = c.execute("SELECT COUNT(*) FROM pins").fetchone()[0]
            oldest = c.execute("SELECT MIN(at) FROM tmdb_cache").fetchone()[0]
        n_img = size = 0
        for root, _d, files in os.walk(self.img_dir):
            for f in files:
                n_img += 1
                try:
                    size += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
        return {"token_configured": self.client.has_token(), "cached_responses": n_cache,
                "matches": n_match, "pins": n_pin, "images": n_img, "image_bytes": size,
                "oldest_cached_at": oldest, "ttl_days": TTL_SECONDS // 86400}

    def purge(self, everything=False):
        """清过期缓存（everything=True 清全部 TMDB 数据与图片）。手动锁定（pins，只含 id）永远保留。"""
        cutoff = self.now() - TTL_SECONDS
        with self._lock, self._conn() as c:
            if everything:
                r1 = c.execute("DELETE FROM tmdb_cache").rowcount
                r2 = c.execute("DELETE FROM matches").rowcount
            else:
                r1 = c.execute("DELETE FROM tmdb_cache WHERE at<?", (cutoff,)).rowcount
                r2 = c.execute("DELETE FROM matches WHERE at<?", (cutoff,)).rowcount
        imgs = 0
        for root, _d, files in os.walk(self.img_dir):
            for f in files:
                p = os.path.join(root, f)
                try:
                    if everything or os.path.getmtime(p) < cutoff:
                        os.remove(p)
                        imgs += 1
                except OSError:
                    pass
        return {"responses": r1, "matches": r2, "images": imgs}

    # ---- 图片（只接受 TMDB 的图片相对路径，永不取任意 URL）----
    def image(self, file_path, size):
        if size not in IMAGE_SIZES or not IMAGE_PATH_RE.match(file_path or ""):
            raise ValueError("图片参数不合法")
        h = hashlib.sha1(file_path.encode()).hexdigest()
        d = os.path.join(self.img_dir, size)
        p = os.path.join(d, h + os.path.splitext(file_path)[1])
        try:
            if self.now() - os.path.getmtime(p) <= TTL_SECONDS:
                with open(p, "rb") as f:
                    return f.read()
            os.remove(p)
        except OSError:
            pass
        data = self.client.get_image(size, file_path)
        os.makedirs(d, exist_ok=True)
        tmp = p + ".%s.tmp" % uuid.uuid4().hex[:6]
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, p)
        return data

    # ---- 搜索 / 选择 ----
    def _search(self, mt, query, year, lang="zh-CN"):
        ck = "search:%s:%s:%s:%s" % (mt, lang, year or "", query.casefold())
        return self._cached(ck, lambda: self.client.search(mt, query, lang, year)).get("results") or []

    def _pick(self, parsed):
        """返回 (best_or_None, alternatives)；每项 = {media_type, tmdb_id, score, ...}。"""
        cands = parsed["title_candidates"][:MAX_CANDIDATES]
        year = parsed.get("year")
        order = ["tv", "movie"] if parsed["kind"] == "episode" else ["movie", "tv"]
        scored = []
        for mi, mt in enumerate(order):
            if mi == 1 and scored and max(s["score"] for s in scored) >= 0.7:
                break
            seen = set()
            for cand in cands:
                res = self._search(mt, cand, year)
                if not res and year:
                    res = self._search(mt, cand, None)
                for r in res[:8]:
                    if r.get("id") in seen:
                        continue
                    seen.add(r.get("id"))
                    sc = title_score(cands, r, year)
                    if mi == 1:
                        sc -= 0.1               # 类型不符的轻微惩罚
                    scored.append({"media_type": mt, "tmdb_id": r["id"], "score": round(sc, 4),
                                   "title_zh": (r.get("title") or r.get("name") or "") if _has_cjk(r.get("title") or r.get("name")) else "",
                                   "title": r.get("title") or r.get("name") or "",
                                   "original_title": r.get("original_title") or r.get("original_name") or "",
                                   "year": (r.get("release_date") or r.get("first_air_date") or "")[:4],
                                   "poster_path": r.get("poster_path") or ""})
                if scored and max(s["score"] for s in scored) >= 0.95:
                    break
        scored.sort(key=lambda s: -s["score"])
        best = scored[0] if scored and scored[0]["score"] >= MATCH_MIN_SCORE else None
        if best:
            rival = next((x for x in scored[1:] if x["tmdb_id"] != best["tmdb_id"]
                          and x["media_type"] == best["media_type"]), None)
            if best["score"] < CONFIDENT_SCORE or (rival and best["score"] - rival["score"] < CLOSE_MARGIN):
                best = dict(best, needs_review=True)        # 低置信度 / 候选咬得太紧：给出暂定结果，但不自动锁定
        return best, scored[:6]

    # ---- 详情 ----
    def _details(self, mt, tmdb_id, lang):
        return self._cached("%s:%d:%s" % (mt, tmdb_id, lang), lambda: self.client.details(mt, tmdb_id, lang))

    def _season(self, tmdb_id, n, lang):
        return self._cached("season:%d:%d:%s" % (tmdb_id, n, lang), lambda: self.client.season(tmdb_id, n, lang))

    def _media_view(self, mt, tmdb_id):
        zh = self._details(mt, tmdb_id, "zh-CN")
        try:
            en = self._details(mt, tmdb_id, "en-US")
        except TmdbError as e:
            if e.code in ("no_token", "bad_token"):
                raise
            en = {}

        def pick(d, *ks):
            for k in ks:
                if d.get(k):
                    return d[k]
            return ""
        t_zh, t_en = pick(zh, "title", "name"), pick(en, "title", "name")
        title_zh = t_zh if _has_cjk(t_zh) else ""
        title_en = t_en or (t_zh if t_zh and not _has_cjk(t_zh) else "")
        date = pick(zh, "release_date", "first_air_date") or pick(en, "release_date", "first_air_date")
        return {
            "media_type": mt, "tmdb_id": tmdb_id,
            "title": title_zh or title_en or pick(zh, "original_title", "original_name"),
            "title_zh": title_zh, "title_en": title_en,
            "original_title": pick(zh, "original_title", "original_name") or pick(en, "original_title", "original_name"),
            "overview_zh": zh.get("overview") or "", "overview_en": en.get("overview") or "",
            "tagline_zh": zh.get("tagline") or "", "tagline_en": en.get("tagline") or "",
            "release_date": date, "year": date[:4],
            "poster_path": zh.get("poster_path") or en.get("poster_path") or "",
            "backdrop_path": zh.get("backdrop_path") or en.get("backdrop_path") or "",
            "vote_average": zh.get("vote_average") or 0,
            "genres_zh": [g.get("name") for g in zh.get("genres") or [] if g.get("name")],
            "genres_en": [g.get("name") for g in en.get("genres") or [] if g.get("name")],
            "runtime": zh.get("runtime") or (zh.get("episode_run_time") or [None])[0],
            "number_of_seasons": zh.get("number_of_seasons"),
            "seasons": [{"season_number": s.get("season_number"), "episode_count": s.get("episode_count"),
                         "poster_path": s.get("poster_path") or ""} for s in zh.get("seasons") or []],
        }

    def _episode_view(self, tmdb_id, season, episode):
        out = {"season": None, "episode": None}
        if season is None:
            return out
        zh = self._season(tmdb_id, season, "zh-CN")
        try:
            en = self._season(tmdb_id, season, "en-US")
        except TmdbError as e:
            if e.code in ("no_token", "bad_token"):
                raise
            en = {}
        out["season"] = {"number": season, "name_zh": zh.get("name") or "", "name_en": en.get("name") or "",
                         "overview_zh": zh.get("overview") or "", "overview_en": en.get("overview") or "",
                         "poster_path": zh.get("poster_path") or en.get("poster_path") or "",
                         "episodes": [{"number": e.get("episode_number"),
                                       "name_zh": e.get("name") or "",
                                       "name_en": next((x.get("name") for x in en.get("episodes") or []
                                                        if x.get("episode_number") == e.get("episode_number")), "") or "",
                                       "air_date": e.get("air_date") or "", "still_path": e.get("still_path") or ""}
                                      for e in zh.get("episodes") or []]}
        if episode is not None:
            ze = next((e for e in zh.get("episodes") or [] if e.get("episode_number") == episode), None)
            ee = next((e for e in en.get("episodes") or [] if e.get("episode_number") == episode), None)
            if ze or ee:
                ze, ee = ze or {}, ee or {}
                out["episode"] = {"number": episode, "name_zh": ze.get("name") or "",
                                  "name_en": ee.get("name") or "",
                                  "overview_zh": ze.get("overview") or "", "overview_en": ee.get("overview") or "",
                                  "air_date": ze.get("air_date") or ee.get("air_date") or "",
                                  "still_path": ze.get("still_path") or ee.get("still_path") or "",
                                  "runtime": ze.get("runtime") or ee.get("runtime")}
        return out

    def _assemble(self, key, parsed, group, status, source, ref, score, alternatives, updated):
        item = {"key": key, "group_key": group, "kind": parsed["kind"], "parsed": parsed,
                "pin_scope": getattr(self._tl, "pin_scope", None) if status == "pinned" else None,
                "status": status, "source": source, "score": score, "alternatives": alternatives,
                "media": None, "season": None, "episode": None,
                "updated_at": updated, "expires_at": (updated or self.now()) + TTL_SECONDS}
        if ref:
            media = self._media_view(ref["media_type"], int(ref["tmdb_id"]))
            item["media"] = media
            if ref["media_type"] == "tv":
                item.update(self._episode_view(int(ref["tmdb_id"]), parsed.get("season") if parsed.get("season") is not None else (1 if parsed.get("episode") is not None else None), parsed.get("episode")))
        return item

    # ---- 对外：match / item / pin ----
    def _get_row(self, table, key):
        with self._lock, self._conn() as c:
            return c.execute("SELECT body, at FROM %s WHERE key=?" % table, (key,)).fetchone()

    def _find_pin(self, key, group):
        for k in (key, group):
            if k:
                row = self._get_row("pins", k)
                if row:
                    self._tl.pin_scope = "video" if k == key else "group"
                    return json.loads(row[0]), row[1]
        return None, None

    def parse_key(self, key):
        fn, parents = names_from_key(key)
        parsed = parse_video(fn, parents)
        return parsed, group_key_for(key, parsed)

    def match(self, key, force=False):
        """按需刮削一个视频（可能联网，别在持锁处调用）。已锁定的永不被改写。"""
        parsed, group = self.parse_key(key)
        pin, at = self._find_pin(key, group)
        if pin:
            return self._assemble(key, parsed, group, "pinned", "pin", pin, 1.0, [], at)
        if not force:
            row = self._get_row("matches", key)
            if row and self.now() - row[1] <= TTL_SECONDS:
                m = json.loads(row[0])
                return self._assemble(key, parsed, group, m["status"], "auto", m.get("ref"),
                                      m.get("score", 0), m.get("alternatives", []), row[1])
        if not parsed["title_candidates"]:
            return self._assemble(key, parsed, group, "unmatched", "auto", None, 0, [], self.now())
        best, alts = self._pick(parsed)
        ref = {"media_type": best["media_type"], "tmdb_id": best["tmdb_id"]} if best else None
        status = ("needs_review" if best.get("needs_review") else "matched") if best else "unmatched"
        score = best["score"] if best else 0
        body = {"status": status, "ref": ref, "score": score, "alternatives": alts}
        with self._lock, self._conn() as c:
            c.execute("INSERT OR REPLACE INTO matches VALUES(?,?,?)",
                      (key, json.dumps(body, ensure_ascii=False), self.now()))
        return self._assemble(key, parsed, group, status, "auto", ref, score, alts, self.now())

    def item(self, key):
        """只读缓存，不联网拿搜索（详情过期则需要联网，失败时返回 None 而不是旧数据）。"""
        parsed, group = self.parse_key(key)
        pin, at = self._find_pin(key, group)
        self._tl.offline = True
        try:
            if pin:
                return self._assemble(key, parsed, group, "pinned", "pin", pin, 1.0, [], at)
            row = self._get_row("matches", key)
            if row and self.now() - row[1] <= TTL_SECONDS:
                m = json.loads(row[0])
                return self._assemble(key, parsed, group, m["status"], "auto", m.get("ref"),
                                      m.get("score", 0), m.get("alternatives", []), row[1])
        except TmdbError:
            return None
        finally:
            self._tl.offline = False
        return None

    def peek(self, key):
        """列表页用：只解析 + 读缓存，绝不联网。返回精简信息。"""
        parsed, group = self.parse_key(key)
        it = self.item(key)
        return {"key": key, "group_key": group, "parsed": parsed, "item": brief(it) if it else None}

    def search_manual(self, query, year=None, media_type="movie"):
        """「修正匹配」用：按用户输入的文本搜 TMDB（仍然只代理搜索，结果精简）。"""
        q = str(query or "").strip()
        if not q or len(q) > 100 or any(ord(c) < 32 for c in q):
            raise ValueError("搜索词不合法")
        if media_type not in ("movie", "tv"):
            raise ValueError("media_type 必须是 movie 或 tv")
        y = None
        if year not in (None, "", 0):
            if isinstance(year, bool) or not str(year).isdigit() or not 1880 <= int(year) <= 2100:
                raise ValueError("年份不合法")
            y = int(year)
        res = self._search(media_type, q, y)
        out = []
        for r in res[:12]:
            t = r.get("title") or r.get("name") or ""
            out.append({"media_type": media_type, "tmdb_id": r.get("id"), "title": t,
                        "title_zh": t if _has_cjk(t) else "",
                        "original_title": r.get("original_title") or r.get("original_name") or "",
                        "year": (r.get("release_date") or r.get("first_air_date") or "")[:4],
                        "poster_path": r.get("poster_path") or "", "overview": (r.get("overview") or "")[:160]})
        return out

    def pin(self, key, media_type, tmdb_id, scope="auto"):
        """用户指定正确的条目。电视剧默认锁整个系列目录（group），电影锁单个视频。tmdb_id=None 取消锁定。"""
        parsed, group = self.parse_key(key)
        target = key
        if scope == "group" or (scope == "auto" and parsed["kind"] == "episode" and group):
            if not group:
                raise ValueError("该视频没有可用的系列目录，请用 scope=video")
            target = group
        elif scope not in ("auto", "video", "group"):
            raise ValueError("scope 不合法")
        if tmdb_id is None:
            with self._lock, self._conn() as c:
                c.execute("DELETE FROM pins WHERE key=?", (target,))
            return None
        if media_type not in ("movie", "tv"):
            raise ValueError("media_type 必须是 movie 或 tv")
        if isinstance(tmdb_id, bool) or not isinstance(tmdb_id, int) or not (0 < tmdb_id < 10 ** 9):
            raise ValueError("tmdb_id 不合法")
        ref = {"media_type": media_type, "tmdb_id": tmdb_id}
        self._tl.pin_scope = "group" if target != key else "video"
        item = self._assemble(key, parsed, group, "pinned", "pin", ref, 1.0, [], self.now())   # 先验证能取到，再落盘
        with self._lock, self._conn() as c:
            c.execute("INSERT OR REPLACE INTO pins VALUES(?,?,?)", (target, json.dumps(ref), self.now()))
        return item

    # ---- 批量任务（后台线程，轮询进度）----
    def start_scan(self, keys):
        with self._job_lock:
            if any(j["state"] == "running" for j in self._jobs.values()):
                raise RuntimeError("已有刮削任务在运行")
            jid = uuid.uuid4().hex[:12]
            job = {"id": jid, "state": "running", "total": len(keys), "done": 0, "matched": 0,
                   "needs_review": 0, "unmatched": 0, "failed": 0, "last_error": "", "cancel": False,
                   "queue": [{"key": k, "state": "pending"} for k in keys[:2000]]}
            self._jobs[jid] = job
            for old in list(self._jobs)[:-10]:
                if self._jobs[old]["state"] != "running":
                    del self._jobs[old]
        threading.Thread(target=self._run_scan, args=(job, list(keys)), daemon=True, name="iv-scrape").start()
        return jid

    def _run_scan(self, job, keys):
        try:
            for idx, k in enumerate(keys):
                if job["cancel"]:
                    break
                q = job["queue"][idx] if idx < len(job["queue"]) else {}
                try:
                    it = self.match(k)
                    st = "matched" if it["status"] in ("matched", "pinned") else it["status"]
                    job[st] += 1
                    q["state"] = st                # matched | needs_review | unmatched
                except TmdbError as e:
                    job["failed"] += 1
                    q["state"] = "failed"
                    job["last_error"] = str(e)
                    if e.code in ("no_token", "bad_token"):
                        break
                except Exception as e:
                    job["failed"] += 1
                    q["state"] = "failed"
                    job["last_error"] = type(e).__name__
                job["done"] += 1
        finally:
            job["state"] = "done"

    def job(self, jid):
        with self._job_lock:
            j = self._jobs.get(jid)
            return {k: v for k, v in j.items() if k != "cancel"} if j else None

    def cancel_job(self, jid):
        with self._job_lock:
            if jid in self._jobs:
                self._jobs[jid]["cancel"] = True


def brief(item):
    """列表 / 海报墙用的精简条目（不含整季分集）。"""
    if not item:
        return None
    m = item.get("media") or {}
    return {"status": item["status"], "source": item["source"], "score": item["score"],
            "pin_scope": item.get("pin_scope"), "group_key": item.get("group_key"),
            "media": {k: m.get(k) for k in ("media_type", "tmdb_id", "title", "title_zh", "title_en", "year",
                                            "poster_path", "vote_average", "number_of_seasons")} if m else None}


class _Conn:
    """sqlite 连接的小包装：with 结束时提交并真正关闭（sqlite3 自带的 with 不关）。"""

    def __init__(self, c):
        self.c = c

    def __enter__(self):
        return self.c

    def __exit__(self, et, ev, tb):
        try:
            if et is None:
                self.c.commit()
            else:
                self.c.rollback()
        finally:
            self.c.close()
        return False
