# -*- coding: utf-8 -*-
"""
caption_engine.py -- 本地实时字幕引擎（桌面版视频播放用）

用 VLC 的原始音频回调（audio_set_format + audio_set_callbacks）拿到解码后的 PCM：
  1) 写回一个本地播放流（sounddevice），保证视频仍然有声音 -- VLC 文档写明一旦
     设置了 audio 回调，libvlc 自身就不再输出任何声音了。
  2) 同时喂给识别器做流式识别（英文/日语用 vosk，中文用 sherpa-onnx
     Zipformer），识别结果放进队列，UI 线程轮询取字幕文本。

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

import netutil

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

# 英文仍用 vosk（小模型已足够准）；中文换 sherpa-onnx 流式 Zipformer，日语换
# SenseVoice 离线多语种模型（+ silero-vad 分句），精度与标点都优于 vosk。
DEFAULT_MODEL_PATHS = {
    "en": r"C:\models\vosk-model-small-en-us-0.15",
}

# 中文 sherpa-onnx 流式模型（int8，约 160MB）。目录内需包含：
#   tokens.txt / encoder.int8.onnx / decoder.onnx / joiner.int8.onnx
SHERPA_ZH_MODEL_DIR = r"C:\models\sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30"
SHERPA_ZH_FILES = {
    "tokens": "tokens.txt",
    "encoder": "encoder.int8.onnx",
    "decoder": "decoder.onnx",
    "joiner": "joiner.int8.onnx",
}
SHERPA_ZH_NUM_THREADS = 4


def _sherpa_zh_paths():
    d = os.environ.get("SHERPA_MODEL_DIR_ZH") or SHERPA_ZH_MODEL_DIR
    return {k: os.path.join(d, v) for k, v in SHERPA_ZH_FILES.items()}


# 中文标点恢复模型（ct-transformer，int8，约 72MB，可选；缺失时字幕照常、只是无标点）。
PUNCT_ZH_MODEL = r"C:\models\sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8\model.int8.onnx"
PUNCT_ZH_NUM_THREADS = 2


def _sherpa_punct_path():
    return os.environ.get("SHERPA_PUNCT_MODEL_ZH") or PUNCT_ZH_MODEL


# 日语 SenseVoice 离线多语种模型（int8，约 228MB）+ silero-vad 分句。
SENSEVOICE_JA_MODEL_DIR = r"C:\models\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
SILERO_VAD_MODEL = r"C:\models\silero_vad.onnx"
SENSEVOICE_NUM_THREADS = 4


def _sensevoice_paths():
    d = os.environ.get("SENSEVOICE_MODEL_DIR_JA") or SENSEVOICE_JA_MODEL_DIR
    return {
        "tokens": os.path.join(d, "tokens.txt"),
        "model": os.path.join(d, "model.int8.onnx"),
    }


def _silero_vad_path():
    return os.environ.get("SILERO_VAD_MODEL") or SILERO_VAD_MODEL

AI_PRESETS = {
    "DeepSeek": ("https://api.deepseek.com", "deepseek-chat"),
    "OpenAI": ("https://api.openai.com/v1", "gpt-4o-mini"),
    "通义千问": ("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"),
    "本地 Ollama": ("http://localhost:11434/v1", "qwen2.5:7b"),
    "自定义": ("", ""),
}


_SYSTEM_PROMPT = (
    "你是字幕翻译，把输入内容翻译成简体中文。"
    "如果提供了上文，请参考上文保持人名、称谓、专有名词的翻译前后一致。"
    "只输出译文本身，不要解释、不要加引号或任何前缀。"
)


def _llm_translate(text, cfg, history=None):
    """OpenAI 兼容接口翻译成简体中文（阻塞调用，须在后台线程跑）。

    history: 可选 [(原文, 译文), ...]（按时间顺序），供模型参考上下文，
    保持人名/术语/指代前后一致。"""
    key = (cfg.get("api_key") or "").strip()
    if not key:
        raise RuntimeError("未配置 AI 翻译 API Key")

    user_content = text
    if history:
        parts = []
        for i, (orig, trans) in enumerate(history, 1):
            parts.append("%d. 原文：%s\n   译文：%s" % (i, orig, trans))
        user_content = (
            "上文（仅供参考，用于保持翻译一致）：\n"
            + "\n".join(parts)
            + "\n\n当前句原文：\n%s\n\n请只输出当前句的简体中文译文。" % text
        )

    payload = {
        "model": (cfg.get("model") or "deepseek-chat").strip(),
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.2,
    }
    req = urllib.request.Request(
        (cfg.get("api_base") or "").strip().rstrip("/") + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + key},
    )
    with netutil.urlopen(req, timeout=20) as r:
        return json.loads(r.read())["choices"][0]["message"]["content"].strip()


def _default_model_path(lang):
    return os.environ.get("VOSK_MODEL_PATH_%s" % lang.upper()) or DEFAULT_MODEL_PATHS.get(lang)


class _VoskASR:
    """vosk 识别后端（英文 / 日语）。"""

    def __init__(self, model_path, sample_rate):
        import vosk
        vosk.SetLogLevel(-1)
        self._model = vosk.Model(model_path=model_path)
        self._sample_rate = sample_rate

    def create_stream(self):
        import vosk
        rec = vosk.KaldiRecognizer(self._model, self._sample_rate)
        rec.SetWords(False)
        return rec

    def feed(self, stream, pcm_bytes):
        """喂一段 int16 PCM，返回 ("final"/"partial", text) 或 None。"""
        import json
        if stream.AcceptWaveform(pcm_bytes):
            text = json.loads(stream.Result()).get("text", "")
            return ("final", text) if text else None
        text = json.loads(stream.PartialResult()).get("partial", "")
        return ("partial", text) if text else None

    def reset(self, stream):
        try:
            stream.Reset()
        except Exception:
            pass


class _SherpaASR:
    """sherpa-onnx 流式 Zipformer 识别后端（中文，int8）。"""

    def __init__(self, tokens, encoder, decoder, joiner, sample_rate, num_threads,
                 punct_model=None, punct_threads=2):
        import sherpa_onnx
        self._recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=tokens, encoder=encoder, decoder=decoder, joiner=joiner,
            num_threads=num_threads, sample_rate=sample_rate, feature_dim=80,
            model_type="zipformer2",
            enable_endpoint_detection=True,
            rule1_min_trailing_silence=1.5,
            rule2_min_trailing_silence=0.8,
            rule3_min_utterance_length=20,
        )
        self._sample_rate = sample_rate
        self._punct = None
        if punct_model and os.path.isfile(punct_model):
            try:
                self._punct = _Punctuator(punct_model, punct_threads)
            except Exception:
                self._punct = None  # 标点模型加载失败不影响识别

    def create_stream(self):
        return self._recognizer.create_stream()

    def feed(self, stream, pcm_bytes):
        """喂一段 int16 PCM，返回 ("final"/"partial", text) 或 None。

        检测到端点（句末静音）时先取整句结果再 reset 流，开始下一句。"""
        import numpy as np
        samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        stream.accept_waveform(self._sample_rate, samples)
        while self._recognizer.is_ready(stream):
            self._recognizer.decode_stream(stream)
        text = self._recognizer.get_result(stream)
        if self._recognizer.is_endpoint(stream):
            self._recognizer.reset(stream)
            if text:
                if self._punct is not None:
                    text = self._punct.apply(text)
                return ("final", text)
            return None
        return ("partial", text) if text else None

    def reset(self, stream):
        self._recognizer.reset(stream)


class _Punctuator:
    """ct-transformer 中文标点恢复（int8，离线）。"""

    def __init__(self, model_path, num_threads):
        import sherpa_onnx
        cfg = sherpa_onnx.OfflinePunctuationConfig(
            model=sherpa_onnx.OfflinePunctuationModelConfig(
                ct_transformer=model_path, num_threads=num_threads))
        self._punct = sherpa_onnx.OfflinePunctuation(cfg)

    def apply(self, text):
        try:
            return self._punct.add_punctuation(text)
        except Exception:
            return text


class _SenseVoiceASR:
    """SenseVoice 离线多语种识别 + silero-vad 分句（日语）。

    离线模型本身没有逐帧 partial。为了降低「整句说完才出字幕」的延迟，这里在
    VAD 分句之外再加一个滚动窗口：每积累约 1 秒音频，就把最近几秒转写一次，
    先作为「半成品」字幕显示；等 VAD 切出完整句子，再用准确结果替换。

    代价：滚动窗口会重复转写重叠音频，CPU 占用上升；两个常量可按机器性能调整。
    """

    # 半成品字幕：每积累这么多秒音频转写一次（越小越跟手、越耗 CPU）
    PARTIAL_EVERY_SEC = 1.0
    # 半成品字幕最多参考最近这么多秒音频（越长越准、越慢）
    PARTIAL_WINDOW_SEC = 4.5

    def __init__(self, tokens, model, vad_model, sample_rate, num_threads, language="ja"):
        import sherpa_onnx
        self._recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            tokens=tokens, model=model, num_threads=num_threads,
            sample_rate=sample_rate, feature_dim=80,
            language=language, use_itn=True)
        vad_cfg = sherpa_onnx.VadModelConfig(
            silero_vad=sherpa_onnx.SileroVadModelConfig(
                model=vad_model, threshold=0.5,
                # 调低静音判定与最大段长：原先要等 0.6s 静音、最长 20s 才切句，
                # 整句说完才转写，观感延迟 4~5s。缩短后更早切句，字幕更跟手；
                # 代价是切得更碎（翻译模式下语句可能不完整）。
                min_silence_duration=0.35, min_speech_duration=0.2,
                max_speech_duration=6),
            sample_rate=sample_rate, num_threads=num_threads)
        self._vad = sherpa_onnx.VoiceActivityDetector(vad_cfg, buffer_size_in_seconds=60)
        self._sample_rate = sample_rate
        self._partial_every = int(sample_rate * self.PARTIAL_EVERY_SEC)
        self._partial_window = int(sample_rate * self.PARTIAL_WINDOW_SEC)
        self._roll = []            # 最近音频块（np.float32）
        self._roll_len = 0         # 滚动窗口累计样本数
        self._since_partial = 0    # 距上次出半成品的样本数

    def create_stream(self):
        # 离线模型无流式 stream，返回 None 占位（_rec_worker 不依赖它）。
        return None

    def feed(self, stream, pcm_bytes):
        """喂 PCM 给 VAD；切出完整语音段返回 ("final", text)，否则按滚动窗口
        定期返回 ("partial", text)，都没有则 None。"""
        import numpy as np
        samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        self._vad.accept_waveform(samples)

        # 滚动窗口累积 + 裁剪到窗口长度
        self._roll.append(samples)
        self._roll_len += len(samples)
        while (len(self._roll) > 1
               and self._roll_len - len(self._roll[0]) >= self._partial_window):
            self._roll_len -= len(self._roll.pop(0))

        # 1) VAD 切出完整句子：出 final，重置滚动窗口避免重复
        if not self._vad.empty():
            seg = self._vad.front
            seg_samples = np.asarray(seg.samples, dtype=np.float32)
            self._vad.pop()
            text = self._transcribe(seg_samples)
            self._roll = []
            self._roll_len = 0
            self._since_partial = 0
            return ("final", text) if text else None

        # 2) 还没成句：每积累约 1 秒，把最近几秒转写成半成品字幕
        self._since_partial += len(samples)
        if (self._since_partial >= self._partial_every
                and self._roll_len >= int(self._sample_rate * 0.4)):
            self._since_partial = 0
            try:
                buf = np.concatenate(self._roll) if len(self._roll) > 1 else self._roll[0]
            except Exception:
                return None
            text = self._transcribe(buf)
            return ("partial", text) if text else None
        return None

    def reset(self, stream):
        self._vad.reset()
        self._roll = []
        self._roll_len = 0
        self._since_partial = 0

    def _transcribe(self, samples):
        s = self._recognizer.create_stream()
        s.accept_waveform(self._sample_rate, samples)
        self._recognizer.decode_stream(s)
        return (s.result.text or "").strip()


class LiveCaptioner:
    def __init__(self, source_lang="en", caption_mode="original", model_path=None, ai_cfg=None):
        self.source_lang = source_lang
        self.caption_mode = caption_mode  # "original" | "translate" | "ai_translate"
        self.model_path = model_path or _default_model_path(source_lang)
        self.ai_cfg = ai_cfg or {}
        self.queue = queue.Queue()
        self.error = None
        self._asr = None
        self._translator = None
        self._stream = None
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
        self._needs_play = False
        self._resume_time = 0
        self._stop_fn = None
        self._empty_play_cb = None
        self._empty_flush_cb = None
        # VLC 的音频回调在它自己的线程上跑；stop() 在 UI 线程上跑。不加锁的话
        # stop() 可能在回调线程还在写 _out_stream 的时候把它关掉，PortAudio 流
        # 被并发 close()+write() 会卡死，进而把 player.stop() 也一起拖死（复现
        # 过：open_folder 切文件时主线程卡在 libvlc_media_player_stop 里不返回）。
        # 这个锁保证 stop() 会等当前正在跑的回调写完再拆流。
        #
        # 识别流（_stream）只由 _rec_worker 这一个线程碰，不跟回调线程
        # 抢锁；stop() 先投递退出标记并 join _rec_thread，之后再安全置空。
        self._callback_lock = threading.Lock()

    def available(self):
        if self.source_lang == "zh":
            return all(os.path.isfile(p) for p in _sherpa_zh_paths().values())
        if self.source_lang in ("ja", "ko", "yue"):
            p = _sensevoice_paths()
            return (os.path.isfile(p["tokens"]) and os.path.isfile(p["model"])
                    and os.path.isfile(_silero_vad_path()))
        return bool(self.model_path) and os.path.isdir(self.model_path)

    def _load_model(self):
        if self._asr is None:
            if self.source_lang == "zh":
                paths = _sherpa_zh_paths()
                self._asr = _SherpaASR(
                    paths["tokens"], paths["encoder"], paths["decoder"], paths["joiner"],
                    SAMPLE_RATE, SHERPA_ZH_NUM_THREADS,
                    punct_model=_sherpa_punct_path(), punct_threads=PUNCT_ZH_NUM_THREADS)
            elif self.source_lang in ("ja", "ko", "yue"):
                paths = _sensevoice_paths()
                self._asr = _SenseVoiceASR(
                    paths["tokens"], paths["model"], _silero_vad_path(),
                    SAMPLE_RATE, SENSEVOICE_NUM_THREADS, language=self.source_lang)
            else:
                self._asr = _VoskASR(self.model_path, SAMPLE_RATE)
        if self.caption_mode in ("translate", "ai_translate") and self._translator is None and self.source_lang != "zh":
            try:
                import translation_engine
                if translation_engine.available(self.source_lang, "zh"):
                    self._translator = translation_engine.build_translator(self.source_lang, "zh")
            except Exception:
                self._translator = None  # 离线翻译缺失/失败时，字幕回退为原声
        return self._asr

    def start_async(self, player, stop_fn=None):
        """Non-blocking. Call poll() from the caller's own thread (the one
        that owns `player`) to find out when it's done.

        `stop_fn(player)`（可选）用于在绑定音频回调前停掉正在播放的 player，
        替代同步的 player.stop()。调用方把视频嵌入到窗口（set_hwnd）时，同步
        stop() 会死锁，应传入一个能安全停 player 的实现（如后台线程 stop + pump）。
        """
        self._stop_fn = stop_fn
        if self._player is not None:
            self._start_result = (True, None)
            return
        self._pending_player = player
        self._start_result = None
        self.error = None
        if not self.available():
            if self.source_lang == "zh":
                self.error = (
                    "未找到中文字幕模型（sherpa-onnx Zipformer）：请把模型放到 %s，"
                    "或设置环境变量 SHERPA_MODEL_DIR_ZH 指定目录"
                    % SHERPA_ZH_MODEL_DIR
                )
            elif self.source_lang in ("ja", "ko", "yue"):
                lang_name = {"ja": "日语", "ko": "韩语", "yue": "粤语"}[self.source_lang]
                self.error = (
                    "未找到%s字幕模型（SenseVoice + silero-vad）：请把模型放到 %s、"
                    "VAD 放到 %s（可用环境变量 SENSEVOICE_MODEL_DIR_JA / SILERO_VAD_MODEL 指定）"
                    % (lang_name, SENSEVOICE_JA_MODEL_DIR, SILERO_VAD_MODEL)
                )
            else:
                self.error = (
                    "未找到 %s 字幕模型：%s（可设置环境变量 VOSK_MODEL_PATH_%s 指定路径）"
                    % (self.source_lang, self.model_path, self.source_lang.upper())
                )
            self._start_result = (False, self.error)
            return
        if self._asr is not None:
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
        if self._asr is not None:
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
            import sounddevice as sd

            # 若上次是透传关闭（stop(keep_audio=True)）残留了输出流，先关掉，
            # 避免重新开字幕时开出第二个 sounddevice 流。
            self._close_stream()

            stream = self._asr.create_stream()

            play_cb = vlc.CallbackDecorators.AudioPlayCb(self._on_audio_play)
            flush_cb = vlc.CallbackDecorators.AudioFlushCb(self._on_audio_flush)
            _CALLBACK_KEEPALIVE.append(play_cb)
            _CALLBACK_KEEPALIVE.append(flush_cb)

            self._stream = stream
            self._play_cb = play_cb
            self._flush_cb = flush_cb

            # 识别线程：识别器只在它自己的线程里跑，音频回调线程只负责把 PCM 丢进来。
            self._pcm_queue = queue.Queue(maxsize=PCM_QUEUE_MAX)
            self._rec_thread = threading.Thread(target=self._rec_worker, daemon=True)
            self._rec_thread.start()

            # 翻译线程：每次启动都确保在跑。stop() 会停掉它并置空 _trans_queue，
            # 所以这里在重启（切视频/开关字幕）时必须重建，否则翻译结果没人消费。
            if self.caption_mode in ("translate", "ai_translate") and self._trans_queue is None:
                self._trans_queue = queue.Queue()
                self._trans_thread = threading.Thread(target=self._trans_worker, daemon=True)
                self._trans_thread.start()

            # libvlc 的 audio_set_callbacks 必须在 play() 之前设置才保证接管。
            # 若视频已在播放，必须在设置回调前先 stop -- 此刻新回调还没绑、新流
            # 还没开（上面的 _close_stream 已把旧流关掉），stop 是安全的；之后由
            # 调用方 play() 恢复播放，回调才会真正接管音频。
            self._needs_play = bool(player.is_playing())
            if self._needs_play:
                self._resume_time = player.get_time()
                if self._stop_fn is not None:
                    self._stop_fn(player)
                else:
                    player.stop()

            player.audio_set_format(b"S16N", SAMPLE_RATE, 1)
            # flush 是 VLC 自己在 seek/stop 时丢弃缓冲区的信号 -- 用它来清空识别器
            # 上下文，比在 UI 线程的 seek 事件里手动调 reset() 更准，能避免 UI 侧
            # 时机跟 VLC 内部丢弃缓冲区的时机没对齐、导致跳转后残留一两个旧词的问题。
            player.audio_set_callbacks(play_cb, None, None, flush_cb, None, None)

            # 开流：必须在 play() 之前开好，这样回调一被调用就能立即写。
            out_stream = sd.RawOutputStream(
                samplerate=SAMPLE_RATE, channels=1, dtype="int16",
                blocksize=OUT_BLOCKSIZE, latency="low")
            out_stream.start()
            self._out_stream = out_stream

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

    def _close_stream(self):
        """关闭 sounddevice 输出流（加锁，等当前回调写完）。拆流后若 VLC 回调
        仍被调用，_on_audio_play 会因 _out_stream 为 None 而静默丢帧。"""
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

    def stop(self, keep_audio=False):
        """keep_audio=True：只停识别/字幕，保留声音输出（透传模式），供
        「关闭字幕」按钮使用 -- VLC 音频回调仍绑着，我们继续用 _out_stream
        出声，避免「解绑回调会崩溃 / 拆流又完全无声」的两难。代价是音质仍
        停在 16kHz 单声道，直到切视频或 keep_audio=False 彻底拆流才恢复。"""
        player = self._player  # 先拿引用，拆流后要用它换空回调解绑
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
        # 通知识别线程退出并等它处理完当前这一帧 -- 之后才能安全置空 _stream。
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
        if not keep_audio:
            # 彻底拆流（切视频 / 换语言 / 换模式时用）。
            self._close_stream()
            # 换成空回调解绑：若什么都不做，回调仍绑着，随后调用方的
            # player.stop() 会在 libvlc 内部死锁（复现：切视频卡死在
            # libvlc_media_player_stop）；若解绑成 None，又会 access
            # violation。空回调立即返回，让音频输出线程正常收尾，stop
            # 既不卡也不崩。
            if player is not None:
                self._unbind_callbacks(player)
        # _rec_worker 已 join 退出，此刻无人再碰 _stream，可安全置空。
        self._stream = None
        while True:
            try:
                self.queue.get_nowait()
            except queue.Empty:
                break

    def _unbind_callbacks(self, player):
        """把真实音频回调换成「立即返回」的空回调，让 libvlc 的音频输出线程
        能正常收尾，从而 player.stop() 不死锁；又因为回调指针始终有效（非
        None），不会触发解绑成 None 时的 access violation。"""
        try:
            import vlc
            if self._empty_play_cb is None:
                self._empty_play_cb = vlc.CallbackDecorators.AudioPlayCb(self._on_dummy_play)
                self._empty_flush_cb = vlc.CallbackDecorators.AudioFlushCb(self._on_dummy_flush)
                _CALLBACK_KEEPALIVE.append(self._empty_play_cb)
                _CALLBACK_KEEPALIVE.append(self._empty_flush_cb)
            player.audio_set_callbacks(self._empty_play_cb, None, None,
                                       self._empty_flush_cb, None, None)
        except Exception:
            pass

    def _on_dummy_play(self, data, samples, count, pts):
        pass

    def _on_dummy_flush(self, data, pts):
        pass

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
        """识别线程：独占识别器（vosk 或 sherpa-onnx），逐帧解码音频，结果写回字幕队列。

        音频回调线程和这个线程通过 _pcm_queue 解耦 -- 回调不碰识别器，
        识别再慢也只会积压/丢帧，不会反过来拖慢音频回调导致出声滞后。

        VLC 的音频回调一帧只有 ~26ms（约 42 次/秒），若每帧都喂一次识别器，
        调用开销累积很高，视频软解 + 翻译 + UI 一起跑时识别线程容易落后 →
        丢帧 → 音频断档 → 识别器提前收句成「一两个字」。这里先攒到约 100ms
        再一次性喂给识别器，把调用频率降到 ~10 次/秒，稳定跑赢实时。"""
        pcm_queue = self._pcm_queue
        asr = self._asr
        stream = self._stream
        acc = bytearray()
        target = SAMPLE_RATE * 2 * 100 // 1000  # 16000Hz*2字节*0.1s = 3200 字节
        while True:
            item = pcm_queue.get()
            if item is None:
                break
            if item is _RESET:
                try:
                    asr.reset(stream)
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
                event = asr.feed(stream, buf)
            except Exception:
                continue
            if event is None:
                continue
            kind, text = event
            if kind == "final":
                self._emit_final(text)
            elif kind == "partial" and self.caption_mode == "original":
                # 翻译模式下不展示原文 partial，等一句说完直接出译文，
                # 避免字幕框里外语原文和中文译文来回跳。
                self.queue.put(("partial", self._display_text(text, self.source_lang == "zh")))

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
        VLC 音频回调线程里碰这些原生库。

        维护最近几句的 (原文, 译文) 历史，随每次请求一起发给 LLM，让它参考
        上下文保持人名/称谓/术语/指代的前后一致——这是逐句独立翻译时最容易
        出错的地方。"""
        trans_queue = self._trans_queue
        history = []  # [(原文, 译文), ...]，只保留最近 3 句
        while True:
            item = trans_queue.get()
            if item is None:
                break
            text, is_chinese = item
            translated = None
            if self.caption_mode == "ai_translate" and self.ai_cfg.get("api_key"):
                try:
                    translated = _llm_translate(text, self.ai_cfg, history=history)
                except Exception:
                    translated = None
            if not translated and self._translator is not None:
                try:
                    translated = self._translator.translate(text)
                except Exception:
                    translated = None
            if translated:
                final = self._display_text(translated, True)
                history.append((text, final))
                if len(history) > 3:
                    history.pop(0)
                self.queue.put(("final", final))
            else:
                # 翻译失败/缺失时回退原声；失败句不进历史，避免污染上下文。
                self.queue.put(("final", self._display_text(text, is_chinese)))

    @staticmethod
    def _display_text(text, is_chinese):
        # 中文模型输出的是空格分词（"火箭 正在 飞向"），中文书面习惯不加
        # 空格，显示前去掉；英文/日文模型输出的词间空格要保留。
        return text.replace(" ", "") if is_chinese else text
