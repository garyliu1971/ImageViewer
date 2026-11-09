# Vendored: libarchive.js（/iv/ 读 rar / cbr / 7z / cb7 / tar / cbt / tgz 用）

从 npm 包 `libarchive.js@2.0.2`（2024-01-27 发布）取出后**原样**提交，不改一个字节。运行时不从任何 CDN 取代码。
只在第一次打开 rar / 7z / tar 系压缩包时才被加载；zip / cbz / epub / pdf 不会碰它。

| 文件 | 包内路径 | 许可证 | 大小 |
|---|---|---|---|
| `libarchive.js` | `dist/libarchive.js`（ES module，主线程用：`Archive.init({workerUrl})` / `Archive.open(file)`） | MIT | 8 KB |
| `worker-bundle.js` | `dist/worker-bundle.js`（module worker，内含 Comlink；按 `new URL('libarchive.wasm', import.meta.url)` 取同目录的 wasm） | MIT | 62 KB |
| `libarchive.wasm` | `dist/libarchive.wasm`（libarchive 3.7.2 编译成 WebAssembly；支持 rar / rar5 / 7z / tar / gz / bz2 / xz / zstd …） | libarchive：BSD-2-Clause（各格式模块带各自的 BSD / 公共领域声明）；zlib / bzip2 / liblzma / zstd 各按其自身许可证 | 1.0 MB |
| `LICENSE.libarchive-js` | `LICENSE`（libarchive.js 本身，MIT） | MIT | 1 KB |

`SHA256SUMS` 列出本目录每个文件的哈希（`sha256sum -c SHA256SUMS`）；`tests/test_build_iv_static.py` 会校验它。
仓库根的 `.gitattributes` 把 `vendor/**` 标成 `-text`，不做换行转换。来源：`npm pack libarchive.js@2.0.2`（registry.npmjs.org）。

Notes

* **CSP**：wasm 需要 `script-src 'wasm-unsafe-eval'`（worker 自己的响应头也带这条）。见 `deploy/Caddyfile.iv.snippet` 与 `deploy/README-iv-deploy.md`。
* **内存**：libarchive.js 2.0.2 会把整个压缩包读进 wasm 内存（`file.arrayBuffer()` -> `malloc`），一本书约占 2～3 倍文件大小（File + wasm 堆 + 临时拷贝）。
  页面在文件 > 300MB 时先提示；换书 / 关书时 `terminate()` worker，wasm 堆随之释放。
* **按页解压**：`CompressedFile.extract()` 每次从头遍历条目、跳过前面的（`skipEntry`），所以非 solid 的 rar / 7z / tar 单页成本 ≈ 线性扫描；
  solid 压缩（rar 的 solid 选项 / 7z 默认 solid）要把前面的数据也解出来，越靠后的页越慢。页面侧用小 LRU 缓存、串行请求。
* **加密**：不支持密码；`hasEncryptedData()` 为真时页面直接提示「压缩包有密码」。
* 升级时：换这三个文件 + `LICENSE.libarchive-js`，更新本文件版本号与 `SHA256SUMS`，并把 `sw.js` 里的 `LIBARCHIVE_VER` 改成同一个版本（build 测试会核对）。
