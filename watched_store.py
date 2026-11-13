# -*- coding: utf-8 -*-
"""视频「已看」状态 + 续播点的纯逻辑（桌面版和网页后端共用，无 UI / 无 IO）。

配置里两个同级 key（都是 {key: 值}，key 方案相同：本机 = normcase(abspath)，云端 = dav:<host>/<路径>）：
  _video_resume_  : {key: 毫秒整数}     —— 老格式，一字不改
  _video_watched_ : {key: unix 秒整数}  —— 新增；老版本不认识这个 key，读写配置时原样保留（config_store 是整份 json 往返）
"""

import time

RESUME_KEY = "_video_resume_"
WATCHED_KEY = "_video_watched_"
RESUME_MIN_MS = 3000          # 开头 3 秒内 / 结尾 3 秒内不记续播点（与桌面版一致）
MAX_KEYS = 5000               # 每个表最多留这么多条（丢最旧的）


def is_finished(position_ms, length_ms):
    """播放到结尾附近：位置超过开头保护区，且离结尾不到 3 秒（长度未知时不算看完）。"""
    return length_ms > 0 and position_ms > RESUME_MIN_MS and position_ms >= length_ms - RESUME_MIN_MS


def _table(config, name):
    t = config.get(name)
    if not isinstance(t, dict):
        t = config[name] = {}
    return t


def is_watched(config, key):
    t = config.get(WATCHED_KEY)
    return isinstance(t, dict) and bool(t.get(key))


def mark_watched(config, key, flag=True, now=None, max_keys=None):
    """标记 / 取消标记已看。取消时同时不碰续播点。返回当前是否已看。"""
    t = _table(config, WATCHED_KEY)
    if flag:
        t.pop(key, None)                       # 先删再写：最近的排最后，超限时丢最旧的
        t[key] = int(now if now is not None else time.time())
        while len(t) > (max_keys or MAX_KEYS):
            t.pop(next(iter(t)))
    else:
        t.pop(key, None)
    return bool(flag)


def apply_resume(config, key, position_ms, length_ms, now=None, max_keys=None):
    """按桌面版同一规则更新续播点；看完（结尾 3 秒内）时清掉续播点并记为已看。
    返回写入后的续播毫秒（None = 已清除）。"""
    resumes = _table(config, RESUME_KEY)
    if position_ms > RESUME_MIN_MS and (length_ms <= 0 or position_ms < length_ms - RESUME_MIN_MS):
        resumes.pop(key, None)                 # 先删再写：最近看的排最后
        resumes[key] = position_ms
        while len(resumes) > (max_keys or MAX_KEYS):
            resumes.pop(next(iter(resumes)))
        return position_ms
    resumes.pop(key, None)
    if is_finished(position_ms, length_ms):
        mark_watched(config, key, True, now, max_keys)
    return None
