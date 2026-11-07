# /iv/ 部署说明（网页版漫画浏览器 → 同域静态 PWA）

目标：在已有的 Caddy + SFTPGo（WebDAV）那台 VM 上，加一个 `https://<host>/iv/`，
手机 / 平板浏览器打开 `https://<host>/iv/#open=<书的相对路径>` 就能按需读取 WebDAV 书库里的 zip / cbz / epub 漫画
（只发 HTTP Range 请求，翻到哪页取哪页；不整本下载）。

> 这份文档和 `deploy/` 下的文件只是**部署材料**，仓库里没有任何东西会自动部署。下面每一步都在你的机器 / VM 上手动执行。
> 文中 `<...>` 都是占位符；账号、密码、令牌不要写进任何文件，也不要贴进聊天。

## 为什么同域

`/iv/` 与 WebDAV 在同一个域名下，浏览器请求是同源的：**没有 CORS**，不需要给 SFTPGo / Caddy 加
`Access-Control-*` 头，`Range` 与 `Authorization` 也不会被预检拦掉。代价是同源页面共享浏览器存储
（IndexedDB / localStorage / Cache Storage），所以：

- `/iv/` 只用自己的库 `iv-settings` 存账号，**不读** `/reader/`（PyReader 网页版）的 IndexedDB；
- 给 `/iv/` 用的是**只读 SFTPGo 账号**（第 5 步），不是 gary / qian 那种 `/: *` 全权限账号；
- Caddy 给 `/iv/` 加了严格的 CSP / `no-referrer` / `X-Frame-Options`（见 `Caddyfile.iv.snippet`）。

## 1. 本地生成静态目录

```
python deploy/build_iv_static.py            # -> dist/iv-static/ 和 dist/iv-static.tgz
```

目录内容：`index.html`（= `image-viewer.html` 改名）、`manifest.webmanifest`、`sw.js`（`__BUILD__` 已换成内容哈希）、
`icons/*.png`。图标是 `deploy/make_pwa_icons.py` 生成并已提交的，平时不用重跑。
`--out <目录>` 只接受不存在的新目录、空目录，或本脚本上次生成的目录（里面有 `.iv-static-build` 标记，不会进 .tgz）；
别的有内容的目录（例如仓库里的 `deploy/`、`tests/`）会被拒绝，什么都不删。build 号只看内容，不受 CRLF / LF 检出影响。

先在本机看一眼（可选）：`python -m http.server -d dist/ 8099`，打开 `http://localhost:8099/iv-static/` 只能验证页面能起来；
真正的 `/iv/` 作用域要在 VM 上验证。

## 2. 上传并替换（保留旧版，随时回滚）

```
VM=<user>@<host>                                   # 例：azureuser@gary-pyreader.…
scp dist/iv-static.tgz $VM:/tmp/iv-static.tgz
ssh $VM
```

在 VM 上：

```
sudo mkdir -p /var/www/iv.new
sudo tar -xzf /tmp/iv-static.tgz -C /var/www/iv.new
sudo find /var/www/iv.new -type d -exec chmod 755 {} \; ; sudo find /var/www/iv.new -type f -exec chmod 644 {} \;
# 首次部署 /var/www/iv 还不存在，mv 那行会报错，忽略即可
[ -d /var/www/iv ] && sudo mv /var/www/iv /var/www/iv.old
sudo mv /var/www/iv.new /var/www/iv
```

回滚：`sudo rm -rf /var/www/iv && sudo mv /var/www/iv.old /var/www/iv`。

## 3. Caddyfile（先备份，再校验，最后才 reload）

```
sudo cp -a /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-iv-$(date +%Y%m%d%H%M)
sudoedit /etc/caddy/Caddyfile
```

把 `deploy/Caddyfile.iv.snippet` 的内容（`redir /iv /iv/ 308` 和 `handle_path /iv/* { … }` 两段）
粘进站点块，位置在兜底反代（SFTPGo WebDAV）**之前**、`handle_path /reader/*` 旁边。然后：

```
sudo caddy validate --config /etc/caddy/Caddyfile      # 必须通过
sudo systemctl reload caddy                            # 不用 restart；校验失败就不要 reload
```

**检查站点块里有没有顶层 `encode`**（`encode gzip zstd` 写在站点块最外层会作用于所有路径，包括 WebDAV）。
zip / epub 本身已是压缩格式，被再压一次会让 `Content-Range` / `Content-Length` 对不上，Range 读取就坏。
如果有，把它移进 `/reader/` 的 handle 里，WebDAV 兜底块里不要有 `encode`。

## 4. 验证 /iv/ 本身

```
HOST=https://<host>
curl -sI $HOST/iv/            | head -n 20      # 200，Cache-Control: no-cache，带 CSP
curl -sI $HOST/iv/sw.js       | head -n 10      # 200，Content-Type 含 javascript
curl -sI $HOST/iv/manifest.webmanifest | head   # 200；Content-Type 最好是 application/manifest+json
curl -sI $HOST/iv               | head -n 5     # 308 -> /iv/
```

浏览器里打开 `/iv/`：开发者工具 → Application → Service Workers 应看到 scope 为 `/iv/`，
Cache Storage 里只有 `iv-shell-<hash>`；`/reader/` 的 `pyreader-web-*` 缓存不受影响。

## 5. 建只读 SFTPGo 账号（给 /iv/ 用）

SFTPGo 的管理界面只监听本机（`127.0.0.1:8080`），经 SSH 隧道访问：

```
ssh -N -L 18080:127.0.0.1:8080 $VM        # 用完就关
```

**方式 A：Web 管理界面**（`http://127.0.0.1:18080/web/admin`）→ Users → Add。要点：

- Username：例如 `iv-viewer`；设一个强密码（只在这个界面里输入，自己的密码管理器保存）。
- Home dir：一个**空目录**（不放任何书，例如 `<data-dir>/iv-viewer-home`）。
- Virtual folders：把书库那个虚拟文件夹挂到 `/library`（**挂载路径 = 用户看到的路径**，和 gary 的 `library-blob` 同一个）。
- Permissions：`/` 只给 `list`；`/library` 只给 `list` 和 `download`。**不要**勾 upload / overwrite / delete / rename / create_dirs / chmod 等。
- Filters → Denied protocols：勾 SSH、FTP、HTTP（Web 客户端），**只留 DAV**。

**方式 B：REST API**（同样走隧道；先拿管理员令牌，令牌和密码都不要落地到文件 / shell 历史）：

```
read -rs -p "admin password: " ADMINPW; echo
TOKEN=$(curl -s -u "<admin>:$ADMINPW" http://127.0.0.1:18080/api/v2/token | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
read -rs -p "viewer password: " VIEWERPW; echo
curl -s -X POST http://127.0.0.1:18080/api/v2/users \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d @- <<JSON
{
  "username": "iv-viewer",
  "password": "$VIEWERPW",
  "status": 1,
  "home_dir": "<data-dir>/iv-viewer-home",
  "permissions": { "/": ["list"], "/library": ["list", "download"] },
  "virtual_folders": [ { "name": "<库的虚拟文件夹名>", "virtual_path": "/library", "quota_size": -1, "quota_files": -1 } ],
  "filters": { "denied_protocols": ["SSH", "FTP", "HTTP"] }
}
JSON
unset ADMINPW VIEWERPW TOKEN
```

字段名随 SFTPGo 版本略有出入（2.7.x 为上面这样）；以 `http://127.0.0.1:18080/openapi` 里的 schema 为准。

**验证它真的是只读**（用新账号，走 DAV）：

```
read -rs -p "viewer password: " P; echo
U="iv-viewer:$P"
curl -s -o /dev/null -w "%{http_code}\n" -u "$U" -X PROPFIND -H "Depth: 1" $HOST/library/        # 207
curl -s -o /dev/null -w "%{http_code}\n" -u "$U" -H "Range: bytes=0-0" "$HOST/library/<某本书>.epub" # 206
curl -s -o /dev/null -w "%{http_code}\n" -u "$U" -X PUT --data x $HOST/library/_iv_probe.txt       # 403
curl -s -o /dev/null -w "%{http_code}\n" -u "$U" -X DELETE $HOST/library/_iv_probe_nonexistent.txt  # 403（只对不存在的文件试，别拿真书试删除）
unset P U
```

## 6. 验证 Range 读取（最重要的一步）

```
curl -s -D - -o /dev/null -u "$U" -H "Range: bytes=0-0" -H "Accept-Encoding: gzip, br" "$HOST/library/<某本书>.epub"
```

必须看到：`HTTP/2 206`、`Content-Range: bytes 0-0/<总大小>`、**没有** `Content-Encoding`。
如果是 `200`，说明中间有东西吞了 Range（`/iv/` 页面会明确报「server ignores Range」并拒绝下载整本）。
再用浏览器真机试：打开 `/iv/#open=<URL 编码后的相对路径>`，第一次会弹出账号框（WebDAV 地址默认是本站根，书库文件夹默认 `library`），
填第 5 步的只读账号；开发者工具 Network 里应该全是 206，而且同时在途的请求不超过 4 个。

## 7. 手机上

- 直接在手机浏览器打开链接，或「添加到主屏幕」装成 PWA（作用域 `/iv/`）。
- 账号保存在这台设备的浏览器里；换人 / 丢设备 / 改密码：账号框里点「忘记此设备」，并在 SFTPGo 里改密或禁用 `iv-viewer`。
- 启动链接格式（给其他页面做跳转用）：
  `/iv/#open=<encodeURIComponent(相对路径)>&src=dav&bid=<可选>&dir=rtl|ltr&back=/reader/`
  - `open` 必须是书库下的相对路径（不能以 `/` 开头，不能含 `..`、协议、反斜杠）；
  - 阅读方向是**每本书各自记住**的：这本书第一次打开时，方向初值 = epub 的 OPF `page-progression-direction`（有的话）> 链接的 `dir`；
    一旦保存过（用户切换过，或第一次打开时已存下），以后每次都用保存的值，OPF / `dir` 都不再覆盖；
  - `back` 只接受同源路径（`/…`，不能 `//…`），有效时工具栏出现「← 返回」。
  - 打开后页面会用 `history.replaceState` 把 `#…` 去掉。连续点两个链接时以最后一个为准（慢的旧链接完成后会被丢弃）。
  - 页面连着本地后端（`web_backend.py`）时不处理 `#open=`（那里没有书库账号入口），只弹一条提示。
  - 链接里**绝不放账号密码**。

## 8. 回滚 / 下线

- 只回滚页面：见第 2 步。
- 完全下线：从 Caddyfile 删掉这两段（用第 3 步的备份），`caddy validate` 后 reload；`sudo rm -rf /var/www/iv /var/www/iv.old`；
  SFTPGo 里禁用 / 删除 `iv-viewer`。已装的 PWA 会在下次联网时发现 `/iv/` 404，卸载即可。
