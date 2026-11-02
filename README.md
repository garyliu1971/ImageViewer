# 图片 / 漫画浏览器

本地图片 / 漫画阅读器，含 **桌面版**（Python + tkinter）和 **网页版**（单文件 HTML）。

## 文件说明

| 文件 | 说明 |
|------|------|
| `image_viewer.py` | 桌面版主程序（tkinter + Pillow） |
| `image-viewer.html` | 网页版（单文件，浏览器直接打开） |
| `caption_engine.py` | 视频实时字幕引擎（英文 vosk、中文 sherpa-onnx、日语 SenseVoice 识别 + 翻译） |
| `translation_engine.py` | 离线字幕翻译（Argos / ctranslate2） |
| `dlna_cast.py` | DLNA 投屏（SSDP 发现 + AVTransport SOAP 控制 + 本地流媒体） |
| `remote_source.py` | 远程媒体源抽象 + WebDAV provider + 本地流代理（网盘视频免下载播放） |
| `viewer.ico` | 程序图标 |
| `image_viewer.json` | 阅读进度（运行时自动生成，不纳入版本控制） |

## 运行

### 桌面版

```bash
pip install Pillow        # 必需
pip install pymupdf       # 可选：阅读 PDF 漫画需要
pip install python-vlc    # 可选：播放视频需要（另需安装 VLC）
pip install vosk sounddevice          # 可选：视频实时字幕（英文）需要
pip install sherpa-onnx               # 可选：中文实时字幕（准确率更高）需要
pip install ctranslate2 sentencepiece # 可选：字幕翻译成中文需要
python image_viewer.py
```

视频页可点击 **CC 字幕** 开启本地实时字幕（离线识别，无需联网），旁边两个下拉框选
**音频语言**（中文 / 英文 / 日语 / 韩语 / 粤语）和**字幕**（原声 / 中文翻译 / AI 翻译；
选中文音频时翻译选项不可用；韩语/粤语无离线翻译模型，只支持原声和 AI 翻译）。识别后端：
**英文用 vosk**、**中文用 sherpa-onnx 流式 Zipformer**、**日语/韩语/粤语用 SenseVoice
（离线多语种 + silero-vad 分句，自带标点）**。默认模型路径：

| 语言 | 默认路径 | 环境变量覆盖 |
|------|----------|--------------|
| 中文 | `C:\models\sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30`（含 tokens.txt / encoder.int8.onnx / decoder.onnx / joiner.int8.onnx） | `SHERPA_MODEL_DIR_ZH` |
| 英文 | `C:\models\vosk-model-small-en-us-0.15` | `VOSK_MODEL_PATH_EN` |
| 日语/韩语/粤语 | `C:\models\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`（含 tokens.txt / model.int8.onnx）+ `C:\models\silero_vad.onnx` | `SENSEVOICE_MODEL_DIR_JA` / `SILERO_VAD_MODEL` |

中文模型下载（约 132MB）：

```bash
cd C:\models
curl -L -o zh.zip https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30.tar.bz2
tar xjf zh.zip
```

中文标点恢复（可选，约 65MB 下载；缺失时字幕照常、只是没有句号逗号）：

```bash
cd C:\models
curl -L -o punct.zip https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8.tar.bz2
tar xjf punct.zip
```

默认路径 `C:\models\sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8\model.int8.onnx`，
可用环境变量 `SHERPA_PUNCT_MODEL_ZH` 覆盖。

日语/韩语/粤语模型下载（约 163MB + VAD 644KB；自带标点）：

```bash
cd C:\models
curl -L -o ja.zip https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2
curl -L -o silero_vad.onnx https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx
tar xjf ja.zip
```

**字幕翻译**有两种方式：

- **中文翻译（离线）**：用 [Argos Open Tech](https://www.argosopentech.com/) 的
  离线模型（ctranslate2 格式），默认放在 `C:\models\argos\en_zh` 和
  `C:\models\argos\ja_en`（日语没有直接的日译中模型，走 日→英→中 两跳），
  环境变量 `ARGOS_MODELS_DIR` 可指定其他目录。翻译只在识别出一整句（不是逐字）
  时才做一次，所以翻译字幕比原声字幕多一点延迟，跟 YouTube 自动翻译字幕一致。
- **AI 翻译（在线，LLM）**：字幕下拉选「AI 翻译」，走 OpenAI 兼容接口实时翻译。
  需先在 **帮助 → AI 字幕翻译设置** 里配置：
  - 服务商预设：DeepSeek / OpenAI / 通义千问 / 本地 Ollama / 自定义（自动填好
    API Base 和模型，如 `deepseek-chat`、`gpt-4o-mini`、`qwen-plus`）；
  - API Key（必填）；未配置或调用失败时自动回退到离线 Argos 翻译。

视频页还支持 **外挂字幕**（`.srt` / `.ass`），在 视图 → 外挂字幕 或按 `S` 选择，
可自动加载与视频同名的字幕文件。

开启字幕后播放音质会降到 16kHz 单声道（识别模型要求的格式）。关闭字幕后声音会
保留（音频输出仍由字幕引擎透传播放，避免「开字幕有声音、关字幕变无声」），但
音量滑块依然不生效、音质也仍停留在 16kHz 单声道——直到切换到下一个视频才会恢复
VLC 原生音频输出。

### 投屏（视频页）

视频条右侧「📺 投屏」按钮（或 视图 → 投屏到电视 / 设备）可把当前视频投到局域网里的
DLNA 设备（极米投影仪 / 电视 / 盒子等）。原理是 DLNA：本地起一个 HTTP 服务器把视频
暴露给设备，设备自己解码播放，本地通过 SOAP 控制播放/暂停/进度条。

- 需要设备支持 DLNA（极米/小米/海信等国产设备普遍支持），且与电脑连同一 WiFi
- 投屏后播放/暂停/进度条由本地控制投影仪；音量由投影仪控制
- 支持格式取决于投屏设备（mp4 一般没问题；mkv 视设备而定）
- DLNA 不支持倍速、画面缩放；本地 vosk 实时字幕不跟投
- 再点一次按钮可取消投屏、恢复本地播放（自动续播到原进度）

### 网盘 / 媒体库（WebDAV、Jellyfin/Emby）

菜单栏 **网盘** 提供两类远程源，均为**免下载流式播放**（本地只起 Range 流代理，不落盘）：

**WebDAV**（坚果云 / NAS / 阿里云盘 WebDAV 等，Basic Auth）

- 连接后浏览目录，支持**图片 / 视频 / 音频（mp3/flac 等）**：图片按需取到内存显示，
  视频/音频经流代理由 VLC 直接播放
- 断点续播、seek 缩略图、倍速、实时字幕、DLNA 投屏均可用

**Jellyfin / Emby**（媒体服务器）

- 填写服务器地址 + 账号密码登录（token 缓存，密码不保存）
- **海报墙**浏览片库（电影 / 剧集 / 音乐封面网格 + 标题/年份，异步加载封面）
- 直连播放（Static 流，支持 Range/seek）；不兼容格式自动回退 HLS 转码流（VLC 直接播 master.m3u8）

- 凭据保存在 `image_viewer.json` 的 `_webdav_` / `_jellyfin_` 段（明文，后续加密）
- 暂不支持：网盘内 zip/cbz 在线读、远程视频的同名字幕、转码流（HLS）的 DLNA 投屏

### 网页版

用浏览器打开 `image-viewer.html` 即可。

## 功能

- 打开 **文件夹 / 多张图片 / zip·cbz 压缩包 / PDF / 播放列表（m3u/m3u8）**
- 章节管理：文件夹含子文件夹、压缩包含子目录时，自动识别为「章节」，顶部出现章节下拉框 + 上一话/下一话
- 双页模式、日漫右→左阅读方向、图片对比模式（两图并排）
- 断点续读、跳到指定页、自动翻页
- 自动裁白边、旋转、缩放 / 平移、适应窗口 / 宽度 / 高度
- 模拟纸质书质感（纸张纹理、书脊阴影、页边阴影，按 `B` 开关）
- 缩略图浏览
- 视频播放（mp4 等，需 VLC）
  - 播放控制：倍速 0.5×~60×、进度条拖动跳转、音量、快进/快退（±5s，Ctrl=±30s）
  - 沉浸式自动隐藏（参考 ACG Player）：播放时自动隐藏菜单栏/工具栏/控制条，顶部菜单改为浮动覆盖在画面上（不缩放画面），鼠标移到窗口上边缘显示浮动菜单、移到下边缘显示控制条（视图菜单可开关）
  - 循环模式：A-B 循环 / 单曲循环 / 列表循环 / 列表随机
  - 投屏：把视频投到局域网里的 Chromecast / DLNA 电视 / 盒子（视频条「📺 投屏」按钮）
- 视频实时字幕（英文 vosk、中文 sherpa-onnx、日语 SenseVoice 离线识别）+ 离线翻译（Argos）+ AI 翻译（LLM）+ 外挂字幕（.srt/.ass）
- 支持格式：png / jpg / jpeg / gif / webp / bmp / tif / tiff / avif / jfif / pdf（漫画 PDF，按页阅读）

## 快捷键

## 打包 / 安装包

- **便携版**：解压 `发布/图片漫画浏览器_v1.0_便携版.zip`，双击
  `图片漫画浏览器.exe` 即可（免安装）。
- **安装程序**：双击 `编译安装包.bat`（需已装 Inno Setup 6，脚本会自动尝试
  用 winget 安装），生成 `发布/图片漫画浏览器_v1.0.0_安装程序.exe`，带桌面/
  开始菜单快捷方式和卸载程序。

## 快捷键

| 按键 | 功能 |
|------|------|
| ← → / PageUp / PageDown | 图片页：翻页；视频页：快退/快进 ±5s（Ctrl=±30s） |
| Home / End | 第一页 / 最后一页 |
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
| B | 纸质书质感 开 / 关 |
| G | 跳到指定页 |
| A | 自动翻页 开 / 关 |
| [ / ] | 自动翻页停留时间 - / + 0.5 秒 |
| 回车 / F / F11 | 全屏 |
| T | 显示 / 隐藏缩略图 |
| S | 视频页：外挂字幕 (.srt/.ass) |
| ? | 帮助 |
