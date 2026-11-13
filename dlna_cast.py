# -*- coding: utf-8 -*-
"""DLNA 投屏：SSDP 发现 + AVTransport SOAP 控制 + 本地 HTTP 流媒体服务。

极米等国产投影仪 / 电视用的是 DLNA/UPnP（Platinum 库），而 VLC 3.0 自带的
renderer 发现（microdns）只支持 mDNS/Chromecast，发现不了这类设备。本模块
自己实现 DLNA 投屏：

  1. SSDP M-SEARCH 发现局域网里的 DLNA 渲染器（电视 / 投影仪 / 盒子）；
  2. 拉取 description.xml，解析 AVTransport 的 controlURL；
  3. 起本地 HTTP 服务器（支持 Range，供播放器 seek 用）暴露视频文件；
  4. 通过 AVTransport SOAP 请求控制：SetAVTransportURI / Play / Pause /
     Seek / Stop / GetPositionInfo。
"""

import re
import socket
import threading
import urllib.request

import netutil
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SSDP_ADDR = ("239.255.255.250", 1900)
ST_MEDIA_RENDERER = "urn:schemas-upnp-org:device:MediaRenderer:1"
AVT_NS = "urn:schemas-upnp-org:service:AVTransport:1"


# ---------------------------------------------------------------- 工具
def _local_ip():
    """获取本机在局域网里的 IP。"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
        finally:
            s.close()
    except Exception:
        pass
    # 回退：遍历网卡
    try:
        import ctypes
        import struct
        import platform
        if platform.system() == "Windows":
            return socket.gethostbyname(socket.gethostname())
    except Exception:
        pass
    return "127.0.0.1"


def _ssdp_search(st=ST_MEDIA_RENDERER, timeout=3.0):
    """SSDP M-SEARCH，返回 {ip: location_url}。"""
    found = {}
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
    msg = ('M-SEARCH * HTTP/1.1\r\n'
           'HOST: 239.255.255.250:1900\r\n'
           'MAN: "ssdp:discover"\r\n'
           f'MX: {max(1, int(timeout))}\r\n'
           f'ST: {st}\r\n'
           '\r\n')
    try:
        s.sendto(msg.encode(), SSDP_ADDR)
        while True:
            try:
                data, addr = s.recvfrom(8192)
                txt = data.decode("utf-8", "replace")
                m = re.search(r"(?i)location:\s*(\S+)", txt)
                if m:
                    found.setdefault(addr[0], m.group(1).strip())
            except socket.timeout:
                break
    finally:
        s.close()
    return found


def _get(url, timeout=5.0):
    req = urllib.request.Request(url, headers={"User-Agent": "ImageViewer/1.0"})
    with netutil.urlopen(req, timeout=timeout) as r:
        return r.read()


# ---------------------------------------------------------------- DLNA 渲染器
class DlnaRenderer:
    """一个 DLNA 渲染器（电视 / 投影仪），封装 AVTransport SOAP 控制。"""

    def __init__(self, name, ip, port, control_path):
        self.name = name
        self.ip = ip
        self.port = port
        self.control_url = control_path if control_path.startswith("http") \
            else f"http://{ip}:{port}{control_path}"

    def __repr__(self):
        return f"<DlnaRenderer {self.name} @ {self.ip}:{self.port}>"

    def _soap_raw(self, action, *args):
        """发送 AVTransport SOAP 请求，返回解析后的 Element（失败返回 None）。"""
        body_args = "".join(
            f"<{name}>{val}</{name}>" for name, val in args if val is not None)
        body = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<s:Envelope '
            's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" '
            'xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">'
            '<s:Body>'
            f'<u:{action} xmlns:u="{AVT_NS}">'
            f'{body_args}'
            f'</u:{action}>'
            '</s:Body>'
            '</s:Envelope>'
        ).encode("utf-8")
        req = urllib.request.Request(
            self.control_url, data=body,
            headers={
                "Content-Type": 'text/xml; charset="utf-8"',
                "SOAPACTION": f'"{AVT_NS}#{action}"',
            })
        try:
            with netutil.urlopen(req, timeout=6.0) as r:
                resp = r.read()
                if not resp:
                    return None
                # 去掉标签上的命名空间前缀（<s:Envelope> -> <Envelope>），
                # 保留 xmlns 声明，方便用 .findtext(".//RelTime") 这类简单路径查找。
                txt = re.sub(rb'(</?)[a-zA-Z_][\w]*:', rb'\1', resp)
                return ET.fromstring(txt)
        except Exception:
            return None

    def _soap(self, action, *args):
        """发送 SOAP 请求，返回 True/False 表示成功与否。"""
        return self._soap_raw(action, *args) is not None

    # ---- 基础控制 ----
    def set_uri(self, url, title=""):
        """把要播放的媒体 URL 推给渲染器（不自动播放）。"""
        meta = ""
        if title:
            meta = (
                '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" '
                'xmlns:dc="http://purl.org/dc/elements/1.1/" '
                'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">'
                f'<item id="0" parentID="-1" restricted="1">'
                f'<dc:title>{title}</dc:title>'
                '<upnp:class>object.item.videoItem</upnp:class>'
                '</item></DIDL-Lite>'
            )
        # 元数据里含 & 等字符需要转义；这里简单处理常见字符
        meta = (meta.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
        return self._soap("SetAVTransportURI",
                          ("InstanceID", "0"),
                          ("CurrentURI", url),
                          ("CurrentURIMetaData", meta))

    def play(self):
        return self._soap("Play", ("InstanceID", "0"), ("Speed", "1"))

    def pause(self):
        return self._soap("Pause", ("InstanceID", "0"))

    def stop(self):
        return self._soap("Stop", ("InstanceID", "0"))

    def seek(self, seconds):
        """跳转到指定秒数（REL_TIME 格式 HH:MM:SS）。"""
        seconds = max(0, int(seconds))
        h, rem = divmod(seconds, 3600)
        m, s = divmod(rem, 60)
        target = f"{h:02d}:{m:02d}:{s:02d}"
        return self._soap("Seek", ("InstanceID", "0"),
                          ("Unit", "REL_TIME"), ("Target", target))

    def get_position(self):
        """返回 (已播放秒数, 总秒数, 状态)，失败返回 None。"""
        root = self._soap_raw("GetPositionInfo", ("InstanceID", "0"))
        if root is None:
            return None
        try:
            rel = root.findtext(".//RelTime") or "0:00:00"
            dur = root.findtext(".//TrackDuration") or "0:00:00"
            state = root.findtext(".//TransportState") or ""
            def _to_sec(t):
                parts = t.strip().split(":")
                parts = [float(p) for p in parts]
                return int(parts[0] * 3600 + parts[1] * 60 + parts[2])
            return _to_sec(rel), _to_sec(dur), state
        except Exception:
            return None


# ---------------------------------------------------------------- 发现
def discover_renderers(timeout=3.0):
    """发现局域网里的 DLNA 渲染器，返回 [DlnaRenderer, ...]。"""
    renderers = []
    locations = _ssdp_search(ST_MEDIA_RENDERER, timeout)
    for ip, loc in locations.items():
        try:
            xml_data = _get(loc, timeout=4.0).decode("utf-8", "replace")
            # 解析 friendlyName 和 AVTransport controlURL
            name_m = re.search(r"<friendlyName>([^<]*)</friendlyName>", xml_data)
            name = name_m.group(1).strip() if name_m else ip
            # 找到 AVTransport 服务块，取其 controlURL
            avt_ctrl = None
            for m in re.finditer(
                    r"<serviceType>urn:schemas-upnp-org:service:AVTransport:1"
                    r"</serviceType>.*?<controlURL>([^<]+)</controlURL>",
                    xml_data, re.S):
                avt_ctrl = m.group(1)
                break
            if not avt_ctrl:
                continue
            # 端口：从 loc 或 URLBase 提取
            port_m = re.search(r"http://[^:/]+:(\d+)", loc)
            port = int(port_m.group(1)) if port_m else 80
            renderers.append(DlnaRenderer(name, ip, port, avt_ctrl))
        except Exception:
            continue
    return renderers


# ---------------------------------------------------------------- 本地 HTTP 流媒体
class _RangeHandler(BaseHTTPRequestHandler):
    """支持 Range 请求的文件服务（DLNA 播放器 seek 依赖 Range）。"""

    server_version = "ImageViewerDLNA/1.0"

    def log_message(self, *args):
        pass  # 静默

    def handle_one_request(self):
        """播放器 seek/断开时会中断连接，吞掉异常避免刷屏。"""
        try:
            super().handle_one_request()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError):
            self.close_connection = True

    def _serve(self, send_body=True):
        path = self.server.media_path
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404)
            return
        with f:
            size = self.server.media_size
            start, end = 0, size - 1
            range_hdr = self.headers.get("Range")
            if range_hdr:
                m = re.match(r"bytes=(\d+)-(\d*)", range_hdr)
                if m:
                    start = int(m.group(1))
                    if m.group(2):
                        end = min(int(m.group(2)), size - 1)
            if start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            length = end - start + 1
            if start != 0 or end != size - 1:
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            else:
                self.send_response(200)
            ctype = "video/mp4"
            low = path.lower()
            if low.endswith(".mkv"):
                ctype = "video/x-matroska"
            elif low.endswith(".webm"):
                ctype = "video/webm"
            elif low.endswith(".avi"):
                ctype = "video/x-msvideo"
            elif low.endswith(".ts"):
                ctype = "video/mp2t"
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(length))
            self.end_headers()
            if not send_body:
                return
            f.seek(start)
            remaining = length
            chunk = 1024 * 256
            while remaining > 0:
                data = f.read(min(chunk, remaining))
                if not data:
                    break
                try:
                    self.wfile.write(data)
                except Exception:
                    break
                remaining -= len(data)

    def do_GET(self):
        self._serve(True)

    def do_HEAD(self):
        self._serve(False)


class LocalMediaServer:
    """在后台线程跑一个本地 HTTP 服务器，暴露单个视频文件给 DLNA 播放器拉流。"""

    def __init__(self, path):
        self.path = path
        self._httpd = None
        self._thread = None
        self.ip = _local_ip()
        self.port = 0
        import os
        self.size = os.path.getsize(path)

    def start(self):
        self._httpd = ThreadingHTTPServer(("0.0.0.0", 0), _RangeHandler)
        self._httpd.media_path = self.path
        self._httpd.media_size = self.size
        self.port = self._httpd.server_address[1]
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()
        return self.url

    @property
    def url(self):
        import urllib.parse
        name = self.path.replace("\\", "/").split("/")[-1]
        return f"http://{self.ip}:{self.port}/{urllib.parse.quote(name)}"

    def stop(self):
        if self._httpd:
            try:
                self._httpd.shutdown()
            except Exception:
                pass
            try:
                self._httpd.server_close()
            except Exception:
                pass
            self._httpd = None
        self._thread = None
