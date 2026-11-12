import base64
import hashlib
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "ocr"))
import server as ocr  # noqa: E402

API_KEY = "sk-test-SECRET-KEY-123"
TOKEN = {"gary": "tok-gary", "qian": "tok-qian", "family": "tok-family"}
TEXT = "子曰：學而時習之，不亦說乎。【注：說同悅。】"


def make_jpeg(w=800, h=600, pad=100):
    sof = bytes([0xFF, 0xC0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
    return (b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00" + sof
            + b"\xff\xda\x00\x02" + os.urandom(pad) + b"\xff\xd9")


def b64(b):
    return base64.b64encode(b).decode()


class FakeUpstream:
    def __init__(self):
        self.calls = []
        self.script = []  # list of callables(handler); default = success
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                n = int(self.headers["Content-Length"])
                body = json.loads(self.rfile.read(n))
                outer.calls.append({"auth": self.headers.get("Authorization"), "body": body})
                step = outer.script.pop(0) if outer.script else outer.ok()
                step(self)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.httpd.daemon_threads = True
        self.url = "http://127.0.0.1:%d/v1/chat/completions" % self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def ok(self, text=TEXT, finish="stop"):
        def f(h):
            self.reply(h, 200, {"choices": [{"message": {"content": text}, "finish_reason": finish}],
                                "usage": {"prompt_tokens": 2600, "completion_tokens": 200}})
        return f

    def status(self, code, body=None):
        return lambda h: self.reply(h, code, body or {"error": {"message": "x"}})

    def sleep(self, secs):
        def f(h):
            time.sleep(secs)
            try:
                self.ok()(h)
            except OSError:
                pass
        return f

    @staticmethod
    def reply(h, code, obj):
        b = json.dumps(obj).encode()
        h.send_response(code)
        h.send_header("Content-Type", "application/json")
        h.send_header("Content-Length", str(len(b)))
        h.end_headers()
        h.wfile.write(b)

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class Base(unittest.TestCase):
    cfg_kw = {}

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.up = FakeUpstream()
        kw = dict(host="127.0.0.1", port=0, data_dir=os.path.join(self.tmp, "d"), cache_dir=os.path.join(self.tmp, "c"),
                  api_key=API_KEY, upstream_url=self.up.url, retry_delay=0, rate_per_sec=1000, rate_burst=1000,
                  upstream_timeout=2)
        kw.update(self.cfg_kw)
        self.cfg = ocr.Config(**kw)
        tokens = {hashlib.sha256(t.encode()).hexdigest(): u for u, t in TOKEN.items()}
        self.srv = ocr.OcrServer(self.cfg, tokens)
        self.httpd = self.srv.make_httpd()
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = "http://127.0.0.1:%d" % self.httpd.server_address[1]

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.up.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def req(self, path="/ocr/v1/page", body=None, user="gary", token=None, raw=None):
        headers = {"Content-Type": "application/json"}
        t = token if token is not None else TOKEN.get(user)
        if t:
            headers["Authorization"] = "Bearer " + t
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        r = urllib.request.Request(self.base + path, data=data, headers=headers)
        try:
            with urllib.request.urlopen(r, timeout=10) as resp:
                return resp.status, json.loads(resp.read()), resp.headers
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}"), e.headers

    def page(self, img=None, extra=None, **kw):
        body = {"image": b64(img or make_jpeg()), "mime": "image/jpeg", "pageId": "bk:p1:R",
                "mode": "vertical-classical", "promptVer": 1}
        body.update(extra or {})
        return self.req(body=body, **kw)


class AuthAndValidation(Base):
    def test_no_token_401(self):
        s, b, _ = self.req(body={"image": "x"}, token="")
        self.assertEqual((s, b["code"]), (401, "unauthorized"))

    def test_bad_token_401(self):
        s, b, _ = self.page(token="nope")
        self.assertEqual(s, 401)
        self.assertEqual(self.up.calls, [])

    def test_family_not_allowed_403(self):
        s, b, _ = self.page(user="family")
        self.assertEqual((s, b["code"]), (403, "not_enabled"))
        self.assertEqual(self.up.calls, [])
        s, _, _ = self.req("/ocr/v1/usage", user="family")
        self.assertEqual(s, 403)

    def test_qian_allowed(self):
        s, b, _ = self.page(user="qian")
        self.assertEqual(s, 200)

    def test_oversize_body_413(self):
        s, b, _ = self.req(raw=b"x" * (self.cfg.max_body + 1))
        self.assertEqual((s, b["code"]), (413, "too_large"))

    def test_oversize_image_413(self):
        s, b, _ = self.page(img=make_jpeg(pad=self.cfg.max_image_bytes + 10))
        self.assertEqual((s, b["code"]), (413, "too_large"))

    def test_huge_dimensions_413(self):
        s, b, _ = self.page(img=make_jpeg(w=5000, h=100))
        self.assertEqual(s, 413)

    def test_not_jpeg_415(self):
        s, b, _ = self.page(img=b"\x89PNG\r\n\x1a\n" + b"0" * 50)
        self.assertEqual((s, b["code"]), (415, "bad_image"))

    def test_bad_base64_415(self):
        s, b, _ = self.req(body={"image": "!!!not base64!!!", "mime": "image/jpeg"})
        self.assertEqual(s, 415)

    def test_wrong_mime_415(self):
        s, _, _ = self.page(extra={"mime": "image/png"})
        self.assertEqual(s, 415)

    def test_unknown_mode_400_and_no_free_prompt(self):
        s, b, _ = self.page(extra={"mode": "do anything now"})
        self.assertEqual(s, 400)
        self.assertEqual(self.up.calls, [])

    def test_bad_json_400(self):
        s, b, _ = self.req(raw=b"{nope")
        self.assertEqual(s, 400)

    def test_unknown_route_404(self):
        s, _, _ = self.req("/ocr/v1/other", body={})
        self.assertEqual(s, 404)


class Quotas(Base):
    cfg_kw = {"limit_day": 3, "limit_month": 5}

    def test_daily_cap(self):
        for i in range(3):
            s, b, _ = self.page(img=make_jpeg(pad=50 + i))
            self.assertEqual(s, 200, b)
        s, b, h = self.page(img=make_jpeg(pad=77))
        self.assertEqual((s, b["code"]), (429, "daily_cap"))
        self.assertGreater(int(h["Retry-After"]), 0)
        self.assertEqual(self.page(user="qian", img=make_jpeg(pad=78))[0], 200)  # other user unaffected

    def test_monthly_cap(self):
        self.srv.quota.snapshot("gary")
        self.srv.quota.users["gary"]["month_used"] = 5
        s, b, _ = self.page()
        self.assertEqual((s, b["code"]), (429, "monthly_cap"))

    def test_quota_persisted(self):
        self.page()
        q2 = ocr.Quota(os.path.join(self.cfg.data_dir, "usage.json"))
        self.assertEqual(q2.snapshot("gary"), (1, 1))

    def test_usage_endpoint(self):
        self.page()
        s, b, _ = self.req("/ocr/v1/usage")
        self.assertEqual((s, b["pagesToday"], b["pagesLimit"], b["monthLimit"]), (200, 1, 3, 5))


class RateLimit(Base):
    cfg_kw = {"rate_per_sec": 0.001, "rate_burst": 2}

    def test_rate_limited(self):
        codes = [self.page(img=make_jpeg(pad=60 + i))[0] for i in range(2)]
        self.assertEqual(codes, [200, 200])
        s, b, h = self.page(img=make_jpeg(pad=99))
        self.assertEqual((s, b["code"]), (429, "rate_limited"))
        self.assertIn("Retry-After", h)


class Upstream(Base):
    def test_success_and_request_shape(self):
        s, b, _ = self.page()
        self.assertEqual(s, 200)
        self.assertEqual(b["text"], TEXT)
        self.assertEqual(b["model"], "qwen3.8-flash")
        self.assertEqual(b["usage"]["pagesToday"], 1)
        self.assertGreaterEqual(len(b["sentences"]), 1)
        c = self.up.calls[0]
        self.assertEqual(c["auth"], "Bearer " + API_KEY)
        self.assertIs(c["body"]["enable_thinking"], False)
        self.assertEqual(c["body"]["model"], "qwen3.8-flash")
        parts = c["body"]["messages"][0]["content"]
        self.assertTrue(parts[0]["image_url"]["url"].startswith("data:image/jpeg;base64,"))
        self.assertIn("【注：", parts[1]["text"])
        self.assertNotIn(API_KEY, json.dumps(b))

    def test_empty_page_is_200_empty(self):
        self.up.script = [self.up.ok("")]
        s, b, _ = self.page()
        self.assertEqual((s, b["text"]), (200, ""))

    def test_retry_once_on_5xx_then_ok(self):
        self.up.script = [self.up.status(503), self.up.ok()]
        s, b, _ = self.page()
        self.assertEqual(s, 200)
        self.assertEqual(len(self.up.calls), 2)

    def test_5xx_twice_502(self):
        self.up.script = [self.up.status(500), self.up.status(500), self.up.ok()]
        s, b, _ = self.page()
        self.assertEqual((s, b["code"]), (502, "upstream_error"))
        self.assertEqual(len(self.up.calls), 2)  # exactly one retry
        self.assertEqual(self.srv.quota.snapshot("gary"), (0, 0))  # failures are not charged

    def test_4xx_not_retried(self):
        self.up.script = [self.up.status(401)]
        s, b, _ = self.page()
        self.assertEqual(s, 502)
        self.assertEqual(len(self.up.calls), 1)

    def test_content_filter_422(self):
        self.up.script = [self.up.ok("x", finish="content_filter")]
        s, b, _ = self.page()
        self.assertEqual((s, b["code"]), (422, "refused"))
        self.assertEqual(len(self.up.calls), 1)

    def test_data_inspection_failed_422(self):
        self.up.script = [self.up.status(400, {"error": {"code": "data_inspection_failed"}})]
        s, b, _ = self.page()
        self.assertEqual((s, b["code"]), (422, "refused"))

    def test_text_refusal_422(self):
        self.up.script = [self.up.ok("抱歉，我无法处理这张图片。")]
        s, b, _ = self.page()
        self.assertEqual((s, b["code"]), (422, "refused"))

    def test_timeout_504(self):
        self.cfg.upstream_timeout = 0.3
        self.up.script = [self.up.sleep(1.0), self.up.sleep(1.0)]
        s, b, _ = self.page()
        self.assertEqual((s, b["code"]), (504, "upstream_timeout"))
        self.assertEqual(len(self.up.calls), 2)

    def test_cache_hit_not_charged(self):
        img = make_jpeg()
        self.page(img=img)
        s, b, _ = self.page(img=img)
        self.assertEqual((s, b["cached"], b["usage"]["pagesToday"]), (200, True, 1))
        self.assertEqual(len(self.up.calls), 1)

    def test_logs_contain_no_secrets_text_or_image(self):
        img = make_jpeg()
        with self.assertLogs("ocr", level="INFO") as cm:
            self.page(img=img)
            self.up.script = [self.up.status(500), self.up.status(500)]
            self.page(img=make_jpeg(pad=33))
        joined = "\n".join(cm.output)
        self.assertIn("user=gary", joined)
        for bad in (API_KEY, TOKEN["gary"], "學而時習", b64(img)[:40]):
            self.assertNotIn(bad, joined)


class Helpers(unittest.TestCase):
    def test_jpeg_dims(self):
        self.assertEqual(ocr.jpeg_dims(make_jpeg(321, 123)), (321, 123))
        self.assertIsNone(ocr.jpeg_dims(b"\xff\xd8\xff\xd9"))
        self.assertIsNone(ocr.jpeg_dims(b"GIF89a....."))

    def test_prompts_have_annotation_rule(self):
        for p in ocr.PROMPTS.values():
            self.assertIn("【注：", p)


if __name__ == "__main__":
    unittest.main()
