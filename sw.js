// /iv/ 的 service worker：只缓存应用外壳（页面本身 + manifest + 图标），让页面能离线打开、秒开。
//
// /ocr/v1/*（AI 朗读识别）：同源但不在 /iv/ 范围内，而且是 POST + Authorization，下面的 fetch 处理一开头就放行，不拦截也不缓存（test_build_iv_static 有断言）。
// 绝不碰书本数据：同源的 WebDAV（/library/…）、Range 请求、带 Authorization 的请求一律不拦截、不缓存，
// 直接走网络 —— 否则 206 分段会被错误地缓存成整文件，或者把带账号的响应留在缓存里。
// 作用域只有 /iv/（注册时 scope './'，且文件就放在 /iv/ 下）；缓存名前缀 iv-，清理旧缓存时只动 iv- 开头的，
// 不会碰同源 /reader/ 的 pyreader-web-*。
// 部署脚本（deploy/build_iv_static.py）会把 __BUILD__ 换成内容哈希，这样每次发布都会换一个缓存名。
//
// pdf.js（/iv/vendor/pdfjs/）：不预缓存（安装时一个字节都不取），第一次读 PDF 用到哪个文件才存哪个（cmap / 字体也是用到才存）。
// 只缓存这个目录下的同源 200 响应（带版本号的独立缓存，shell 发布不会清掉它；升级 pdf.js 改 PDFJS_VER 即可换新、删旧）。
// 其余一切（WebDAV / Range / Authorization）仍然不碰。
// libarchive.js（/iv/vendor/libarchive/，读 rar / 7z / tar 的 WASM）：同样的做法，独立的带版本缓存 iv-vendor-libarchive-<ver>，第一次打开这类书才存。
const BUILD = '__BUILD__';
const CACHE = 'iv-shell-' + BUILD;
const PDFJS_VER = '4.10.38';                                  // 与 vendor/pdfjs/README.md 一致（build 测试会核对）
const VENDOR_CACHE = 'iv-vendor-pdfjs-' + PDFJS_VER;
const LIBARCHIVE_VER = '2.0.2';                               // 与 vendor/libarchive/README.md 一致（build 测试会核对）
const LIBARCHIVE_CACHE = 'iv-vendor-libarchive-' + LIBARCHIVE_VER;
const SCOPE = new URL('./', self.location).pathname;        // 例如 /iv/
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'];
const SHELL_PATHS = new Set(SHELL.map((p) => new URL(p, self.location).pathname));
const VENDOR_PREFIX = new URL('vendor/pdfjs/', self.location).pathname;
const LIBARCHIVE_PREFIX = new URL('vendor/libarchive/', self.location).pathname;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 逐个加：有一个取不到（比如本地调试时没有 index.html）不该让整个安装失败
    await Promise.all(SHELL.map((p) => c.add(new URL(p, self.location)).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('iv-') && k !== CACHE && k !== VENDOR_CACHE && k !== LIBARCHIVE_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (req.headers.has('range') || req.headers.has('authorization')) return;   // 书本数据 / 带账号的请求：不拦截
  const u = new URL(req.url);
  if (u.origin !== self.location.origin || !u.pathname.startsWith(SCOPE)) return;
  const vcache = u.pathname.startsWith(VENDOR_PREFIX) ? VENDOR_CACHE : u.pathname.startsWith(LIBARCHIVE_PREFIX) ? LIBARCHIVE_CACHE : null;
  if (vcache) {      // pdf.js / libarchive.js：缓存优先（版本固定，内容不会变）；只存 200，取不到就让浏览器自己报错
    e.respondWith((async () => {
      const c = await caches.open(vcache);
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.status === 200) c.put(req, res.clone()).catch(() => {});
      return res;
    })());
    return;
  }
  const isShell = SHELL_PATHS.has(u.pathname);
  if (!isShell && req.mode !== 'navigate') return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      // 网络优先：有网就总是拿最新的外壳；断网才回退到缓存
      const res = await fetch(req);
      if (isShell && res.ok && res.status === 200) c.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const hit = await c.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await c.match(new URL('./', self.location)) : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
