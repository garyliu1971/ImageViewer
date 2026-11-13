# -*- coding: utf-8 -*-
"""给 e2e 生成带 AC3 音轨 / 内嵌字幕的 mkv：python tests/make_ff_fixtures.py <目录>  -> 打印 JSON；没装 ffmpeg 打印 {}。"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ffmpeg_tools as ft
from tests.test_ffmpeg_tools import make_media

d = sys.argv[1]
if not (ft.find_tool("ffmpeg") and ft.find_tool("ffprobe")):
    print("{}")
    sys.exit(0)
out = {"ac3": make_media(d, "h264_ac3.mkv", dur=30), "aac": make_media(d, "h264_aac.mkv", acodec="aac", dur=30),
       "subs": make_media(d, "subs.mkv", acodec="aac", subs=True, dur=30)}
print(json.dumps(out))
