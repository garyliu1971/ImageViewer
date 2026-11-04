# -*- coding: utf-8 -*-
"""远程媒体源（网盘 / NAS / WebDAV）抽象 + 本地流代理（无 UI、无 VLC 依赖）。

设计目标：让 image_viewer.py 里现有的「本地文件 → VLC 播放」链路，能够以最小改动
接入远程视频。核心是两点：

  1. RemoteSource —— 一个新的「源」类型，与现有的 str（本地路径）/
     tuple（zip 条目 / PDF 页）并列，表示一个远程文件或目录；
  2. RemoteStreamProxy —— 把远程视频包装成本地 HTTP 端点（支持 Range），
     VLC 永远读 http://127.0.0.1:port/...，鉴权头 / Range / 直链时效都被
     代理挡在内部，播放、seek 缩略图、投屏全部复用同一套本地端点。

目前实现 WebDAV 一种 provider；SMB / Emby / 商业网盘作为后续 provider 按同一
接口接入即可。

约定：本模块只做纯 IO 与协议，不 import tkinter / vlc。
"""

import base64
import hashlib
import json
import re
import socket
import threading
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from media_source import IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS
from remote_types import RemoteSource  # noqa: F401  (re-export，保持 remote_source.RemoteSource 可用)


def _natural_key(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def _lan_ip():
    """获取本机局域网 IP，失败回退 127.0.0.1。"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
        finally:
            s.close()
    except Exception:
        return "127.0.0.1"


class RemoteProvider:
    """远程 provider 抽象接口。"""

    name = "base"

    def list_dir(self, path):
        """返回某目录下的 RemoteSource 列表（目录 + 视频文件）。"""
        raise NotImplementedError

    def open_stream(self, src, headers):
        """打开 src 的 GET 流，返回 response 对象（含 .code/.status、.headers、.read）。"""
        raise NotImplementedError

    def direct_play_url(self, src):
        """返回可直接交给 VLC 的 URL（如 HLS 转码流）；None 表示走本地流代理。"""
        return None

    def fetch_image(self, src, max_width=300):
        """返回海报/封面图片字节；无图返回 None。"""
        return None


class WebDavProvider(RemoteProvider):
    """WebDAV（坚果云 / NAS / 阿里云盘 WebDAV 等）provider，Basic Auth + PROPFIND。"""

    name = "webdav"

    def __init__(self, base_url, username="", password=""):
        split = urllib.parse.urlsplit(base_url)
        self.origin = "%s://%s" % (split.scheme or "https", split.netloc)
        self.root_path = self._encode_path(split.path or "/")
        self.username = username
        self.password = password

    @staticmethod
    def _encode_path(path):
        """用户输入的地址可能含中文/空格（http://host/dav/我的网盘）：urlopen 要求 ASCII，
        这里只对非 ASCII 和空格做百分号编码，已编码的 %XX 与服务端给的 href 保持原样。"""
        if path.isascii() and " " not in path:
            return path
        path = re.sub(r"%(?![0-9A-Fa-f]{2})", "%25", path)   # 字面 % 不是转义，先转成 %25
        return urllib.parse.quote(path, safe="/%")

    def _auth_header(self):
        token = base64.b64encode(
            ("%s:%s" % (self.username, self.password)).encode("utf-8")).decode("ascii")
        return "Basic " + token

    def _url(self, path):
        return self.origin + "/" + self._encode_path(path).lstrip("/")

    def _propfind(self, path):
        body = ('<?xml version="1.0" encoding="utf-8"?>'
                '<d:propfind xmlns:d="DAV:">'
                '<d:prop><d:resourcetype/><d:getcontentlength/>'
                '<d:getlastmodified/><d:displayname/></d:prop>'
                '</d:propfind>').encode("utf-8")
        req = urllib.request.Request(
            self._url(path), data=body, method="PROPFIND",
            headers={
                "Depth": "1",
                "Authorization": self._auth_header(),
                "Content-Type": 'application/xml; charset="utf-8"',
                "User-Agent": "ImageViewer/1.0",
            })
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.read()

    def list_dir(self, path):
        try:
            return self.list_dir_strict(path)
        except Exception:
            return []

    def list_dir_strict(self, path):
        """同 list_dir，但网络/认证/解析错误直接抛出，供界面显示真实原因。"""
        path = self._encode_path(path or self.root_path)
        data = self._propfind(path)
        root = ET.fromstring(data)
        entries = []
        requested = urllib.parse.unquote(path).rstrip("/")
        for resp in root.findall(".//{DAV:}response"):
            href = resp.findtext("{DAV:}href")
            if not href:
                continue
            # href 保持百分号编码，用于后续请求 URL；仅显示名解码
            if urllib.parse.unquote(href).rstrip("/") == requested:
                continue  # 跳过集合自身（按解码后比较，兼容 %e4/%E4 大小写与中文原文）
            rt = resp.find(".//{DAV:}resourcetype")
            is_dir = rt is not None and rt.find("{DAV:}collection") is not None
            size = resp.findtext(".//{DAV:}getcontentlength")
            mtime = resp.findtext(".//{DAV:}getlastmodified")
            name = urllib.parse.unquote(href.rstrip("/").split("/")[-1])
            if is_dir:
                entries.append(RemoteSource(self.name, href, name=name, is_dir=True,
                                            mtime=mtime, kind="folder"))
            else:
                ext = ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else ""
                if ext in IMAGE_EXTS:
                    kind = "image"
                elif ext in VIDEO_EXTS:
                    kind = "video"
                elif ext in AUDIO_EXTS:
                    kind = "audio"
                else:
                    continue
                entries.append(RemoteSource(
                    self.name, href, name=name,
                    size=int(size) if size else None, mtime=mtime, kind=kind))
        entries.sort(key=lambda s: (not s.is_dir, _natural_key(s.name)))
        return entries

    def open_stream(self, src, headers):
        hdrs = {"Authorization": self._auth_header(), "User-Agent": "ImageViewer/1.0"}
        if headers:
            hdrs.update(headers)
        req = urllib.request.Request(self._url(src.path), headers=hdrs)
        return urllib.request.urlopen(req, timeout=60)

    THUMB_MAX_BYTES = 20 * 1024 * 1024

    def fetch_image(self, src, max_width=300):
        """图片条目：GET 整个文件交给调用方缩放（WebDAV 无服务端缩略图）；
        视频/音频/目录或超过 THUMB_MAX_BYTES 的文件返回 None。"""
        if src.is_dir or src.kind != "image":
            return None
        if src.size and src.size > self.THUMB_MAX_BYTES:
            return None
        r = self.open_stream(src, None)
        try:
            data = r.read(self.THUMB_MAX_BYTES + 1)
        finally:
            r.close()
        return data if len(data) <= self.THUMB_MAX_BYTES else None


class JellyfinProvider(RemoteProvider):
    """Jellyfin / Emby 服务器 provider：登录 → 浏览片库 → 直链流播。

    目录用 item id 而非路径：list_dir("") 列出顶层视图/媒体库，之后用
    list_dir(parent_item_id) 下钻。可播放条目（Movie/Episode/Video/Audio）的
    src.extra 里带 id/type，open_stream 时查 PlaybackInfo 拿直链（Static 直连）。
    """

    name = "jellyfin"

    FOLDER_TYPES = {"UserView", "CollectionFolder", "Folder", "Series", "Season",
                    "MusicAlbum", "MusicArtist", "Playlist", "BoxSet"}
    VIDEO_TYPES = {"Movie", "Episode", "Video", "TvEpisode", "MusicVideo"}
    AUDIO_TYPES = {"Audio"}

    def __init__(self, base_url, token, user_id, username="", device_id=None):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.user_id = user_id
        self.device_id = device_id or self._device_id(self.base_url, username or user_id)
        self.root_path = ""   # list_dir("") = 根

    def _headers(self):
        auth = ('MediaBrowser Token="%s", Client="ImageViewer", Device="Desktop", '
                'DeviceId="%s", Version="1.0.0"' % (self.token, self.device_id))
        return {
            "Authorization": auth,
            "Accept": "application/json",
            "User-Agent": "ImageViewer/1.0",
        }

    def _get_json(self, url):
        req = urllib.request.Request(url, headers=self._headers())
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))

    @staticmethod
    def _device_id(base_url, username):
        return "iv-" + hashlib.sha1((base_url + "|" + username).encode("utf-8")).hexdigest()[:16]

    @staticmethod
    def authenticate(base_url, username, password):
        """登录拿 (token, user_id, device_id)，失败抛异常。"""
        base = base_url.rstrip("/")
        device_id = JellyfinProvider._device_id(base, username)
        auth = ('MediaBrowser Client="ImageViewer", Device="Desktop", '
                'DeviceId="%s", Version="1.0.0"' % device_id)
        body = json.dumps({"Username": username, "Pw": password}).encode("utf-8")
        req = urllib.request.Request(
            base + "/Users/AuthenticateByName", data=body,
            headers={"Authorization": auth, "Content-Type": "application/json",
                     "Accept": "application/json", "User-Agent": "ImageViewer/1.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8"))
        return data.get("AccessToken"), data.get("User", {}).get("Id"), device_id

    def list_dir(self, path):
        try:
            return self.list_dir_strict(path)
        except Exception:
            return []

    def list_dir_strict(self, path):
        """同 list_dir，但网络/认证错误直接抛出，供连接自检与界面显示真实原因。"""
        path = path or ""
        url = self.base_url + "/Users/%s/Items" % self.user_id
        params = {"Recursive": "false", "Fields": "Overview,ProductionYear"}
        if path:
            params["ParentId"] = path
        url += "?" + urllib.parse.urlencode(params)
        data = self._get_json(url)
        entries = []
        for it in data.get("Items", []):
            itype = it.get("Type")
            iid = it.get("Id")
            name = it.get("Name") or it.get("SortName") or "(未命名)"
            extra = {
                "id": iid, "type": itype,
                "image_tag": (it.get("ImageTags") or {}).get("Primary"),
                "year": it.get("ProductionYear"),
                "overview": it.get("Overview"),
            }
            if itype in self.FOLDER_TYPES or it.get("IsFolder"):
                entries.append(RemoteSource(self.name, iid, name=name, is_dir=True,
                                            kind="folder", extra=extra))
            elif itype in self.VIDEO_TYPES:
                entries.append(RemoteSource(self.name, iid, name=name, kind="video",
                                            extra=extra))
            elif itype in self.AUDIO_TYPES:
                entries.append(RemoteSource(self.name, iid, name=name, kind="audio",
                                            extra=extra))
        entries.sort(key=lambda s: (not s.is_dir, _natural_key(s.name)))
        return entries

    def _playback_info(self, src):
        """查（并缓存）PlaybackInfo，返回完整 JSON dict。"""
        info = src.extra.get("_playback_info")
        if info is None:
            iid = src.extra.get("id", src.path)
            url = self.base_url + "/Items/%s/PlaybackInfo?UserId=%s" % (iid, self.user_id)
            info = self._get_json(url)
            src.extra["_playback_info"] = info
        return info

    def _media_source(self, src):
        sources = self._playback_info(src).get("MediaSources") or []
        if not sources:
            raise RuntimeError("无可用媒体源")
        return sources[0]

    def _stream_url(self, src):
        """直连（Static）或直连重封装（remux）的流 URL，支持 Range。"""
        ms = self._media_source(src)
        iid = src.extra.get("id", src.path)
        params = {"MediaSourceId": str(ms.get("Id") or ms.get("Name"))}
        if ms.get("SupportsDirectPlay"):
            params["Static"] = "true"
        q = urllib.parse.urlencode(params)
        if src.kind == "audio":
            return self.base_url + "/Audio/%s/stream?%s" % (iid, q)
        return self.base_url + "/Videos/%s/stream?%s" % (iid, q)

    def direct_play_url(self, src):
        """需要转码时返回 HLS master.m3u8 URL（VLC 直接播），否则返回 None（走流代理）。"""
        if src.kind == "audio":
            return None   # 音频转码暂不处理
        try:
            ms = self._media_source(src)
        except Exception:
            return None
        if ms.get("SupportsDirectPlay") or ms.get("SupportsDirectStream"):
            return None
        iid = src.extra.get("id", src.path)
        q = urllib.parse.urlencode({
            "MediaSourceId": str(ms.get("Id") or ms.get("Name")),
            "ApiKey": self.token,
        })
        return self.base_url + "/Videos/%s/master.m3u8?%s" % (iid, q)

    def open_stream(self, src, headers):
        url = src.extra.get("_stream_url")
        if not url:
            ms = self._media_source(src)
            if not (ms.get("SupportsDirectPlay") or ms.get("SupportsDirectStream")):
                raise RuntimeError("该媒体需要转码，应使用 HLS 流")
            url = self._stream_url(src)
            src.extra["_stream_url"] = url   # 缓存，避免每次 Range 请求都重查
        hdrs = self._headers()
        if headers:
            hdrs.update(headers)
        req = urllib.request.Request(url, headers=hdrs)
        return urllib.request.urlopen(req, timeout=60)

    def image_url(self, src, max_width=300):
        """海报/封面图片 URL（无图返回 None）。"""
        if src.kind == "audio":
            return None
        iid = src.extra.get("id", src.path)
        params = {"maxWidth": str(max_width)}
        tag = src.extra.get("image_tag")
        if tag:
            params["tag"] = tag
        return self.base_url + "/Items/%s/Images/Primary?%s" % (
            iid, urllib.parse.urlencode(params))

    def fetch_image(self, src, max_width=300):
        url = self.image_url(src, max_width)
        if not url:
            return None
        req = urllib.request.Request(url, headers=self._headers())
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.read()


# ---------------------------------------------------------------- 本地流代理
class _ProxyHandler(BaseHTTPRequestHandler):
    """把远程 GET 流（含 Range）以本地 HTTP 端点形式透传出去。

    VLC 的 http access 模块需要准确的 Content-Length / Content-Range / Accept-Ranges
    才能正常 seek；这里把这些头从上游透传下来，缺失 Content-Length 时用 PROPFIND
    拿到的 src.size 兜底（WebDAV 普遍提供）。
    """

    server_version = "ImageViewerProxy/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def handle_one_request(self):
        """VLC seek/探测时会频繁中断连接，吞掉这些异常避免控制台刷屏。"""
        try:
            super().handle_one_request()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError):
            self.close_connection = True

    def _serve(self, send_body=True):
        up = {}
        rng = self.headers.get("Range")
        if rng:
            up["Range"] = rng
        try:
            resp = self.server.provider.open_stream(self.server.src, up)
        except urllib.error.HTTPError as e:
            resp = e
        except Exception as e:
            try:
                self.send_error(502, "upstream error: %s" % e)
            except Exception:
                pass
            return

        status = resp.code if hasattr(resp, "code") else resp.status
        hdrs = resp.headers
        clen = hdrs.get("Content-Length")
        ctype = hdrs.get("Content-Type")
        crange = hdrs.get("Content-Range")
        if clen is None:
            if status == 200 and self.server.src.size is not None:
                clen = str(self.server.src.size)
            elif status == 206 and crange:
                # 从 Content-Range "bytes 0-999/1000" 里反推本次长度
                m = re.search(r"/(\d+)$", crange)
                if m:
                    total = int(m.group(1))
                    m2 = re.match(r"bytes (\d+)-(\d+)/", crange)
                    if m2:
                        clen = str(int(m2.group(2)) - int(m2.group(1)) + 1)

        self.send_response(status)
        if ctype:
            self.send_header("Content-Type", ctype)
        if crange:
            self.send_header("Content-Range", crange)
        self.send_header("Accept-Ranges", "bytes")
        if clen is not None:
            self.send_header("Content-Length", clen)
        self.end_headers()

        if not send_body:
            self._close(resp)
            return
        written = 0
        try:
            while True:
                chunk = resp.read(256 * 1024)
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except Exception:
                    break
                written += len(chunk)
                if clen is not None and written >= int(clen):
                    break
        except Exception:
            pass
        finally:
            self._close(resp)

    def _close(self, resp):
        try:
            resp.close()
        except Exception:
            pass

    def do_GET(self):
        self._serve(True)

    def do_HEAD(self):
        self._serve(False)


class RemoteStreamProxy:
    """把单个远程视频包装成本地 HTTP 端点（后台线程）。"""

    def __init__(self, provider, src):
        self.provider = provider
        self.src = src
        self._httpd = None
        self._thread = None
        self.ip = _lan_ip()
        self.port = 0
        self.size = src.size

    def start(self):
        self._httpd = ThreadingHTTPServer(("0.0.0.0", 0), _ProxyHandler)
        self._httpd.provider = self.provider
        self._httpd.src = self.src
        self.port = self._httpd.server_address[1]
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()
        return self.local_url

    def _name(self):
        return urllib.parse.quote(self.src.name)

    @property
    def local_url(self):
        return "http://127.0.0.1:%d/%s" % (self.port, self._name())

    @property
    def lan_url(self):
        return "http://%s:%d/%s" % (self.ip, self.port, self._name())

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
