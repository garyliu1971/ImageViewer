# -*- coding: utf-8 -*-
"""RemoteSource 数据类型（独立成模块：只依赖 urllib.parse，启动时导入几乎零成本，
不必为了 isinstance 判断而加载 urllib.request / http.server 等重模块）。"""

import urllib.parse


class RemoteSource:
    """一个远程媒体条目（文件或目录）。

    path 存服务端原始 href（已百分号编码，形如 "/dav/Movies/a.mp4"），
    name 存解码后的显示名。provider 用于回查对应的 RemoteProvider。
    """

    __slots__ = ("provider", "path", "name", "size", "is_dir", "mtime", "kind", "extra")

    def __init__(self, provider, path, name=None, size=None, is_dir=False, mtime=None,
                 kind=None, extra=None):
        self.provider = provider
        self.path = path
        self.name = name or urllib.parse.unquote(path.rstrip("/").split("/")[-1])
        self.size = size
        self.is_dir = is_dir
        self.mtime = mtime
        self.kind = kind          # "image" | "video" | "audio" | "folder" | None
        self.extra = extra or {}  # provider 私有数据（如 Jellyfin 的 item 元数据）

    def __repr__(self):
        return "<RemoteSource %s:%s>" % (self.provider, self.path)

    def __eq__(self, other):
        return (isinstance(other, RemoteSource)
                and self.provider == other.provider and self.path == other.path)

    def __hash__(self):
        return hash((self.provider, self.path))

    def key(self):
        """续播点 / 历史的稳定标识。"""
        return "remote:" + self.provider + ":" + self.path
