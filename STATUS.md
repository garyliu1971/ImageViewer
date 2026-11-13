# 开发状态报告 · 网页版对齐（路线 A → 路线 B/D）

生成时间：2026-11-06 · 分支：`feature/rar-cbr-support`（`8b22bb7`）
状态：9 个 commit 已全部推送；**PR #7 已开** → https://github.com/garyliu-seismic/ImageViewer/pull/7
（base `garyliu-seismic:main` @ `879d383` · 6 commits · 27 files · +6578/−444 · mergeable=clean）

---

## 1. 这轮做了什么（一句话）

给网页版 `image-viewer.html` 补齐了桌面版的「看图/漫画」主线（路线 A），并加了本地后端
`web_backend.py`（路线 B/D 第一阶段），使网页版额外支持 **rar/cbr、PDF、磁盘路径打开、
服务端缩略图、与桌面版共享进度**。全量测试 354 项绿。

---

## 2. 文件清单

### 新增
| 文件 | 行数 | 作用 |
|---|---|---|
| `web_backend.py` | 734 | 本地后端：`/api/ping ls archive data thumb pdf pdfpage progress`；只绑 127.0.0.1 + 随机 token + 媒体扩展名白名单 |
| `启动网页版.bat` | 10 | 一键起后端并开浏览器 |
| `tests/test_web_backend.py` | 602 | 后端 36 项（含安全边界、rar 语料、进度隔离） |
| `tests/web_core.test.mjs` | 232 | IVCore 纯逻辑 14 项，期望值取自 `viewer_core.py` / `media_source.py` |
| `tests/web_e2e.mjs` | 955 | **file:// 模式**真 Chrome + CDP，122 项断言 |
| `tests/web_backend_e2e.mjs` | 372 | **后端模式**真 Chrome + 真后端，40 项（rar/cbr/PDF/磁盘路径/共享进度） |
| `tests/web_demo_check.mjs` | 171 | 用真实样本走真人路径，22 项 |
| `tests/make_web_fixtures.py` | 161 | 生成 zip/cbz/zip64/GBK/**手拼 RAR3**/mini PDF 样本 |
| `tests/make_web_demo.py` | 130 | 生成 `网页版测试样本/`（17 页漫画 + cbz + GBK zip + 6000×900 + tif/pdf/rar） |
| `网页版对齐评估.md` | — | 可行性评估 + 两轮落地记录（含实测浏览器约束表） |

### 修改
| 文件 | 变化 | 说明 |
|---|---|---|
| `image-viewer.html` | 807 → 2287 行 | 章节/zip·cbz/双页/日漫/对比/裁白边/纸质/断点续读/跳页/自动翻页/缩放滑块/详情/状态栏/快捷键；后端模式（磁盘路径浏览器、rar/pdf、服务端缩略图、共享进度） |
| `image_viewer.py` | +38 行 | 菜单「文件 → 网页版（本地服务…）」、`open_web_server()`、`_on_close` 里停后端 |
| `media_source.py` | +29 行 | 新增 `is_junk()`，`media_files_in` / `build_zip_chapters` 过滤 `__MACOSX`、`.DS_Store`、`Thumbs.db`（**桌面版也受益**） |
| `tests/test_media_source.py` | +35 行 | 垃圾过滤的回归测试 |
| `ImageViewer.spec` | 1 行 | `hiddenimports` 加 `web_backend` |
| `README.md` / `.gitignore` | — | 网页版小节重写 + 后端用法；忽略生成物（样本目录、预览图） |

---

## 3. 测试怎么跑 / 当前状态

```bash
python tests/make_web_fixtures.py && python tests/make_web_demo.py   # 先出样本（首次）

python -m unittest discover -s tests -q   # 149 OK   桌面版 + 后端
python tests/smoke_test.py                #   7 OK   桌面版 GUI 冒烟（需图形环境）
node --test tests/web_core.test.mjs       #  14 pass 纯逻辑对拍
node tests/web_e2e.mjs                    # 122 pass file:// 模式
node tests/web_demo_check.mjs             #  22 pass 真实样本
node tests/web_backend_e2e.mjs            #  40 pass 后端模式（rar/cbr/PDF/进度）

SHOT=1 node tests/web_e2e.mjs             # 生成 网页版预览.png
SHOT=1 node tests/web_backend_e2e.mjs     # 生成 网页版预览-后端阅读.png / -磁盘路径.png
```
最后一次全量运行：**149 + 7 + 14 + 122 + 22 + 40 = 354 项，全绿，0 失败 0 跳过**。
Node ≥ 21（自带 WebSocket/fetch，无需 npm 安装）；浏览器测试会自动找 Chrome/Edge，可用 `CHROME=` 覆盖。

---

## 4. 关键决策与实测约束（别再重新踩一遍）

在本机 Chrome 156 用 headless + CDP 实测过，不是查资料：

| 事实 | 影响 |
|---|---|
| `file://` 是 secure context，`showDirectoryPicker` 可用（需用户手势） | 手动选目录 OK；**自动恢复上次目录不行** |
| `file://` 下 `fetch('兄弟文件')` = **Failed to fetch** | 不能加载外部 .js/.wasm/模型 → 依赖只能内联或走后端 |
| `file://` 下 IndexedDB `open()` 不 resolve | 存不了目录句柄 → 纯浏览器模式进度靠 localStorage |
| `localStorage` 在 file:// 可用 | 断点续读、UI 偏好、最近路径都存这 |
| `DecompressionStream('deflate-raw')` 可用 | **zip/cbz 零依赖纯 JS 解压** |
| `Worker(blobURL)` 可用 | 重活可以丢 Worker（目前没用到，裁边用降采样扫描已够快） |
| `playbackRate` 上限 **16**（17 抛异常） | 网页版做视频时倍速不如 VLC 的 60× |
| `canPlayType`：h264/mkv(h264+aac)/webm/vp9/flac/mp3/aac = probably；**ac3/avi/wmv/flv/mp2t/hevc = 空** | 视频格式覆盖不到 VLC 的一半 |
| Chrome **不解 TIFF / HEIC** | 网页版明确提示「用桌面版」，别当 bug 报 |
| CDP `DOM.setFileInputFiles` **拒绝** `webkitdirectory` 输入框（files.length=0） | 目录选择器路径改用假 `FileSystemDirectoryHandle` / 假 FileList 测（见 `web_e2e.mjs` [16]/[20]） |
| 无 UDP 组播 / 无监听端口 / 不能起进程 | DLNA 投屏、AList 管理、SSDP 只能留在桌面版 |

其它设计取舍：

- **进度 key 统一正斜杠绝对路径**（后端模式）→ 和桌面版 `filedialog` 返回形式一致，两边进度真互通。
- 纯浏览器模式的 key = `书名 + 页数 + 相对路径采样 hash`（**故意不含文件大小**：FSA 选型是惰性的，size 未知，用 size 会让同一本书两种入口 key 不一致）。
- 后端 `CONFIG_PATH` 支持 `IV_CONFIG` 环境变量覆盖 —— 测试用它指到临时文件，**绝不写用户真实 `image_viewer.json`**。
- 换页时 `fit_mode == custom` 复位成 `window`、双击 = `custom→window / 否则 actual`：这两条是**故意照抄桌面版**（哪怕看着别扭），不是 bug。
- 裁白边用亮度 `0.299R+0.587G+0.114B` 比 240，和 Pillow `convert("L")` 一致（米色纸底 #f7f4ec 因此能被正确裁掉）。
- PDF 渲染 `scale=2`，等于桌面版 `_render_pdf_page(scale=2.0)`。
- `.cbr` 测试样本是**纯 Python 手拼的合法 RAR3（stored）**，`rarfile` 和 7-Zip 都能解；真实压缩 RAR 用 `rarfile` 语料（RAR3 solid / RAR5 / 子目录）覆盖。

---

## 5. 本轮测试抓出并修掉的 bug（共 11 个）

网页版侧：
1. `scanDir` 递归只走到**第一个**子目录就停 → 后面的章节全丢
2. `decidePair` 某些分支不解码当前页 → 单页显示时 `<img>` 是 0×0（看不见图）
3. `closeBook` 立即 revoke objectURL → 打断正在加载的图
4. 缩略图用全尺寸 `<img>` → 几百页内存爆（改 IntersectionObserver + 小 canvas + objectURL LRU 上限 8）
5. `Intl.Collator` 按拼音排中文（第二章 < 第一章）→ 改成码位排，和 Python `natural_key` 对拍
6. 裁白边按「任一通道」判白 → 改亮度
7. 图片被工具栏/缩略图条/状态栏盖住 → `#viewport` 按 UI 实际高度缩进（隐藏 UI / 全屏时归零）
8. 工具栏溢出出滚动条 → 缩文案、窄屏隐滑块、跳页改成点页码
9. 后端模式：`ARCHIVE_EXTS` 不含 rar/cbr；`classify` 只看扩展名误杀 PDF 页；`makePage` 丢 `spath` 导致服务端缩略图没用上；`markBackendUi` 依赖进度往返；路径弹窗打开后不收起

桌面版/共享侧（**这些是老 bug，现在两版一起修了**）：
10. `__MACOSX/._x.png`、`.DS_Store`、`Thumbs.db` 会被当成一页/一个假章节
11. 压缩包内非图片条目不进 `skipped`，「跳过了什么」在详情里看不到

---

## 6. 还没做（按性价比排序 · 2026-11-06 更新）

> 手机访问 & VLC 已在第 10 节落地，不在待办里了。

1. **网盘前端 UI**（后端已就绪）：`/api/remote/config|ls|data|thumb|local|disconnect` 全部实现，
   `tests/fake_webdav.py` 带动 10 项测试；只差前端入口（凭据弹窗 + 目录浏览，可复用 🖧 路径浏览器组件）。
   **下一步首选这里** —— 纯前端，后端零改动。
2. **网页版视频播放器**：`/api/data` 已支持 Range，`<video src="/api/data?path=x.mp4">` 理论上直接能播；
   要补格式探测提示、倍速上限 16×、seek 缩略图。**手机看视频已可用 VLC + `/api/m3u` 绕过，优先级下调。**
3. **tif / heic**：浏览器不解；后端有 Pillow 但只用来出缩略图。可加一个 `/api/pageimg`（像 `/api/pdfpage`
   那样渲染成 PNG，约 20 行），网页版就能看 tif。
4. **字幕**：`/api/caption/*` 复用 `caption_engine.py`（浏览器出 PCM → 后端识别 → 回文字轨）。依赖视频先做。
5. **投屏**：`/api/cast` 复用 `dlna_cast.LocalMediaServer`（已绑 `0.0.0.0` + Range，是最接近现成的一步）。
6. **Jellyfin/Emby + AList**：后端目前只有 WebDAV（`grep jellyfin\|alist web_backend.py` = 0）。
7. **exe 打包验证**：`web_backend` 已进 `hiddenimports`，但没跑过 PyInstaller 验证；
   且 `image_viewer.py` **没有** `--serve` 命令行入口（`web_backend.py` 文档里那句
   `python image_viewer.py --serve` 是错的），`启动网页版.bat` 依赖 PATH 里有 python。
   要做：加 `--serve/--serve-lan` → bat 回退到 exe → 跑一次 PyInstaller。约 40 分钟。
8. 小尾巴：上传目录 `%TEMP%\iv-uploads` 只增不删；拖拽开 rar 的路径没有 e2e 覆盖（只测了 `#zipInput`）；
   网页版没有「最近打开」。

---

## 7. 提交记录（3 个 commit）

改动跨 3 个关注点，按下面拆成 3 个 commit（已执行，分支 `feature/rar-cbr-support`）：

```bash
git add .gitattributes media_source.py tests/test_media_source.py
git commit -m "fix: 过滤 __MACOSX/.DS_Store/Thumbs.db，不再变成假章节（桌面版+网页版共用逻辑）"

git add web_backend.py 启动网页版.bat ImageViewer.spec image_viewer.py \
        tests/test_web_backend.py tests/make_web_fixtures.py tests/fixtures
git commit -m "feat: 新增本地后端 web_backend.py（rar/cbr・PDF・磁盘路径・服务端缩略图・共享进度）"

git add image-viewer.html tests/web_core.test.mjs tests/web_e2e.mjs tests/web_backend_e2e.mjs \
        tests/web_demo_check.mjs tests/make_web_demo.py README.md .gitignore 网页版对齐评估.md STATUS.md
git commit -m "feat(网页版): 对齐桌面版看图主线 + 后端模式解锁 rar/cbr 与 PDF"

git push origin feature/rar-cbr-support
```
注意：`网页版测试样本/`、`网页版预览*.png` 是生成物（已进 `.gitignore`）。
`tests/fixtures/` 只有 18KB 但**入库**了 —— `web_backend_e2e.mjs` 没有 `sample.cbr` 会直接报错，
入库后 `node tests/*.mjs` 在新克隆上开箱可跑（不跑 Python 生成脚本也行）。
`.gitattributes` 把 fixtures 标成 `-text`：`sample.pdf` 里是绝对字节偏移的 xref 表，
被 `core.autocrlf=true` 换成 CRLF 会损坏（PyMuPDF 能自愈，别的解析器不一定）。

---

## 8. 5 分钟验收清单（下次接手先跑这个）

```bash
python tests/make_web_fixtures.py && python tests/make_web_demo.py
python -m unittest discover -s tests -q          # 期望 149 OK
node tests/web_backend_e2e.mjs                   # 期望 40 通过 0 失败
python web_backend.py                            # 浏览器自动打开
```
打开后手点：
- 工具栏应有 **🖧 磁盘路径**；状态栏右侧写「本地后端已连接：rar/cbr、PDF…」
- 磁盘路径 → 粘 `tests\fixtures\sample.cbr` → 应出 4 页 / 3 章节，能翻页、双页、`C` 去边
- 磁盘路径 → 粘 `tests\fixtures\sample.pdf` → 3 页，尺寸是 600×800 的 2 倍（1200×1600）
- 读到第 3 页 → 打开**桌面版** → 同一本 cbr 的进度应出现在 `image_viewer.json`（key 是正斜杠绝对路径）
- 关掉 `python web_backend.py`（Ctrl+C）→ 桌面版菜单里再点「网页版」应能重新起（端口会变）

---

## 9. 后续补丁（第 3 个 commit 之后）

**补丁 A · 网页版 rar/cbr 入口补齐**（用户实测「rar 还是不支持」后定位）

问题不在后端：运行中的后端 `/api/ping` 报 `rar: true`，`/api/archive?path=xxx.cbr`
能正常列出条目。是入口只有「🖧 磁盘路径」一条 —— `📦 压缩包` 按钮/拖拽走的是纯 JS zip 解析，
而后端 `/api/upload` 虽然早就写了，前端从没调用过。

- `image-viewer.html`：新增 `uploadFile / canServeFile / openViaBackend`；
  `📦` 按钮、`🖼 图片`（单选）、拖拽三条路径在 `BE.on && caps.rar/pdf` 时先上传再按路径打开；
  `file://` 模式行为不变（提示「需要本地后端」）；`accept` 在后端模式下放宽到 `.rar/.cbr/.pdf`
- 文案：开始页/帮助表格里「PDF、rar·cbr 请用桌面版」已过期，改成「需连本地后端」
- 测试：`web_backend_e2e.mjs` +5（[8] 真实 .cbr 走 `#zipInput` → 上传 → 4 页/3 章/渲染 OK/accept）；
  `web_e2e.mjs` +3（[21b] file:// 下选 .cbr 必须明确提示，不静默失败）
- 顺手修掉 `web_backend_e2e.mjs` [1] 的偶发假阴性（等 `has-backend` 再断言）

**补丁 B · 修上一轮遗留的红灯**（提交时 `tests/test_web_backend.py` 里那张 WebDAV 测试表）

- `http_get` 返回三元组，新测试却按二元组解包（6 处）
- 测试类里 `cls.p1/cls.cbz/...` 被 `FixtureCase.setUp` 的同名实例属性遮住（拿到的是路径字符串），
  改名 `FIX_*`
- `remote_source.list_dir_strict(media_only=False)` 用了没 import 的 `ARCHIVE_EXTS/PDF_EXTS` → NameError；
  同时 `other`（txt/exe）不该进列表
- `web_backend._api`：本地扩展名白名单误伤了网盘路径（`/dav` 是目录，没有扩展名）→ 只对
  `LOCAL_PATH_ROUTES` 生效
- `tests/fake_webdav.py` PROPFIND 的 href 拼接少了个 `/`（`/dav漫画`）
- 测试里 URL 已含 `%E6` 这类转义，再拿 `%` 拼 `size=` 会报 `not enough arguments`

全量：**159 + 7 + 14 + 125 + 22 + 45 = 372 项，全绿**。

---

## 10. 补丁 C · 手机访问 + VLC（局域网）

目标：手机/平板同 Wi-Fi 能用网页版；视频交给 VLC（绕开浏览器 codec 与 16× 倍速上限）。

- `web_backend.serve(..., lan=True)` 绑 `0.0.0.0`，新增 `lan_ip()`；`capabilities()` 多返回 `lan / lan_url`
- CLI `--lan` + `启动网页版(局域网).bat`；桌面版菜单新增「网页版（局域网，手机可访问）...」
- 启动时打印局域网 URL + token + 二维码（`pip install qrcode`；终端用 ASCII `##` 画，
  PNG 另存 `%TEMP%\iv-web-qr.png` 并自动弹出，避免 GBK 控制台把 █ 打成崩）
- 新接口 `GET /api/m3u?path=<目录|单文件|压缩包>&t=<token>` → 标准 `#EXTM3U`，
  条目 URL 用请求的 `Host` 拼绝对地址（手机访问时就是局域网 IP），压缩包条目走 `entry=` 参数；
  只收 image/video/audio（PDF 页是给浏览器的，不进 VLC）
- 前端：`I` 详情多一行「手机 / VLC 播放列表」（点一下复制，含 `execCommand` 兜底 —— 局域网 http 不是 secure context）；
  状态栏显示「局域网 192.168.x.x:PORT」
- 修一个真 bug：`print("⚠ …")` 在 GBK 控制台上 `UnicodeEncodeError` 直接让后端退出 → 统一走 `_safe_print()`

验证：`163 + 7 + 14 + 125 + 22 + 52 = 383 项全绿`；实测 `--lan` 下从 `192.168.1.75:18999`
能打开页面、`/api/ping` 报 `lan=true`、`/api/m3u` 里每条 URL 都是该 IP 且能取到图。

---

## 11. 交接（下次从这里开始）

**仓库状态**

```bash
分支 feature/rar-cbr-support @ 8b22bb7，工作区干净，与 origin 同步
PR #7 open / mergeable=clean → https://github.com/garyliu-seismic/ImageViewer/pull/7
```

**跑测试**（Node ≥ 21，Chrome/Edge 自动找；缺样本先跑两个 make_ 脚本）

```bash
python tests/make_web_fixtures.py && python tests/make_web_demo.py
python -m unittest discover -s tests -q          # 163 OK
python tests/smoke_test.py                       #   7 OK（需图形环境）
node --test tests/web_core.test.mjs              #  14 pass
node tests/web_e2e.mjs                           # 125 pass（file://）
node tests/web_demo_check.mjs                    #  22 pass（真实样本）
node tests/web_backend_e2e.mjs                   #  52 pass（后端模式，含上传 / m3u）
# 合计 383
```

**常用启动**

```bash
python web_backend.py                 # 仅本机（127.0.0.1，随机端口）
python web_backend.py --lan           # 局域网：手机/VLC 可访问，终端出二维码
双击 启动网页版.bat / 启动网页版(局域网).bat
桌面版菜单：文件 → 网页版（本地服务…）/ 网页版（局域网，手机可访问）…
```

**已经踩过的坑（别再踩）**

- Windows 控制台是 GBK：`print` 里不能有 emoji / `█`，否则 `UnicodeEncodeError` 直接把后端打挂 → 用 `_safe_print()`
- `core.autocrlf=true` + 无 `.gitattributes` 会把 `tests/fixtures/sample.pdf` 的 xref 偏移换行改坏
- 本机多网卡（WSL `172.24.x`、WireGuard `10.0.0.2`、WLAN `192.168.1.x`）：`lan_ip()` 一般取对，但开全隧道 VPN 后要手动拼 URL
- `tests/fixtures/` 已入库（18KB），但 `网页版测试样本/`、`网页版预览*.png`、`web_backend.log/.pid` 都在 gitignore 里


---

## 12. 视频播放 Phase 1（`feature/iv-video`，2026-11-13）

**做了什么**
- 后端 `/api/data` 改成流式 + 真 HTTP Range：无 Range 回 200；`Range: bytes=a-b / a- / -N` 回 206 + `Content-Range`；
  越界 / 非法回 416 + `Content-Range: bytes */size`；永远带 `Accept-Ranges: bytes`。不再把整段读进内存。
  视频 Content-Type 显式映射（mp4/m4v/webm/ogv/mov/mkv/avi…，`VIDEO_MIME`）。`?range=bytes=a-b` 旧写法仍兼容。
- `media_source.VIDEO_EXTS` 补上 `.ogv`（桌面版也受益）。仍然只能读白名单扩展名，token 校验不变。
- 新接口 `/api/subtitle?path=<视频>`（列同主名旁挂字幕 .srt/.vtt/.ass/.ssa）、`&name=` 取字节（只能取列出来的纯文件名，防穿越）。
- 新接口 `/api/videoresume`（GET/PUT）：续播点写桌面版同一个 `_video_resume_`（key = 规范化绝对路径，值 = 毫秒，开头 / 结尾 3 秒不记），没有新建存储。
- 前端：全屏播放层 `#vplayer`（`<video controls playsinline>`）：倍速、画中画（浏览器支持才显示）、上一个 / 下一个（同目录视频当播放列表）、
  字幕下拉 / 载入本地字幕 / 字幕大小；`canPlayType` 判断 + `error` 事件给中文提示（"仍然尝试播放"可绕过 canPlayType 误判）。
- 入口：后端「按磁盘路径打开」里点视频文件；路径框输入视频路径；打开只含视频的目录；拖放 / 「图片/视频」按钮选本地视频（blob URL，不上传后端，可同时选字幕）。
- 字幕转换在 `IVCore`（纯函数，Node 可测）：`srtToVtt`（BOM / CRLF / 逗号→点 / 补 3 位毫秒 / 去 `<font>` `{\an8}`）、`assToVtt`（只取 Dialogue 文本）、
  `decodeSubtitle`（UTF-8 / UTF-16 BOM → 严格 UTF-8 → GBK 回退）。

**测试**：`python -m unittest tests.test_web_backend`（新增 `TestVideoServing` 14 项）、`node --test tests/web_core.test.mjs`（新增 5 项）、
`node tests/web_video_e2e.mjs`（真 Chrome + 真后端，19 项；样本 webm 由页面 MediaRecorder 现录，无需 ffmpeg）。

**刻意没做（后续阶段）**
- 服务端 ffmpeg 转码 / remux（VM 太小，明确不做）；不支持的编码（HEVC / AC3 / avi / wmv…）只提示，不转。
- mkv 内嵌字幕 / 多音轨切换；ASR 字幕（caption_engine）和翻译字幕（translation_engine）。
- 纯静态 /iv/ 页面（无本地后端）里 WebDAV 书架的视频：`<video src>` 带不了 Basic 头，仍未支持（后端模式已用中转解决，见上）。
- 纯浏览器（file://）模式的续播点（没有落盘处）；音频文件仍提示"需桌面版"。
- 没在真实手机 / Safari 上测过；`::cue` 字号百分比在不同浏览器表现略有差异。

**补充（云端视频）**：后端模式下「磁盘路径」窗口新增「☁ 云端」开关，浏览后端已配置的 WebDAV（凭据与桌面版共用 `_webdav_`），
点视频即播，同目录视频成列表，同主名字幕自动挂。字节经 `/api/remote/data` 流式中转（Range 透传、416 透传、按扩展名纠正 video/* 类型），
Basic 凭据只在后端 -> 网盘一段使用，不下发、不转发 WWW-Authenticate。`/api/data` 的 `Cache-Control: max-age=60` 现在只加在视频上，图片行为不变。
云端暂只开放视频（图 / 压缩包仍用书架）；云端视频没有续播点（续播接口只认本机路径）。

**补充（云端账号表单 + AList 兼容）**
- 后端模式下「☁ 云端」未配置时弹出账号表单（地址 / 用户名 / 密码，type=password）；⚙ 可随时改；「断开并忘记」清掉后端保存的账号。
  连接走 `POST /api/remote/config`（后端先连一次自检，成功才保存），页面不显示、不保存密码。AList 地址形如 `http://主机:5244/dav`（要带 /dav）。
- 中转兼容 AList：跟随 302 到网盘 CDN，但跨主机重定向时丢掉 Authorization（`remote_source._SafeRedirect`，桌面版流代理同受益），Range 照常带给 CDN；
  上游忽略 Range（回 200）时中转按总长自行切片回 206（最多替它跳过 256MB，超了给出明确错误）；没有 Content-Length 的上游按流转发并以关连接结束，`Accept-Ranges: none`。
- PROPFIND：目录 href 带尾斜杠、绝对 URL href、中文、`/dav` 前缀都有测试（`TestAListLikeRelay`）；字幕类文件在网页版后端列表里标为 `subtitle`。
- 没有真实 AList 验证过；只用假 WebDAV + 假 CDN 模拟。

