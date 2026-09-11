# 图片 / 漫画浏览器

本地图片 / 漫画阅读器，含 **桌面版**（Python + tkinter）和 **网页版**（单文件 HTML）。

## 文件说明

| 文件 | 说明 |
|------|------|
| `image_viewer.py` | 桌面版主程序（tkinter + Pillow） |
| `image-viewer.html` | 网页版（单文件，浏览器直接打开） |
| `viewer.ico` | 程序图标 |
| `image_viewer.json` | 阅读进度（运行时自动生成，不纳入版本控制） |

## 运行

### 桌面版

```bash
pip install Pillow        # 必需
pip install python-vlc    # 可选：播放视频需要（另需安装 VLC）
pip install vosk sounddevice          # 可选：视频实时字幕需要
pip install ctranslate2 sentencepiece # 可选：字幕翻译成中文需要
python image_viewer.py
```

视频页可点击 **CC 字幕** 开启本地实时字幕（基于 vosk，离线识别，无需联网），旁边
两个下拉框选**音频语言**（中文 / 英文 / 日语）和**字幕**（原声 / 中文翻译，选中文
音频时这个选项不可用）。默认模型路径：

| 语言 | 默认路径 | 环境变量覆盖 |
|------|----------|--------------|
| 中文 | `C:\models\vosk-model-small-cn-0.22` | `VOSK_MODEL_PATH_ZH` |
| 英文 | `C:\models\vosk-model-small-en-us-0.15` | `VOSK_MODEL_PATH_EN` |
| 日语 | `C:\models\vosk-model-small-ja-0.22` | `VOSK_MODEL_PATH_JA` |

翻译成中文用的是 [Argos Open Tech](https://www.argosopentech.com/) 发布的离线翻译
模型（ctranslate2 格式），默认放在 `C:\models\argos\en_zh` 和 `C:\models\argos\ja_en`
（日语没有直接的日译中模型，走 日→英→中 两跳），可用环境变量 `ARGOS_MODELS_DIR`
指定其他目录。翻译只在识别出一整句（不是逐字）时才做一次，所以翻译字幕会比原声
字幕多一点延迟，这跟 YouTube 自动翻译字幕的实际体验一致。

开启字幕后播放音质会降到 16kHz 单声道（vosk 识别要求的格式）。关闭字幕后音量滑块
可能需要重新调整才能生效（VLC 的原生音量控制在字幕开启期间不生效，因为音频输出
被接管了）。

### 网页版

用浏览器打开 `image-viewer.html` 即可。

## 功能

- 打开 **文件夹 / 多张图片 / zip·cbz 压缩包**
- 双页模式、日漫右→左阅读方向
- 断点续读、跳到指定页、自动翻页
- 自动裁白边、旋转、缩放 / 平移、适应窗口 / 宽度 / 高度
- 缩略图浏览
- 视频播放（mp4 等，需 VLC）
- 支持格式：png / jpg / jpeg / gif / webp / bmp / tif / tiff / avif / jfif

## 快捷键

| 按键 | 功能 |
|------|------|
| ← → / PageUp / PageDown | 翻页 |
| 空格 | 图片页：下一页；视频页：播放 / 暂停 |
| 滚轮 / 触控板上下滑 | 缩放（以鼠标为中心） |
| 触控板捏合（Ctrl+滚轮） | 缩放 |
| 触控板左右滑 | 翻页 |
| + / - | 放大 / 缩小 |
| 拖拽 | 平移 |
| 点击画面左 / 右边缘 | 翻页（方向随阅读方向） |
| 双击画面中间 | 适应窗口 ↔ 实际大小 |
| R / Shift+R | 顺时针 / 逆时针旋转 90° |
| 0 / 1 / 2 / 3 | 适应窗口 / 实际大小 / 适应宽度 / 适应高度 |
| D | 双页模式 开 / 关 |
| M | 阅读方向 左→右 / 右→左（日漫） |
| C | 裁白边 开 / 关 |
| G | 跳到指定页 |
| A | 自动翻页 开 / 关 |
| [ / ] | 自动翻页停留时间 - / + 0.5 秒 |
| F / F11 | 全屏 |
| T | 显示 / 隐藏缩略图 |
| ? | 帮助 |
