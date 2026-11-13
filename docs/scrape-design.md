# 媒体刮削（海报 / 元数据）设计 · 第 1 步：引擎

状态：引擎 + HTTP 接口 + 测试已实现（分支 `feature/iv-scrape-engine`，**依赖** `feature/iv-cloud-video-polish`，未推送）。
UI（第 2 步）、剧集分组 / 继续观看 / NFO（第 3 步）尚未做。

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

## 9. 第 2 步：UI（后续）

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

1. TMDB 令牌能否在你的网络直连？不能的话你有可信的网关 / 反代吗（`tmdb_check.py` 可测）？
2. 需要 `TMDB_TOKEN` 之外的配置方式吗（例如 Windows 用户环境变量即可，还是要在 UI 里填？UI 填的话令牌存哪、如何不进 `image_viewer.json`）。
3. needs_review 阈值（0.8 / 差距 0.08）偏保守还是偏激进？你的片库命名风格能给几个典型样例吗？
4. 缓存 150 天后自动过期重取——是否接受？（条款上限 6 个月。）
5. 第 2 步是否要「整个目录一键刮削」，还是只在打开某个视频时按需刮？AList 大目录递归会产生很多 TMDB 请求。
6. 是否要在第 3 步做 `.nfo` 导出？目标目录是否可写？
7. 成人 / R 级内容：目前搜索固定 `include_adult=false`，是否合适？
8. 署名 logo 放在哪个页面（About / 设置）？
