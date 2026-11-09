# Vendored: pdf.js（/iv/ 读 PDF 用）

从 npm 包 `pdfjs-dist@4.10.38` 取出后**原样**提交（不改一个字节，保留文件头里的 Mozilla / Apache-2.0 版权声明）。
应用运行时不从任何 CDN 取代码；这里的文件在浏览器里才会被执行。

| 文件 | 包内路径 | 许可证 | SHA-256 |
|---|---|---|---|
| `pdf.min.js` | `legacy/build/pdf.min.mjs`（改名 .mjs → .js，内容不变） | Apache-2.0（`LICENSE.pdfjs`） | `44ec6f011027ee77791386b66c14876a5fc29e20bf0433c07c6726fff7212b72` |
| `pdf.worker.min.js` | `legacy/build/pdf.worker.min.mjs`（同上） | Apache-2.0 | `bd88805178a26c729db8c0107a5b630cb900ec070f4d8c7529a3e45530afd41d` |
| `LICENSE.pdfjs` | `LICENSE` | Apache-2.0 全文 | `0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594` |
| `cmaps/*.bcmap`（168 个）+ `cmaps/LICENSE` | `cmaps/` | Adobe BSD 风格（`cmaps/LICENSE`） | 见 `SHA256SUMS` |
| `standard_fonts/*`（14 个字体 + 2 个 LICENSE） | `standard_fonts/` | Foxit（`LICENSE_FOXIT`）/ Liberation（`LICENSE_LIBERATION`） | 见 `SHA256SUMS` |

`SHA256SUMS` 列出本目录每个文件的哈希（`sha256sum -c SHA256SUMS`）；`tests/test_build_iv_static.py` 会校验它，
防止换行转换（autocrlf）或手滑改动悄悄损坏二进制。仓库根的 `.gitattributes` 把 `vendor/**` 标成 `-text`。

来源：`npm pack pdfjs-dist@4.10.38`（registry.npmjs.org）。

Notes

* 用 **legacy** 构建而不是 `build/`：main 构建里原生调用 `Promise.withResolvers`（Chrome 119 / Safari 17.4 才有），
  legacy 构建把 core-js 的 `Promise.withResolvers` polyfill 打进了主文件和 worker（已用 grep 核实两个文件里都有
  `target:"Promise",stat:!0 … withResolvers`；原生已有时 core-js 不会覆盖），所以旧 iPhone / 旧 Chromium 内核的国产浏览器也能用。
  代价：主文件 398 KB、worker 1.4 MB（比 main 构建大约 +45 KB / +40 KB）。
* 这两个文件是 ES module：主文件用 `import()` 动态加载，worker 用 `new Worker(url, {type:'module'})`（同源，不需要 blob:）。
  改名为 `.js` 是因为有些静态服务器不给 `.mjs` 发 JavaScript 的 MIME。
* 4.10.38 没有独立的 `.wasm` 文件：JPEG2000（JPXDecode）解码器以内嵌 base64 的形式在 worker 里，用 `new WebAssembly.Module` 编译。
  /iv/ 的 CSP 没有 `'wasm-unsafe-eval'`，所以这类图片会是空白，其余内容正常（见 `deploy/README-iv-deploy.md`）。
* `cmaps/`（非嵌入 CJK 字体用的预定义 CMap）和 `standard_fonts/`（非嵌入的标准 14 字体）只在 PDF 真的用到时才被
  worker 按需取一个文件，**不会**预缓存。
* 升级：下载新版 → 复核许可证 → 更新本表和 `SHA256SUMS` → 把 `sw.js` 里的 `PDFJS_VER`（缓存名）改成新版本号。
  不要升到 5.x（浏览器下限更高、API 有变）；已高于修复 CVE-2024-4367 的 4.2.67，代码里仍传 `isEvalSupported:false`。
