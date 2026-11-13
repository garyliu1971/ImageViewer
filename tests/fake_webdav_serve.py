# -*- coding: utf-8 -*-
"""把一个目录里的文件用假 WebDAV（Basic u/p）发出去，给浏览器 e2e 用。
用法：python tests/fake_webdav_serve.py <目录>   -> 打印 ROOT=http://127.0.0.1:端口/dav 后一直跑到被杀。"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests.fake_webdav import FakeWebDav

d = sys.argv[1]
files = {}
for n in os.listdir(d):
    with open(os.path.join(d, n), "rb") as f:
        files["/dav/视频/" + n] = f.read()
dav = FakeWebDav(files, user="u", pw="p")
print("ROOT=" + dav.start(), flush=True)
while True:
    time.sleep(1)
