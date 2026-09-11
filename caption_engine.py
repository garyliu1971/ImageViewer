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

支持三种音频语言（中文 / 英文 / 日语），以及"原声"或"翻译成中文"两种字幕
模式。中文音频没有翻译选项（本身就是中文）。翻译只在识别出一整句（final）
时才做一次 -- 逐字翻译每个 partial 既没必要也太慢；这意味着翻译模式下字幕
会比原声模式多一点延迟（等一句话说完才出译文），这跟 YouTube 自动翻译字幕
的实际体验是一致的。
"""
from __future__ import annotations

import ctypes
import json
import os
import queue
import threading
import urllib.request

SAMPLE_RATE = 16000

# 输出流每次写入帧数（16kHz 下约 32ms）。显式给出低延迟 + 小 blocksize，
# 避免 sounddevice 默认 latency='high' 开超大缓冲，导致出声明显滞后。
OUT_BLOCKSIZE = 512

# 识别队列上限（按音频帧计）。识别线程若偶尔跟不上实时，只会丢帧降级字幕，
# 绝不阻塞音频回调、拖累出声；有上限也保证字幕延迟不会无限累积。
PCM_QUEUE_MAX = 64

# 识别队列里的 reset 标记：seek/flush 时清空 vosk 的识别上下文。
_RESET = object()

# 防止 ctypes 回调对象被垃圾回收后 libvlc 仍持有其函数指针、导致野指针崩溃。
# 回调创建后 append 到这里，进程存活期间一直持有引用。
_CALLBACK_KEEPALIVE = []

DEFAULT_MODEL_PATHS = {
    "zh": r"C:\models\vosk-model-small-cn-0.22",
    "en": r"C:\models\vosk-model-small-en-us-0.15",
    "ja": r"C:\models\vosk-model-small-ja-0.22",
}

AI_PRESETS = {
    "DeepSeek": ("https://api.deepseek.com", "deepseek-chat"),
    "OpenAI": ("https://api.openai.com/v1", "gpt-4o-mini"),
    "通义千问": ("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"),
    "本地 Ollama": ("http://localhost:11434/v1", "qwen2.5:7b"),
    "自定义": ("", ""),
}


def _llm_translate(text, cfg):
    """OpenAI 兼容接口翻译成简体中文（阻塞调用，须在后台线程跑）。"""
    key = (cfg.get("api_key") or "").strip()
    if not key:
        raise RuntimeError("未配置 AI 翻译 API Key")
    payload = {
        "model": (cfg.get("model") or "deepseek-chat").strip(),
        "messages": [
            {"role": "system",
             "content": "你是字幕翻译，把输入内容翻译成简体中文，只输出译文，不要解释。"},
            {"role": "user", "content": text},
        ],
        "temperature": 0.2,
    }
    req = urllib.request.Request(
        (cfg.get("api_base") or "").strip().rstrip("/") + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + key},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())["choices"][0]["message"]["content"].strip()


def _default_model_path(lang):
    return os.environ.get("VOSK_MODEL_PATH_%s" % lang.upper()) or DEFAULT_MODEL_PATHS.get(lang)


class LiveCaptioner:
    def __init__(self, source_lang="en", caption_mode="original", model_path=None, ai_cfg=None):
        self.source_lang = source_lang
        self.caption_mode = caption_mode  # "original" | "translate" | "ai_translate"
        self.model_path = model_path or _default_model_path(source_lang)
        self.ai_cfg = ai_cfg or {}
        self.queue = queue.Queue()
        self.error = None
        self._model = None
        self._translator = None
        self._recognizer = None
        self._out_stream = None
        self._play_cb = None
        self._flush_cb = None
        self._player = None
        self._pending_player = None
        self._loading = False
        self._start_result = None
        self._trans_queue = None
        self._trans_thread = None
        self._pcm_queue = None
        self._rec_thread = None
        # VLC 的音频回调在它自己的线程上跑；stop() 在 UI 线程上跑。不加锁的话
        # stop() 可能在回调线程还在写 _out_stream 的时候把它关掉，PortAudio 流
        # 被并发 close()+write() 会卡死，进而把 player.stop() 也一起拖死（复现
        # 过：open_folder 切文件时主线程卡在 libvlc_media_player_stop 里不返回）。
        # 这个锁保证 stop() 会等当前正在跑的回调写完再拆流。
        #
        # vosk 识别（_recognizer）只由 _rec_worker 这一个线程碰，不跟回调线程
        # 抢锁；stop() 先投递退出标记并 join _rec_thread，之后再安全置空。
        self._callback_lock = threading.Lock()

    def available(self):
        return bool(self.model_path) and os.path.isdir(self.model_path)

    def _load_model(self):
        if self._model is None:
            import vosk
            vosk.SetLogLevel(-1)
            self._model = vosk.Model(model_path=self.model_path)
        if self.caption_mode in ("translate", "ai_translate") and self._translator is None and self.source_lang != "zh":
            try:
                import translation_engine
                self._translator = translation_engine.build_translator(self.source_lang, "zh")
            except Exception:
                if self.caption_mode == "translate":
                    raise
                self._translator = None  # ai_translate 模式下 Argos 只作兜底，缺失可继续
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
                "未找到 %s 字幕模型：%s（可设置环境变量 VOSK_MODEL_PATH_%s 指定路径）"
                % (self.source_lang, self.model_path, self.source_lang.upper())
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

            out_stream = sd.RawOutputStream(
                samplerate=SAMPLE_RATE, channels=1, dtype="int16",
                blocksize=OUT_BLOCKSIZE, latency="low")
            out_stream.start()

            play_cb = vlc.CallbackDecorators.AudioPlayCb(self._on_audio_play)
            flush_cb = vlc.CallbackDecorators.AudioFlushCb(self._on_audio_flush)
            _CALLBACK_KEEPALIVE.append(play_cb)
            _CALLBACK_KEEPALIVE.append(flush_cb)

            self._recognizer = recognizer
            self._out_stream = out_stream
            self._play_cb = play_cb
            self._flush_cb = flush_cb

            # 识别线程：vosk 只在它自己的线程里跑，音频回调线程只负责把 PCM 丢进来。
            self._pcm_queue = queue.Queue(maxsize=PCM_QUEUE_MAX)
            self._rec_thread = threading.Thread(target=self._rec_worker, daemon=True)
            self._rec_thread.start()

            # 翻译线程：每次启动都确保在跑。stop() 会停掉它并置空 _trans_queue，
            # 所以这里在重启（切视频/开关字幕）时必须重建，否则翻译结果没人消费。
            if self.caption_mode in ("translate", "ai_translate") and self._trans_queue is None:
                self._trans_queue = queue.Queue()
                self._trans_thread = threading.Thread(target=self._trans_worker, daemon=True)
                self._trans_thread.start()

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
        captions come out garbled for a while after every seek.

        recognizer 现在只由 _rec_worker 拥有，所以这里不直接碰它，而是丢一个
        _RESET 标记进队列、并顺手清掉 seek 前已排队但还没识别的旧音频帧。"""
        pcm_queue = self._pcm_queue
        if pcm_queue is None:
            return
        # 丢弃 seek 前积压的旧音频帧
        while True:
            try:
                pcm_queue.get_nowait()
            except queue.Empty:
                break
        try:
            pcm_queue.put_nowait(_RESET)
        except queue.Full:
            pass

    def stop(self):
        # 通知翻译线程退出并清空引用（_finish_start 会在下次启动时重建它）。
        trans_queue = self._trans_queue
        trans_thread = self._trans_thread
        if trans_queue is not None:
            try:
                trans_queue.put(None)
            except Exception:
                pass
        self._trans_queue = None
        self._trans_thread = None
        if trans_thread is not None and trans_thread is not threading.current_thread():
            trans_thread.join(timeout=2.0)
        # 通知识别线程退出并等它处理完当前这一帧 -- 之后才能安全置空 _recognizer。
        pcm_queue = self._pcm_queue
        rec_thread = self._rec_thread
        if pcm_queue is not None:
            try:
                pcm_queue.put(None)
            except Exception:
                pass
        self._rec_thread = None
        self._pcm_queue = None
        if rec_thread is not None and rec_thread is not threading.current_thread():
            rec_thread.join(timeout=2.0)
        # 不主动调 audio_set_callbacks(None, ...) 去解绑 -- 实测这样做之后紧
        # 跟着的 player.stop() 会在 libvlc 内部崩掉（access violation），大概
        # 是把 libvlc 的音频输出内部状态搞乱了。改成什么都不做，让调用方随后
        # 自己的 player.stop() 去处理 -- 那之后 VLC 不会再调用这个回调，我们
        # 也不清空 _play_cb/_flush_cb（万一 libvlc 内部还留着指向它们的指针，
        # 提前被 Python 回收就是野指针）。
        self._player = None
        # 等任何正在执行的回调写完，再拆 _out_stream -- 见 __init__ 里
        # _callback_lock 的注释。
        with self._callback_lock:
            if self._out_stream is not None:
                try:
                    # .stop() waits for buffered audio to drain before
                    # returning; on this sounddevice/PortAudio build that
                    # wait reliably hung for 10s+ and then crashed the
                    # process with an access violation. .abort() discards
                    # the buffer and returns immediately instead -- fine
                    # here since we're tearing the stream down anyway.
                    self._out_stream.abort()
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

        # 回调里只做「出声」这一件事，保持实时。vosk 识别不在这里做，而是把
        # PCM 丢给 _rec_worker，避免识别耗时让音频回调跟不上实时节奏 → 滞后/卡顿。
        with self._callback_lock:
            out_stream = self._out_stream
            if out_stream is not None:
                try:
                    out_stream.write(buf)
                except Exception:
                    pass

        # 非阻塞投递；队列满说明识别暂时跟不上，丢这一帧降级字幕，绝不阻塞出声。
        pcm_queue = self._pcm_queue
        if pcm_queue is not None:
            try:
                pcm_queue.put_nowait(buf)
            except queue.Full:
                pass

    def _rec_worker(self):
        """识别线程：独占 vosk recognizer，逐帧解码音频，结果写回字幕队列。

        音频回调线程和这个线程通过 _pcm_queue 解耦 -- 回调不碰 recognizer，
        识别再慢也只会积压/丢帧，不会反过来拖慢音频回调导致出声滞后。

        VLC 的音频回调一帧只有 ~26ms（约 42 次/秒），若每帧都调一次
        AcceptWaveform，调用开销累积很高，视频软解 + 翻译 + UI 一起跑时识别
        线程容易落后 → 丢帧 → 音频断档 → vosk 提前收句成「一两个字」。这里先
        攒到约 100ms 再一次性喂给 vosk，把调用频率降到 ~10 次/秒，稳定跑赢实时。"""
        pcm_queue = self._pcm_queue
        acc = bytearray()
        target = SAMPLE_RATE * 2 * 100 // 1000  # 16000Hz*2字节*0.1s = 3200 字节
        while True:
            item = pcm_queue.get()
            if item is None:
                break
            recognizer = self._recognizer
            if recognizer is None:
                continue
            if item is _RESET:
                try:
                    recognizer.Reset()
                except Exception:
                    pass
                acc = bytearray()
                continue
            acc += item
            if len(acc) < target:
                continue
            buf = bytes(acc)
            acc = bytearray()
            try:
                if recognizer.AcceptWaveform(buf):
                    text = json.loads(recognizer.Result()).get("text", "")
                    if text:
                        self._emit_final(text)
                elif self.caption_mode == "original":
                    # 翻译模式下不展示原文 partial，等一句说完直接出译文，
                    # 避免字幕框里外语原文和中文译文来回跳。
                    text = json.loads(recognizer.PartialResult()).get("partial", "")
                    if text:
                        self.queue.put(("partial", self._display_text(text, self.source_lang == "zh")))
            except Exception:
                pass

    def _emit_final(self, text):
        is_chinese = self.source_lang == "zh"
        need_translate = (self.caption_mode in ("translate", "ai_translate")) and not is_chinese
        if need_translate and self._trans_queue is not None:
            # 翻译（ctranslate2 / LLM）一律放到专用 Python 线程里做，绝不阻塞、
            # 也绝不在 VLC 的音频回调线程里调用原生库 -- 否则可能野指针/非法指令崩溃。
            self._trans_queue.put((text, is_chinese))
            return
        self.queue.put(("final", self._display_text(text, is_chinese)))

    def _trans_worker(self):
        """后台线程：消费待翻译句子，调 LLM / Argos，结果写回字幕队列。
        所有 ctranslate2 与 LLM 调用都集中在这里（Python 线程），保证不在
        VLC 音频回调线程里碰这些原生库。"""
        trans_queue = self._trans_queue
        while True:
            item = trans_queue.get()
            if item is None:
                break
            text, is_chinese = item
            translated = None
            if self.caption_mode == "ai_translate" and self.ai_cfg.get("api_key"):
                try:
                    translated = _llm_translate(text, self.ai_cfg)
                except Exception:
                    translated = None
            if not translated and self._translator is not None:
                try:
                    translated = self._translator.translate(text)
                except Exception:
                    translated = None
            if translated:
                self.queue.put(("final", self._display_text(translated, True)))
            else:
                self.queue.put(("final", self._display_text(text, is_chinese)))

    @staticmethod
    def _display_text(text, is_chinese):
        # vosk 中文模型输出的是空格分词（"火箭 正在 飞向"），中文书面习惯不加
        # 空格，显示前去掉；英文/日文模型输出的词间空格要保留。
        return text.replace(" ", "") if is_chinese else text
