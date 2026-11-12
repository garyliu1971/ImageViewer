#!/usr/bin/env python3
"""PyReader / ImageViewer OCR proxy (POST /ocr/v1/page).

Stdlib ThreadingHTTPServer on 127.0.0.1:8091. Receives one base64 JPEG page image, forwards it to
DashScope (OpenAI-compatible chat/completions, vision model) with a FIXED server-side prompt, and returns
the transcribed text. Same auth style as the TTS proxy (Bearer token -> sha256 -> user table).

Secrets come from the environment only (systemd EnvironmentFile). Logs metadata only: never images,
recognised text, tokens or the API key.
"""
import base64
import binascii
import hashlib
import json
import logging
import os
import re
import socket
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

log = logging.getLogger("ocr")

PROMPT_VER = 1

# Server-held prompts. The client can only pick a key from this table (never send free text), so the
# token cannot be used as a general-purpose VLM.
#
# Small double-line annotations (双行小注) are READ ALOUD (owner decision 2026-11-12): they are transcribed
# inline at their natural reading position and wrapped in 【注：……】. The wrapper is a plain bracket pair, so
# the client sentence splitter needs no change (it just sees extra punctuation), the TTS says "注" as an
# audible cue, and a later client option can still strip/skip them with /【注：[^】]*】/g.
PROMPTS = {
    "vertical-classical": (
        "你是古籍文字转写器。逐字忠实转写图中的文字，不得翻译、简化、改写，也不得补写缺字（看不清的字用□）。"
        "繁体竖排：列序从右到左，每列从上到下。"
        "忽略版心栏（书口、鱼尾、书名、卷次）和页码。"
        "正文中的双行小字注文要保留并朗读：按其在正文中的自然阅读位置原样逐字转写，并用【注：……】括起来"
        "（一段注文分在多处时，每一处各自括起）。"
        "在不改动原字的前提下，按文意加入现代标点（，。、；：？！「」）。"
        "只输出转写出的文字，不要任何解释、标题或前后缀；若页面没有文字，输出空。"
    ),
    "horizontal": (
        "你是文字转写器。逐字忠实转写图中的文字，不得翻译、改写，也不得补写缺字（看不清的字用□）。"
        "按正常阅读顺序输出，忽略页眉页脚和页码。"
        "正文中的小字注文要保留并朗读：按其在正文中的自然阅读位置原样转写，并用【注：……】括起来。"
        "只输出转写出的文字，不要任何解释、标题或前后缀；若页面没有文字，输出空。"
    ),
}

REFUSAL_RE = re.compile(
    r"^\s*(抱歉|对不起|很抱歉|无法|我无法|我不能|不能为|sorry|i'?m sorry|i am sorry|i can(?:'|no)t|i cannot|as an ai)",
    re.IGNORECASE)
PAGEID_RE = re.compile(r"^[A-Za-z0-9:_.\-]{1,100}$")


def _f(name, default):
    return float(os.environ.get(name, default))


class Config:
    """All tunables; built from env in production, passed explicitly in tests."""

    def __init__(self, **kw):
        e = os.environ.get
        self.host = e("OCR_HOST", "127.0.0.1")
        self.port = int(e("OCR_PORT", "8091"))
        self.data_dir = e("OCR_DATA_DIR", "/var/lib/pyreader-ocr")
        self.cache_dir = e("OCR_CACHE_DIR", "/var/cache/pyreader-ocr")
        self.tokens_file = e("OCR_TOKENS_FILE", "/etc/pyreader-ocr/tokens.json")
        self.allowed_users = {u.strip() for u in e("OCR_ALLOWED_USERS", "gary,qian").split(",") if u.strip()}
        self.api_key = e("DASHSCOPE_API_KEY", "")
        self.upstream_url = e("OCR_UPSTREAM_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions")
        self.model = e("OCR_MODEL", "qwen3.8-flash")
        self.limit_day = int(e("OCR_LIMIT_DAY", "300"))        # pages / user / day
        self.limit_month = int(e("OCR_LIMIT_MONTH", "6000"))   # pages / user / month
        self.rate_per_sec = _f("OCR_RATE_PER_SEC", "0.5")      # 1 request / 2 s
        self.rate_burst = _f("OCR_RATE_BURST", "3")
        self.max_user_concurrency = int(e("OCR_USER_CONCURRENCY", "2"))
        self.max_global_concurrency = int(e("OCR_GLOBAL_CONCURRENCY", "3"))
        self.max_body = int(e("OCR_MAX_BODY", str(2 * 1024 * 1024)))
        self.max_image_bytes = int(e("OCR_MAX_IMAGE_BYTES", str(1200 * 1024)))
        self.max_edge = int(e("OCR_MAX_EDGE", "2048"))
        self.upstream_timeout = _f("OCR_UPSTREAM_TIMEOUT", "25")
        self.retry_delay = _f("OCR_RETRY_DELAY", "0.5")
        self.max_tokens = int(e("OCR_MAX_TOKENS", "1500"))
        self.cache_max_bytes = int(e("OCR_CACHE_MAX_BYTES", str(50 * 1024 * 1024)))
        for k, v in kw.items():
            if not hasattr(self, k):
                raise AttributeError(k)
            setattr(self, k, v)


def now_utc():
    return datetime.now(timezone.utc)


def secs_to_next_day():
    n = now_utc()
    return int((n.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1) - n).total_seconds()) + 1


def secs_to_next_month():
    n = now_utc()
    first = (n.replace(day=1, hour=0, minute=0, second=0, microsecond=0) + timedelta(days=32)).replace(day=1)
    return int((first - n).total_seconds()) + 1


class Quota:
    """Per-user daily + monthly page counters in one JSON file (atomic replace)."""

    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.users = {}
        try:
            with open(path, "r", encoding="utf-8") as f:
                self.users = json.load(f).get("users", {})
        except (OSError, ValueError, AttributeError):
            pass

    def _u(self, user):
        n = now_utc()
        d, m = n.strftime("%Y-%m-%d"), n.strftime("%Y-%m")
        u = self.users.setdefault(user, {"day": d, "day_used": 0, "month": m, "month_used": 0})
        if u.get("day") != d:
            u["day"], u["day_used"] = d, 0
        if u.get("month") != m:
            u["month"], u["month_used"] = m, 0
        return u

    def snapshot(self, user):
        with self.lock:
            u = self._u(user)
            return u["day_used"], u["month_used"]

    def commit(self, user, pages=1):
        with self.lock:
            u = self._u(user)
            u["day_used"] += pages
            u["month_used"] += pages
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"users": self.users}, f)
            os.replace(tmp, self.path)


class Limiter:
    def __init__(self, per_sec, burst):
        self.per_sec, self.burst = per_sec, burst
        self.lock = threading.Lock()
        self.b = {}

    def allow(self, user):
        with self.lock:
            t = time.monotonic()
            tokens, last = self.b.get(user, (self.burst, t))
            tokens = min(self.burst, tokens + (t - last) * self.per_sec)
            if tokens < 1:
                self.b[user] = (tokens, t)
                return False
            self.b[user] = (tokens - 1, t)
            return True


class ResultCache:
    """Disk cache of recognised text keyed by sha256(image|model|promptVer|mode); size-capped LRU by mtime."""

    def __init__(self, d, max_bytes):
        self.d, self.max_bytes = d, max_bytes
        self.lock = threading.Lock()
        os.makedirs(d, exist_ok=True)

    def key(self, img, model, mode):
        h = hashlib.sha256(img)
        h.update(("|%s|%d|%s" % (model, PROMPT_VER, mode)).encode("utf-8"))
        return h.hexdigest()

    def get(self, k):
        p = os.path.join(self.d, k + ".json")
        try:
            with open(p, "r", encoding="utf-8") as f:
                v = json.load(f)
            os.utime(p, None)
            return v
        except (OSError, ValueError):
            return None

    def put(self, k, v):
        p = os.path.join(self.d, k + ".json")
        tmp = p + ".tmp%d" % threading.get_ident()
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(v, f, ensure_ascii=False)
        os.replace(tmp, p)
        self._evict()

    def _evict(self):
        with self.lock:
            files, total = [], 0
            for n in os.listdir(self.d):
                fp = os.path.join(self.d, n)
                try:
                    st = os.stat(fp)
                except OSError:
                    continue
                files.append((st.st_mtime, st.st_size, fp))
                total += st.st_size
            if total <= self.max_bytes:
                return
            files.sort()
            for _, size, fp in files:
                if total <= self.max_bytes * 0.9:
                    break
                try:
                    os.remove(fp)
                    total -= size
                except OSError:
                    pass


def jpeg_dims(b):
    """Return (width, height) from the first SOF marker, or None if b is not a well-formed-enough JPEG.
    Only walks marker headers; never decodes pixel data."""
    if len(b) < 4 or b[0] != 0xFF or b[1] != 0xD8 or b[2] != 0xFF:
        return None
    i, n = 2, len(b)
    while i + 4 <= n:
        if b[i] != 0xFF:
            return None
        m = b[i + 1]
        if m == 0xFF:
            i += 1
            continue
        if m in (0xD8, 0x01) or 0xD0 <= m <= 0xD7:
            i += 2
            continue
        if m == 0xD9 or m == 0xDA:
            return None  # end / scan reached before any SOF
        seglen = (b[i + 2] << 8) | b[i + 3]
        if seglen < 2:
            return None
        if m in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            if i + 9 > n:
                return None
            h = (b[i + 5] << 8) | b[i + 6]
            w = (b[i + 7] << 8) | b[i + 8]
            return (w, h) if w > 0 and h > 0 else None
        i += 2 + seglen
    return None


def split_sentences(text):
    out, cur = [], ""
    for ch in text:
        cur += ch
        if ch in "。！？；!?;\n":
            if cur.strip():
                out.append(cur.strip())
            cur = ""
    if cur.strip():
        out.append(cur.strip())
    return out


class UpstreamError(Exception):
    def __init__(self, status, code, http_status=None):
        super().__init__(code)
        self.status, self.code, self.http_status = status, code, http_status


def call_upstream(cfg, data_uri, mode):
    """One DashScope call (with one retry on 5xx / timeout / connection error). Returns (text, usage_dict)."""
    body = json.dumps({
        "model": cfg.model,
        "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": data_uri}},
            {"type": "text", "text": PROMPTS[mode]}]}],
        "enable_thinking": False,
        "temperature": 0,
        "max_tokens": cfg.max_tokens,
    }).encode("utf-8")
    last = None
    for attempt in range(2):
        if attempt:
            time.sleep(cfg.retry_delay)
        req = urllib.request.Request(cfg.upstream_url, data=body, method="POST", headers={
            "Authorization": "Bearer " + cfg.api_key, "Content-Type": "application/json",
            "User-Agent": "pyreader-ocr-proxy"})
        try:
            with urllib.request.urlopen(req, timeout=cfg.upstream_timeout) as r:
                payload = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                eb = e.read(4096).decode("utf-8", "replace")
            except Exception:
                eb = ""
            if "data_inspection_failed" in eb or "content_filter" in eb:
                raise UpstreamError(422, "refused", e.code)
            last = UpstreamError(502, "upstream_error", e.code)
            if e.code >= 500:
                continue
            raise last
        except (socket.timeout, TimeoutError):
            last = UpstreamError(504, "upstream_timeout")
            continue
        except urllib.error.URLError as e:
            if isinstance(getattr(e, "reason", None), (socket.timeout, TimeoutError)):
                last = UpstreamError(504, "upstream_timeout")
            else:
                last = UpstreamError(502, "upstream_error")
            continue
        except (ValueError, OSError):
            last = UpstreamError(502, "upstream_error")
            continue
        try:
            ch = payload["choices"][0]
            content = ch["message"]["content"]
            finish = ch.get("finish_reason")
        except (KeyError, IndexError, TypeError):
            raise UpstreamError(502, "upstream_error")
        if finish == "content_filter":
            raise UpstreamError(422, "refused")
        if content is None:
            content = ""
        if not isinstance(content, str):
            raise UpstreamError(502, "upstream_error")
        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
        return content, usage
    raise last


def clean_text(t):
    t = t.strip()
    m = re.match(r"^```[a-zA-Z]*\n(.*?)\n?```$", t, re.DOTALL)
    if m:
        t = m.group(1).strip()
    return t


def looks_like_refusal(t):
    return len(t) <= 80 and bool(REFUSAL_RE.match(t))


class OcrServer:
    def __init__(self, cfg, tokens):
        self.cfg = cfg
        self.tokens = tokens  # {sha256hex: user}
        os.makedirs(cfg.data_dir, exist_ok=True)
        self.quota = Quota(os.path.join(cfg.data_dir, "usage.json"))
        self.limiter = Limiter(cfg.rate_per_sec, cfg.rate_burst)
        self.cache = ResultCache(cfg.cache_dir, cfg.cache_max_bytes)
        self.global_sem = threading.BoundedSemaphore(cfg.max_global_concurrency)
        self.user_active = {}
        self.user_lock = threading.Lock()
        self.httpd = None

    def acquire_user(self, user):
        with self.user_lock:
            if self.user_active.get(user, 0) >= self.cfg.max_user_concurrency:
                return False
            self.user_active[user] = self.user_active.get(user, 0) + 1
            return True

    def release_user(self, user):
        with self.user_lock:
            self.user_active[user] -= 1

    def make_httpd(self):
        srv = self
        cfg = self.cfg

        class H(BaseHTTPRequestHandler):
            server_version = "pyreader-ocr"
            protocol_version = "HTTP/1.1"
            timeout = 30

            def log_message(self, *a):
                pass

            def _send(self, code, body=b"", extra=None):
                if isinstance(body, (dict, list)):
                    body = json.dumps(body, ensure_ascii=False).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Cache-Control", "no-store")
                for k, v in (extra or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)

            def _err(self, status, code, msg, retry_after=None):
                b = {"error": msg, "code": code}
                extra = None
                if retry_after is not None:
                    b["retryAfter"] = retry_after
                    extra = {"Retry-After": str(retry_after)}
                return self._send(status, b, extra)

            def _route(self):
                p = self.path.split("?", 1)[0]
                if p.startswith("/ocr/"):
                    p = p[4:]
                return p

            def _auth(self):
                h = self.headers.get("Authorization", "")
                if not h.startswith("Bearer "):
                    return None
                return srv.tokens.get(hashlib.sha256(h[7:].strip().encode("utf-8")).hexdigest())

            def do_GET(self):
                if self._route() != "/v1/usage":
                    return self._err(404, "not_found", "not found")
                user = self._auth()
                if not user:
                    return self._err(401, "unauthorized", "unauthorized")
                if user not in cfg.allowed_users:
                    return self._err(403, "not_enabled", "OCR is not enabled for this token")
                d, m = srv.quota.snapshot(user)
                return self._send(200, {"pagesToday": d, "pagesLimit": cfg.limit_day,
                                        "pagesMonth": m, "monthLimit": cfg.limit_month, "model": cfg.model})

            def do_POST(self):
                t0 = time.monotonic()
                if self._route() != "/v1/page":
                    return self._err(404, "not_found", "not found")
                user = self._auth()
                if not user:
                    self.close_connection = True
                    return self._err(401, "unauthorized", "unauthorized")
                if user not in cfg.allowed_users:
                    self.close_connection = True
                    return self._err(403, "not_enabled", "OCR is not enabled for this token")
                if not srv.limiter.allow(user):
                    self.close_connection = True
                    return self._err(429, "rate_limited", "rate limited", 2)
                try:
                    n = int(self.headers.get("Content-Length", "-1"))
                except ValueError:
                    n = -1
                if n < 0 or n > cfg.max_body:
                    self.close_connection = True
                    return self._err(413, "too_large", "body too large")
                raw = self.rfile.read(n)
                try:
                    req = json.loads(raw.decode("utf-8"))
                    img_b64, mime = req["image"], req.get("mime", "image/jpeg")
                    mode = req.get("mode", "vertical-classical")
                    page_id = req.get("pageId", "-")
                    if not isinstance(img_b64, str) or not isinstance(mode, str) or not isinstance(page_id, str):
                        raise ValueError
                except (ValueError, KeyError, UnicodeDecodeError, TypeError, AttributeError):
                    return self._err(400, "bad_request", "bad request")
                if mode not in PROMPTS:
                    return self._err(400, "bad_mode", "unknown mode")
                if not PAGEID_RE.match(page_id):
                    page_id = "-"  # never echo untrusted text into logs
                if mime != "image/jpeg":
                    return self._err(415, "bad_image", "only image/jpeg is accepted")
                try:
                    img = base64.b64decode(img_b64, validate=True)
                except (binascii.Error, ValueError):
                    return self._err(415, "bad_image", "invalid base64")
                if len(img) > cfg.max_image_bytes:
                    return self._err(413, "too_large", "image too large")
                dims = jpeg_dims(img)
                if dims is None:
                    return self._err(415, "bad_image", "not a JPEG")
                if max(dims) > cfg.max_edge:
                    return self._err(413, "too_large", "image dimensions too large")

                day_used, month_used = srv.quota.snapshot(user)
                ck = srv.cache.key(img, cfg.model, mode)
                hit = srv.cache.get(ck)
                if hit is not None:
                    log.info("page user=%s page=%s bytes=%d status=200 cached=1 ms=%d",
                             user, page_id, len(img), (time.monotonic() - t0) * 1000)
                    return self._send(200, self._ok(hit["text"], mode, 0, 0, day_used, month_used, True))
                if day_used >= cfg.limit_day:
                    ra = secs_to_next_day()
                    return self._err(429, "daily_cap", "daily page quota exceeded", ra)
                if month_used >= cfg.limit_month:
                    ra = secs_to_next_month()
                    return self._err(429, "monthly_cap", "monthly page quota exceeded", ra)
                if not cfg.api_key:
                    log.error("DASHSCOPE_API_KEY not configured")
                    return self._err(502, "upstream_error", "upstream not configured")
                if not srv.acquire_user(user):
                    return self._err(429, "busy", "too many concurrent requests", 2)
                if not srv.global_sem.acquire(blocking=False):
                    srv.release_user(user)
                    return self._err(429, "busy", "server busy", 3)
                try:
                    data_uri = "data:image/jpeg;base64," + img_b64
                    try:
                        text, usage = call_upstream(cfg, data_uri, mode)
                    except UpstreamError as e:
                        log.warning("page user=%s page=%s bytes=%d status=%d code=%s up=%s ms=%d", user, page_id,
                                    len(img), e.status, e.code, e.http_status, (time.monotonic() - t0) * 1000)
                        if e.status == 422:
                            return self._err(422, "refused", "the model refused or content was filtered")
                        if e.status == 504:
                            return self._err(504, "upstream_timeout", "upstream timeout")
                        return self._err(502, "upstream_error", "upstream error")
                finally:
                    srv.global_sem.release()
                    srv.release_user(user)
                text = clean_text(text)
                if looks_like_refusal(text):
                    log.warning("page user=%s page=%s bytes=%d status=422 code=refused(text)", user, page_id, len(img))
                    return self._err(422, "refused", "the model refused or content was filtered")
                try:
                    srv.cache.put(ck, {"text": text})
                except OSError as e:
                    log.warning("cache put failed: %s", type(e).__name__)
                srv.quota.commit(user)
                pt, ct = int(usage.get("prompt_tokens", 0) or 0), int(usage.get("completion_tokens", 0) or 0)
                log.info("page user=%s page=%s bytes=%d ptok=%d ctok=%d status=200 cached=0 ms=%d",
                         user, page_id, len(img), pt, ct, (time.monotonic() - t0) * 1000)
                self._send(200, self._ok(text, mode, pt, ct, day_used + 1, month_used + 1, False))

            def _ok(self, text, mode, pt, ct, day, month, cached):
                return {"text": text, "sentences": split_sentences(text), "model": cfg.model,
                        "promptVer": PROMPT_VER, "mode": mode, "cached": cached,
                        "usage": {"promptTokens": pt, "completionTokens": ct, "pagesToday": day,
                                  "pagesLimit": cfg.limit_day, "pagesMonth": month, "monthLimit": cfg.limit_month}}

        httpd = ThreadingHTTPServer((cfg.host, cfg.port), H)
        httpd.daemon_threads = True
        self.httpd = httpd
        return httpd


def load_tokens(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)  # {sha256hex: user}


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = Config()
    s = OcrServer(cfg, load_tokens(cfg.tokens_file))
    httpd = s.make_httpd()
    log.info("listening %s:%d model=%s key=%s allowed=%s day=%d month=%d", cfg.host, cfg.port, cfg.model,
             bool(cfg.api_key), ",".join(sorted(cfg.allowed_users)), cfg.limit_day, cfg.limit_month)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
