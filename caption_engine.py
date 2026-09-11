# -*- coding: utf-8 -*-
"""
caption_engine.py -- 本地实时字幕引擎（桌面版视频播放用）

用 VLC 的原始音频回调（audio_set_format + audio_set_callbacks）拿到解码后的 PCM：
  1) 写回一个本地播放流（sounddevice），保证视频仍然有声音 -- VLC 文档写明一旦
     设置了 audio 回调，libvlc 自身就不再输出任何声音了。
  2) 同时喂给 vosk 做流式识别，识别结果放进队列，UI 线程轮询取字幕文本。

代价：开启字幕后播放音质降到 16kHz 单声道（vosk 要求的格式）；关闭字幕后调
用方清空回调，libvlc 会按文档重新选择默认的音频输出模块 -- 但具体音质是否
完全恢复取决于 libvlc 的内部重协商行为，未做过量化验证。

模型加载（几百毫秒到几秒，纯 I/O + CPU，不碰 VLC/ctypes）放在后台线程里做，
避免卡住 Tk 主线程。VLC 的 audio_set_format / audio_set_callbacks / ctypes
回调创建则必须留在调用方自己的线程上执行 -- 从别的线程调用会段错误 -- 所以
由 poll() 在模型加载完成后同步做这最后一步（这部分很快，不会卡 UI）。
"""
from __future__ import annotations

import ctypes
import json
import os
import queue
import threading

SAMPLE_RATE = 16000
DEFAULT_MODEL_PATH = r"C:\models\vosk-model-small-en-us-0.15"


class LiveCaptioner:
    def __init__(self, model_path=None):
        self.model_path = model_path or os.environ.get("VOSK_MODEL_PATH", DEFAULT_MODEL_PATH)
        self.queue = queue.Queue()
        self.error = None
        self._model = None
        self._recognizer = None
        self._out_stream = None
        self._play_cb = None
        self._flush_cb = None
        self._player = None
        self._pending_player = None
        self._loading = False
        self._start_result = None

    def available(self):
        return os.path.isdir(self.model_path)

    def _load_model(self):
        if self._model is None:
            import vosk
            vosk.SetLogLevel(-1)
            self._model = vosk.Model(model_path=self.model_path)
        return self._model

    def start_async(self, player):
        """Non-blocking. Call poll() from the caller's own thread (the one
        that owns `player`) to find out when it's done."""
        if self._player is not None:
            self._start_result = (True, None)
            return
        self._pending_player = player
        self._start_result = None
        self.error = None
        if not self.available():
            self.error = (
                "未找到字幕模型：%s（可设置环境变量 VOSK_MODEL_PATH 指定路径）" % self.model_path
            )
            self._start_result = (False, self.error)
            return
        if self._model is not None:
            self._finish_start()
            return
        if self._loading:
            return
        self._loading = True
        threading.Thread(target=self._load_model_worker, daemon=True).start()

    def poll(self):
        """Returns None while still loading, else (ok, error). Must be
        called from the thread that owns the player passed to start_async()
        -- the final VLC wiring happens here, synchronously, once the model
        finishes loading."""
        if self._start_result is not None:
            return self._start_result
        if self._loading:
            return None
        if self._model is not None:
            self._finish_start()
        return self._start_result

    def _load_model_worker(self):
        try:
            self._load_model()
        except Exception as exc:
            self.error = "字幕模型加载失败：%s" % exc
            self._start_result = (False, self.error)
        finally:
            self._loading = False

    def _finish_start(self):
        player = self._pending_player
        try:
            import vlc
            import vosk
            import sounddevice as sd

            recognizer = vosk.KaldiRecognizer(self._model, SAMPLE_RATE)
            recognizer.SetWords(False)

            out_stream = sd.RawOutputStream(samplerate=SAMPLE_RATE, channels=1, dtype="int16")
            out_stream.start()

            play_cb = vlc.CallbackDecorators.AudioPlayCb(self._on_audio_play)
            flush_cb = vlc.CallbackDecorators.AudioFlushCb(self._on_audio_flush)

            self._recognizer = recognizer
            self._out_stream = out_stream
            self._play_cb = play_cb
            self._flush_cb = flush_cb
            player.audio_set_format(b"S16N", SAMPLE_RATE, 1)
            # flush 是 VLC 自己在 seek/stop 时丢弃缓冲区的信号 -- 用它来清空识别器
            # 上下文，比在 UI 线程的 seek 事件里手动调 reset() 更准，能避免 UI 侧
            # 时机跟 VLC 内部丢弃缓冲区的时机没对齐、导致跳转后残留一两个旧词的问题。
            player.audio_set_callbacks(play_cb, None, None, flush_cb, None, None)
            self._player = player
            self.error = None
            self._start_result = (True, None)
        except Exception as exc:
            self.error = "字幕启动失败：%s" % exc
            self.stop()
            self._start_result = (False, self.error)

    def reset(self):
        """Clears the recognizer's rolling context. Call this whenever the
        player seeks -- otherwise the recognizer keeps decoding new audio
        against a hypothesis built from audio right before the jump, and
        captions come out garbled for a while after every seek."""
        recognizer = self._recognizer
        if recognizer is not None:
            try:
                recognizer.Reset()
            except Exception:
                pass

    def stop(self):
        if self._player is not None:
            try:
                self._player.audio_set_callbacks(None, None, None, None, None, None)
            except Exception:
                pass
        self._player = None
        self._play_cb = None
        self._flush_cb = None
        if self._out_stream is not None:
            try:
                self._out_stream.stop()
                self._out_stream.close()
            except Exception:
                pass
            self._out_stream = None
        self._recognizer = None
        while True:
            try:
                self.queue.get_nowait()
            except queue.Empty:
                break

    def _on_audio_flush(self, data, pts):
        self.reset()

    def _on_audio_play(self, data, samples, count, pts):
        try:
            buf = ctypes.string_at(samples, count * 2)
        except Exception:
            return

        out_stream = self._out_stream
        if out_stream is not None:
            try:
                out_stream.write(buf)
            except Exception:
                pass

        recognizer = self._recognizer
        if recognizer is None:
            return
        try:
            if recognizer.AcceptWaveform(buf):
                text = json.loads(recognizer.Result()).get("text", "")
                if text:
                    self.queue.put(("final", text))
            else:
                text = json.loads(recognizer.PartialResult()).get("partial", "")
                if text:
                    self.queue.put(("partial", text))
        except Exception:
            pass
