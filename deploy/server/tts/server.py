#!/usr/bin/env python3
"""PyReader TTS proxy. Stdlib HTTP server; Azure Speech REST primary, edge-tts fallback.

Binds 127.0.0.1 only. Secrets come from the environment (systemd EnvironmentFile).
Logs metadata only (never text).
"""
import asyncio
import hashlib
import json
import logging
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from xml.sax.saxutils import escape

VENDOR = os.environ.get("TTS_VENDOR_DIR", "")
if VENDOR and VENDOR not in sys.path:
    sys.path.insert(0, VENDOR)

HOST = os.environ.get("TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("TTS_PORT", "8090"))
DATA_DIR = os.environ.get("TTS_DATA_DIR", "/var/lib/pyreader-tts")
CACHE_DIR = os.environ.get("TTS_CACHE_DIR", "/var/cache/pyreader-tts")
TOKENS_FILE = os.environ.get("TTS_TOKENS_FILE", "/etc/pyreader-tts/tokens.json")
AZURE_KEY = os.environ.get("AZURE_SPEECH_KEY", "")
AZURE_REGION = os.environ.get("AZURE_SPEECH_REGION", "eastasia")
MAX_CHARS = 200
LIMIT_DAY = int(os.environ.get("TTS_LIMIT_DAY", "150000"))      # billable chars/user/day
LIMIT_MONTH = int(os.environ.get("TTS_LIMIT_MONTH", "450000"))  # billable chars/month, Azure only
CACHE_MAX_BYTES = int(os.environ.get("TTS_CACHE_MAX_BYTES", str(1024 ** 3)))
FALLBACK_ENABLED = os.environ.get("TTS_FALLBACK_EDGE", "1") == "1"
FORCE_FALLBACK = os.environ.get("TTS_FORCE_FALLBACK", "0") == "1"  # test switch: skip Azure
RATE_PER_SEC = float(os.environ.get("TTS_RATE_PER_SEC", "5"))
RATE_BURST = float(os.environ.get("TTS_RATE_BURST", "10"))
MAX_BODY = 4096

VOICES = [
    ("zh-CN-XiaoxiaoNeural", "Xiaoxiao", "zh-CN", "Female"),
    ("zh-CN-XiaoyiNeural", "Xiaoyi", "zh-CN", "Female"),
    ("zh-CN-YunxiNeural", "Yunxi", "zh-CN", "Male"),
    ("zh-CN-YunyangNeural", "Yunyang", "zh-CN", "Male"),
    ("zh-CN-YunjianNeural", "Yunjian", "zh-CN", "Male"),
    ("zh-TW-HsiaoChenNeural", "HsiaoChen", "zh-TW", "Female"),
    ("en-US-JennyNeural", "Jenny", "en-US", "Female"),
    ("en-US-AriaNeural", "Aria", "en-US", "Female"),
    ("en-US-GuyNeural", "Guy", "en-US", "Male"),
    ("en-GB-SoniaNeural", "Sonia", "en-GB", "Female"),
    ("en-GB-RyanNeural", "Ryan", "en-GB", "Male"),
]
VOICE_IDS = {v[0] for v in VOICES}

log = logging.getLogger("tts")


def billable(text):
    """Azure bills CJK characters as 2 chars each."""
    n = 0
    for ch in text:
        o = ord(ch)
        n += 2 if (0x2E80 <= o <= 0x9FFF or 0xAC00 <= o <= 0xD7AF or 0xF900 <= o <= 0xFAFF
                   or 0x3040 <= o <= 0x30FF or 0xFF00 <= o <= 0xFFEF) else 1
    return n


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
    """Persistent counters in one JSON file (atomic replace)."""

    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.s = {"month": "", "azure_month": 0, "edge_month": 0, "users": {}}
        try:
            with open(path, "r", encoding="utf-8") as f:
                self.s.update(json.load(f))
        except (OSError, ValueError):
            pass

    def _roll(self):
        n = now_utc()
        m, d = n.strftime("%Y-%m"), n.strftime("%Y-%m-%d")
        if self.s["month"] != m:
            self.s["month"], self.s["azure_month"], self.s["edge_month"] = m, 0, 0
        for u in self.s["users"].values():
            if u.get("day") != d:
                u["day"], u["used"] = d, 0
        return d

    def _save(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.s, f)
        os.replace(tmp, self.path)

    def _user(self, user, d):
        return self.s["users"].setdefault(user, {"day": d, "used": 0})

    def snapshot(self, user):
        with self.lock:
            d = self._roll()
            return self._user(user, d)["used"], self.s["azure_month"]

    def reserve_check(self, user, cost):
        """Return (ok_day, azure_ok)."""
        with self.lock:
            d = self._roll()
            used = self._user(user, d)["used"]
            return used + cost <= LIMIT_DAY, self.s["azure_month"] + cost <= LIMIT_MONTH

    def commit(self, user, cost, backend):
        with self.lock:
            d = self._roll()
            self._user(user, d)["used"] += cost
            self.s["azure_month" if backend == "azure" else "edge_month"] += cost
            self._save()


class Limiter:
    def __init__(self):
        self.lock = threading.Lock()
        self.b = {}

    def allow(self, user):
        with self.lock:
            t = time.monotonic()
            tokens, last = self.b.get(user, (RATE_BURST, t))
            tokens = min(RATE_BURST, tokens + (t - last) * RATE_PER_SEC)
            if tokens < 1:
                self.b[user] = (tokens, t)
                return False
            self.b[user] = (tokens - 1, t)
            return True


class Cache:
    def __init__(self, d):
        self.d = d
        self.lock = threading.Lock()
        os.makedirs(d, exist_ok=True)

    def path(self, voice, rate, text):
        h = hashlib.sha256(f"{voice}|{rate}|{text}".encode("utf-8")).hexdigest()
        return os.path.join(self.d, h[:2], h + ".mp3")

    def get(self, p):
        try:
            with open(p, "rb") as f:
                data = f.read()
            os.utime(p, None)
            return data
        except OSError:
            return None

    def put(self, p, data):
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".tmp%d" % threading.get_ident()
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, p)
        self._evict()

    def _evict(self):
        with self.lock:
            files, total = [], 0
            for root, _, names in os.walk(self.d):
                for n in names:
                    fp = os.path.join(root, n)
                    try:
                        st = os.stat(fp)
                    except OSError:
                        continue
                    files.append((st.st_mtime, st.st_size, fp))
                    total += st.st_size
            if total <= CACHE_MAX_BYTES:
                return
            files.sort()
            for _, size, fp in files:
                if total <= CACHE_MAX_BYTES * 0.9:
                    break
                try:
                    os.remove(fp)
                    total -= size
                except OSError:
                    pass


def pct(rate):
    r = int(round(rate))
    return f"{r:+d}%"


def azure_synth(text, voice, rate):
    lang = voice.split("-")[0] + "-" + voice.split("-")[1]
    ssml = (f"<speak version='1.0' xml:lang='{lang}'><voice name='{voice}'>"
            f"<prosody rate='{pct(rate)}'>{escape(text)}</prosody></voice></speak>")
    req = urllib.request.Request(
        f"https://{AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1",
        data=ssml.encode("utf-8"), method="POST",
        headers={"Ocp-Apim-Subscription-Key": AZURE_KEY,
                 "Content-Type": "application/ssml+xml",
                 "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
                 "User-Agent": "pyreader-tts-proxy"})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = r.read()
    if len(data) < 100:
        raise RuntimeError("empty audio")
    return data


def edge_synth(text, voice, rate):
    import edge_tts

    async def run():
        out = bytearray()
        async for ch in edge_tts.Communicate(text, voice, rate=pct(rate)).stream():
            if ch["type"] == "audio":
                out += ch["data"]
        return bytes(out)

    data = asyncio.run(asyncio.wait_for(run(), 20))
    if len(data) < 100:
        raise RuntimeError("empty audio")
    return data


quota = Quota(os.path.join(DATA_DIR, "usage.json"))
limiter = Limiter()
cache = None
tokens = {}
upstream_sem = threading.BoundedSemaphore(4)


def load_tokens():
    global tokens
    with open(TOKENS_FILE, "r", encoding="utf-8") as f:
        tokens = json.load(f)  # {sha256hex: user}


def active_backend():
    _, azm = quota.snapshot("_")
    if FORCE_FALLBACK or not AZURE_KEY or azm >= LIMIT_MONTH:
        return "edge-tts" if FALLBACK_ENABLED else "none"
    return "azure"


class H(BaseHTTPRequestHandler):
    server_version = "pyreader-tts"
    protocol_version = "HTTP/1.1"
    timeout = 20

    def log_message(self, *a):  # silence default access log
        pass

    def _send(self, code, body=b"", ctype="application/json", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _route(self):
        p = self.path.split("?", 1)[0]
        if p.startswith("/tts/"):
            p = p[4:]
        return p

    def _auth(self):
        h = self.headers.get("Authorization", "")
        if not h.startswith("Bearer "):
            return None
        d = hashlib.sha256(h[7:].strip().encode("utf-8")).hexdigest()
        return tokens.get(d)

    def do_GET(self):
        p = self._route()
        if p == "/v1/voices":
            return self._send(200, [{"id": i, "name": n, "lang": l, "gender": g} for i, n, l, g in VOICES],
                              extra={"Cache-Control": "public, max-age=3600"})
        if p == "/v1/usage":
            user = self._auth()
            if not user:
                return self._send(401, {"error": "unauthorized"})
            ut, um = quota.snapshot(user)
            return self._send(200, {"usedToday": ut, "limitToday": LIMIT_DAY, "usedMonth": um,
                                    "limitMonth": LIMIT_MONTH, "backend": active_backend()})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        t0 = time.monotonic()
        if self._route() != "/v1/speak":
            return self._send(404, {"error": "not found"})
        user = self._auth()
        if not user:
            return self._send(401, {"error": "unauthorized"})
        if not limiter.allow(user):
            return self._send(429, {"error": "rate limited", "retryAfter": 1}, extra={"Retry-After": "1"})
        try:
            n = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            n = -1
        if n < 0 or n > MAX_BODY:
            self.close_connection = True
            return self._send(413, {"error": "body too large"})
        try:
            req = json.loads(self.rfile.read(n).decode("utf-8"))
            text, voice = req["text"], req["voice"]
            rate = req.get("rate", 0)
            if not isinstance(text, str) or not isinstance(voice, str) or isinstance(rate, bool) \
                    or not isinstance(rate, (int, float)):
                raise ValueError
        except (ValueError, KeyError, UnicodeDecodeError, TypeError):
            return self._send(400, {"error": "bad request"})
        if len(text) > MAX_CHARS:
            return self._send(413, {"error": "text too long (max %d chars)" % MAX_CHARS})
        text = text.strip()
        if not text:
            return self._send(400, {"error": "empty text"})
        if voice not in VOICE_IDS:
            return self._send(400, {"error": "unknown voice"})
        if not -50 <= rate <= 100:
            return self._send(400, {"error": "rate out of range"})
        rate = int(round(rate))

        cp = cache.path(voice, rate, text)
        data = cache.get(cp)
        if data is not None:
            log.info("speak user=%s voice=%s chars=%d backend=cache status=200 ms=%d",
                     user, voice, len(text), (time.monotonic() - t0) * 1000)
            return self._send(200, data, "audio/mpeg",
                              {"Cache-Control": "private, max-age=31536000, immutable", "X-TTS-Backend": "cache"})

        cost = billable(text)
        day_ok, azure_ok = quota.reserve_check(user, cost)
        if not day_ok:
            ra = secs_to_next_day()
            return self._send(429, {"error": "daily quota exceeded", "retryAfter": ra}, extra={"Retry-After": str(ra)})
        use_azure = bool(AZURE_KEY) and azure_ok and not FORCE_FALLBACK
        if not use_azure and not FALLBACK_ENABLED:
            ra = secs_to_next_month()
            return self._send(429, {"error": "monthly quota exceeded", "retryAfter": ra}, extra={"Retry-After": str(ra)})

        backend, data = None, None
        with upstream_sem:
            if use_azure:
                try:
                    data, backend = azure_synth(text, voice, rate), "azure"
                except Exception as e:  # never log text or key
                    log.warning("azure failed: %s", type(e).__name__ + (":%s" % e.code if isinstance(e, urllib.error.HTTPError) else ""))
            if data is None and FALLBACK_ENABLED:
                try:
                    data, backend = edge_synth(text, voice, rate), "edge-tts"
                except Exception as e:
                    log.warning("edge-tts failed: %s", type(e).__name__)
        if data is None:
            log.info("speak user=%s voice=%s chars=%d backend=none status=502 ms=%d",
                     user, voice, len(text), (time.monotonic() - t0) * 1000)
            return self._send(502, {"error": "upstream failure"})
        try:
            cache.put(cp, data)
        except OSError as e:
            log.warning("cache put failed: %s", type(e).__name__)
        quota.commit(user, cost, backend)
        log.info("speak user=%s voice=%s chars=%d billable=%d backend=%s status=200 ms=%d",
                 user, voice, len(text), cost, backend, (time.monotonic() - t0) * 1000)
        self._send(200, data, "audio/mpeg",
                   {"Cache-Control": "private, max-age=31536000, immutable", "X-TTS-Backend": backend})


def main():
    global cache
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    os.makedirs(DATA_DIR, exist_ok=True)
    cache = Cache(CACHE_DIR)
    load_tokens()
    srv = ThreadingHTTPServer((HOST, PORT), H)
    srv.daemon_threads = True
    log.info("listening %s:%d azure=%s fallback=%s force_fallback=%s", HOST, PORT, bool(AZURE_KEY),
             FALLBACK_ENABLED, FORCE_FALLBACK)
    srv.serve_forever()


if __name__ == "__main__":
    main()
