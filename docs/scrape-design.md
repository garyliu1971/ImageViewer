# 媒体刮削（海报 / 元数据）设计 · 第 1 步：引擎

状态：第 1 步（引擎 + HTTP 接口）与第 2 步（海报墙 UI）已实现（分支 `feature/iv-scrape-engine`，**依赖** `feature/iv-cloud-video-polish`，未推送）。
第 3 步（系列合并 / 继续观看横栏 / 可选 NFO）尚未做。Owner 已确认：令牌只走环境变量、阈值 0.8 / 0.08、缓存 150 天、按需刮削 + 只刮当前层、不做 NFO、`include_adult=false`、署名放帮助页底部与海报墙脚注。

## 1. 范围与已定决策

- 数据源：**只用 TMDB 官方 API**（个人 / 非商业免费）。不爬任何没有官方 API 的网站。
- 语言：中英双语，`zh-CN` 为主，`en-US` 作副标题 / 兜底。
- 媒体库没有 `.nfo` / 海报旁挂文件；媒体常在局域网 AList WebDAV（可能只读）和本地盘 -> **缓存一律放本机后端数据目录，默认不往媒体目录写任何东西**。
- 只跑在**本地后端**（`web_backend.py`）。静态 `/iv/` 没有后端，不在范围内。
- 令牌：只从环境变量 `TMDB_TOKEN`（API Read Access Token，`Authorization: Bearer`）读；不写盘、不进日志、不下发浏览器、不进配置。
- 不爬豆瓣：豆瓣没有公开官方 API，爬取违反其条款，**不计划实现**。需要中文评分以后只能走 TMDB 自带的评分字段。

## 2. 流水线

```
视频 key -> 文件名 / 上层目录解析 -> TMDB 搜索(zh-CN) -> 打分挑选 -> 取详情(zh-CN + en-US) -> 写缓存
                                                         ↘ 低置信度 / 候选咬得紧 => needs_review（暂定，不自动锁定）
手动锁定(pin) 优先于一切；锁定后重刮、过期、清缓存都不会改它。
```

1. **解析**（`scrape.parse_video`，自己实现）：输入文件名 + 最多 3 层上层目录。输出
   `{kind: movie|episode, title_candidates[], year, season, episode, show_dir_levels}`。
   处理：分辨率 / 编码 / 来源 / 音轨 / 字幕组 / 中文噪声词（`国语中字`、`简繁` 等）剥离；年份与分辨率数字区分（`1917.2019`、`2012.2009`、`1920x1080`）；
   `S01E01` / `1x03` / `E01` / `EP01` / `第1集` / `第十二集` / `Show - 03` / `[05]`（动漫）/ 纯数字 `03.mkv`；
   季目录 `Season 2` / `S02` / `第二季` / `Specials`，剧名取季目录的上一层；中英混排标题拆成 `[中文, 英文, 整体]` 多个候选；多点号 / 下划线 / 连字符分词。
   已知局限：按日期命名的日更节目（`2019-03-05`）、`Show 03.mkv`（无连字符的尾部集号）、`S.W.A.T` 这类名字里本身带点的标题。
2. **搜索**：电影 `search/movie`，剧集 `search/tv`（带 year / first_air_date_year，无结果时去掉年份重搜；主类型没把握时再试另一类型）。搜索结果按 `类型+语言+年份+关键词` 缓存。
3. **打分**：候选标题与 `title/name/original_*` 的归一化相似度（完全相等 1.0，包含关系加权，`difflib`），年份相符 +0.15、差 1 年 +0.05、差更多 -0.15，人气做微小加权。
   - 分数 < 0.45 => `unmatched`（仍给候选）。
   - 分数 < 0.8，或第一名与同类型第二名差 < 0.08 => `needs_review`（给暂定结果，**从不自动锁定**）。
   - 否则 `matched`。
4. **详情**：`movie/{id}`、`tv/{id}`、`tv/{id}/season/{n}`，各取 `zh-CN` 与 `en-US` 两份，合并成双语字段。一部剧的搜索 / 详情 / 季信息在所有集之间共享缓存。

## 3. 数据模型

稳定 key = 与 `/api/videoresume` 完全相同的方案：本机 = `normcase(abspath(path))`，云端 = `dav:<host:port>/<解码后的路径>`
（host 取后端已保存的 WebDAV 地址，不含账号密码）。key 只由路径算出，不读文件内容。

| 概念 | 内容 |
|---|---|
| 视频条目 `item` | `key, group_key, kind, parsed, status(matched/needs_review/unmatched/pinned), source(auto/pin), score, alternatives[], media, season, episode, updated_at, expires_at` |
| `media`（电影或剧） | `media_type, tmdb_id, title, title_zh, title_en, original_title, overview_zh/en, tagline_zh/en, release_date, year, poster_path, backdrop_path, vote_average, genres_zh/en, runtime, number_of_seasons, seasons[]` |
| `season`（仅剧集） | `number, name_zh/en, overview_zh/en, poster_path, episodes[{number, name_zh/en, air_date, still_path}]` |
| `episode`（仅剧集） | `number, name_zh/en, overview_zh/en, air_date, still_path, runtime` |
| `group_key`（仅剧集） | `grp:` + 剧名目录的 key；锁定一次，整部剧（所有季、所有集）生效 |

`title` = 有中文译名用中文，否则英文，否则原名；`title_zh` 只在确实含中文字符时才有值（TMDB 缺译名时会回退成英文，不当作中文）。

## 4. 缓存布局与 TTL

位置：`IV_SCRAPE_DIR`，缺省 = 配置文件（`image_viewer.json`）同目录下 `scrape_cache/`。

- `scrape.db`（sqlite）：
  - `tmdb_cache(ck, body, at)`：原始 TMDB 响应（搜索 / 详情 / 季），键形如 `movie:603:zh-CN`；
  - `matches(key, body, at)`：自动匹配结果（只存 `status/ref/score/alternatives`）；
  - `pins(key, body, at)`：手动锁定，只含 `{media_type, tmdb_id}`，**不含 TMDB 数据**，因此不受 6 个月限制、永不过期、永不被 purge 清掉。
- `img/<size>/<sha1(path)>.jpg|png`：图片缓存，尺寸变体 `w92 w154 w185 w342 w500 w780 original`，mtime 即抓取时间。
- **TTL = 150 天**（TMDB 条款：缓存不得超过 6 个月，留余量）。读取时发现过期就当作没有并删除；启动时调用一次 `purge()`；`POST /api/scrape/purge` 手动清（`all=true` 清全部 TMDB 数据与图片，保留 pins）。
- 过期且联网失败时**不会回退使用旧数据**（宁可显示未刮削也不违反条款）。
- 节流：全局 <= 20 请求/秒；429 读 `Retry-After`（上限 10 秒）重试，5xx / 网络错误指数退避，最多 4 次；图片请求从不带令牌。

## 5. 手动锁定（pin）

`POST /api/scrape/pin {path|remote, media_type, tmdb_id, scope}`：用户选一次正确条目。
`scope=auto`：电影锁单个视频，剧集锁整部剧（`group_key`）；`video` / `group` 可显式指定；`tmdb_id=null` 取消锁定。
锁定前先向 TMDB 取一次详情验证 id 真实存在，失败则不落盘。查找顺序：视频级锁定 -> 系列级锁定 -> 自动匹配缓存 -> 重新搜索。

## 6. 接口（均需 `?t=<后端 token>`，与现有接口一致）

| 接口 | 作用 |
|---|---|
| `GET /api/scrape/status` | `{token_configured: bool, cached_responses, matches, pins, images, image_bytes, ttl_days}`（**只给 true/false，不给令牌**） |
| `POST /api/scrape/match {path\|remote, force?}` | 按需刮一个视频，返回 item（含候选 alternatives） |
| `GET /api/scrape/item?path=\|remote=` | 只读缓存（不联网搜索），无则 `item:null` |
| `POST /api/scrape/pin` | 见上 |
| `GET /api/scrape/image?p=/xxx.jpg&size=w342` | 缓存海报代理。`p` 只接受 `^/[A-Za-z0-9_-]{6,80}\.(jpg|png)$`，`size` 只接受白名单；永不抓取客户端给的 URL（无 SSRF） |
| `POST /api/scrape/purge {all?}` | 清缓存 |
| `POST /api/scrape/scan {items:[{path\|remote}...]}` | 开后台任务（最多 2000 个，同时只允许 1 个），返回 job |
| `GET /api/scrape/job?id=` | 进度：`state, total, done, matched, needs_review, unmatched, failed, last_error, queue[{key,state}]` |

输入校验：只认视频扩展名、长度上限、控制字符；云端路径走与续播相同的 `remote_resume_key`（解析 `..`）。错误：令牌缺失 503 `no_token`，TMDB 失败 502（消息里绝无令牌）。
队列状态模型：`pending -> matched | needs_review | unmatched | failed`；needs_review 与 unmatched 留给 UI 的「待确认」列表；令牌失效时任务立即停止。

## 7. 网关 / 反代（国内网络）

TMDB 在中国大陆直连常不稳。`TMDB_API_BASE`（默认 `https://api.themoviedb.org/3`）与 `TMDB_IMAGE_BASE`（缺省取 `/configuration` 返回的地址，失败回退 `https://image.tmdb.org/t/p`）都可覆盖。校验：只允许 https，或内网 / 回环的 http；拒绝账号密码、query、fragment。
令牌**只会发往 `TMDB_API_BASE` 这一个主机**（请求层有断言），图片请求完全不带令牌。**重要：令牌必须只交给你信任的网关**——网关运营者能看到令牌和你所有的文件名搜索词。

## 8. 隐私与合规

- **文件名会发给 TMDB**（解析出的标题 + 年份作为搜索词；目录名可能是第二候选）。不发完整路径、不发文件内容。使用网关时同样发给网关。
- 请求带描述性 `User-Agent: ImageViewer/<版本> (...)`，不隐藏应用身份。
- 不用 TMDB 数据做 AI 训练；缓存 <= 6 个月（见 §4）。
- **署名（第 2 步 UI 必须带）**：在「关于 / 致谢」处写
  “This product uses the TMDB API but is not endorsed or certified by TMDB.” 并放 TMDB 官方批准的 logo（尺寸小于应用自己的标识）。引擎阶段尚无 UI，因此尚未展示——**发布含刮削 UI 之前必须补上**。
- 豆瓣等无官方 API 的站点：不爬（见 §1）。

## 9. 第 2 步：UI（已实现，仅后端模式；静态 /iv/ 没有后端所以看不到）

1. 浏览窗口里的**海报墙**网格（`/api/scrape/image` w342），排序：名称 / 评分 / 年份；电影 vs 剧集自动区分；多季 + Specials。
2. **详情页**：中文主标题 + 英文副标题、简介（中 / 英切换）、类型、评分、背景图；剧集显示季选择与**分集列表**（分集名中英、剧照、播放进度）。
3. 「**修正匹配**」对话框：显示 alternatives，支持手动搜索（新增 `GET /api/scrape/search?q=`，仍只代理 TMDB 搜索）；确认后 pin。
4. **待确认队列**页：needs_review / unmatched / failed；批量扫描入口（目录 -> 视频列表 -> `scan`）。
5. 已看 / 未看角标、继续观看（复用现有 `_video_resume_` 存储，key 同一方案）。
6. About 页署名 + 令牌配置状态提示（`token_configured`，不显示令牌）。

## 10. 第 3 步（更后）

- 系列分组页、「继续观看」横栏、季海报。
- 可选导出 Kodi 风格 `.nfo` / 海报到**用户明确选择的可写目录**（默认关闭；只读 AList 不写）。
- 可选：导演 / 演员浏览（TMDB credits）。

## 11. 待 Owner 确认的问题

（以下问题 1~8 已由 Owner 回复并采纳，保留作记录；新问题见文末「第 2 步后的新问题」。）
1. TMDB 令牌能否在你的网络直连？不能的话你有可信的网关 / 反代吗（`tmdb_check.py` 可测）？
2. 需要 `TMDB_TOKEN` 之外的配置方式吗（例如 Windows 用户环境变量即可，还是要在 UI 里填？UI 填的话令牌存哪、如何不进 `image_viewer.json`）。
3. needs_review 阈值（0.8 / 差距 0.08）偏保守还是偏激进？你的片库命名风格能给几个典型样例吗？
4. 缓存 150 天后自动过期重取——是否接受？（条款上限 6 个月。）
5. 第 2 步是否要「整个目录一键刮削」，还是只在打开某个视频时按需刮？AList 大目录递归会产生很多 TMDB 请求。
6. 是否要在第 3 步做 `.nfo` 导出？目标目录是否可写？
7. 成人 / R 级内容：目前搜索固定 `include_adult=false`，是否合适？
8. 署名 logo 放在哪个页面（About / 设置）？

## 12. 第 2 步实现说明（image-viewer.html）

- 入口：「按磁盘路径打开」窗口（本机或 ☁ 云端目录）里新增 `☰ 列表 / 🎞 海报墙` 切换（选择会记住）。
- 列表页只调 `POST /api/scrape/peek`（解析文件名 + 读缓存，**绝不联网**，最多 500 项）；卡片进入视口时才逐个 `POST /api/scrape/match`（前端并发 2，后端再节流）。剧集卡只匹配代表集，其余集共享缓存。
- 卡片：电影一张；同一剧名目录（或同名）的剧集合并成一张剧集卡（「N 集」）；徽标 待确认 / 未匹配 / 📌 锁定；排序 名称 / 年份 / 评分；标题或文件名筛选。
- 详情页：背景图 + 海报、中文主标题 + 英文副标题、年份 / 评分 / 时长或季数 / 类型、简介（中文优先，英文作辅）；剧集有季标签和分集列表（中英片名、剧照）。
  播放复用现有播放器（`openServerVideo` / `openRemoteVideo`，字幕等一并复用）。
- 继续观看：卡片 / 分集上显示 `▶ mm:ss`，数据来自 peek 返回的 `resume_ms`（直接读 `_video_resume_`，没有新增存储）。
  **「已看」标记例外**：续播点在看完时会被清掉（结尾 3 秒内），无法区分「看完」和「没看过」，所以播放器 `ended` 事件会在浏览器 localStorage（`iv.scrape.played.v1`）记一个小标记。它只是本浏览器的显示便利，不同步、不进后端。
- 修正匹配：`GET /api/scrape/search?q=&year=&type=`（只代理 TMDB 搜索，q ≤ 100 字符）→ 点选 → `POST /api/scrape/pin`（剧集锁整部剧）；可「取消锁定」（取消后立即重新自动匹配）。
- 刮削当前目录：`POST /api/scrape/scan`（只当前这一层，≤ 2000）+ 轮询 `GET /api/scrape/job` 显示进度（已匹配 / 待确认 / 未匹配 / 失败），`POST /api/scrape/cancel` 取消。
- 状态行：令牌已配置 / 未配置（只来自 `token_configured`）、缓存统计、「清缓存」（两次点击确认，锁定保留）。未配置令牌时给出中文设置说明（用户级环境变量命令 + 重启后端），界面上**没有任何令牌输入框**。
- 错误：401 / 令牌缺失 / 连不上（连续 3 次失败后暂停懒加载并提示）都有明确提示；TMDB 不可用时仍按文件名显示标题。
- 署名：帮助页底部与海报墙脚注都有 “This product uses the TMDB API but is not endorsed or certified by TMDB.” 和 TMDB 官方短版 logo（12px 高，远小于应用自身标识；SVG 取自 TMDB 品牌页 themoviedb.org/about/logos-attribution 列出的文件，原样内嵌，副本在 `icons/tmdb-logo-short.svg`）。
  TMDB 品牌页本身没有给出声明的固定措辞，这里用的是其 API 条款里通行的那句，**请 Owner 对照 API Terms of Use 再确认一次措辞**。

新增后端接口：`POST /api/scrape/peek`、`GET /api/scrape/search`、`POST /api/scrape/cancel`；`item` / `peek` 对过期详情不再联网（离线模式）；item 增加 `pin_scope`（video / group）。

## 13. 文件名解析：已知缺口与如何扩展

Owner 还没有提供真实文件名样本，以下是**已知处理不了或容易错**的情形（没有测试保证它们正确）：

| 情形 | 现状 |
|---|---|
| 按日期命名的日更节目 `Show.2019-03-05.mkv` | 日期被当年份；没有集号，会按电影搜 |
| 无连字符的尾部集号 `Show 03.mkv`、`Show 12 完.mp4` | 当成标题的一部分（`Show 03`），搜索可能偏 |
| 标题里自带点号的名字 `S.W.A.T.2017.mkv`、`Mr.Robot` 之外的缩写 | 点号当分隔符，拆成多个词 |
| 标题本身像噪声词 / 以数字开头的续集 `Ocean's 11`、`Se7en`、`Movie 2` | `- 2` 形式的会被当集号；`Movie 2` 保持标题 |
| 一个文件含多集 `S01E01-E03` | 只取第一集 |
| 绝对集号动漫（`进击的巨人 - 75` 对应第 4 季第 16 集） | 按季 1 第 75 集处理，分集名对不上 |
| 目录名是发布名而文件名只有 `movie.mkv` | 从目录取标题，但目录里的噪声词清理不如文件名完整 |
| 简繁混排 / 全角标点标题 | 搜索时原样发给 TMDB，不做简繁转换 |

扩展方法：
1. 先在 `tests/test_scrape_parser.py` 的 `CASES` 表加一行（文件名、上层目录、期望 kind / 标题 / 年 / 季 / 集）——这张表就是规格，加完先看红。
2. 噪声词：在 `scrape.py` 的 `NOISE` 集合里加词，或运行时 `scrape.add_noise("某字幕组", ...)`；分辨率 / 年份 / 集号写法在 `_parse_stem()` 的 token 规则里。
3. 目录规则（季目录写法）在 `SEASON_DIR_RES`，泛名黑名单（`video` / `cd1` 等）在 `GENERIC_STEM_RE`。

### 第 2 步后的新问题（已全部由 Owner 答复「要」，并已实现，见 §14）

1. ~~「已看」标记只在浏览器 localStorage~~ -> 已改为共享配置里的 `_video_watched_`（桌面版 + 网页版共用）。 ✅
2. ~~播放后回到海报墙~~ -> 播放器关闭（含 Esc）后回到同一目录 / 模式 / 排序 / 筛选 / 滚动位置，详情页也回来。 ✅
3. ~~每季一个目录的剧合并~~ -> 按 TMDB id 合并成一张卡，详情页列出全部季，每集链接到自己的文件。 ✅
4. 手机端实测、TMDB 声明措辞确认：仍待 Owner。

## 14. 第 2 步追加：已看 / 回到原视图 / 分季合并 / 内网直连

**已看（`_video_watched_`）**
- 新的同级配置 key：`{key: unix 秒}`，key 方案与 `_video_resume_` 相同（本机 normcase(abspath)，云端 `dav:<host>/<路径>`），同样最多 5000 条。`_video_resume_` 的格式（毫秒整数）一个字节都没变；老版本桌面不认识新 key，但 `config_store` 是整份 JSON 读写，所以不会被丢（有测试）。
- 纯逻辑在 `watched_store.py`（桌面和后端共用）：看完（离结尾 < 3 秒）清续播点并记已看；已看之后又看了一半，续播点照常记、已看保留；手动标记 / 取消不动续播点。
- 网页：`/api/videoresume` GET 多返回 `watched`；PUT 带 `watched: true|false` 手动标记；播放到结尾（`ms≈length`）自动记。`/api/scrape/peek` 每项带 `watched`。海报墙 / 详情页显示已看 / 未看、单集开关、「全部标为已看 / 未看」；**剧集只有所有可见的集都已看才算已看完**（否则显示 n/N）。旧的 localStorage `iv.scrape.played.v1` 已删除（首次加载时把里面的本机路径一次性迁移进后端）。
- 桌面：`image_viewer.py` 的 `_save_resume_position` 改用 `watched_store.apply_resume`（续播规则逐字等价，有对照测试），VLC 播放到 `Ended` 时 `mark_watched`。**桌面界面目前只写不显示**已看状态，且这部分是 Tk / VLC GUI，这里跑不了，只能测它调用的纯逻辑。
- 后端配置读写加了锁：批量标记时并发 PUT 会丢更新（e2e 里抓到的真问题，已修，有并发测试）。

**回到原来的视图**：从详情页 / 海报墙 / 列表播放视频前记下（目录、本机或云端、海报墙或列表、排序、筛选、滚动位置、选中项、详情页和季）；播放器关闭（按钮或 Esc）后恢复。

**分季目录合并**：海报墙新增「含子目录」（默认开）：把当前目录往下最多两层（≤ 60 次目录读取、≤ 500 个视频，超出会提示）的视频一起列出。`Show/Season 1`、`Show/Season 2` 本来就同一个系列目录；`Show S01`、`Show 第二季` 这类各自独立的目录在匹配后按 TMDB id 合并成一张卡（含缓存 / 锁定的结果）。锁定合并卡会对其中每个目录组各锁一次。「刮削当前目录」仍然只处理当前这一层。

**内网直连（独立提交，可单独摘取）**：`netutil.py`——目标是内网 / 回环 / 链路本地 / `.local` / 单段主机名时绕过环境变量和系统代理（`HTTP_PROXY` 指向死端口也能连上 LAN AList），公网（TMDB、Azure）照旧走代理；重定向后每一跳重新判断。规则与前端 `IVCore.plainHttpRisk` 一致（有测试对照）。WebDAV、`/api/remote/*` 中转、DLNA、TTS 转发、字幕 / 大模型接口、TMDB 客户端都改用它。

## 15. 后续修正（真实反馈）

- **忽略（不是影视）**：修正匹配对话框里的「忽略此项（不是影视）」。忽略记录存在 `pins` 表里（`{"ignore": true}`，key 方案同锁定，剧集作用于所在系列目录组），所以 `purge` 不会清掉；被忽略的条目永不发给 TMDB（懒加载、`刮削当前目录` 都不会），peek 返回 `status: ignored`，海报墙显示成普通文件卡 +「已忽略」小标签，弹窗里可「取消忽略」。接口：`POST /api/scrape/pin {path|remote, ignore: true|false}`。起因：网盘的「夸克」介绍视频被匹配成 1941 年德国片。
- **极短中文标题不自动接受**：主候选（文件名里的标题）≤ 2 个汉字时，只有结果自己的标题 / 原名里真的含有这个词才算命中；只靠外语别名命中的结果只作候选，状态为「未匹配」，不会 `matched` 或 `needs_review`。
- **TMDB 还没有这一季（404）**：真实复现了「流人第六季」的现象——`/tv/{id}/season/6` 回 404 导致整个 match 失败（`刮削失败：TMDB 找不到该条目 (404)`）。现在降级：返回剧集层面的资料（海报、简介、评分、其它季），`season_missing = 6`，详情页只显示一条灰色小提示，并按文件名解析出的集号列出本地文件（可播放）。404 只做 1 小时的负缓存（`NEG_TTL`），新一季上线后很快就能刷出来；已锁定的 id 若在 TMDB 上消失，则标记 `tmdb_missing` 而不是报错。
- **电视剧年份只是软提示**：文件名里的 `2026` 是「这一季」的年份，不是首播年。剧集搜索不再带 `first_air_date_year` 过滤（会把真正的剧排除掉，只剩同名干扰项），年份只在打分时当加分，不扣分；电影仍按年份过滤。
- **解析器**：`流人第六季.2026.S06E01…` 里季标记后面紧跟的 `S06E01` 以前读不出集号（真实 bug）；站点水印（`BT世界网`、`[www.xxx.com]`、`www.xxx.la-`、`【…www…】`、`…字幕组 / 论坛 / 影视之家`）被剥掉；`HD1080P` 识别为分辨率；`Episode 05` 支持。用例都在 `tests/test_scrape_parser.py` 的 `CASES`。
