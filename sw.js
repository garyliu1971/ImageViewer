// /iv/ 的 service worker：只缓存应用外壳（页面本身 + manifest + 图标），让页面能离线打开、秒开。
//
// 绝不碰书本数据：同源的 WebDAV（/library/…）、Range 请求、带 Authorization 的请求一律不拦截、不缓存，
// 直接走网络 —— 否则 206 分段会被错误地缓存成整文件，或者把带账号的响应留在缓存里。
// 作用域只有 /iv/（注册时 scope './'，且文件就放在 /iv/ 下）；缓存名前缀 iv-，清理旧缓存时只动 iv- 开头的，
// 不会碰同源 /reader/ 的 pyreader-web-*。
// 部署脚本（deploy/build_iv_static.py）会把 __BUILD__ 换成内容哈希，这样每次发布都会换一个缓存名。
const BUILD = '__BUILD__';
const CACHE = 'iv-shell-' + BUILD;
const SCOPE = new URL('./', self.location).pathname;        // 例如 /iv/
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'];
const SHELL_PATHS = new Set(SHELL.map((p) => new URL(p, self.location).pathname));

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
    await Promise.all(keys.filter((k) => k.startsWith('iv-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (req.headers.has('range') || req.headers.has('authorization')) return;   // 书本数据 / 带账号的请求：不拦截
  const u = new URL(req.url);
  if (u.origin !== self.location.origin || !u.pathname.startsWith(SCOPE)) return;
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
