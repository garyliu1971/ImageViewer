# -*- coding: utf-8 -*-
"""
translation_engine.py -- 本地离线翻译（给实时字幕用）

只用 ctranslate2 + sentencepiece 直接加载 Argos Open Tech 发布的翻译模型包
(.argosmodel，本质是 ctranslate2 模型 + sentencepiece 词表的 zip)，不依赖
argostranslate 这个包本身 -- 它会拉 stanza（用于多句分句），stanza 又依赖
PyTorch，对"整句已经是 vosk 分好的一个 utterance"这种场景完全没必要，装起来
也慢得离谱。

当前只需要"翻成中文"这一个方向：
  - en -> zh：直接翻译模型。
  - ja -> zh：没有直接的日译中模型，经英语中转（ja -> en -> zh 两跳）。
中文音频本身不需要翻译（上层直接跳过，不会调用这里）。
"""
from __future__ import annotations

import glob
import os

MODELS_DIR = os.environ.get("ARGOS_MODELS_DIR", r"C:\models\argos")

# (source_lang, target_lang) -> 已解压的模型包目录名
_DIRECT_PACKAGES = {
    ("ja", "en"): "ja_en",
    ("en", "zh"): "en_zh",
}


class ArgosHop:
    """一次单跳翻译（一个 ctranslate2 模型 + 一个 sentencepiece 词表）。"""

    def __init__(self, package_dir):
        import ctranslate2
        import sentencepiece as spm

        model_dir = self._find_model_dir(package_dir)
        sp_path = self._find_sp_model(package_dir)
        self._translator = ctranslate2.Translator(model_dir, device="cpu")
        self._sp = spm.SentencePieceProcessor(model_file=sp_path)

    @staticmethod
    def _find_model_dir(root):
        for dirpath, _dirnames, filenames in os.walk(root):
            if "model.bin" in filenames:
                return dirpath
        raise FileNotFoundError("model.bin not found under %s" % root)

    @staticmethod
    def _find_sp_model(root):
        matches = glob.glob(os.path.join(root, "**", "sentencepiece.model"), recursive=True)
        if not matches:
            raise FileNotFoundError("sentencepiece.model not found under %s" % root)
        return matches[0]

    def translate(self, text):
        text = text.strip()
        if not text:
            return ""
        tokens = self._sp.encode(text, out_type=str)
        result = self._translator.translate_batch([tokens])
        out_text = self._sp.decode(result[0].hypotheses[0])
        return out_text.replace("\u2581", "").strip()


class ChainedTranslator:
    """依次经过一个或多个 ArgosHop（比如日语先翻英语再翻中文）。"""

    def __init__(self, hops):
        self._hops = hops

    def translate(self, text):
        for hop in self._hops:
            text = hop.translate(text)
            if not text:
                break
        return text


def available(source_lang, target_lang):
    if source_lang == target_lang:
        return True
    if (source_lang, target_lang) in _DIRECT_PACKAGES:
        return _package_exists(_DIRECT_PACKAGES[(source_lang, target_lang)])
    first = _DIRECT_PACKAGES.get((source_lang, "en"))
    second = _DIRECT_PACKAGES.get(("en", target_lang))
    if first and second:
        return _package_exists(first) and _package_exists(second)
    return False


def _package_exists(name):
    return os.path.isdir(os.path.join(MODELS_DIR, name))


def build_translator(source_lang, target_lang):
    """返回一个有 .translate(text) 方法的对象；source==target 时返回 None
    （上层应该直接跳过翻译，不要调用）。"""
    if source_lang == target_lang:
        return None

    direct = _DIRECT_PACKAGES.get((source_lang, target_lang))
    if direct:
        return ChainedTranslator([ArgosHop(os.path.join(MODELS_DIR, direct))])

    first = _DIRECT_PACKAGES.get((source_lang, "en"))
    second = _DIRECT_PACKAGES.get(("en", target_lang))
    if first and second:
        return ChainedTranslator([
            ArgosHop(os.path.join(MODELS_DIR, first)),
            ArgosHop(os.path.join(MODELS_DIR, second)),
        ])

    raise ValueError("没有从 %s 到 %s 的本地翻译模型" % (source_lang, target_lang))
