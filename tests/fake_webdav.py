# -*- coding: utf-8 -*-
"""假 WebDAV 服务器（测试用）：PROPFIND + GET(带 Range) + Basic Auth。

只实现 remote_source.WebDavProvider 用到的那一小块协议，够用就行。
"""
import base64
import io
import threading
import urllib.parse
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NS = 'xmlns:D="DAV:"'


class FakeWebDav:
    """files: {路径: bytes}，路径以 /dav/ 开头；目录从路径推导。"""

    def __init__(self, files, user="u", pw="p"):
        self.files = files
        self.user, self.pw = user, pw
        self.requests = []
        self.httpd = None
        self.thread = None

    # ---------- 目录树 ----------
    def dirs(self):
        out = set()
        for p in self.files:
            parts = p.strip("/").split("/")
            for i in range(1, len(parts)):
                out.add("/" + "/".join(parts[:i]))
        return out

    def children(self, path):
        path = path.rstrip("/")
        out = []
        seen = set()
        for p in sorted(self.files):
            if not p.startswith(path + "/"):
                continue
            rest = p[len(path) + 1:]
            segs = rest.split("/")
            if len(segs) > 1:
                name = path + "/" + segs[0]
                if name not in seen:
                    seen.add(name)
                    out.append((name, True))
            else:
                out.append((p, False))
        return out

    # ---------- 生命周期 ----------
    def start(self):
        outer = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def _auth_ok(self):
                got = self.headers.get("Authorization", "")
                want = "Basic " + base64.b64encode(
                    ("%s:%s" % (outer.user, outer.pw)).encode()).decode()
                return got == want

            def _deny(self):
                self.send_response(401)
                self.send_header("WWW-Authenticate", 'Basic realm="dav"')
                self.send_header("Content-Length", "0")
                self.end_headers()

            def _path(self):
                return urllib.parse.unquote(urlparse_(self.path).path)

            def do_OPTIONS(self):
                self.send_response(200)
                self.send_header("DAV", "1,2")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def do_GET(self):
                outer.requests.append(("GET", self._path()))
                if not self._auth_ok():
                    return self._deny()
                data = outer.files.get(self._path())
                if data is None:
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                rng = self.headers.get("Range") or ""
                if rng.startswith("bytes="):
                    a, _, b = rng[6:].partition("-")
                    s = int(a or 0)
                    e = int(b) if b else len(data) - 1
                    chunk = data[s:e + 1]
                    self.send_response(206)
                    self.send_header("Content-Range", "bytes %d-%d/%d" % (s, e, len(data)))
                    self.send_header("Content-Length", str(len(chunk)))
                    self.send_header("Content-Type", "application/octet-stream")
                    self.end_headers()
                    self.wfile.write(chunk)
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Type", "application/octet-stream")
                self.end_headers()
                self.wfile.write(data)

            def do_HEAD(self):
                return self.do_GET()

            def do_PROPFIND(self):
                outer.requests.append(("PROPFIND", self._path()))
                if not self._auth_ok():
                    return self._deny()
                path = self._path()
                if path not in outer.files and path.rstrip("/") not in outer.dirs():
                    # 根目录 /dav 允许（当作集合）
                    if not path.rstrip("/").endswith("dav"):
                        self.send_response(404)
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                buf = io.BytesIO()
                buf.write(('<?xml version="1.0" encoding="utf-8"?><D:multistatus %s>' % NS).encode())

                def item(p, is_dir, size=0):
                    href = "/" + "/".join(urllib.parse.quote(seg) for seg in p.split("/") if seg)
                    body = ("<D:response><D:href>%s</D:href><D:propstat><D:prop>"
                            "<D:resourcetype>%s</D:resourcetype>"
                            "<D:getcontentlength>%d</D:getcontentlength>"
                            "<D:getlastmodified>Wed, 05 Nov 2025 10:00:00 GMT</D:getlastmodified>"
                            "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>"
                            % (href, "<D:collection/>" if is_dir else "", size))
                    buf.write(body.encode())

                item(path, True)
                for child, is_dir in outer.children(path):
                    item(child, is_dir, len(outer.files.get(child, b"")))
                buf.write(b"</D:multistatus>")
                data = buf.getvalue()
                self.send_response(207)
                self.send_header("Content-Type", "application/xml; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        return "http://127.0.0.1:%d/dav" % self.httpd.server_address[1]

    def stop(self):
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()


def urlparse_(u):
    import urllib.parse
    return urllib.parse.urlparse(u)
