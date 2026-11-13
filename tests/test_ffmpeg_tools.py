# -*- coding: utf-8 -*-
"""ffmpeg_tools：发现 / 判断 / argv 构造（纯逻辑，用假数据）+ 真 ffmpeg 的探测与转码（没装就带原因跳过）。"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ffmpeg_tools as ft

HAVE_FF = bool(ft.find_tool("ffmpeg") and ft.find_tool("ffprobe"))
SKIP = "没找到 ffmpeg / ffprobe（winget install Gyan.FFmpeg；FFMPEG_PATH 可指路）"


def make_media(dirpath, name, vcodec="libx264", acodec="ac3", extra=None, dur=6, subs=False, pix="yuv420p"):
    """用真 ffmpeg 生成测试片：testsrc + 正弦波。"""
    ff = ft.find_tool("ffmpeg")
    out = os.path.join(dirpath, name)
    argv = [ff, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=%d:size=320x180:rate=15" % dur,
            "-f", "lavfi", "-i", "sine=frequency=440:duration=%d" % dur]
    if subs:
        srt = os.path.join(dirpath, "t.srt")
        with open(srt, "w", encoding="utf-8") as f:
            f.write("1\n00:00:00,500 --> 00:00:02,000\n你好 hello\n\n2\n00:00:03,000 --> 00:00:05,000\n第二句\n")
        argv += ["-i", srt]
    argv += ["-c:v", vcodec, "-pix_fmt", pix, "-g", "15", "-keyint_min", "15", "-c:a", acodec]
    if subs:
        argv += ["-c:s", "srt", "-map", "0:v", "-map", "1:a", "-map", "2:s"]
    argv += (extra or []) + [out]
    r = subprocess.run(argv, capture_output=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode("utf-8", "replace")[-400:])
    return out


def probe_json(vcodec="h264", acodec="aac", container="matroska,webm", bits=8, pix="yuv420p", extra_streams=()):
    streams = [{"index": 0, "codec_type": "video", "codec_name": vcodec, "profile": "High", "width": 1920, "height": 1080, "pix_fmt": pix,
                "bits_per_raw_sample": str(bits), "avg_frame_rate": "24000/1001"}]
    if acodec:
        streams.append({"index": 1, "codec_type": "audio", "codec_name": acodec, "channels": 6, "channel_layout": "5.1",
                        "tags": {"language": "eng"}, "disposition": {"default": 1}})
    return {"format": {"format_name": container, "duration": "3600.5", "size": "1000", "bit_rate": "800"}, "streams": streams + list(extra_streams)}


class TestAnalyze(unittest.TestCase):
    def test_direct(self):
        a = ft.analyze(probe_json())
        self.assertEqual((a["action"], a["container"], a["duration"]), ("direct", "matroska", 3600.5))
        self.assertTrue(a["video"]["browser_ok"] and a["audio"][0]["browser_ok"])
        self.assertEqual(a["video"]["fps"], 23.976)

    def test_audio_codecs_that_need_transcode(self):
        for ac in ("ac3", "eac3", "dts", "truehd", "mlp"):
            a = ft.analyze(probe_json(acodec=ac))
            self.assertEqual(a["action"], "transcode_audio", ac)
            self.assertFalse(a["audio"][0]["browser_ok"])
            self.assertIn(ac, a["reason"])

    def test_browser_audio_ok(self):
        for ac in ("aac", "mp3", "opus", "vorbis", "flac"):
            self.assertEqual(ft.analyze(probe_json(acodec=ac))["action"], "direct", ac)

    def test_video_codecs(self):
        self.assertEqual(ft.analyze(probe_json(vcodec="hevc"))["action"], "transcode_video")
        self.assertEqual(ft.analyze(probe_json(vcodec="vp9", acodec="opus", container="matroska,webm"))["action"], "direct")
        self.assertEqual(ft.analyze(probe_json(vcodec="av1"))["action"], "direct")
        self.assertEqual(ft.analyze(probe_json(vcodec="mpeg4"))["action"], "transcode_video")
        self.assertEqual(ft.analyze(probe_json(vcodec="h264", bits=10, pix="yuv420p10le"))["action"], "transcode_video")
        a = ft.analyze(probe_json(vcodec="h264", pix="yuv444p"))
        self.assertFalse(a["video"]["browser_ok"])

    def test_container_remux(self):
        self.assertEqual(ft.analyze(probe_json(container="avi"))["action"], "remux")
        self.assertEqual(ft.analyze(probe_json(container="mpegts"))["action"], "remux")
        self.assertEqual(ft.analyze(probe_json(container="mov,mp4,m4a,3gp,3g2,mj2"))["action"], "direct")

    def test_picks_playable_audio_track(self):
        extra = [{"index": 2, "codec_type": "audio", "codec_name": "aac", "channels": 2, "tags": {"language": "zho"}}]
        a = ft.analyze(probe_json(acodec="eac3", extra_streams=extra))
        self.assertEqual((a["audio_index"], a["action"]), (1, "direct"))        # 有一条能直接播的 AAC：用它，不转码

    def test_no_video_and_no_audio(self):
        self.assertEqual(ft.analyze({"format": {}, "streams": [{"index": 0, "codec_type": "audio", "codec_name": "aac"}]})["action"], "unsupported")
        self.assertEqual(ft.analyze(probe_json(acodec=None))["action"], "direct")             # 无音轨视频照常

    def test_subtitles(self):
        subs = [{"index": 2, "codec_type": "subtitle", "codec_name": "subrip", "tags": {"language": "chi"}},
                {"index": 3, "codec_type": "subtitle", "codec_name": "hdmv_pgs_subtitle"},
                {"index": 4, "codec_type": "subtitle", "codec_name": "ass"}]
        a = ft.analyze(probe_json(extra_streams=subs))
        self.assertEqual([(s["kind"], s["extractable"]) for s in a["subtitles"]], [("text", True), ("image", False), ("text", True)])

    def test_garbage_probe(self):
        self.assertEqual(ft.analyze({})["action"], "unsupported")


class TestArgv(unittest.TestCase):
    FF = "/x/ffmpeg"

    def test_audio_transcode_argv(self):
        a = ft.build_stream_argv(self.FF, "/m/a.mkv", "audio", audio_index=1, start=12.5, stereo=True)
        self.assertEqual(a[0], self.FF)
        self.assertIn("-nostdin", a)
        i = a.index("-i")
        self.assertEqual(a[i + 1], "/m/a.mkv")
        self.assertLess(a.index("-ss"), i)                              # -ss 在 -i 之前（输入端 seek）
        self.assertEqual(a[a.index("-ss") + 1], "12.500")
        self.assertIn("0:a:1?", a)
        self.assertEqual(a[a.index("-c:v") + 1], "copy")
        self.assertEqual(a[a.index("-c:a") + 1], "aac")
        self.assertEqual(a[a.index("-ac") + 1], "2")
        self.assertEqual(a[-1], "pipe:1")
        self.assertEqual(a[a.index("-f") + 1], "mp4")

    def test_remux_and_video_modes(self):
        r = ft.build_stream_argv(self.FF, "/m/a.avi", "remux")
        self.assertEqual((r[r.index("-c:v") + 1], r[r.index("-c:a") + 1]), ("copy", "copy"))
        self.assertNotIn("-ss", r)
        v = ft.build_stream_argv(self.FF, "/m/a.mkv", "video", venc="libx264")
        self.assertEqual(v[v.index("-c:v") + 1], "libx264")
        self.assertIn("-crf", v)
        n = ft.build_stream_argv(self.FF, "/m/a.mkv", "video", venc="h264_nvenc")
        self.assertEqual(n[n.index("-c:v") + 1], "h264_nvenc")

    def test_argv_is_a_list_of_strings_no_shell_injection(self):
        evil = "/m/a.mkv; calc.exe & echo $(x) `y` \"z\""
        a = ft.build_stream_argv(self.FF, evil, "audio")
        self.assertTrue(all(isinstance(x, str) for x in a))
        self.assertEqual(a[a.index("-i") + 1], evil)                    # 整个当作一个参数，不会被 shell 解释
        self.assertEqual(a.count("-i"), 1)

    def test_rejects_bad_inputs(self):
        for kw in ({"mode": "x"}, {"mode": "audio", "audio_index": -1}, {"mode": "audio", "audio_index": 999},
                   {"mode": "audio", "audio_index": "1; rm"}, {"mode": "audio", "start": -5}, {"mode": "audio", "start": 10 ** 9},
                   {"mode": "audio", "start": "abc"}):
            with self.assertRaises(ValueError, msg=kw):
                ft.build_stream_argv(self.FF, "/m/a.mkv", **kw)

    def test_url_inputs_get_whitelist_and_timeout(self):
        a = ft.build_stream_argv(self.FF, "http://127.0.0.1:1234/api/media/in/abcd", "audio")
        self.assertEqual(a[a.index("-protocol_whitelist") + 1], "http,tcp,file")
        self.assertIn("-rw_timeout", a)
        b = ft.build_stream_argv(self.FF, "/m/a.mkv", "audio")
        self.assertEqual(b[b.index("-protocol_whitelist") + 1], "file")

    def test_probe_and_subtitle_argv(self):
        p = ft.build_probe_argv("/x/ffprobe", "/m/a.mkv")
        self.assertIn("-probesize", p)
        self.assertEqual(p[-2:], ["-i", "/m/a.mkv"])
        s = ft.build_subtitle_argv(self.FF, "/m/a.mkv", 2)
        self.assertEqual(s[s.index("-map") + 1], "0:s:2")
        self.assertEqual(s[s.index("-f") + 1], "webvtt")
        with self.assertRaises(ValueError):
            ft.build_subtitle_argv(self.FF, "/m/a.mkv", "x")

    def test_hw_encoder_args(self):
        for enc, key in (("h264_qsv", "-global_quality"), ("h264_amf", "-quality")):
            a = ft.build_stream_argv(self.FF, "/m/a.mkv", "video", venc=enc)
            self.assertIn(key, a)


class TestVtt(unittest.TestCase):
    VTT = "WEBVTT\n\n00:00:00.500 --> 00:00:02.000\n你好\n\n00:00:03.000 --> 00:00:05.000\n第二句\n\n01:00:00.000 --> 01:00:01.500\n很晚\n"

    def test_shift(self):
        out = ft.shift_vtt(self.VTT, 2.5)
        self.assertNotIn("你好", out)                          # 结束时间 <= 0 的丢掉
        self.assertIn("00:00:00.500 --> 00:00:02.500\n第二句", out)
        self.assertIn("00:59:57.500 --> 00:59:59.000\n很晚", out)
        self.assertTrue(out.startswith("WEBVTT"))

    def test_shift_clamps_start_and_zero_is_noop(self):
        out = ft.shift_vtt(self.VTT, 1.0)
        self.assertIn("00:00:00.000 --> 00:00:01.000\n你好", out)
        self.assertEqual(ft.shift_vtt(self.VTT, 0), self.VTT)


class TestDiscovery(unittest.TestCase):
    def test_env_override_and_missing(self):
        old = {k: os.environ.get(k) for k in ("FFMPEG_PATH", "FFPROBE_PATH")}
        d = tempfile.mkdtemp()
        try:
            fake = os.path.join(d, "ffmpeg.exe" if os.name == "nt" else "ffmpeg")
            open(fake, "w").close()
            os.environ["FFMPEG_PATH"] = fake
            ft.reset_cache()
            self.assertEqual(ft.find_tool("ffmpeg"), os.path.abspath(fake))
            os.environ["FFMPEG_PATH"] = os.path.join(d, "nope")
            ft.reset_cache()
            self.assertNotEqual(ft.find_tool("ffmpeg"), os.path.join(d, "nope"))
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            ft.reset_cache()
            shutil.rmtree(d, ignore_errors=True)

    @unittest.skipUnless(HAVE_FF, SKIP)
    def test_info(self):
        i = ft.info()
        self.assertTrue(i["available"])
        self.assertRegex(i["version"], r"^\d")
        self.assertIn("libx264", i["encoders"])

    def test_vlc_env(self):
        d = tempfile.mkdtemp()
        old = os.environ.get("IV_VLC_PATH")
        try:
            f = os.path.join(d, "vlc.exe")
            open(f, "w").close()
            os.environ["IV_VLC_PATH"] = f
            self.assertEqual(ft.find_vlc(), f)
        finally:
            if old is None:
                os.environ.pop("IV_VLC_PATH", None)
            else:
                os.environ["IV_VLC_PATH"] = old
            shutil.rmtree(d, ignore_errors=True)


@unittest.skipUnless(HAVE_FF, SKIP)
class TestRealFfmpeg(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="iv_ff_")
        cls.ac3 = make_media(cls.tmp, "h264_ac3.mkv")
        cls.aac = make_media(cls.tmp, "h264_aac.mkv", acodec="aac")
        cls.subs = make_media(cls.tmp, "subs.mkv", acodec="aac", subs=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_probe_real_ac3_mkv(self):
        a = ft.analyze(ft.run_probe(self.ac3))
        self.assertEqual((a["container"], a["video"]["codec"], a["audio"][0]["codec"]), ("matroska", "h264", "ac3"))
        self.assertEqual((a["video"]["width"], a["video"]["height"]), (320, 180))
        self.assertAlmostEqual(a["duration"], 6.0, delta=0.5)
        self.assertEqual(a["action"], "transcode_audio")

    def test_probe_real_aac_is_direct(self):
        self.assertEqual(ft.analyze(ft.run_probe(self.aac))["action"], "direct")

    def test_probe_real_subtitles(self):
        a = ft.analyze(ft.run_probe(self.subs))
        self.assertEqual([(s["codec"], s["extractable"]) for s in a["subtitles"]], [("subrip", True)])

    def test_probe_missing_file_errors(self):
        with self.assertRaises(RuntimeError):
            ft.run_probe(os.path.join(self.tmp, "nope.mkv"))

    def _run_stream(self, src, **kw):
        ff = ft.find_tool("ffmpeg")
        p = ft.popen(ft.build_stream_argv(ff, src, **kw))
        data = p.stdout.read()
        p.wait()
        err = ft.err_tail(p)
        ft.kill(p)
        return data, err

    def test_audio_transcode_produces_playable_aac_fmp4(self):
        data, err = self._run_stream(self.ac3, mode="audio")
        self.assertGreater(len(data), 5000, err)
        out = os.path.join(self.tmp, "out_audio.mp4")
        with open(out, "wb") as f:
            f.write(data)
        a = ft.analyze(ft.run_probe(out))
        self.assertEqual((a["video"]["codec"], a["audio"][0]["codec"]), ("h264", "aac"))
        self.assertEqual(a["action"], "direct")

    def test_start_offset_shortens_stream(self):
        data, err = self._run_stream(self.ac3, mode="audio", start=3)
        out = os.path.join(self.tmp, "out_start.mp4")
        with open(out, "wb") as f:
            f.write(data)
        d = ft.analyze(ft.run_probe(out))["duration"]
        self.assertLess(d, 4.5)
        self.assertGreater(d, 1.0)

    def test_remux_copy(self):
        data, err = self._run_stream(self.aac, mode="remux")
        out = os.path.join(self.tmp, "out_remux.mp4")
        with open(out, "wb") as f:
            f.write(data)
        a = ft.analyze(ft.run_probe(out))
        self.assertEqual((a["video"]["codec"], a["audio"][0]["codec"]), ("h264", "aac"))

    def test_subtitle_extraction_and_kill(self):
        vtt = ft.extract_subtitle(self.subs, 0)
        self.assertTrue(vtt.startswith("WEBVTT"))
        self.assertIn("你好 hello", vtt)
        self.assertEqual(ft.live_count(), 0)

    def test_hevc_probe_is_transcode_video(self):
        try:
            hv = make_media(self.tmp, "hevc.mkv", vcodec="libx265", acodec="aac", extra=["-x265-params", "log-level=error"])
        except RuntimeError as e:
            self.skipTest("本机 ffmpeg 没有 libx265：%s" % e)
        a = ft.analyze(ft.run_probe(hv))
        self.assertEqual((a["video"]["codec"], a["action"]), ("hevc", "transcode_video"))

    def test_video_transcode_software(self):
        try:
            hv = make_media(self.tmp, "hevc2.mkv", vcodec="libx265", acodec="ac3", extra=["-x265-params", "log-level=error"])
        except RuntimeError as e:
            self.skipTest("本机 ffmpeg 没有 libx265：%s" % e)
        data, err = self._run_stream(hv, mode="video", venc="libx264")
        out = os.path.join(self.tmp, "out_video.mp4")
        with open(out, "wb") as f:
            f.write(data)
        a = ft.analyze(ft.run_probe(out))
        self.assertEqual((a["video"]["codec"], a["audio"][0]["codec"], a["action"]), ("h264", "aac", "direct"))

    def test_slot_limit(self):
        got = []
        try:
            for _ in range(ft.MAX_CONCURRENT):
                ft.acquire_slot()
                got.append(1)
            with self.assertRaises(ft.Busy):
                ft.acquire_slot()
        finally:
            for _ in got:
                ft.release_slot()


if __name__ == "__main__":
    unittest.main()
