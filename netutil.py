# -*- coding: utf-8 -*-
"""出站 HTTP 的共用小工具：内网 / 回环 / 链路本地 / .local / 单段主机名一律直连，不走环境变量或系统代理。

背景：shell 里常设有 HTTP_PROXY / HTTPS_PROXY（比如指向云上的代理），而 NO_PROXY 不会列全 192.168.* 等内网段，
urllib 默认就会把访问局域网 AList / NAS 的请求也发给代理，结果超时。这里按「主机是否内网」逐个请求决定：
内网直连，公网照旧遵守环境 / 系统代理（TMDB、Azure 等）。重定向后的新主机同样重新判断。

内网判定规则与前端 `IVCore.plainHttpRisk` 完全一致（10.x / 127.x / 172.16-31.x / 192.168.x / 169.254.x /
localhost / *.local / 单段主机名 / IPv6 ::1、fc00::/7、fe80::/10）。
"""

import re
import urllib.parse
import urllib.request

_V4 = re.compile(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$")


def is_private_host(host):
    h = str(host or "").strip().lower()
    if h.startswith("[") and h.endswith("]"):
        h = h[1:-1]
    if not h:
        return False
    m = _V4.match(h)
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        return a == 10 or a == 127 or (a == 172 and 16 <= b <= 31) or (a == 192 and b == 168) or (a == 169 and b == 254)
    if ":" in h:
        return h == "::1" or bool(re.match(r"^f[cd][0-9a-f]{2}:", h)) or bool(re.match(r"^fe[89ab][0-9a-f]:", h))
    return h == "localhost" or h.endswith(".local") or "." not in h


def host_of(url):
    try:
        return urllib.parse.urlsplit(str(url)).hostname or ""
    except ValueError:
        return ""


def is_private_url(url):
    return is_private_host(host_of(url))


class BypassPrivateProxy(urllib.request.ProxyHandler):
    """ProxyHandler：目标是内网主机时放行给下一个 handler（直连），否则按环境 / 系统代理走。"""

    def proxy_open(self, req, proxy, type):
        if is_private_url(req.full_url):
            return None
        return super().proxy_open(req, proxy, type)


def build_opener(*handlers):
    """等价于 urllib.request.build_opener，但代理处理换成 BypassPrivateProxy（每次现读环境变量）。"""
    return urllib.request.build_opener(BypassPrivateProxy(), *handlers)


def urlopen(req, timeout=None):
    """urllib.request.urlopen 的替代：内网直连、公网走代理。"""
    return build_opener().open(req, timeout=timeout) if timeout is not None else build_opener().open(req)
