# -*- coding: utf-8 -*-
"""ffmpeg / ffprobe 辅助（只在本地后端用，可选依赖）：发现、探测（ffprobe）、「浏览器能不能播」的判断、
转码流的命令行构造、进程并发 / 清理、内嵌字幕转 WebVTT。

安全约定：
* 命令行全部由本模块按固定模板拼成 argv 列表（不经过 shell），客户端只能选 音轨序号 / 起点秒数 / 模式，
  不能传任何自定义参数或 URL；输入只能是后端校验过的本机视频路径，或后端自己签发的一次性回环 URL（见 web_backend 的 nonce）。
* 不用临时文件：输出走 stdout 管道，stderr 只留有限长度的尾部用来报错（从不包含凭据：凭据不在 argv 里）。
"""

import glob
import json
import os
import re
import shutil
import subprocess
import threading
import time

IS_WIN = os.name == "nt"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if IS_WIN else 0
STDERR_KEEP = 4000
MAX_CONCURRENT = max(1, int(os.environ.get("IV_FFMPEG_MAX", "2") or 2))
PROBE_TIMEOUT = 40
FIRST_BYTE_TIMEOUT = 120          # 云端冷启动（多次 Range 读）可能很慢
SUB_TIMEOUT = 240
SUB_MAX_BYTES = 3 * 1024 * 1024

# ---------------------------------------------------------------- 发现
_cache = {}
_cache_lock = threading.Lock()


def _candidates(name):
    exe = name + (".exe" if IS_WIN else "")
    env = os.environ.get("FFMPEG_PATH" if name == "ffmpeg" else "FFPROBE_PATH")
    if env:
        yield env if os.path.isfile(env) else os.path.join(env, exe)
    if name == "ffprobe" and os.environ.get("FFMPEG_PATH"):
        fp = os.environ["FFMPEG_PATH"]
        yield os.path.join(fp if os.path.isdir(fp) else os.path.dirname(fp), exe)
    w = shutil.which(name)
    if w:
        yield w
    if IS_WIN:
        la = os.environ.get("LOCALAPPDATA") or ""
        if la:
            for g in glob.glob(os.path.join(la, "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg*", "**", "bin", exe), recursive=True):
                yield g
            yield os.path.join(la, "Microsoft", "WinGet", "Links", exe)
        for d in (r"C:\ffmpeg\bin", r"C:\Program Files\ffmpeg\bin", r"C:\Program Files (x86)\ffmpeg\bin",
                  os.path.join(os.environ.get("ProgramData", r"C:\ProgramData"), "chocolatey", "bin"),
                  os.path.join(os.path.expanduser("~"), "scoop", "shims")):
            yield os.path.join(d, exe)
    else:
        for d in ("/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"):
            yield os.path.join(d, exe)


def find_tool(name):
    """ffmpeg / ffprobe 的路径（缓存；找不到返回 None）。顺序：环境变量 > PATH > winget(Gyan.FFmpeg) > 常见目录。"""
    with _cache_lock:
        if name in _cache:
            return _cache[name]
    found = None
    for c in _candidates(name):
        if c and os.path.isfile(c):
            found = os.path.abspath(c)
            break
    with _cache_lock:
        _cache[name] = found
    return found


def reset_cache():
    with _cache_lock:
        _cache.clear()


def _run_quick(argv, timeout=10):
    try:
        r = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout, creationflags=NO_WINDOW)
        return r.returncode, r.stdout.decode("utf-8", "replace"), r.stderr.decode("utf-8", "replace")
    except Exception as e:
        return -1, "", str(e)


def info():
    """给 /api/caps 用：{available, version, ffprobe, encoders}。只调一次 ffmpeg（缓存）。"""
    with _cache_lock:
        if "info" in _cache:
            return dict(_cache["info"])
    ff, fp = find_tool("ffmpeg"), find_tool("ffprobe")
    out = {"available": bool(ff and fp), "version": "", "ffprobe": bool(fp), "encoders": []}
    if ff:
        rc, so, _ = _run_quick([ff, "-hide_banner", "-version"], 8)
        m = re.match(r"ffmpeg version (\S+)", so)
        out["version"] = m.group(1) if m else ""
        rc, so, _ = _run_quick([ff, "-hide_banner", "-encoders"], 10)
        names = set(re.findall(r"^\s*V\S*\s+(\S+)", so, re.M))
        out["encoders"] = [e for e in ("h264_nvenc", "h264_qsv", "h264_amf", "libx264") if e in names]
        out["aac"] = bool(re.search(r"^\s*A\S*\s+aac\b", so, re.M))
    with _cache_lock:
        _cache["info"] = out
    return dict(out)


def video_encoder(force_software=False):
    """能用的最好的 H.264 编码器：硬件（nvenc / qsv / amf，各试一次真编码，缓存）优先，否则 libx264。"""
    ff = find_tool("ffmpeg")
    if not ff:
        return None
    if not force_software:
        with _cache_lock:
            if "venc" in _cache:
                return _cache["venc"]
        pick = "libx264"
        for enc in [e for e in info()["encoders"] if e != "libx264"]:
            rc, _, _ = _run_quick([ff, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=256x256:d=0.2",
                                   "-frames:v", "3", "-c:v", enc, "-f", "null", "-"], 12)
            if rc == 0:
                pick = enc
                break
        with _cache_lock:
            _cache["venc"] = pick
        return pick
    return "libx264"


# ---------------------------------------------------------------- 探测结果 -> 判断（纯逻辑）
BROWSER_VIDEO = {"h264", "vp9", "vp8", "av1", "theora"}
BROWSER_AUDIO = {"aac", "mp3", "opus", "vorbis", "flac", "pcm_s16le", "pcm_s24le", "pcm_f32le", "alac"}
NEEDS_REMUX_CONTAINERS = ("avi", "mpegts", "flv", "asf", "mpeg", "rm", "ogm")
TEXT_SUBS = {"subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text"}
IMAGE_SUBS = {"hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub", "pgssub", "dvdsub"}


def _bits(st):
    for k in ("bits_per_raw_sample", "bits_per_sample"):
        v = st.get(k)
        if isinstance(v, str) and v.isdigit() and int(v) > 0:
            return int(v)
    pf = st.get("pix_fmt") or ""
    return 10 if re.search(r"(10|12|16)(le|be)", pf) or "p010" in pf else 8


def video_ok(st):
    c = (st.get("codec_name") or "").lower()
    if c not in BROWSER_VIDEO:
        return False
    if c == "h264" and (_bits(st) > 8 or "4:4:4" in str(st.get("profile") or "") or "High 4:4:4" in str(st.get("profile") or "")
                        or (st.get("pix_fmt") or "").startswith("yuv444") or (st.get("pix_fmt") or "").startswith("yuv422")):
        return False
    return True


def audio_ok(st):
    return (st.get("codec_name") or "").lower() in BROWSER_AUDIO


def _lang(st):
    return ((st.get("tags") or {}).get("language") or "").strip()


def analyze(probe):
    """ffprobe -show_format -show_streams 的 JSON -> 面向界面的摘要 + 浏览器支持判断 + 推荐动作。
    action: direct | remux | transcode_audio | transcode_video | unsupported"""
    fmt = probe.get("format") or {}
    streams = probe.get("streams") or []
    vids = [s for s in streams if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")]
    auds = [s for s in streams if s.get("codec_type") == "audio"]
    subs = [s for s in streams if s.get("codec_type") == "subtitle"]
    try:
        duration = float(fmt.get("duration") or (vids[0].get("duration") if vids else 0) or 0)
    except (TypeError, ValueError):
        duration = 0.0
    out = {"container": (fmt.get("format_name") or "").split(",")[0], "container_all": fmt.get("format_name") or "",
           "duration": duration, "size": int(fmt["size"]) if str(fmt.get("size", "")).isdigit() else None,
           "bit_rate": int(fmt["bit_rate"]) if str(fmt.get("bit_rate", "")).isdigit() else None,
           "video": None, "audio": [], "subtitles": []}
    if vids:
        v = vids[0]
        out["video"] = {"index": v.get("index"), "codec": v.get("codec_name"), "profile": v.get("profile") or "",
                        "width": v.get("width"), "height": v.get("height"), "pix_fmt": v.get("pix_fmt") or "",
                        "bits": _bits(v), "fps": _fps(v), "browser_ok": video_ok(v)}
    for i, a in enumerate(auds):
        out["audio"].append({"index": i, "stream": a.get("index"), "codec": a.get("codec_name"), "profile": a.get("profile") or "",
                             "channels": a.get("channels"), "layout": a.get("channel_layout") or "", "language": _lang(a),
                             "title": (a.get("tags") or {}).get("title") or "", "default": bool((a.get("disposition") or {}).get("default")),
                             "browser_ok": audio_ok(a)})
    for i, s in enumerate(subs):
        c = (s.get("codec_name") or "").lower()
        out["subtitles"].append({"index": i, "stream": s.get("index"), "codec": c, "language": _lang(s),
                                 "title": (s.get("tags") or {}).get("title") or "",
                                 "kind": "text" if c in TEXT_SUBS else ("image" if c in IMAGE_SUBS else "unknown"),
                                 "extractable": c in TEXT_SUBS})
    # 默认音轨：default 标记且浏览器能播 > 第一条浏览器能播的 > default > 第一条
    pick = None
    for pred in (lambda a: a["default"] and a["browser_ok"], lambda a: a["browser_ok"], lambda a: a["default"], lambda a: True):
        pick = next((a for a in out["audio"] if pred(a)), None)
        if pick:
            break
    out["audio_index"] = pick["index"] if pick else 0
    cont = out["container"]
    cont_remux = any(cont.startswith(c) for c in NEEDS_REMUX_CONTAINERS)
    if not out["video"]:
        action, why = "unsupported", "没有视频流"
    elif not out["video"]["browser_ok"]:
        action, why = "transcode_video", "视频编码（%s%s）浏览器解不了，需要转成 H.264" % (out["video"]["codec"], " 10bit" if out["video"]["bits"] > 8 else "")
    elif out["audio"] and not (pick and pick["browser_ok"]):
        action, why = "transcode_audio", "音轨编码（%s）浏览器解不了，只需把音轨转成 AAC（视频不重编码）" % (pick["codec"] if pick else "?")
    elif cont_remux:
        action, why = "remux", "容器（%s）浏览器不能直接播，换个封装即可（不重编码）" % cont
    else:
        action, why = "direct", "浏览器可以直接播放"
    out["action"], out["reason"] = action, why
    out["browser_support"] = {"video": bool(out["video"] and out["video"]["browser_ok"]),
                              "audio": (not out["audio"]) or bool(pick and pick["browser_ok"]), "container": not cont_remux}
    return out


def _fps(v):
    r = v.get("avg_frame_rate") or v.get("r_frame_rate") or ""
    m = re.match(r"^(\d+)/(\d+)$", r)
    if m and int(m.group(2)):
        return round(int(m.group(1)) / int(m.group(2)), 3)
    return None


# ---------------------------------------------------------------- 命令行构造（纯逻辑）
MODES = ("auto", "remux", "audio", "video")


def input_args(src):
    """-i 之前的输入选项。URL（回环 nonce）加超时 + 协议白名单；本机路径只允许 file。"""
    if re.match(r"^https?://", src):
        return ["-protocol_whitelist", "http,tcp,file", "-rw_timeout", "60000000", "-reconnect", "1", "-reconnect_streamed", "1"]
    return ["-protocol_whitelist", "file"]


def build_probe_argv(ffprobe, src):
    return [ffprobe, "-v", "error", "-probesize", "16M", "-analyzeduration", "20M"] + input_args(src) + \
        ["-print_format", "json", "-show_format", "-show_streams", "-i", src]


def build_stream_argv(ffmpeg, src, mode, audio_index=0, start=0.0, venc="libx264", stereo=False, abitrate="192k"):
    """转码 / 转封装成 fragmented MP4 写到 stdout。mode: remux(音视频都 copy) | audio(视频 copy，音频转 AAC) | video(视频转 H.264 + 音频转 AAC)。"""
    if mode not in ("remux", "audio", "video"):
        raise ValueError("mode 不合法")
    audio_index = int(audio_index)
    if not 0 <= audio_index < 64:
        raise ValueError("audio 序号不合法")
    start = float(start)
    if not 0 <= start <= 3 * 24 * 3600:
        raise ValueError("start 不合法")
    argv = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin"]
    argv += input_args(src)
    if start > 0:
        argv += ["-ss", "%.3f" % start]                     # 放在 -i 前：输入端 seek（关键帧精度，快）
    argv += ["-i", src, "-map", "0:v:0", "-map", "0:a:%d?" % audio_index, "-sn", "-dn", "-map_metadata", "-1"]
    if mode in ("remux", "audio"):
        argv += ["-c:v", "copy"]
    else:
        argv += _venc_args(venc)
    if mode == "remux":
        argv += ["-c:a", "copy"]
    else:
        argv += ["-c:a", "aac", "-b:a", abitrate]
        if stereo:
            argv += ["-ac", "2"]
    argv += ["-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1"]
    return argv


def _venc_args(venc):
    if venc == "h264_nvenc":
        return ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "23", "-pix_fmt", "yuv420p", "-g", "48"]
    if venc == "h264_qsv":
        return ["-c:v", "h264_qsv", "-global_quality", "23", "-pix_fmt", "nv12", "-g", "48"]
    if venc == "h264_amf":
        return ["-c:v", "h264_amf", "-quality", "speed", "-pix_fmt", "yuv420p", "-g", "48"]
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-g", "48"]


def build_subtitle_argv(ffmpeg, src, stream_index):
    n = int(stream_index)
    if not 0 <= n < 64:
        raise ValueError("字幕序号不合法")
    return [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin"] + input_args(src) + \
        ["-i", src, "-map", "0:s:%d" % n, "-vn", "-an", "-dn", "-f", "webvtt", "pipe:1"]


# ---------------------------------------------------------------- 进程管理
_procs = set()
_procs_lock = threading.Lock()
_slots = threading.BoundedSemaphore(MAX_CONCURRENT)


class Busy(Exception):
    pass


def acquire_slot():
    if not _slots.acquire(blocking=False):
        raise Busy("转码任务太多（同时最多 %d 个）。先关掉别的转码播放再试。" % MAX_CONCURRENT)


def release_slot():
    try:
        _slots.release()
    except ValueError:
        pass


def popen(argv, popen_fn=subprocess.Popen):
    """启动子进程（无 shell、无控制台窗口、stdin 关掉）并登记，方便服务关闭时统一清理。"""
    p = popen_fn(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=NO_WINDOW, bufsize=0)
    p._iv_err = bytearray()

    def drain():
        try:
            while True:
                b = p.stderr.read(1024)
                if not b:
                    break
                if len(p._iv_err) < STDERR_KEEP:
                    p._iv_err += b[:STDERR_KEEP - len(p._iv_err)]
        except Exception:
            pass
    threading.Thread(target=drain, daemon=True, name="iv-ffmpeg-err").start()
    with _procs_lock:
        _procs.add(p)
    return p


def kill(p):
    try:
        if p.poll() is None:
            if IS_WIN:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)], capture_output=True, timeout=5, creationflags=NO_WINDOW)
            p.kill()
    except Exception:
        pass
    try:
        p.wait(timeout=3)
    except Exception:
        pass
    for f in (p.stdout, p.stderr):
        try:
            f and f.close()
        except Exception:
            pass
    with _procs_lock:
        _procs.discard(p)


def kill_all():
    with _procs_lock:
        ps = list(_procs)
    for p in ps:
        kill(p)


def live_count():
    with _procs_lock:
        return len([p for p in _procs if p.poll() is None])


def err_tail(p):
    t = bytes(getattr(p, "_iv_err", b"")).decode("utf-8", "replace").strip()
    return t[-600:]


def run_probe(src, timeout=PROBE_TIMEOUT):
    fp = find_tool("ffprobe")
    if not fp:
        raise RuntimeError("没找到 ffprobe")
    p = popen(build_probe_argv(fp, src))
    out = []
    t = threading.Thread(target=lambda: out.append(p.stdout.read()), daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        kill(p)
        raise TimeoutError("探测超时（%d 秒）：文件太大或网盘太慢" % timeout)
    p.wait()
    data = out[0] if out else b""
    err = err_tail(p)
    kill(p)
    if not data:
        raise RuntimeError("ffprobe 失败：" + (err or "没有输出"))
    try:
        j = json.loads(data.decode("utf-8", "replace"))
    except ValueError:
        raise RuntimeError("ffprobe 输出无法解析：" + err)
    if not j.get("streams"):
        raise RuntimeError("ffprobe 没读出任何流：" + (err or "文件打不开或不是媒体"))
    return j


# ---------------------------------------------------------------- 字幕 WebVTT
_TS = re.compile(r"(?:(\d+):)?(\d\d):(\d\d)[.,](\d{3})")


def _sec(m):
    return int(m.group(1) or 0) * 3600 + int(m.group(2)) * 60 + int(m.group(3)) + int(m.group(4)) / 1000.0


def _fmt(t):
    t = max(0.0, t)
    ms = int(round(t * 1000))
    return "%02d:%02d:%02d.%03d" % (ms // 3600000, ms // 60000 % 60, ms // 1000 % 60, ms % 1000)


def shift_vtt(text, offset):
    """把 WebVTT 所有时间减去 offset 秒（转码流从 start 秒开始播放，字幕要对齐到流的时间轴）。结束时间 <= 0 的 cue 丢掉。"""
    if not offset:
        return text
    blocks = re.split(r"\n\s*\n", text.replace("\r\n", "\n"))
    out = []
    for b in blocks:
        lines = b.split("\n")
        idx = next((i for i, l in enumerate(lines) if "-->" in l), None)
        if idx is None:
            out.append(b)
            continue
        a, _, c = lines[idx].partition("-->")
        ma, mc = _TS.search(a), _TS.search(c)
        if not ma or not mc:
            out.append(b)
            continue
        s, e = _sec(ma) - offset, _sec(mc) - offset
        if e <= 0:
            continue
        rest = c[mc.end():]
        lines[idx] = "%s --> %s%s" % (_fmt(s), _fmt(e), rest)
        out.append("\n".join(lines))
    return "\n\n".join(out).strip() + "\n"


def extract_subtitle(src, stream_index, timeout=SUB_TIMEOUT):
    ff = find_tool("ffmpeg")
    if not ff:
        raise RuntimeError("没找到 ffmpeg")
    p = popen(build_subtitle_argv(ff, src, stream_index))
    buf = []
    done = threading.Event()

    def rd():
        n = 0
        while True:
            b = p.stdout.read(65536)
            if not b:
                break
            n += len(b)
            if n > SUB_MAX_BYTES:
                break
            buf.append(b)
        done.set()
    threading.Thread(target=rd, daemon=True).start()
    if not done.wait(timeout):
        kill(p)
        raise TimeoutError("提取字幕超时（%d 秒）" % timeout)
    p.wait()
    err = err_tail(p)
    data = b"".join(buf)
    kill(p)
    if not data:
        raise RuntimeError("提取字幕失败：" + (err or "没有内容"))
    return data.decode("utf-8", "replace")


# ---------------------------------------------------------------- VLC
def find_vlc():
    env = os.environ.get("IV_VLC_PATH")
    if env and os.path.isfile(env):
        return env
    w = shutil.which("vlc")
    if w:
        return w
    cands = []
    if IS_WIN:
        try:
            import winreg
            for root, sub in ((winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\VideoLAN\VLC"), (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\VideoLAN\VLC"),
                              (winreg.HKEY_CURRENT_USER, r"SOFTWARE\VideoLAN\VLC")):
                try:
                    with winreg.OpenKey(root, sub) as k:
                        d = winreg.QueryValueEx(k, "InstallDir")[0]
                        cands.append(os.path.join(d, "vlc.exe"))
                except OSError:
                    pass
        except ImportError:
            pass
        cands += [r"C:\Program Files\VideoLAN\VLC\vlc.exe", r"C:\Program Files (x86)\VideoLAN\VLC\vlc.exe"]
    else:
        cands += ["/Applications/VLC.app/Contents/MacOS/VLC", "/usr/bin/vlc"]
    return next((c for c in cands if os.path.isfile(c)), None)
