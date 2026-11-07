// 网页版端到端测试：用真实 Chrome（headless）通过 CDP 打开 file:// 的 image-viewer.html，
// 在页面里合成图片 / 压缩包，验证章节、双页、日漫方向、裁白边、缩放数学、
// 断点续读、快捷键、鼠标手势、cbz 解压、错误提示。
//
// 运行： node tests/web_e2e.mjs          （需要本机 Chrome / Edge，无需 npm 依赖）
//        CHROME=路径 node tests/web_e2e.mjs   可指定浏览器
//        先跑 python tests/make_web_fixtures.py 生成压缩包样本（可选）
//
// Node >= 21：自带 WebSocket / fetch。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import url from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PAGE = path.join(ROOT, 'image-viewer.html');

/* ------------------------- 找浏览器 ------------------------- */
function findChrome() {
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME;
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('找不到 Chrome/Edge，请设置环境变量 CHROME 指向可执行文件');
}

/* ------------------------- 最小 CDP 客户端 ------------------------- */
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(body, tries = 3) {
    for (let i = 0; i < tries; i++) {
      const r = await this.send('Runtime.evaluate', {
        expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true,
      });
      if (!r.exceptionDetails) return r.result.value;
      const desc = r.exceptionDetails.exception?.description || r.exceptionDetails.text || '';
      // 超时后 isolated context 偶尔会被销毁，重试一次
      if (/context was destroyed|not bound/i.test(desc) && i < tries - 1) { await sleep(600); continue; }
      throw new Error('页面异常: ' + desc);
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getJson(port, p) {
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000 }, (r) => {
      let b = '';
      r.on('data', (d) => (b += d));
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    });
    req.on('error', rej);
    req.on('timeout', () => req.destroy(new Error('CDP http 超时')));
  });
}

/* ------------------------- Node 侧造 zip / PNG ------------------------- */
function crc32(buf) {
  let t = crc32._t || (crc32._t = (() => {
    const a = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; a[n] = c; }
    return a;
  })());
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ t[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}
function buildZip(files) {
  const chunks = [], central = [];
  let off = 0;
  for (const { name, data, store } of files) {
    const nb = Buffer.from(name, 'utf8');
    const comp = store ? data : zlib.deflateRawSync(data, { level: 6 });
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(store ? 0 : 8, 8); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nb.length, 26);
    chunks.push(lh, nb, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x800, 8); cd.writeUInt16LE(store ? 0 : 8, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nb.length, 28); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(off, 42);
    central.push(Buffer.concat([cd, nb]));
    off += lh.length + nb.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}
function pngBytes(w, h, hex) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = parseInt(hex.slice(0, 2), 16); raw[o + 1] = parseInt(hex.slice(2, 4), 16); raw[o + 2] = parseInt(hex.slice(4, 6), 16);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/* ------------------------- /iv/ 同源测试服务器（模拟 Caddy + SFTPGo WebDAV）-------------------------
   /iv/…      页面 / manifest / sw.js / 图标，带 deploy/Caddyfile.iv.snippet 里同一条 CSP
   /library/… 书库：Basic 认证 + 真 Range（206）；/library/ignore/… 故意忽略 Range 回 200
   PROPFIND（Depth:1，SFTPGo 风格的 207）：目录从 books 的键推出，S.virtual[目录] 追加假条目（几千个文件的文件夹），
     S.listSlow[目录] 让列目录变慢（测连点时旧请求被 abort），S.denyList=true 让所有请求回 401（账号被禁）。
   记录每个 /library 请求（方法 / 路径 / Range / 是否带 Authorization / 实际发出的字节），供断言。 */
function startIvServer(books) {
  const snippet = fs.readFileSync(path.join(ROOT, 'deploy', 'Caddyfile.iv.snippet'), 'utf8');
  const CSP = (/header Content-Security-Policy "([^"]+)"/.exec(snippet) || [])[1];
  if (!CSP) throw new Error('deploy/Caddyfile.iv.snippet 里没找到 CSP');
  const html = fs.readFileSync(PAGE);
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8').replace('__BUILD__', 'e2e');
  const manifest = fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'));
  const S = { log: [], inflight: 0, maxInflight: 0, user: 'viewer', pass: 'pä ss', hits: [], slow: {}, prog: {}, progLog: [], progDir: false,   // slow: 相对路径 -> 每个请求的延迟 ms（默认 15）
    virtual: {}, listSlow: {}, denyList: false };
  const xesc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const hrefOf = (rel, dir) => '/library/' + rel.split('/').filter(Boolean).map(encodeURIComponent).join('/') + (dir && rel ? '/' : '');
  /** dirRel 这一层的孩子：Map(名字 -> {dir, size})；目录不存在返回 null */
  function listDir(dirRel) {
    const kids = new Map(), pre = dirRel ? dirRel + '/' : '';
    for (const k of Object.keys(books)) {
      if (!k.startsWith(pre)) continue;
      const rest = k.slice(pre.length), i = rest.indexOf('/');
      if (i < 0) kids.set(rest, { dir: false, size: books[k].length });
      else if (!kids.has(rest.slice(0, i))) kids.set(rest.slice(0, i), { dir: true });
    }
    for (const [d, items] of Object.entries(S.virtual)) {
      if (d === dirRel) { for (const it of items) kids.set(it.name, { dir: !!it.dir, size: it.size || 0 }); }
      else if (d.startsWith(pre) && !kids.has(d.slice(pre.length).split('/')[0])) kids.set(d.slice(pre.length).split('/')[0], { dir: true });
    }
    return dirRel === '' || kids.size || S.virtual[dirRel] ? kids : null;
  }
  function propfindXml(dirRel, kids) {
    const one = (rel, dir, size) => '<D:response><D:href>' + xesc(hrefOf(rel, dir)) + '</D:href><D:propstat><D:prop><D:resourcetype>' +
      (dir ? '<D:collection xmlns:D="DAV:"/>' : '') + '</D:resourcetype>' + (dir ? '' : '<D:getcontentlength>' + size + '</D:getcontentlength>') +
      '<D:getlastmodified>Fri, 07 Nov 2026 08:00:00 GMT</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>';
    let out = '<?xml version="1.0" encoding="UTF-8"?><D:multistatus xmlns:D="DAV:">' + one(dirRel, true, 0);
    for (const [name, k] of kids) out += one((dirRel ? dirRel + '/' : '') + name, k.dir, k.size);
    return out + '</D:multistatus>';
  }
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = decodeURIComponent(u.pathname);
    S.hits.push(req.method + ' ' + u.pathname);
    const send = (code, type, body, extra) => {
      res.writeHead(code, Object.assign({ 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) }, extra || {}));
      res.end(body);
    };
    if (p === '/iv/' || p === '/iv/index.html') {
      return send(200, 'text/html; charset=utf-8', html, { 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP,
        'Referrer-Policy': 'no-referrer' });
    }
    if (p === '/iv/sw.js') return send(200, 'text/javascript', sw, { 'Cache-Control': 'no-cache' });
    if (p === '/iv/manifest.webmanifest') return send(200, 'application/manifest+json', manifest);
    if (p.startsWith('/iv/icons/')) {
      const f = path.join(ROOT, 'icons', path.basename(p));
      return fs.existsSync(f) ? send(200, 'image/png', fs.readFileSync(f)) : send(404, 'text/plain', 'no');
    }
    if (p === '/reader/') return send(200, 'text/html; charset=utf-8', '<title>reader</title>reader');
    if (p.startsWith('/library/')) {
      const ent = { method: req.method, path: u.pathname, range: req.headers.range || null,
        auth: !!req.headers.authorization, status: 0, bytes: 0 };
      S.log.push(ent);
      const want = 'Basic ' + Buffer.from(S.user + ':' + S.pass, 'utf8').toString('base64');
      if (req.headers.authorization !== want || S.denyList) {
        ent.status = 401;
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="lib"' }); return res.end('no');
      }
      if (req.method === 'PROPFIND') {
        req.resume();
        ent.depth = req.headers.depth || null;
        res.on('close', () => { if (!res.writableEnded) ent.aborted = true; });     // 客户端中途放弃（abort）
        const dirRel = p.replace(/^\/library\/?/, '').replace(/\/+$/, '');
        setTimeout(() => {
          if (ent.aborted) return;
          const kids = listDir(dirRel);
          if (!kids) { ent.status = 404; return send(404, 'text/plain', 'nf'); }
          ent.status = 207;
          send(207, 'application/xml; charset=utf-8', propfindXml(dirRel, kids));
        }, S.listSlow[dirRel] || 5);
        return;
      }
      const ignore = p.startsWith('/library/ignore/');
      const rel = ignore ? p.slice('/library/ignore/'.length) : p.slice('/library/'.length);
      const data = books[rel];
      if (!data) { ent.status = 404; return send(404, 'text/plain', 'nf'); }
      S.inflight++; S.maxInflight = Math.max(S.maxInflight, S.inflight);
      setTimeout(() => {
        S.inflight--;
        const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
        if (req.method === 'HEAD') { ent.status = 200; res.writeHead(200, { 'Content-Length': data.length }); return res.end(); }
        if (!m || ignore) {
          ent.status = 200; ent.bytes = data.length;
          res.writeHead(200, { 'Content-Length': data.length, 'Content-Type': 'application/octet-stream' }); return res.end(data);
        }
        const a = +m[1], b = Math.min(+m[2], data.length - 1), body = data.subarray(a, b + 1);
        ent.status = 206; ent.bytes = body.length;
        res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': body.length,
          'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes' });
        res.end(body);
      }, S.slow[rel] || 15);
      return;
    }
    /* /users/gary/iv-progress/：进度文件夹（和 PyReader 同一个同步用户目录）。writer 能写；viewer（只读账号）→ 403；其它 → 401。文件夹要先 MKCOL，否则 PUT 回 409（和 SFTPGo 一样） */
    if (p === '/users' || p === '/users/gary' || p.startsWith('/users/gary/iv-progress')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const ent = { method: req.method, path: u.pathname, auth: req.headers.authorization || '', status: 0, body: Buffer.concat(chunks).toString('utf8') };
        S.progLog.push(ent);
        const basic = (n, pw) => 'Basic ' + Buffer.from(n + ':' + pw, 'utf8').toString('base64');
        const a = req.headers.authorization;
        let code = 200, body = '';
        if (a !== basic('writer', 'w pass') && a !== basic(S.user, S.pass)) code = 401;
        else if (a === basic(S.user, S.pass) && req.method !== 'GET' && req.method !== 'PROPFIND') code = 403;
        else if (req.method === 'PROPFIND') {
          const dirp = '/users/gary/iv-progress';
          if (p.replace(/\/+$/, '') !== dirp) code = 404;
          else if (!S.progDir) code = 404;
          else {
            code = 207;
            body = '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>' + dirp + '/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>' +
              Object.keys(S.prog).map((k, i) => '<D:response><D:href>' + k + '</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>' + S.prog[k].length +
                '</D:getcontentlength><D:getlastmodified>' + new Date((S.progMtime && S.progMtime[k]) || Date.now() - i * 1000).toUTCString() + '</D:getlastmodified></D:prop></D:propstat></D:response>').join('') +
              '</D:multistatus>';
          }
        }
        else if (req.method === 'MKCOL') { if (p === '/users/gary/iv-progress') S.progDir = true; code = 201; }
        else if (req.method === 'PUT') { if (!S.progDir) code = 409; else { S.prog[p] = ent.body; code = 201; } }
        else if (req.method === 'GET') { if (S.prog[p] === undefined) code = 404; else body = S.prog[p]; }
        else code = 405;
        ent.status = code;
        send(code, 'application/json', body);
      });
      return;
    }
    send(404, 'text/plain', 'nf');
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    const origin = 'http://127.0.0.1:' + srv.address().port;
    resolve(Object.assign(S, { origin, close: () => srv.close() }));
  }));
}

/* ------------------------- 断言 ------------------------- */
let pass = 0, fail = 0;
const log = (...a) => console.log(...a);
function check(name, ok, detail) {
  if (ok) { pass++; log('  \x1b[32m✔\x1b[0m ' + name); }
  else { fail++; log('  \x1b[31m✘\x1b[0m ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
}

/* ============================ 主流程 ============================ */
(async () => {
  if (!fs.existsSync(PAGE)) throw new Error('找不到 ' + PAGE);
  const exe = findChrome();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-e2e-'));
  log('浏览器：' + exe);
  const proc = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,820',   // 固定桌面尺寸：默认 800×600 会触发“窄屏默认关缩略图”的新默认值
    '--disable-extensions', '--mute-audio', '--user-data-dir=' + profile,
    '--remote-debugging-port=0', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));

  let port = 0;
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 120 && !port; i++) {
    await sleep(250);
    try { port = parseInt(fs.readFileSync(portFile, 'utf8').split('\n')[0], 10); } catch (e) { /* 还没起来 */ }
  }
  if (!port) { proc.kill(); throw new Error('Chrome 没起来：\n' + stderr.slice(-1500)); }

  let ws, cdp;
  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(200);
      const list = await getJson(port, '/json/list').catch(() => null);
      target = list && list.find((t) => t.type === 'page');
    }
    if (!target) throw new Error('拿不到 CDP page target');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('ws 连接失败（新版 Chrome 可能需要 --remote-allow-origins=*）')));
    });
    cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: url.pathToFileURL(PAGE).href });
    await sleep(1500);

    /* 页面内工具函数 */
    const HELPERS = `
      window.__mk = (name, path, w, h, o) => {
        o = o || {};
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        const x = cv.getContext('2d');
        x.fillStyle = o.bg || '#ffffff'; x.fillRect(0, 0, w, h);
        if (o.rect) { x.fillStyle = o.rect; x.fillRect(o.rectX||0, o.rectY||0, o.rectW||w, o.rectH||h); }
        return new Promise((res) => cv.toBlob((b) => res({
          kind: 'file', file: new File([b], name, { type: 'image/png' }), name, path, size: b.size }), 'image/png'));
      };
      window.__wait = (ms) => new Promise(r => setTimeout(r, ms));
      window.__tick = async () => { for (let i = 0; i < 45; i++) await new Promise(r => setTimeout(r, 20)); };
      window.__force = async (key, want) => {
        const iv = window.__IV;
        for (let i = 0; i < 4; i++) {
          const cur = key === 'direction' ? (iv.state().S.direction === 'rtl') : iv.state().S[key];
          if (cur === want) break;
          if (key === 'direction') iv.toggleDirection(); else iv.toggleMode(key, key);
          await __tick();
        }
        await __tick();
        return window.__IV.state().S;
      };
      window.__domPages = () => document.querySelectorAll('#pageBox .page').length;
      return true;
    `;
    await cdp.eval(HELPERS);

    log('\n[1] 启动 / 界面骨架');
    const boot = await cdp.eval(`
      return {
        hasCore: !!window.IVCore && !!window.__IV,
        start: !document.querySelector('#start').classList.contains('hidden'),
        toolbar: !!document.querySelector('#btnSpread') && !!document.querySelector('#zoomSlider'),
        chapterBarHidden: !document.querySelector('#chapterBar').classList.contains('show'),
        statusText: document.querySelector('#statusText').textContent,
        helpRows: document.querySelectorAll('#help table tr').length,
      };
    `);
    check('IVCore + __IV 已挂载', boot.hasCore, boot);
    check('开始页可见、章节条隐藏', boot.start && boot.chapterBarHidden, boot);
    check('状态栏初始文案「未打开」', /未打开/.test(boot.statusText), boot);
    check('帮助表有条目', boot.helpRows >= 12, boot);

    log('\n[2] 打开文件夹：子目录 -> 章节（修复「只取顶层文件」）');
    const folder = await cdp.eval(`
      const items = [];
      items.push(await __mk('00_cover.png', 'book/00_cover.png', 200, 120, {rect:'#111', rectW:200, rectH:120}));
      for (let i=1;i<=3;i++) items.push(await __mk('0'+i+'.png','book/第2话/0'+i+'.png',120,200,{rect:'#0a0',rectW:120,rectH:200}));
      for (let i=1;i<=2;i++) items.push(await __mk('0'+i+'.png','book/第10话/0'+i+'.png',120,200,{rect:'#00a',rectW:120,rectH:200}));
      items.push(await __mk('notes.txt','book/notes.txt',10,10));
      items.push(await __mk('scan.tif','book/scan.tif',10,10));
      window.__IV.openItems(items, { kind:'dir', title:'book' });
      await __tick();
      return window.__IV.state();
    `);
    check('章节「根目录」在最前 + 自然排序',
      JSON.stringify(folder.chapters.map((c) => c.title)) === JSON.stringify(['根目录', '第2话', '第10话']), folder.chapters);
    check('章节页数 1/3/2', JSON.stringify(folder.chapters.map((c) => c.n)) === '[1,3,2]', folder.chapters);
    check('总页数 6', folder.total === 6, folder);
    check('先加载根目录章节（1 页）', folder.pages === 1, folder);
    check('非图片/tif 被跳过并计数', folder.skipped.length === 2, folder.skipped);
    check('章节条已显示', await cdp.eval(`return document.querySelector('#chapterBar').classList.contains('show')`));
    check('解码出真实像素（不是占位 800×600）', folder.decoded[0].w === 200 && folder.decoded[0].h === 120, folder.decoded[0]);
    check('标题/进度 key 生成', /book/.test(folder.bookTitle) && /^dir:[0-9a-f]{8}:6$/.test(folder.bookKey), folder);

    log('\n[3] 章节切换');
    const ch = await cdp.eval(`
      window.__IV.switchChapter(2); await __tick();
      const s2 = window.__IV.state();
      window.__IV.switchChapter(1); await __tick();
      const s1 = window.__IV.state();
      const opt = document.querySelector('#chapterSel').value;
      return { s2, s1, opt };
    `);
    check('切到第 10 话 -> 2 页', ch.s2.chapterIndex === 2 && ch.s2.pages === 2, ch.s2);
    check('切回第 2 话 -> 3 页', ch.s1.chapterIndex === 1 && ch.s1.pages === 3, ch.s1);
    check('下拉框同步', ch.opt === '1', ch);

    log('\n[4] 双页模式');
    const spread = await cdp.eval(`
      const it = [];
      it.push(await __mk('1.png','sp/1.png',300,100,{rect:'#333',rectW:300,rectH:100}));   // 横
      it.push(await __mk('2.png','sp/2.png',100,300,{rect:'#333',rectW:100,rectH:300}));   // 竖
      it.push(await __mk('3.png','sp/3.png',100,300,{rect:'#444',rectW:100,rectH:300}));   // 竖
      it.push(await __mk('4.png','sp/4.png',100,300,{rect:'#555',rectW:100,rectH:300}));   // 竖
      it.push(await __mk('5.png','sp/5.png',300,100,{rect:'#666',rectW:300,rectH:100}));   // 横
      window.__IV.openItems(it, { kind:'dir', title:'sp' });
      await __force('spread', true); await __force('trim', false); await __force('compare', false);
      await __force('direction', false);
      window.__IV.showPage(0); await __tick();
      const s0 = window.__IV.state(), d0 = __domPages();
      window.__IV.showPage(1); await __tick();
      const s1 = window.__IV.state(), d1 = __domPages();
      const spreadCls = document.querySelector('#pageBox').classList.contains('spread');
      const rtlCls = document.querySelector('#pageBox').classList.contains('rtl');
      window.__IV.next(); await __tick();
      const s2 = window.__IV.state();
      window.__IV.prev(); await __tick();
      const s3 = window.__IV.state();
      await __force('spread', false);
      window.__IV.showPage(1); await __tick();
      const s4 = window.__IV.state(), d4 = __domPages();
      await __force('spread', true);
      return { s0, d0, s1, d1, s2, s3, s4, d4, spreadCls, rtlCls };
    `);
    check('横图 -> 单页', spread.s0.pair.length === 1 && spread.d0 === 1, spread.s0.pair);
    check('竖图 + 下一页竖图 -> 并排', spread.s1.pair.length === 2 && spread.d1 === 2, { pair: spread.s1.pair, d: spread.d1 });
    check('并排时加 spread 类（书脊阴影）、ltr 不加 rtl 类', spread.spreadCls && !spread.rtlCls, spread);
    check('双页时 next() 跳 2 页', spread.s1.index === 1 && spread.s2.index === 3, { a: spread.s1.index, b: spread.s2.index });
    check('下一页是横图 -> 退回单页', spread.s2.pair.length === 1, spread.s2.pair);
    check('prev() 按当前并排状态退步', spread.s3.index === 2, spread.s3.index);
    check('关掉双页后总是单页', spread.s4.pair.length === 1 && spread.d4 === 1, { pair: spread.s4.pair, d: spread.d4 });

    log('\n[4b] 双页时适配用合并尺寸');
    const fit2 = await cdp.eval(`
      const vw = document.querySelector('#viewport').clientWidth, vh = document.querySelector('#viewport').clientHeight;
      window.__IV.showPage(1); await __tick();
      window.__IV.applyFit('window');
      return { z: window.__IV.state().zoom, want: Math.min(vw/200, vh/300), pair: window.__IV.state().pair };
    `);
    check('两张 100×300 并排 -> 按 200×300 适配', Math.abs(fit2.z - fit2.want) < 1e-6, fit2);

    log('\n[5] 日漫右→左 + 对比模式');
    const rtl = await cdp.eval(`
      window.__IV.showPage(1); await __tick();
      await __force('direction', true);
      const rtlOn = document.querySelector('#pageBox').classList.contains('rtl');
      const btnOn = document.querySelector('#btnDir').classList.contains('on');
      const order = [...document.querySelectorAll('#pageBox .page img')].map(i => i.src.slice(-8));
      await __force('direction', false);
      const ltrOn = document.querySelector('#pageBox').classList.contains('rtl');
      await __force('compare', true);
      window.__IV.showPage(0); await __tick();
      const cmp = window.__IV.state(), cmpD = __domPages();
      await __force('compare', false);
      return { rtlOn, btnOn, ltrOn, cmpPair: cmp.pair, cmpD, order };
    `);
    check('M -> DOM 加 rtl 类 + 按钮高亮', rtl.rtlOn && rtl.btnOn, rtl);
    check('再按 M 回到左→右', rtl.ltrOn === false, rtl);
    check('对比模式无条件并排（第 0 页是横图也并排）', rtl.cmpPair.length === 2 && rtl.cmpD === 2, rtl);

    log('\n[6] 裁白边');
    const trim = await cdp.eval(`
      const it = [await __mk('p1.png','t/p1.png',400,300,{rect:'#000', rectX:100, rectY:80, rectW:200, rectH:140})];
      window.__IV.openItems(it, { kind:'dir', title:'trimbook' });
      await __force('trim', false); await __force('spread', false);
      window.__IV.showPage(0); await __tick();
      const off = window.__IV.state();
      await __force('trim', true);
      const on = window.__IV.state();
      const box = document.querySelector('#pageBox .page');
      const img = box && box.querySelector('img');
      return { off: off.crop, crop: on.crop, domW: box && box.offsetWidth, domH: box && box.offsetHeight,
               imgLeft: img && parseFloat(img.style.left), status: document.querySelector('#statusText').textContent };
    `);
    check('未开去边时 crop 为空', trim.off === null, trim.off);
    check('crop 接近 Pillow _trim_white 结果 (96,76)-(304,224)',
      trim.crop && trim.crop.l >= 92 && trim.crop.l <= 101 && trim.crop.t >= 72 && trim.crop.t <= 81 &&
      (trim.crop.r - trim.crop.l) >= 199 && (trim.crop.r - trim.crop.l) <= 217 &&
      (trim.crop.b - trim.crop.t) >= 139 && (trim.crop.b - trim.crop.t) <= 157, trim.crop);
    check('DOM 页面尺寸 = 裁剪后尺寸', trim.domW === trim.crop.r - trim.crop.l && trim.domH === trim.crop.b - trim.crop.t, trim);
    check('图片按裁剪偏移定位', Math.abs(trim.imgLeft + (trim.crop.l)) <= 1, trim);
    check('状态栏标出「已去边」', /已去边/.test(trim.status), trim.status);

    log('\n[7] 缩放 / 适应 / 旋转（对齐 viewer_core）');
    const geo = await cdp.eval(`
      const it = [];
      for (let i=1;i<=3;i++) it.push(await __mk('g'+i+'.png','geo/g'+i+'.png',200,140,{rect:'#123',rectW:200,rectH:140}));
      window.__IV.openItems(it, { kind:'dir', title:'geo' });
      await __force('trim', false); await __force('spread', false); await __force('direction', false);
      window.__IV.showPage(0); await __tick();
      const vw = document.querySelector('#viewport').clientWidth, vh = document.querySelector('#viewport').clientHeight;
      window.__IV.applyFit('window');
      const z1 = window.__IV.state().zoom, want1 = Math.min(vw/200, vh/140);
      window.__IV.applyFit('width'); const z2 = window.__IV.state().zoom, want2 = vw/200;
      window.__IV.applyFit('height'); const z2b = window.__IV.state().zoom, want2b = vh/140;
      window.__IV.applyFit('actual'); const z3 = window.__IV.state().zoom;
      window.__IV.zoomAt(vw/2, vh/2, 2);
      const st = window.__IV.state();
      const labelAtZoom = document.querySelector('#zoomInfo').textContent;
      const slider = document.querySelector('#zoomSlider').value;
      // 拖拽过界后平移被钳制（clamp_pan）
      const sliderWant = window.IVCore.zoomSliderPos(2);   // 当前倍率 = 实际大小 1 × 2
      window.__IV.zoomAt(vw / 2, vh / 2, 4);
      const vp0 = document.querySelector('#viewport');
      const r0 = vp0.getBoundingClientRect();
      const pe = (type, x, y, buttons) => vp0.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 77, pointerType: 'mouse',
        clientX: x, clientY: y, buttons: buttons | 0 }));
      pe('pointerdown', r0.left + r0.width / 2, r0.top + r0.height / 2, 1);
      pe('pointermove', r0.left + r0.width / 2 + 9000, r0.top + r0.height / 2 + 9000, 1);
      pe('pointerup', r0.left + r0.width / 2 + 9000, r0.top + r0.height / 2 + 9000, 0);
      const panned = window.__IV.state();
      const zBig = panned.zoom;
      const bound = window.IVCore.clampPan(99999, -99999, vw, vh, 200 * zBig, 140 * zBig, 1);
      // 实际大小：DOM 按源像素排版（不是 0×0）
      window.__IV.applyFit('actual'); await __tick();
      const pageEl = document.querySelector('#pageBox .page');
      const imgEl = document.querySelector('#pageBox .page img');
      const actual = { boxW: pageEl && pageEl.offsetWidth, boxH: pageEl && pageEl.offsetHeight,
                       imgW: imgEl && imgEl.clientWidth, imgH: imgEl && imgEl.clientHeight,
                       visW: imgEl && Math.round(imgEl.getBoundingClientRect().width) };
      window.__IV.applyFit('window'); await __tick();
      window.__IV.showPage(1); await __tick();
      const afterPage = window.__IV.state().fitMode;
      window.__IV.rotateBy(90);
      const rot = window.__IV.state();
      const rw = window.IVCore.rotatedSize(200, 140, 90);
      const rotWant = Math.min(vw/rw.w, vh/rw.h);
      window.__IV.applyFit('window');
      const rotZ = window.__IV.state().zoom;
      window.__IV.zoomAt(5, 5, 500);
      const clamped = window.__IV.state().zoom;
      window.__IV.applyFit('window'); await __tick();
      return { z1, want1, z2, want2, z2b, want2b, z3, custom: st.fitMode, z4: st.zoom, labelAtZoom,
               slider, sliderWant, afterPage, rot: rot.rotation, fitAfterRot: rot.fitMode, rotZ, rotWant,
               clamped, zoomLabel: document.querySelector('#zoomInfo').textContent, vw, vh,
               panX: panned.panX, panY: panned.panY, wantPanX: bound.x, wantPanY: bound.y, actual };
    `);
    check('适应窗口 = min(vw/w, vh/h)', Math.abs(geo.z1 - geo.want1) < 1e-6, geo);
    check('适应宽度 = vw/w', Math.abs(geo.z2 - geo.want2) < 1e-6, geo);
    check('适应高度 = vh/h', Math.abs(geo.z2b - geo.want2b) < 1e-6, geo);
    check('实际大小 = 100%', Math.abs(geo.z3 - 1) < 1e-9, geo);
    check('手动缩放 -> fitMode=custom 且 ×2（基于实际大小）',
      geo.custom === 'custom' && Math.abs(geo.z4 - 2 * geo.z3) < 1e-6, geo);
    check('百分比标签跟随', geo.labelAtZoom === Math.round(geo.z4 * 100) + '%', geo);
    check('缩放滑块跟随（对数刻度）', +geo.slider === geo.sliderWant, geo);
    check('换页时 custom 复位 window（同桌面版）', geo.afterPage === 'window', geo);
    check('旋转 90° -> custom + 适配按宽高互换', geo.rot === 90 && geo.fitAfterRot === 'custom' && Math.abs(geo.rotZ - geo.rotWant) < 1e-6, geo);
    check('缩放钳到上限 4000%', Math.abs(geo.clamped - 40) < 1e-9, geo);
    check('拖拽过界后平移被钳制', Math.abs(geo.panX - geo.wantPanX) < 1 && geo.wantPanX > 0, geo);
    check('实际大小时 DOM 按源像素排版（不是 0×0）',
      geo.actual.boxW === 200 && geo.actual.imgW === 200 && geo.actual.visW === 200 && geo.actual.boxH === 140, geo.actual);

    log('\n[8] 自动翻页 + 间隔调节');
    const auto = await cdp.eval(`
      const iv = window.__IV;
      iv.showPage(0); await __tick();
      document.dispatchEvent(new KeyboardEvent('keydown', {key: ']', bubbles:true}));
      const iv2 = iv.state().S.autoInterval;
      document.dispatchEvent(new KeyboardEvent('keydown', {key: '[', bubbles:true}));
      const iv3 = iv.state().S.autoInterval;
      iv.setAuto(true);
      await __wait(300);
      const on = iv.state().autoOn;
      const btn = document.querySelector('#btnAuto').classList.contains('on');
      const status = document.querySelector('#statusText').textContent;
      const i0 = iv.state().index;
      await __wait(3400);
      const advanced = iv.state().index > i0;
      iv.setAuto(false);
      await __force('book', false);
      return { iv2, iv3, on, btn, status, advanced, autoInterval: iv.state().S.autoInterval };
    `);
    check('] 间隔 +0.5s / [ 回到 3s', auto.iv2 === 3.5 && auto.iv3 === 3, auto);
    check('A 开自动翻页 + 按钮高亮 + 状态栏显示', auto.on && auto.btn && /自动 3s/.test(auto.status), auto);
    check('3 秒后自动翻页', auto.advanced, auto);

    log('\n[9] 断点续读（localStorage）');
    const prog = await cdp.eval(`
      const iv = window.__IV;
      const mk = () => Promise.all([1,2,3,4,5].map(i => __mk('p'+i+'.png','resume/p'+i+'.png',100,300,{rect:'#0'+(i+100)+'0',rectW:100,rectH:300})));
      iv.openItems(await mk(), { kind:'dir', title:'resume' });
      await __force('trim', false); await __force('direction', false);
      iv.showPage(3); await __tick();
      iv.saveProgress();
      const s = iv.state();
      const stored = JSON.parse(localStorage.getItem('iv.books.v1') || '{}');
      const rec = stored[s.bookKey];
      iv.openItems(await mk(), { kind:'dir', title:'resume' });
      await __tick();
      const after = iv.state();
      return { key: s.bookKey, rec, afterIndex: after.index, sameKey: after.bookKey === s.bookKey,
               uiPref: !!localStorage.getItem('iv.ui.v1'), dir: after.S.direction };
    `);
    check('进度写入 localStorage', prog.rec && prog.rec.index === 3, prog.rec);
    check('进度记录含章节 / 模式 / 适配', prog.rec && prog.rec.fit && prog.rec.spread !== undefined && prog.rec.chapter === 0, prog.rec);
    check('重开同一本 -> 续到第 4 页', prog.afterIndex === 3 && prog.sameKey, prog);
    check('UI 偏好独立持久化', prog.uiPref, prog);

    log('\n[10] 键盘快捷键');
    const keys = await cdp.eval(`
      const it = [];
      for (let i=1;i<=5;i++) it.push(await __mk('k'+i+'.png','keys/k'+i+'.png',100+i*10,300,{rect:'#345',rectW:100,rectH:300}));
      window.__IV.openItems(it, { kind:'dir', title:'keys' });
      await __force('trim', false); await __force('book', false); await __force('compare', false);
      await __force('spread', true); await __force('direction', false);
      const press = (k, opt) => document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key:k, bubbles:true }, opt||{})));
      const iv = window.__IV;
      iv.showPage(0); await __tick();
      const out = {};
      press('ArrowRight'); await __tick(); out.right = iv.state().index;
      press('PageUp'); await __tick(); out.pgup = iv.state().index;
      press('End'); await __tick(); out.end = iv.state().index;
      press('Home'); await __tick(); out.home = iv.state().index;
      press(' '); await __tick(); out.space = iv.state().index;
      press('2'); out.fit2 = iv.state().fitMode;
      press('3'); out.fit3 = iv.state().fitMode;
      press('1'); out.fit1 = iv.state().fitMode;
      press('0'); out.fit0 = iv.state().fitMode;
      press('r'); out.rot = iv.state().rotation;
      press('R', { shiftKey:true }); out.rotBack = iv.state().rotation;
      const bSpread = iv.state().S.spread; press('d'); out.d = (iv.state().S.spread !== bSpread);
      const bTrim = iv.state().S.trim; press('c'); out.c = (iv.state().S.trim !== bTrim);
      const bBook = iv.state().S.book; press('b'); out.b = (iv.state().S.book !== bBook);
      out.bookClass = document.body.classList.contains('book-on');
      const bDir = iv.state().S.direction; press('m'); out.m = (iv.state().S.direction !== bDir);
      press('c'); press('b'); press('d');
      const pages = iv.state().total;
      press('g'); out.jumpOpen = !document.querySelector('#jump').classList.contains('hidden');
      out.jumpHint = document.querySelector('#jumpHint').textContent.indexOf(String(pages)) >= 0;
      press('Escape'); out.jumpClosed = document.querySelector('#jump').classList.contains('hidden');
      press('i'); out.detailOpen = !document.querySelector('#detail').classList.contains('hidden');
      out.detailRows = document.querySelectorAll('#detailTable tr').length;
      press('Escape');
      press('?'); out.helpOpen = !document.querySelector('#help').classList.contains('hidden');
      press('Escape'); out.helpClosed = document.querySelector('#help').classList.contains('hidden');
      press('t'); out.thumbsHidden = document.querySelector('#thumbs').classList.contains('hidden');
      press('t');
      const sp0 = iv.state().S.spread, tr0 = iv.state().S.trim;
      press('d', { ctrlKey:true }); press('c', { metaKey:true }); press('t', { altKey:true });
      out.modKeysIgnored = iv.state().S.spread === sp0 && iv.state().S.trim === tr0 &&
        !document.querySelector('#thumbs').classList.contains('hidden');
      press('n'); await __tick(); out.chapterKey = iv.state().chapterIndex;
      return out;
    `);
    check('→ / PageUp（双页步长 2）', keys.right === 2 && keys.pgup === 0, keys);
    check('Home / End / 空格', keys.home === 0 && keys.end === 4 && keys.space === 2, keys);
    check('0/1/2/3 切 fit', keys.fit2 === 'width' && keys.fit3 === 'height' && keys.fit1 === 'actual' && keys.fit0 === 'window', keys);
    check('R / Shift+R 旋转 90 → 0', keys.rot === 90 && keys.rotBack === 0, keys);
    check('D / C / B / M 都能切', keys.d && keys.c && keys.b && keys.m && keys.bookClass, keys);
    check('G 弹跳页框且提示总页数', keys.jumpOpen && keys.jumpHint, keys);
    check('I 详情弹窗（多行）/ Esc 关闭', keys.detailOpen && keys.detailRows > 12 && keys.jumpClosed && keys.helpClosed, keys);
    check('? 开帮助、Esc 关', keys.helpOpen && keys.helpClosed, keys);
    check('T 切缩略图条', keys.thumbsHidden === true, keys);
    check('单章节书按 N 不报错', keys.chapterKey === 0, keys);
    check('Ctrl/Cmd/Alt 组合键不触发看图操作', keys.modKeysIgnored === true, keys);

    log('\n[10b] 竖屏窄窗口不并排双页，横过来恢复');
    const spreadGate = {};
    for (const [label, w, h] of [['portrait', 390, 844], ['landscape', 1280, 820]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      spreadGate[label] = await cdp.eval(`
        const iv = window.__IV;
        await __force('spread', true); await __force('compare', false);
        await new Promise(r => setTimeout(r, 150));
        iv.showPage(0); await __tick();
        return { spread: iv.state().S.spread, dom: __domPages() };`);
    }
    check('竖屏 390×844：S.spread 仍为开，但只渲染 1 页', spreadGate.portrait.spread === true && spreadGate.portrait.dom === 1, spreadGate);
    check('横屏 1280×820：并排 2 页', spreadGate.landscape.dom === 2, spreadGate);

    log('\n[11] 鼠标 / 触控手势');
    const mouse = await cdp.eval(`
      const iv = window.__IV;
      await __force('spread', true); await __force('direction', false); await __force('compare', false);
      iv.showPage(0); await __tick();
      const vp = document.querySelector('#viewport');
      const r = vp.getBoundingClientRect();
      const pe = (type, x, y, extra) => vp.dispatchEvent(new PointerEvent(type, Object.assign({
        bubbles:true, cancelable:true, pointerId:1, pointerType:'mouse', isPrimary:true,
        clientX:x, clientY:y, button:0, buttons: type==='pointerdown'?1:0 }, extra||{})));
      const clickAt = async (fx) => {
        const x = r.left + r.width * fx, y = r.top + r.height / 2;
        pe('pointerdown', x, y); pe('pointerup', x, y);
        await __wait(430);
      };
      const out = { start: iv.state().index };
      await clickAt(0.95); out.afterRightEdge = iv.state().index;
      await clickAt(0.05); out.afterLeftEdge = iv.state().index;
      await __force('direction', true);
      await clickAt(0.05); out.rtlLeft = iv.state().index;
      await __force('direction', false);
      const y0 = r.top + r.height / 2;
      pe('pointerdown', r.left + r.width / 2, y0);
      pe('pointermove', r.left + r.width / 2 - 220, y0, { buttons: 1 });
      pe('pointerup', r.left + r.width / 2 - 220, y0);
      await __wait(80);
      out.afterSwipe = iv.state().index;
      // 双指捏合
      iv.showPage(0); await __tick();
      const z0 = iv.state().zoom;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const pp = (type, id, x, y, buttons) => vp.dispatchEvent(new PointerEvent(type, { bubbles:true, cancelable:true,
        pointerId:id, pointerType:'touch', clientX:x, clientY:y, buttons:buttons|0 }));
      pp('pointerdown', 11, cx - 40, cy, 1); pp('pointerdown', 12, cx + 40, cy, 1);
      pp('pointermove', 11, cx - 140, cy, 1); pp('pointermove', 12, cx + 140, cy, 1);
      pp('pointerup', 11, cx - 140, cy, 0); pp('pointerup', 12, cx + 140, cy, 0);
      await __wait(80);
      out.pinchZoom = iv.state().zoom > z0 * 1.5;
      // 滚轮 / 触控板
      const zw = iv.state().zoom;
      vp.dispatchEvent(new WheelEvent('wheel', { bubbles:true, cancelable:true, deltaY:-240, clientX:cx, clientY:cy }));
      out.wheelIn = iv.state().zoom > zw && iv.state().fitMode === 'custom';
      vp.dispatchEvent(new WheelEvent('wheel', { bubbles:true, cancelable:true, deltaY:400, ctrlKey:true, clientX:cx, clientY:cy }));
      out.ctrlWheelOut = iv.state().zoom < zw;
      const i0 = iv.state().index;
      vp.dispatchEvent(new WheelEvent('wheel', { bubbles:true, cancelable:true, deltaX:90, deltaY:2, clientX:cx, clientY:cy }));
      await __wait(80);
      out.hwheelPaged = iv.state().index !== i0;
      // 双击：非 custom 时去实际大小（同桌面版分支）；custom 时回适应窗口
      iv.applyFit('window'); await __wait(30);
      const zWin = iv.state().zoom;
      vp.dispatchEvent(new MouseEvent('dblclick', { bubbles:true, clientX:cx, clientY:cy }));
      out.dblActual = iv.state().fitMode;
      out.dblZoom1 = iv.state().zoom;
      iv.zoomAt(cx, cy, 3);            // 变成 custom
      vp.dispatchEvent(new MouseEvent('dblclick', { bubbles:true, clientX:cx, clientY:cy }));
      out.dblBack = iv.state().fitMode === 'window' && Math.abs(iv.state().zoom - zWin) < 1e-6;
      // 单击中间隐工具栏
      await clickAt(0.5);
      out.uiHidden = document.body.classList.contains('ui-hidden');
      await clickAt(0.5);
      out.uiShown = !document.body.classList.contains('ui-hidden');
      return out;
    `);
    check('点右边缘下一页（双页 +2）', mouse.afterRightEdge === 2, mouse);
    check('点左边缘上一页', mouse.afterLeftEdge === 0, mouse);
    check('日漫模式左边缘 = 下一页', mouse.rtlLeft === 2, mouse);
    check('快滑翻页', mouse.afterSwipe === 2 || mouse.afterSwipe === 4, mouse);
    check('双指捏合放大', mouse.pinchZoom, mouse);
    check('滚轮放大 / Ctrl 滚轮缩小', mouse.wheelIn && mouse.ctrlWheelOut, mouse);
    check('触控板横滚翻页', mouse.hwheelPaged, mouse);
    check('双击 = 实际大小（同桌面版 else 分支）', mouse.dblActual === 'actual' && Math.abs(mouse.dblZoom1 - 1) < 1e-9, mouse);
    check('手动缩放后双击 = 回适应窗口', mouse.dblBack === true, mouse);
    check('单击中间 隐藏 / 再单击 显示工具栏', mouse.uiHidden && mouse.uiShown, mouse);

    log('\n[12] 跳页 / 详情 / 纸质质感叠加层');
    const ui = await cdp.eval(`
      const iv = window.__IV;
      iv.showPage(0); await __tick();
      document.querySelector('#pageInfo').click();   // 点页码 = 跳页
      document.querySelector('#jumpInput').value = '5';
      document.querySelector('#jumpOk').click();
      await __tick();
      const jumped = iv.state().index;
      document.querySelector('#btnDetail').click();
      const txt = document.querySelector('#detailTable').textContent;
      const detailVisible = !document.querySelector('#detail').classList.contains('hidden');
      document.querySelector('#detail').classList.add('hidden');
      await __force('book', true);
      const fx = document.querySelector('#bookFx');
      const cs = getComputedStyle(fx);
      const grain = document.querySelector('#grain');
      const out = { jumped, detailVisible, hasKey: /进度 key/.test(txt), hasMode: /模式/.test(txt),
        hasPath: /压缩包内路径|路径/.test(txt),
        bodyOn: document.body.classList.contains('book-on'),
        fxDisplay: cs.display, fxBlend: cs.mixBlendMode, fxLayers: (cs.backgroundImage.match(/gradient/g)||[]).length,
        grainImg: (grain.style.backgroundImage||'').indexOf('data:image/png') >= 0,
        spreadAfter: iv.state().S.spread };
      await __force('book', false);
      return out;
    `);
    check('跳页到第 5 页', ui.jumped === 4, ui);
    check('详情含路径 / 模式 / 进度 key', ui.detailVisible && ui.hasKey && ui.hasMode && ui.hasPath, ui);
    check('纸质质感 = multiply 叠加层（渐变 + 噪点）',
      ui.bodyOn && ui.fxDisplay === 'block' && ui.fxBlend === 'multiply' && ui.fxLayers >= 3 && ui.grainImg, ui);

    log('\n[13] cbz 压缩包（File.slice + 原生 DecompressionStream）');
    const zipBuf = buildZip([
      { name: 'cover.png', data: pngBytes(120, 80, '226688'), store: true },
      { name: '第2话/01.png', data: pngBytes(100, 160, '112233'), store: false },
      { name: '第2话/02.png', data: pngBytes(100, 160, '445566'), store: false },
      { name: '第10话/01.png', data: pngBytes(100, 160, '778899'), store: false },
      { name: '__MACOSX/._cover.png', data: Buffer.from('junk'), store: true },
      { name: '.DS_Store', data: Buffer.from('junk'), store: true },
      { name: 'readme.txt', data: Buffer.from('not an image'), store: true },
      { name: 'scan.pdf', data: Buffer.from('%PDF-1.4'), store: true },
    ]);
    const zipRes = await cdp.eval(`
      const bin = atob('${zipBuf.toString('base64')}');
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      window.__IV.openZipFile(new File([u8], '我的漫画.cbz', { type: 'application/zip' }));
      await __tick(); await __tick();
      const s = window.__IV.state();
      const srcOk = [...document.querySelectorAll('#pageBox .page img')].every(i => i.complete && i.naturalWidth > 0);
      window.__IV.switchChapter(1); await __tick();
      const s2 = window.__IV.state();
      const ok2 = [...document.querySelectorAll('#pageBox .page img')].every(i => i.complete && i.naturalWidth > 0);
      window.__IV.switchChapter(2); await __tick();
      const s3 = window.__IV.state();
      window.__IV.showPage(0);
      return { s, s2, s3, srcOk, ok2, domW: document.querySelector('#pageBox .page').offsetWidth };
    `);
    const zs = zipRes.s;
    check('cbz 解出 4 张图（跳过 junk/txt/pdf）', zs.total === 4, zs);
    check('压缩包内子目录 -> 章节', JSON.stringify((zs.chapters || []).map((c) => c.title)) === JSON.stringify(['根目录', '第2话', '第10话']), zs.chapters);
    check('store 条目能显示', zipRes.srcOk, zipRes.srcOk);
    check('解压位图尺寸正确 120×80', zs.decoded[0] && zs.decoded[0].w === 120 && zs.decoded[0].h === 80, zs.decoded[0]);
    check('deflate 条目能显示（第2话 2 页）', zipRes.s2.pages === 2 && zipRes.ok2, { s2: zipRes.s2.pages, ok: zipRes.ok2 });
    check('deflate 位图尺寸 100×160', zipRes.s2.decoded[0].w === 100 && zipRes.s2.decoded[0].h === 160, zipRes.s2.decoded[0]);
    check('zip 文件名作为书名 / key 前缀', /我的漫画/.test(zs.bookTitle) && /^zip:/.test(zs.bookKey), zs);
    check('第10话 1 页', zipRes.s3.pages === 1, zipRes.s3.pages);

    log('\n[14] 缩略图（懒生成小 canvas，不再常驻全尺寸 img）');
    const th = await cdp.eval(`
      const s = window.__IV.state();
      const nodes = document.querySelectorAll('#thumbs .thumb');
      return { thumbs: s.thumbs, nodes: nodes.length,
               canvases: document.querySelectorAll('#thumbs .thumb canvas').length,
               anyFullImg: !!document.querySelector('#thumbs .thumb img'),
               heights: [...document.querySelectorAll('#thumbs .thumb canvas')].slice(0,3).map(c => c.height) };
    `);
    check('每页一个缩略图节点', th.nodes === th.thumbs && th.nodes >= 1, th);
    check('缩略图是 canvas 而非全尺寸 <img>', th.anyFullImg === false && th.canvases >= 1, th);
    check('缩略图高度固定 80px（省内存）', th.heights.length > 0 && th.heights.every((h) => h === 80), th);

    log('\n[15] 错误处理');
    const err = await cdp.eval(`
      const clear = () => { const t = document.querySelector('#toast'); t.classList.remove('show'); t.textContent=''; };
      const out = {};
      clear();
      window.__IV.openItems([{kind:'file', name:'broken.png', path:'broken.png', size:5,
        file:new File([new Uint8Array([1,2,3,4,5])],'broken.png',{type:'image/png'})}], {kind:'files', title:'bad'});
      await __tick(); out.t1 = document.querySelector('#toast').textContent;
      clear();
      window.__IV.openItems([{kind:'file', name:'scan.tif', path:'scan.tif', size:5,
        file:new File([new Uint8Array([1,2,3])],'scan.tif')}], {kind:'files', title:'tif'});
      await __tick(); out.t2 = document.querySelector('#toast').textContent;
      clear();
      window.__IV.openItems([{kind:'file', name:'comic.rar', path:'comic.rar', size:5,
        file:new File([new Uint8Array([1,2,3])],'comic.rar')}], {kind:'files', title:'rar'});
      await __tick(); out.t3 = document.querySelector('#toast').textContent;
      clear();
      window.__IV.openZipFile(new File([new Uint8Array(64).fill(65)], 'x.cbz'));
      await __tick(); out.t4 = document.querySelector('#toast').textContent;
      clear();
      window.__IV.openZipFile(new File([new Uint8Array(30).fill(66)], 'y.cbz'));
      await __tick(); out.t5 = document.querySelector('#toast').textContent;
      clear();
      window.__IV.openItems([], {kind:'files', title:'empty'});
      await __tick(); out.t6 = document.querySelector('#toast').textContent;
      return out;
    `);
    check('坏图给出加载失败提示', /失败|无法/.test(err.t1), err.t1);
    check('.tif 提示用桌面版', /桌面版/.test(err.t2), err.t2);
    check('.rar 提示用桌面版', /桌面版/.test(err.t3), err.t3);
    check('坏压缩包给出可读错误', /压缩包打开失败/.test(err.t4), err.t4);
    check('二次坏包仍报错不卡死', /压缩包打开失败/.test(err.t5), err.t5);
    check('空列表提示', /没有找到/.test(err.t6), err.t6);

    log('\n[16] showDirectoryPicker 递归扫描（模拟 FileSystemDirectoryHandle）');
    const fsa = await cdp.eval(`
      // 构造：根/00.png, 根/第1话/{01,02}.png, 根/第10话/{01}.png, 根/sub/deep/01.png
      const file = (name, path) => ({ kind: 'file', name, _p: path,
        getFile: () => Promise.resolve({ name, path, kind: 'file' }) });
      const dir = (name, entries) => ({ kind: 'directory', name, _e: entries,
        entries: function () {
          const arr = Object.entries(entries); let i = 0;
          return { next: () => Promise.resolve(i < arr.length
            ? { value: arr[i++], done: false } : { done: true }) };
        } });
      const root = dir('漫画', {
        '00.png': file('00.png'),
        '第1话': dir('第1话', { '01.png': file('01.png'), '02.png': file('02.png') }),
        '第10话': dir('第10话', { '01.png': file('01.png') }),
        'sub': dir('sub', { 'deep': dir('deep', { '01.png': file('01.png') }) }),
        '.DS_Store': file('.DS_Store'),
      });
      const items = await window.__IV.scanDir(root, '');
      return { paths: items.map(i => i.path), kinds: [...new Set(items.map(i => i.kind))],
               hasHandle: items.every(i => !!i.handle) };
    `);
    check('递归拿到全部子目录图片（含三层）',
      JSON.stringify(fsa.paths) === JSON.stringify(['00.png', '第1话/01.png', '第1话/02.png', '第10话/01.png', 'sub/deep/01.png']), fsa.paths);
    check('不一次把所有文件读进内存（只存 handle）', fsa.kinds.length === 1 && fsa.kinds[0] === 'fsa' && fsa.hasHandle, fsa);

    log('\n[17] 文件夹拖拽递归（webkitGetAsEntry 风格）');
    const dropped = await cdp.eval(`
      const mkFile = (name) => ({ isFile: true, isDirectory: false, name,
        file: (ok) => ok({ name, size: 10, text: () => Promise.resolve('x') }) });
      const mkDir = (name, kids) => ({ isFile: false, isDirectory: true, name,
        createReader: () => { let done = false; return { readEntries: (ok) => { if (done) return ok([]); done = true; ok(kids); } }; } });
      const out = [];
      await window.__IV.walkEntry(mkDir('漫画', [mkFile('a.png'), mkDir('第2话', [mkFile('b.png'), mkDir('x', [mkFile('c.png')])])]), '', out);
      return out.map(e => ({ path: e.path, name: e.name, hasFile: !!e.file }));
    `);
    check('拖拽保留相对路径（章节不会混排）',
      JSON.stringify(dropped.map(d => d.path)) === JSON.stringify(['漫画/a.png', '漫画/第2话/b.png', '漫画/第2话/x/c.png']), dropped);
    check('每项都带 File', dropped.every(d => d.hasFile), dropped);

    log('\n[18] 大图降采样上限 + objectURL 不溢出');
    const mem = await cdp.eval(`
      const big = [await __mk('big.png','mem/big.png',5000,600,{rect:'#123',rectW:5000,rectH:600})];
      window.__IV.openItems(big, { kind:'dir', title:'mem' });
      await __force('trim', false); await __force('spread', false);
      await __tick();
      const s = window.__IV.state();
      const it = [];
      for (let i = 0; i < 24; i++) it.push(await __mk('p'+String(i+1).padStart(2,'0')+'.png','mem2/p'+String(i+1).padStart(2,'0')+'.png',120,170,{rect:'#'+(i+100)+'' ,rectW:120,rectH:170}));
      window.__IV.openItems(it, { kind:'dir', title:'mem2' });
      await __tick();
      let maxUrls = 0;
      for (let i = 0; i < 24; i++) { window.__IV.showPage(i); await __wait(30); maxUrls = Math.max(maxUrls, window.__IV.state().urls); }
      await __tick();
      const fin = window.__IV.state();
      return { box: s.box, bmp: s.decoded[0], maxUrls, urls: fin.urls, pages: fin.pages, thumbDone: fin.thumbDone };
    `);
    check('5000×600 超图按 4000px 上限排布', mem.box[0].w === 4000 && mem.box[0].h === 480, mem.box);
    check('原始像素仍记录真实尺寸', mem.bmp.w === 5000 && mem.bmp.h === 600, mem.bmp);
    check('连刷 24 页 objectURL 数量有上限', mem.maxUrls <= 10, mem);
    check('24 页都加载得动', mem.pages === 24, mem);

    log('\n[19] 内存：旧页位图不常驻（切换书籍后释放）');
    const mem2 = await cdp.eval(`
      const s1 = window.__IV.state();
      const it = [await __mk('x.png','mem3/x.png',300,200,{rect:'#111',rectW:300,rectH:200})];
      window.__IV.openItems(it, { kind:'dir', title:'mem3' });
      await __tick();
      return { before: s1.urls, after: window.__IV.state().urls, pages: window.__IV.state().pages };
    `);
    check('换书后 URL 缓存重新计', mem2.after <= 6 && mem2.pages === 1, mem2);

    /* ---------- 真实文件：走 <input type=file> / 选择器同一代码路径 ---------- */
    await cdp.send('DOM.enable');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-web-'));
    const book = path.join(tmp, 'book');
    fs.mkdirSync(path.join(book, '第1话'), { recursive: true });
    fs.mkdirSync(path.join(book, '第2话'), { recursive: true });
    fs.writeFileSync(path.join(book, '00_cover.png'), pngBytes(200, 120, '226688'));
    fs.writeFileSync(path.join(book, '第1话', '1.png'), pngBytes(100, 300, '112233'));
    fs.writeFileSync(path.join(book, '第1话', '2.png'), pngBytes(100, 300, '445566'));
    fs.writeFileSync(path.join(book, '第2话', '1.png'), pngBytes(100, 300, '778899'));
    fs.writeFileSync(path.join(book, 'notes.txt'), Buffer.from('x'));
    const cbzPath = path.join(tmp, 'comic.cbz');
    fs.writeFileSync(cbzPath, buildZip([
      { name: 'cover.png', data: pngBytes(120, 80, '226688'), store: true },
      { name: '第2话/01.png', data: pngBytes(100, 160, '112233'), store: false },
      { name: '第2话/02.png', data: pngBytes(100, 160, '445566'), store: false },
      { name: '第10话/01.png', data: pngBytes(100, 160, '778899'), store: false },
    ]));

    const doc = await cdp.send('DOM.getDocument');
    async function setInputFiles(selector, files) {
      const fresh = await cdp.send('DOM.getDocument');          // 导航后 nodeId 会过期
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: fresh.root.nodeId, selector });
      if (!nodeId) throw new Error('找不到 ' + selector);
      await cdp.send('DOM.setFileInputFiles', { nodeId, files });
      await sleep(1800);
    }
    void doc;

    log('\n[20] webkitdirectory 兼容入口（folderInput；CDP 不允许脚本填目录输入框，用假 FileList 跑同一代码路径）');
    const real = await cdp.eval(`
      const mk = (relPath, w, h) => __mk(relPath.split('/').pop(), relPath, w, h, { rect: '#333', rectW: w, rectH: h });
      const raw = await Promise.all([
        mk('book/00_cover.png', 200, 120), mk('book/第1话/1.png', 100, 300),
        mk('book/第1话/2.png', 100, 300), mk('book/第2话/1.png', 100, 300),
        mk('book/notes.txt', 10, 10),
      ]);
      const inp = document.querySelector('#folderInput');
      const files = raw.map(r => { const f = r.file; try { Object.defineProperty(f, 'webkitRelativePath', { value: r.path, configurable: true }); } catch (e) { return null; } return f; });
      if (files.some(f => !f)) return { skipReason: '浏览器不允许伪装 webkitRelativePath' };
      Object.defineProperty(inp, 'files', { value: files, configurable: true, writable: true });
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      await __tick();
      return window.__IV.state();
    `);
    if (real.skipReason) {
      log('  \x1b[33m跳过\x1b[0m [20]：' + real.skipReason);
    } else {
      check('目录输入 -> 4 页 / 3 章节', real.total === 4 && real.chapters && real.chapters.length === 3, real);
      check('章节自然排序且根目录在前',
        JSON.stringify((real.chapters || []).map((c) => c.title)) === JSON.stringify(['根目录', '第1话', '第2话']), real.chapters);
      check('书名取根目录名', /book/.test(real.bookTitle), real.bookTitle);
      check('txt 被跳过', real.skipped.length === 1 && /notes.txt/.test(real.skipped[0].name), real.skipped);
      check('真实尺寸 200×120', real.decoded[0].w === 200 && real.decoded[0].h === 120, real.decoded[0]);
    }

    log('\n[21] 压缩包选择器（真实 .cbz 文件）');
    await setInputFiles('#zipInput', [cbzPath]);
    const zip2 = await cdp.eval(`return window.__IV.state();`);
    check('真实 cbz -> 4 页 / 3 章节', zip2.total === 4 && zip2.chapters && zip2.chapters.length === 3, zip2);
    check('cbz 书名用文件名', /comic\.cbz/.test(zip2.bookTitle), zip2.bookTitle);
    check('store 条目解码 120×80', zip2.decoded[0].w === 120 && zip2.decoded[0].h === 80, zip2.decoded[0]);
    await cdp.eval(`window.__IV.switchChapter(1); await __tick(); return 1;`);
    const zip2b = await cdp.eval(`return window.__IV.state();`);
    check('deflate 条目解码 100×160', zip2b.decoded[0].w === 100 && zip2b.decoded[0].h === 160, zip2b.decoded[0]);
    check('压缩包进度也写盘', await cdp.eval(`
      window.__IV.showPage(1); await __tick(); window.__IV.saveProgress();
      const st = window.__IV.state();
      const b = JSON.parse(localStorage.getItem('iv.books.v1'))[st.bookKey];
      return !!(b && b.index === 1 && b.chapter === 1);`));

    log('\n[21b] 压缩包选择器里选 .rar（file:// 没后端 → 明确提示，而不是默默失败）');
    const cbrSample = path.join(HERE, 'fixtures', 'sample.cbr');
    if (!fs.existsSync(cbrSample)) {
      check('file:// 下选 .cbr 给出提示', 'skip', '没有 tests/fixtures/sample.cbr');
    } else {
      await setInputFiles('#zipInput', [cbrSample]);
      const rarHint = await cdp.eval(`
        const t = document.querySelector('#toast');
        return { toast: t.textContent, show: t.classList.contains('show'),
                 total: window.__IV.state().total, title: window.__IV.state().bookTitle,
                 can: window.__IV.canServeFile('a.cbr'), on: window.__IV.backend().on };`);
      check('file:// 下 .cbr 提示「需要本地后端」', /需要本地后端/.test(rarHint.toast), rarHint);
      check('不会把 rar 当 zip 硬解（还是上一本书）', rarHint.total === 4 && /comic\.cbz/.test(rarHint.title), rarHint);
      check('canServeFile 在无后端时恒 false', rarHint.can === false && rarHint.on === false, rarHint);
    }

    log('\n[21c] 漫画 epub：页序按 OPF spine（文件名自然排序是错的）、rtl、svg 包图、丢弃 spine 外缩略图');
    const epubSample = path.join(HERE, 'fixtures', 'sample_comic.epub');
    if (!fs.existsSync(epubSample)) {
      check('epub 页序', 'skip', '没有 tests/fixtures/sample_comic.epub（先跑 python tests/make_web_fixtures.py）');
    } else {
      await setInputFiles('#zipInput', [epubSample]);
      await cdp.eval(`await window.__IV.wait(300); return 1;`);
      const ep = await cdp.eval(`return window.__IV.state();`);
      const epNames = (ep.decoded || []).map((d) => d.name).join('|');
      check('epub 5 页（spine 外的 thumb.png 被丢弃）、单章节', ep.total === 5 && ep.chapters === null, ep);
      check('页序 = spine：cover → p 2(svg,%20) → p3(#frag) → p10 → a_last',
        epNames === 'zz_cover.png|p 2.png|p3.png|p10.png|a_last.png', epNames);
      check('页路径改为顺序名 0001.png…', ep.decoded[0].path === '0001.png' && ep.decoded[4].path === '0005.png', ep.decoded.map((d) => d.path));
      check('第 1 页是 101 宽的封面', ep.decoded[0].w === 101 && ep.decoded[0].h === 150, ep.decoded[0]);
      check('OPF page-progression-direction=rtl -> 日漫方向', ep.S.direction === 'rtl', ep.S);
      check('epub 书名用文件名', /sample_comic\.epub/.test(ep.bookTitle), ep.bookTitle);
      await cdp.eval(`await __force('direction', false); return 1;`);   // 还原，避免影响后面依赖 ltr 的用例
    }

    log('\n[22] 多选图片（真实文件）/ 拖放');
    await setInputFiles('#fileInput', [path.join(book, '00_cover.png'), path.join(book, '第1话', '1.png'),
      path.join(book, '第1话', '2.png')]);
    const multi = await cdp.eval(`return window.__IV.state();`);
    check('选三张真实图 -> 3 页', multi.total === 3, multi);
    check('当前页读得出真实尺寸', multi.decoded[0].w === 200 && multi.decoded[0].h === 120, multi.decoded[0]);
    await cdp.eval(`window.__IV.showPage(1); await __tick(); return 1;`);
    const multi2 = await cdp.eval(`return window.__IV.state();`);
    check('翻页后下一页也解码（100×300）', multi2.decoded[1] && multi2.decoded[1].w === 100 && multi2.decoded[1].h === 300, multi2.decoded);
    check('没显示过的页不预先占内存（尺寸仍为 0）', multi.decoded[2].w === 0, multi.decoded[2]);
    const drop = await cdp.eval(`
      const dt = new DataTransfer();
      const mkPng = (w, h) => new Promise(res => { const cv = document.createElement('canvas');
        cv.width = w; cv.height = h; const x = cv.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0,0,w,h);
        cv.toBlob(b => res(new File([b], 'd' + w + '.png', { type: 'image/png' })), 'image/png'); });
      const a = await mkPng(140, 200), b = await mkPng(150, 200);
      dt.items.add(a); dt.items.add(b);
      dt.items.add(new File([new Uint8Array([1,2,3])], 'c.txt', { type: 'text/plain' }));
      window.dispatchEvent(new DragEvent('dragenter', { bubbles:true, dataTransfer: dt }));
      const overlayOn = document.querySelector('#dropOverlay').classList.contains('show');
      window.dispatchEvent(new DragEvent('drop', { bubbles:true, cancelable:true, dataTransfer: dt }));
      await __tick();
      return { st: window.__IV.state(), overlayOn, overlayOff: document.querySelector('#dropOverlay').classList.contains('show') };
    `);
    check('拖进去能看到遮罩', drop.overlayOn === true, drop);
    check('拖放：3 个条目里取 2 张图片', drop.st.total === 2, drop.st);
    check('拖完遮罩收起', drop.overlayOff === false, drop);

    if (process.env.SHOT) {
      log('\n[截图] 排版自检（SHOT=1 时生成 网页版预览.png）');
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
      await cdp.eval(`
        const it = [];
        for (let i = 1; i <= 9; i++) it.push(await __mk('p' + i + '.png', 'shot/p' + String(i).padStart(2, '0') + '.png',
          360, 520, { bg: '#f7f4ec', rect: '#1b1b1b', rectX: 30, rectY: 34, rectW: 300, rectH: 420 }));
        window.__IV.openItems(it, { kind: 'dir', title: '试阅本' });
        await __force('spread', true); await __force('book', true); await __force('trim', true);
        window.__IV.showPage(0); await __tick();
        document.querySelector('#thumbs').scrollLeft = 0;
        return window.__IV.state().pair.length;
      `);
      await sleep(900);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const out = path.join(ROOT, '网页版预览.png');
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
      log('  已写入 ' + out);
      await cdp.send('Emulation.clearDeviceMetricsOverride');
    }

    log('\n[23] 刷新页面（模拟下次打开）后选中同一批文件 -> 续读');
    const before = await cdp.eval(`
      const it = [];
      for (let i = 1; i <= 4; i++) it.push(await __mk('p'+i+'.png','resume2/p'+i+'.png',100,300,{rect:'#222',rectW:100,rectH:300}));
      window.__IV.openItems(it, { kind:'dir', title:'resume2' });
      await __tick();
      window.__IV.showPage(2); await __tick();
      window.__IV.saveProgress();
      const s = window.__IV.state();
      return { key: s.bookKey, index: s.index, errsBefore: (window.__errs || []).slice(0, 8) };
    `);
    check('刷新前无未捕获异常', !before.errsBefore || !before.errsBefore.length, before.errsBefore);
    await cdp.send('Page.navigate', { url: url.pathToFileURL(PAGE).href });
    await sleep(1500);
    await cdp.eval(HELPERS);
    const hint = await cdp.eval(`return document.querySelector('#resumeHint').textContent;`);
    check('刷新后开始页提示最近一本', /resume2/.test(hint), hint);
    const reopened = await cdp.eval(`
      const it = [];
      for (let i = 1; i <= 4; i++) it.push(await __mk('p'+i+'.png','resume2/p'+i+'.png',100,300,{rect:'#222',rectW:100,rectH:300}));
      window.__IV.openItems(it, { kind:'dir', title:'resume2' });
      await __tick();
      return window.__IV.state();
    `);
    check('重开同一批文件 key 一致', reopened.bookKey === before.key, { a: before.key, b: reopened.bookKey });
    check('刷新后续到第 3 页', reopened.index === 2, { want: before.index, got: reopened.index });
    check('续读后图片正常显示', reopened.decoded[2] && reopened.decoded[2].w === 100 && reopened.domPages >= 1, reopened);

    log('\n[23b] /iv/ 同源页面：PWA 外壳、云端启动链接、Range 源（本机模拟 Caddy + SFTPGo WebDAV）');
    const RELE = '小说/sample_comic.epub';
    const bookBufs = {};
    const epubBuf = fs.existsSync(epubSample) ? fs.readFileSync(epubSample) : null;
    if (!epubBuf) {
      check('云端启动链接', 'skip', '没有 tests/fixtures/sample_comic.epub（先跑 python tests/make_web_fixtures.py）');
    } else {
      bookBufs[RELE] = epubBuf;
      // 同一本 epub 的两个变体：OPF 不声明方向 / 声明 ltr（把属性值就地改成等长的内容，zip 里 OPF 是 store 的）
      const ppd = Buffer.from('page-progression-direction="rtl"');
      const at = epubBuf.indexOf(ppd);
      if (at >= 0) {
        const noPpd = Buffer.from(epubBuf); Buffer.alloc(ppd.length, 0x20).copy(noPpd, at);
        const ltr = Buffer.from(epubBuf); Buffer.from('page-progression-direction="ltr"').copy(ltr, at);
        bookBufs['nodir.epub'] = noPpd; bookBufs['ltr.epub'] = ltr;
        bookBufs['rtl2.epub'] = epubBuf;     // OPF 声明 rtl，用来测「保存的该书方向」压过 OPF
      }
      bookBufs['slow/x.epub'] = epubBuf;     // 慢书：测两次快速启动「最后一个说了算」
      // 大 cbz：20 页，每页 PNG 后面补 200KB 零（store，不压缩）→ 约 4MB，用来证明只取用到的页
      const bigFiles = [];
      for (let i = 1; i <= 20; i++) {
        bigFiles.push({ name: String(i).padStart(2, '0') + '.png', store: true,
          data: Buffer.concat([pngBytes(400, 600, ((i * 12) % 256).toString(16).padStart(2, '0') + '4488'), Buffer.alloc(200000)]) });
      }
      bookBufs['big/lazy.cbz'] = buildZip(bigFiles);
      bookBufs['Re:Zero/v1.cbz'] = bookBufs['big/lazy.cbz'];   // 名字带冒号：书架要能列出并打开
      const iv = await startIvServer(bookBufs);
      const IVURL = iv.origin + '/iv/';
      const enc = encodeURIComponent;
      const hashFor = (rel, extra) => '#open=' + enc(rel) + '&src=dav&bid=' + enc('remote:' + rel) + (extra || '');
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source:
        "window.__csp=[];document.addEventListener('securitypolicyviolation',function(e){window.__csp.push(e.violatedDirective+' '+e.blockedURI)});try{if(!sessionStorage.getItem('iv.e2e.home'))localStorage.setItem('iv.home.shelf.v1','0')}catch(e){}" });
      async function fresh(u) {
        await cdp.send('Page.navigate', { url: 'about:blank' }); await sleep(250);
        await cdp.send('Page.navigate', { url: u }); await sleep(1300);
        await cdp.eval(HELPERS);
      }
      async function waitFor(expr, ms) {
        const t0 = Date.now();
        for (;;) {
          const v = await cdp.eval(`return (${expr});`).catch(() => null);
          if (v || Date.now() - t0 > (ms || 8000)) return v;
          await sleep(120);
        }
      }
      const stateOf = () => cdp.eval(`return window.__IV.state();`);
      const dlgOpen = `!document.querySelector('#dav').classList.contains('hidden')`;

      /* ---- 1) 外壳：manifest / SW / 缓存 / CSP ---- */
      await fresh(IVURL);
      const shell = await cdp.eval(`
        const ready = await Promise.race([navigator.serviceWorker.ready.then(r => r.scope), new Promise(r => setTimeout(() => r(null), 8000))]);
        const keys = await caches.keys();
        let urls = [];
        for (const k of keys) { const c = await caches.open(k); urls = urls.concat((await c.keys()).map(r => new URL(r.url).pathname)); }
        return { scope: ready, keys, urls, manifest: !!document.querySelector('link[rel=manifest]'),
          has: document.body.classList.contains('has-dav'), startDav: getComputedStyle(document.querySelector('#startDav')).display,
          back: getComputedStyle(document.querySelector('#btnBack')).display, csp: window.__csp,
          dbs: (await indexedDB.databases()).map(d => d.name) };`);
      check('SW 注册在 /iv/ 作用域', shell.scope === IVURL, shell.scope);
      check('缓存名都以 iv- 开头', shell.keys.length >= 1 && shell.keys.every((k) => /^iv-/.test(k)), shell.keys);
      check('只缓存外壳（页面 / manifest / 图标），没有 /library', shell.urls.includes('/iv/') && shell.urls.includes('/iv/manifest.webmanifest') &&
        shell.urls.every((u) => u.startsWith('/iv/')), shell.urls);
      check('manifest 链接在，http 页面且无后端 → 显示「☁ 书库账号」，没有返回键', shell.manifest && shell.has && shell.startDav !== 'none' && shell.back === 'none', shell);
      check('部署用的 CSP 下页面零违规', shell.csp.length === 0, shell.csp);
      check('没有碰别的 IndexedDB（只允许 iv-* 或还没建）', shell.dbs.every((n) => /^iv-/.test(n)), shell.dbs);

      /* ---- 2) 第一次打开：弹账号框 → 错误密码 401 再弹 → 正确 → 打开；方向 OPF 优先于链接提示 ---- */
      await fresh(IVURL + hashFor(RELE, '&dir=ltr&back=%2Freader%2F'));
      const dlg = await waitFor(dlgOpen, 6000);
      const dlgInfo = await cdp.eval(`return { base: document.querySelector('#davBase').value, lib: document.querySelector('#davLib').value,
        hash: location.hash, pass: document.querySelector('#davPass').type, pending: window.__IV.launchInfo().pending };`);
      check('没有账号 → 弹出账号框，默认同源根 + library', dlg && dlgInfo.base === iv.origin && dlgInfo.lib === 'library' && dlgInfo.pass === 'password', dlgInfo);
      await waitFor(`document.activeElement && document.activeElement.id === 'davPass'`, 3000);
      const pre = await cdp.eval(`const q = (s) => document.querySelector(s);
        return { user: q('#davUser').value, pass: q('#davPass').value, focus: document.activeElement && document.activeElement.id,
          syncUser: q('#davSyncUser').value, syncPass: q('#davSyncPass').value, syncOpen: q('#dav details.dav-sync').open };`);
      check('第一次：用户名预填 iv-viewer、密码留空、光标在密码上；进度账号预填 gary 并展开「跨设备续读」',
        pre.user === 'iv-viewer' && pre.pass === '' && pre.focus === 'davPass' && pre.syncUser === 'gary' && pre.syncPass === '' && pre.syncOpen, pre);
      check('弹框期间 hash 还在（刷新不丢）、还没发任何 /library 请求', /open=/.test(dlgInfo.hash) && iv.log.length === 0, { h: dlgInfo.hash, n: iv.log.length });
      await cdp.eval(`document.querySelector('#davBase').value = 'https://evil.example/'; document.querySelector('#davSave').click(); return 1;`);
      const rejected = await cdp.eval(`return { open: ${dlgOpen}, msg: document.querySelector('#davMsg').textContent };`);
      check('WebDAV 地址填别的站点被拒（凭据不会发给别人）', rejected.open && /本站/.test(rejected.msg) && iv.log.length === 0, rejected);
      await cdp.eval(`document.querySelector('#davBase').value = '${iv.origin}/';
        document.querySelector('#davUser').value = 'viewer'; document.querySelector('#davPass').value = 'wrong';
        document.querySelector('#davSave').click(); return 1;`);
      const again = await waitFor(`${dlgOpen} && /401/.test(document.querySelector('#davMsg').textContent)`, 6000);
      check('密码错 → 401 → 重新弹框并提示', !!again, await cdp.eval(`return document.querySelector('#davMsg').textContent;`));
      check('401 时 hash 还在', await cdp.eval(`return /open=/.test(location.hash);`));
      await cdp.eval(`document.querySelector('#davPass').value = 'pä ss'; document.querySelector('#davSave').click(); return 1;`);
      await waitFor(`window.__IV.state().total === 5`, 8000);
      const o1 = await stateOf();
      const names1 = (o1.decoded || []).map((d) => d.name).join('|');
      check('云端 epub 打开：5 页，页序 = spine', o1.total === 5 && names1 === 'zz_cover.png|p 2.png|p3.png|p10.png|a_last.png', { t: o1.total, names1 });
      check('key = dav:<相对路径>，书名 = 文件名', o1.bookKey === 'dav:' + RELE && o1.bookTitle === 'sample_comic.epub', { k: o1.bookKey, t: o1.bookTitle });
      check('方向：OPF 的 rtl 优先于链接 dir=ltr', o1.S.direction === 'rtl', o1.S.direction);
      const after = await cdp.eval(`return { hash: location.hash, href: location.href, info: window.__IV.launchInfo(),
        back: getComputedStyle(document.querySelector('#btnBack')).display, dlg: ${dlgOpen} };`);
      check('打开后 replaceState 去掉 hash', after.hash === '' && !/#/.test(after.href), after);
      check('back=/reader/ 有效 → 显示「← 返回」', after.info.back === '/reader/' && after.back !== 'none' && !after.dlg, after);
      const reqs = iv.log.filter((e) => e.status !== 401);
      const wantPath = '/library/' + RELE.split('/').map(enc).join('/');
      check('每个书库请求：同一个编码后的路径、都带 Authorization、除 HEAD 外全是 Range', reqs.length >= 2 &&
        reqs.every((e) => e.path === wantPath && e.auth && (e.method === 'HEAD' || /^bytes=\d+-\d+$/.test(e.range || ''))), reqs.slice(0, 4));
      check('Range 请求全部得到 206', reqs.filter((e) => e.method === 'GET').every((e) => e.status === 206), reqs.map((e) => e.status));
      check('账号不在任何 URL 里', iv.hits.every((h) => !/viewer|p%C3%A4|p%20ss|pä/.test(h)), iv.hits.slice(0, 5));
      const store = await cdp.eval(`
        const out = {};
        for (const k of Object.keys(localStorage)) out[k] = localStorage.getItem(k);
        const db = await new Promise((res, rej) => { const r = indexedDB.open('iv-settings'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        const rec = await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get('dav'); q.onsuccess = () => res(q.result); });
        db.close();
        return { ls: JSON.stringify(out), rec };`);
      check('账号存在 iv-settings 库里（用户 / 密码 / 地址 / 书库）', store.rec && store.rec.user === 'viewer' && store.rec.pass === 'pä ss' && store.rec.library === 'library', store.rec && { ...store.rec, pass: '***' });
      check('localStorage 里没有账号 / 密码', !/viewer|pä ss/.test(store.ls));

      /* ---- 3) openZipUrl 与 openZipFile 同一本 epub，结果一致 ---- */
      await fresh(IVURL);
      await setInputFiles('#zipInput', [epubSample]);
      const viaFile = await stateOf();
      const viaUrl = await cdp.eval(`
        const auth = window.IVCore.basicAuth('viewer', 'pä ss');
        const ok = await window.__IV.openZipUrl(location.origin + '/library/' + ${JSON.stringify(RELE)}.split('/').map(encodeURIComponent).join('/'),
          { title: 'sample_comic.epub', authHeader: auth });
        await window.__IV.wait(300);
        return Object.assign({ ok }, window.__IV.state());`);
      const sig = (s) => JSON.stringify({ n: s.total, d: s.decoded.map((d) => [d.name, d.path]), dir: s.S.direction, ch: s.chapters });
      check('openZipUrl 的页序 / 路径 / 方向 / 章节 = openZipFile', viaUrl.ok === true && sig(viaFile) === sig(viaUrl), { a: sig(viaFile).slice(0, 160), b: sig(viaUrl).slice(0, 160) });

      /* ---- 4) 方向「每本书各自记住」：第一次打开 = OPF > 链接 dir 做初值；保存之后以保存的为准（OPF / 链接都不再覆盖） ---- */
      if (!bookBufs['nodir.epub']) {
        check('方向优先级', 'skip', 'fixture 的 OPF 不是 store，没法就地改');
      } else {
        const R2 = 'nodir.epub';
        await fresh(IVURL + hashFor(R2, '&dir=rtl'));
        await waitFor(`window.__IV.state().total === 5`, 8000);
        const d1 = await stateOf();
        check('OPF 没声明方向 + 没保存过 → 用链接的 dir=rtl', d1.total === 5 && d1.S.direction === 'rtl', d1.S);
        await cdp.eval(`await __force('direction', false); window.__IV.saveProgress(); return 1;`);   // 用户切成左→右
        const saved = await cdp.eval(`return window.__IV.books()['dav:nodir.epub'] && window.__IV.books()['dav:nodir.epub'].direction;`);
        check('用户切换后，这本书（dav:key）记住了方向', saved === 'ltr', saved);
        await fresh(IVURL + hashFor(R2, '&dir=rtl'));
        await waitFor(`window.__IV.state().total === 5`, 8000);
        const d2 = await stateOf();
        check('再次用 dir=rtl 打开：已保存的该书方向（ltr）优先', d2.S.direction === 'ltr', d2.S);
        await fresh(IVURL + hashFor('ltr.epub', '&dir=rtl'));
        await waitFor(`window.__IV.state().total === 5`, 8000);
        const d3 = await stateOf();
        check('第一次打开：OPF 声明 ltr + 链接 dir=rtl → OPF 优先（ltr）', d3.S.direction === 'ltr', d3.S);
        // OPF 声明 rtl 的书：第一次 rtl（OPF 压过链接 dir=ltr）→ 用户切成 ltr → 再次打开（OPF 仍是 rtl、链接 dir=rtl）→ 用保存的 ltr
        await fresh(IVURL + hashFor('rtl2.epub', '&dir=ltr'));
        await waitFor(`window.__IV.state().total === 5`, 8000);
        const e1 = await stateOf();
        check('第一次打开：OPF rtl > 链接 dir=ltr → rtl', e1.S.direction === 'rtl', e1.S);
        await cdp.eval(`await __force('direction', false); window.__IV.saveProgress(); return 1;`);
        await fresh(IVURL + hashFor('rtl2.epub', '&dir=rtl'));
        await waitFor(`window.__IV.state().total === 5`, 8000);
        const e2 = await stateOf();
        check('用户切换后再次打开：保存的方向（ltr）压过 OPF rtl 和链接 dir=rtl', e2.S.direction === 'ltr' && e2.bookKey === 'dav:rtl2.epub', e2.S);
        await cdp.eval(`window.__IV.toggleDirection(); window.__IV.saveProgress(); return 1;`);   // 切回 rtl 也同样被记住
        await fresh(IVURL + hashFor('rtl2.epub', '&dir=ltr'));
        await waitFor(`window.__IV.state().total === 5`, 8000);
        check('再切一次 → 第三次打开仍用保存的值（rtl）', (await stateOf()).S.direction === 'rtl');
      }

      /* ---- 5) 只取用到的页：4MB 的 cbz，看前几页只发出很少字节；并发不超过 4 ---- */
      await fresh(IVURL);
      await cdp.eval(`localStorage.setItem('iv.ui.v1', JSON.stringify({ thumbs: false })); return 1;`);
      await fresh(IVURL + hashFor('big/lazy.cbz'));
      await waitFor(`window.__IV.state().total === 20`, 10000);
      await cdp.eval(`await __tick(); return 1;`);
      const bigPath = '/library/big/lazy.cbz';
      const bigSize = bookBufs['big/lazy.cbz'].length;
      const sent1 = iv.log.filter((e) => e.path === bigPath).reduce((a, e) => a + e.bytes, 0);
      check('打开 20 页（约 ' + Math.round(bigSize / 1048576) + 'MB）的 cbz 并看第 1 页：只发出整本的 <35%', sent1 > 0 && sent1 < bigSize * 0.35, { sent1, bigSize });
      await cdp.eval(`window.__IV.showPage(19); await __tick(); return 1;`);
      const sent2 = iv.log.filter((e) => e.path === bigPath).reduce((a, e) => a + e.bytes, 0);
      const st2 = await stateOf();
      check('翻到最后一页才取最后一页的字节，且图能解出', sent2 > sent1 && st2.decoded[19].w === 400, { sent1, sent2, w: st2.decoded[19].w });
      check('同时在途的书库请求 ≤ 4', iv.maxInflight <= 4, iv.maxInflight);
      check('没有一次 200 整本响应', iv.log.filter((e) => e.path === bigPath).every((e) => e.status === 206 || e.method === 'HEAD'), iv.log.filter((e) => e.path === bigPath && e.status === 200).length);

      /* ---- 6) 非法 / 恶意启动链接：拒绝，不发任何书库请求，hash 被清掉 ---- */
      await fresh(IVURL);
      const before = iv.log.length;
      const hits0 = iv.hits.length;
      const badHashes = ['#open=..%2F..%2Fsecret.epub', '#open=a%2F..%2Fb.epub', '#open=%2F%2Fevil.example%2Fa.epub',
        '#open=http%3A%2F%2Fevil.example%2Fa.epub', '#open=javascript%3Aalert(1)', '#open=%2Fetc%2Fpasswd', '#open=a.epub&src=ftp', '#open=%E0%A4%A'];
      const badRes = await cdp.eval(`
        const out = [];
        for (const h of ${JSON.stringify(badHashes)}) {
          document.querySelector('#toast').textContent = '';
          location.hash = h;
          await window.__IV.wait(200);
          out.push({ h, toast: document.querySelector('#toast').textContent, hash: location.hash });
        }
        return out;`);
      check('8 种恶意 / 非法链接都被拒绝并提示', badRes.every((r) => /启动链接无效/.test(r.toast)), badRes.filter((r) => !/启动链接无效/.test(r.toast)));
      check('拒绝后 hash 被清掉', badRes.every((r) => r.hash === ''), badRes.map((r) => r.hash));
      check('拒绝的链接没有向书库发任何请求', iv.log.length === before && iv.hits.slice(hits0).every((h) => !/\/library|evil|secret|passwd/.test(h)), iv.hits.slice(hits0));
      const noBack = await cdp.eval(`
        location.hash = '#open=' + encodeURIComponent(${JSON.stringify(RELE)}) + '&back=' + encodeURIComponent('//evil.example/x');
        for (let i = 0; i < 60 && window.__IV.state().total !== 5; i++) await window.__IV.wait(100);
        return { total: window.__IV.state().total, back: window.__IV.launchInfo().back, disp: getComputedStyle(document.querySelector('#btnBack')).display, hash: location.hash };`);
      check('hashchange（同页再点链接）也能打开；非法 back 被丢弃：能打开、没有返回键', noBack.total === 5 && noBack.back === null && noBack.disp === 'none' && noBack.hash === '', noBack);

      /* ---- 6b) 连着本地后端（BE.on）时不处理 #open=：提示 + 不发请求 + hash 清掉 ---- */
      await fresh(IVURL);
      const be0 = iv.log.length;
      const beRes = await cdp.eval(`
        const BE = window.__IV.backend(); const was = BE.on; BE.on = true;
        document.querySelector('#toast').textContent = '';
        location.hash = '#open=' + encodeURIComponent(${JSON.stringify(RELE)});
        await window.__IV.wait(600);
        const out = { toast: document.querySelector('#toast').textContent, hash: location.hash, total: window.__IV.state().total };
        BE.on = was;
        return out;`);
      check('连着本地后端：#open= 不处理，给出提示、不发书库请求、hash 清掉', /本地后端/.test(beRes.toast) && beRes.total === 0 && beRes.hash === '' && iv.log.length === be0, { beRes, n: iv.log.length - be0 });

      /* ---- 6c) 连点两个启动链接：最后一个说了算，慢的旧链接后到也不覆盖 ---- */
      await fresh(IVURL);
      iv.slow['slow/x.epub'] = 400;
      await cdp.eval(`location.hash = '#open=' + encodeURIComponent('slow/x.epub'); await window.__IV.wait(120);
        location.hash = '#open=' + encodeURIComponent(${JSON.stringify(RELE)}); return 1;`);
      await waitFor(`window.__IV.state().total === 5 && window.__IV.state().bookKey === 'dav:' + ${JSON.stringify(RELE)}`, 8000);
      await sleep(2500);                                    // 慢书的几个请求（各 400ms）早就返回完了
      const raced = await cdp.eval(`return { key: window.__IV.state().bookKey, total: window.__IV.state().total, hash: location.hash };`);
      check('先慢后快：最后点的那本留着，慢的旧链接完成后没有盖上去', raced.key === 'dav:' + RELE && raced.total === 5 && raced.hash === '', raced);
      check('旧链接确实发过请求（所以测到的是丢弃而不是没发）', iv.log.some((e) => e.path === '/library/slow/x.epub'));
      delete iv.slow['slow/x.epub'];

      /* ---- 6d) 起始页的续读提示：云端书（dav:）不能叫人「重新选中同一个文件夹」 ---- */
      await fresh(IVURL);
      const hint = await cdp.eval(`return document.querySelector('#resumeHint').textContent;`);
      check('最近读的是云端书 → 提示重新打开书 / 链接，而不是重新选文件夹', /上次阅读/.test(hint) && /云端/.test(hint) && !/重新选中同一个文件夹/.test(hint), hint);

      /* ---- 7) 服务器忽略 Range / 404 ---- */
      await fresh(IVURL);
      const igBefore = iv.log.length;
      const ig = await cdp.eval(`
        location.hash = '#open=' + encodeURIComponent('ignore/${RELE}');
        for (let i = 0; i < 60 && !/Range/.test(document.querySelector('#toast').textContent); i++) await window.__IV.wait(100);
        return { toast: document.querySelector('#toast').textContent, total: window.__IV.state().total, hash: location.hash };`);
      const igReqs = iv.log.slice(igBefore);
      check('服务器忽略 Range（200）→ 明确报错，没有打开', /server ignores Range/.test(ig.toast) && ig.total === 0, ig);
      check('只发了 1 个请求就中止（没有反复 / 整本下载）', igReqs.length === 1, igReqs);
      check('失败时 hash 保留（刷新可重试）', /open=/.test(ig.hash), ig.hash);
      await fresh(IVURL);
      const nf = await cdp.eval(`
        location.hash = '#open=' + encodeURIComponent('不存在的书.epub');
        for (let i = 0; i < 60 && !/404/.test(document.querySelector('#toast').textContent); i++) await window.__IV.wait(100);
        return document.querySelector('#toast').textContent;`);
      check('404 → 提示找不到', /404/.test(nf), nf);

      /* ---- 8) 打开之后密码被改 → 翻页遇到 401 → 重新弹框 ---- */
      await fresh(IVURL + hashFor('big/lazy.cbz'));
      await waitFor(`window.__IV.state().total === 20`, 10000);
      iv.pass = 'changed';
      await cdp.eval(`window.__IV.showPage(12); return 1;`);
      const re401 = await waitFor(`${dlgOpen} && /401/.test(document.querySelector('#davMsg').textContent)`, 8000);
      check('已打开的书翻页遇到 401 → 自动弹出账号框', !!re401);
      await cdp.eval(`document.querySelector('#davCancel').click(); return 1;`);
      check('取消 → 框收起、等待中的 Promise 结束', await cdp.eval(`return ${dlgOpen} === false && window.__IV.launchInfo().pending === false;`));
      iv.pass = 'pä ss';

      /* ---- 8b) 跨设备续读：进度文件夹（MKCOL → PUT / GET）、新旧判断、没写权限、坏数据 ---- */
      const SYNCKEY = 'dav:big/lazy.cbz';
      /* 模拟「另一台设备」：账号还在（IndexedDB），本地进度清空，然后真的重新加载页面（只改 hash 不会重载） */
      async function newDeviceOpen(rel) {
        await fresh(IVURL);
        await cdp.eval(`localStorage.removeItem('iv.books.v1'); return 1;`);
        await fresh(IVURL + hashFor(rel));
        await waitFor(`window.__IV.state().total === 20`, 10000);
      }
      iv.progLog.length = 0;
      const cfgJs = (extra) => `await window.__IV.davStore(Object.assign({ base: '${iv.origin}', library: 'library', user: 'viewer', pass: 'pä ss' }, ${extra})); return 1;`;
      await fresh(IVURL);
      await cdp.eval(cfgJs(`{ syncDir: 'users/gary/iv-progress', syncUser: 'writer', syncPass: 'w pass' }`));
      await newDeviceOpen('big/lazy.cbz');
      iv.progLog.length = 0;
      await cdp.eval(`window.__IV.showPage(5); window.__IV.saveProgress(); return window.__IV.syncPush(false);`);
      await waitFor(`window.__IV.syncState().sent[${JSON.stringify(SYNCKEY)}]`, 6000);
      const pIdx = (await stateOf()).index;
      const puts = iv.progLog.filter((e) => e.method === 'PUT' || e.method === 'MKCOL');
      check('进度文件夹不存在 → 逐层 MKCOL（users / users/gary / users/gary/iv-progress）再 PUT', puts[0] && puts[0].status === 409 && puts.slice(1, 4).every((e) => e.method === 'MKCOL' && e.status === 201) && puts[3].path === '/users/gary/iv-progress' && puts[4] && puts[4].method === 'PUT' && puts[4].status === 201, puts.map((e) => e.method + e.status));
      const wrote = Object.values(iv.prog).map((b) => JSON.parse(b))[0] || {};
      check('写出去的 JSON：key / 页码 / 方向 / 设备，且不含双页 / 适应方式', wrote.key === SYNCKEY && wrote.index === pIdx && pIdx >= 1 && /^(rtl|ltr)$/.test(wrote.direction) && wrote.at > 1.7e12 && !('spread' in wrote) && !('fit' in wrote), wrote);
      check('用的是进度账号（writer），不是只读的书库账号', puts[4].auth === 'Basic ' + Buffer.from('writer:w pass').toString('base64'), puts[4].auth);

      // 另一台设备（本地没有记录）打开同一本书 → 接上云端的页码
      await newDeviceOpen('big/lazy.cbz');
      const pulled = await stateOf();
      check('别的设备打开同一本书 → 从云端页码续读', pulled.index === pIdx, { want: pIdx, got: pulled.index });
      const note = await waitFor(`/已接上/.test(document.querySelector('#toast').textContent) && document.querySelector('#toast').textContent`, 3000);
      check('提示「已接上……的进度」', !!note, note);

      // 云端比本地旧 → 不动本地
      const key0 = Object.keys(iv.prog)[0];
      iv.prog[key0] = JSON.stringify({ v: 1, key: SYNCKEY, at: 1000, index: 11, chapter: 0, total: 20, direction: 'ltr', title: 'old', dev: 'x' });
      await cdp.eval(`window.__IV.showPage(3); window.__IV.saveProgress(); return 1;`);
      await fresh(IVURL + hashFor('big/lazy.cbz'));
      await waitFor(`window.__IV.state().total === 20`, 10000);
      check('云端旧于本地 → 保持本地页码', (await stateOf()).index === 3, (await stateOf()).index);

      // 坏数据（key 对不上 / 不是 JSON）→ 当没有，照常打开
      for (const junk of [JSON.stringify({ v: 1, key: 'dav:other', at: 9e12, index: 15 }), 'not json {']) {
        await fresh(IVURL);                  // 先离开上一本书（它离开时会补写进度），再放坏数据
        iv.prog[key0] = junk;
        await newDeviceOpen('big/lazy.cbz');
        check('云端进度文件是坏的 / key 对不上 → 忽略，从第 1 页打开', (await stateOf()).index === 0, junk.slice(0, 20));
      }

      // 只有只读账号（没填进度账号）→ 403 → 提示一次并停用，不反复重试
      await fresh(IVURL);
      await cdp.eval(cfgJs(`{ syncDir: 'users/gary/iv-progress' }`));
      await fresh(IVURL + hashFor('big/lazy.cbz'));
      await waitFor(`window.__IV.state().total === 20`, 10000);
      const n0 = iv.progLog.length;
      await cdp.eval(`window.__IV.showPage(7); window.__IV.saveProgress(); window.__IV.syncPush(false); return 1;`);
      const denied = await waitFor(`window.__IV.syncState().off && document.querySelector('#toast').textContent`, 6000);
      check('只读账号写进度 → 403 → 提示没有写权限并停用', /没有写权限/.test(denied || ''), denied);
      await cdp.eval(`window.__IV.showPage(8); window.__IV.saveProgress(); window.__IV.syncPush(false); return 1;`);
      await sleep(400);
      check('停用之后不再发请求', iv.progLog.length - n0 === 1, iv.progLog.slice(n0).map((e) => e.method + e.status));

      // 进度文件夹留空 = 关闭同步：不发任何请求
      await fresh(IVURL);
      await cdp.eval(cfgJs(`{ syncDir: '' }`));
      await fresh(IVURL + hashFor('big/lazy.cbz'));
      await waitFor(`window.__IV.state().total === 20`, 10000);
      const n1 = iv.progLog.length;
      await cdp.eval(`window.__IV.showPage(9); window.__IV.saveProgress(); window.__IV.syncPush(false); return 1;`);
      await sleep(400);
      check('进度文件夹留空 → 不同步（零请求）', iv.progLog.length === n1, iv.progLog.slice(n1));
      await fresh(IVURL);
      await cdp.eval(cfgJs(`{ syncDir: 'users/gary/iv-progress' }`));

      /* ---- 8c) 书架：PROPFIND 目录浏览 -> 点书打开；记住上次目录；筛选；401 ---- */
      await fresh(IVURL);
      const shelfVis = await cdp.eval(`return { start: getComputedStyle(document.querySelector('#startShelf')).display, tool: getComputedStyle(document.querySelector('#btnShelf')).display };`);
      check('云端部署页上有「云端书架」入口（起始页 + 工具栏）', shelfVis.start !== 'none' && shelfVis.tool !== 'none', shelfVis);
      const shelfOpenExpr = `!document.querySelector('#shelf').classList.contains('hidden')`;
      const rowsOf = () => cdp.eval(`return Array.from(document.querySelectorAll('#shelfList .shelf-row')).map(b => ({ t: b.querySelector('.nm').textContent, dir: b.hasAttribute('data-dir'), meta: b.querySelector('.meta') ? b.querySelector('.meta').textContent : '' }));`);
      iv.log.length = 0;
      await cdp.eval(`localStorage.removeItem('iv.shelf.dir.v1'); document.querySelector('#startShelf').click(); return 1;`);
      await waitFor(`${shelfOpenExpr} && document.querySelectorAll('#shelfList .shelf-row').length > 0`, 8000);
      const root = await rowsOf();
      check('书库根：先文件夹后书，只列 epub / cbz / zip', root.length >= 4 && root[0].dir && root.filter((r) => r.dir).map((r) => r.t).join() === 'big,Re:Zero,slow,小说' &&
        root.filter((r) => !r.dir).every((r) => /\.(epub|cbz|zip)$/i.test(r.t)), root.map((r) => (r.dir ? '[D]' : '') + r.t));
      const pf = iv.log.filter((e) => e.method === 'PROPFIND');
      check('PROPFIND：Depth 1、带 Authorization、只发 1 次', pf.length === 1 && pf[0].depth === '1' && pf[0].auth && pf[0].status === 207, pf);
      await cdp.eval(`document.querySelector('#shelfList .shelf-row[data-dir="小说"]').click(); return 1;`);
      await waitFor(`document.querySelector('#shelfList .shelf-row[data-book]')`, 8000);
      const sub = await cdp.eval(`return { crumbs: Array.from(document.querySelectorAll('#shelfCrumbs button')).map(b => b.textContent), info: document.querySelector('#shelfInfo').textContent,
        ls: localStorage.getItem('iv.shelf.dir.v1') };`);
      check('进入子目录：面包屑 = 书库 / 小说，并记住这个目录', sub.crumbs.length === 2 && sub.crumbs[1] === '小说' && sub.ls === '小说', sub);
      await cdp.eval(`document.querySelector('#shelfFilter').value = 'zzz-nothing'; document.querySelector('#shelfFilter').dispatchEvent(new Event('input')); return 1;`);
      check('筛选：没有匹配 → 提示', /没有匹配/.test(await cdp.eval(`return document.querySelector('#shelfList').textContent;`)));
      await cdp.eval(`document.querySelector('#shelfFilter').value = 'sample'; document.querySelector('#shelfFilter').dispatchEvent(new Event('input')); return 1;`);
      check('筛选：sample → 只剩 sample_comic.epub', JSON.stringify((await rowsOf()).map((r) => r.t)) === '["sample_comic.epub"]');
      await cdp.eval(`document.querySelector('#shelfList .shelf-row[data-book]').click(); return 1;`);
      await waitFor(`window.__IV.state().total === 5 && window.__IV.state().bookKey === 'dav:' + ${JSON.stringify(RELE)}`, 10000);
      check('点书：书架关闭，书以 dav:<相对路径> 打开', (await cdp.eval(`return ${shelfOpenExpr} === false;`)) && (await stateOf()).bookKey === 'dav:' + RELE, (await stateOf()).bookKey);
      await cdp.eval(`window.__IV.showPage(2); window.__IV.saveProgress(); return 1;`);
      await cdp.eval(`document.querySelector('#btnShelf').click(); return 1;`);
      await waitFor(`${shelfOpenExpr} && document.querySelector('#shelfList .shelf-row[data-book]')`, 8000);
      const shelfAgain = await rowsOf();
      check('再开书架：停在上次的目录，读过的书标出「读到第 N 页」', shelfAgain.length >= 1 && /第 3 \/ 5 页/.test(shelfAgain[0].meta), shelfAgain);
      /* 名字带冒号的文件夹 / 书：书架能进、能打开 */
      await cdp.eval(`document.querySelector('#shelfCrumbs button[data-rel=""]').click(); return 1;`);
      await waitFor(`document.querySelector('#shelfList .shelf-row[data-dir="Re:Zero"]')`, 8000);
      await cdp.eval(`document.querySelector('#shelfList .shelf-row[data-dir="Re:Zero"]').click(); return 1;`);
      await waitFor(`document.querySelector('#shelfList .shelf-row[data-book="Re:Zero/v1.cbz"]')`, 8000);
      await cdp.eval(`document.querySelector('#shelfList .shelf-row[data-book]').click(); return 1;`);
      await waitFor(`window.__IV.state().total === 20 && window.__IV.state().bookKey === 'dav:Re:Zero/v1.cbz'`, 10000);
      check('名字带冒号的书（Re:Zero/v1.cbz）能从书架打开', (await stateOf()).bookKey === 'dav:Re:Zero/v1.cbz', (await stateOf()).bookKey);
      await cdp.eval(`document.querySelector('#btnShelf').click(); return 1;`);
      await waitFor(`${shelfOpenExpr} && document.querySelector('#shelfCrumbs button')`, 8000);
      const lastDir = await cdp.eval(`return localStorage.getItem('iv.shelf.dir.v1');`);
      check('带冒号的目录也能被记住并在下次恢复（不会被打回根）', lastDir === 'Re:Zero' && (await cdp.eval(`return document.querySelectorAll('#shelfCrumbs button').length;`)) === 2, lastDir);
      /* 书架开着时，空格 / 方向键不能翻后面的书；账号框要盖在书架上面 */
      const idx0 = (await stateOf()).index;
      await cdp.eval(`document.body.focus(); for (const k of [' ', 'ArrowRight', 'l']) document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); return 1;`);
      check('书架开着时全局快捷键不生效（不翻页）', (await stateOf()).index === idx0, { idx0, now: (await stateOf()).index });
      await cdp.eval(`document.querySelector('#shelfCrumbs button[data-rel=""]').click(); return 1;`);
      await waitFor(`document.querySelector('#shelfList .shelf-row[data-dir="big"]')`, 8000);
      check('点面包屑「书库」回到根', (await rowsOf()).some((r) => r.dir && r.t === 'big'));
      iv.pass = 'bad-pass';
      await cdp.eval(`document.querySelector('#shelfReload').click(); return 1;`);
      const sh401 = await waitFor(`${dlgOpen} && /401/.test(document.querySelector('#davMsg').textContent)`, 8000);
      check('书架读目录遇到 401 → 弹出账号框', !!sh401);
      const onTop = await cdp.eval(`const r = document.querySelector('#davUser').getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!(el && el.closest('#dav'));`);
      check('账号框盖在书架上面（用户看得到、点得到输入框）', onTop === true, onTop);
      iv.pass = 'pä ss';
      await cdp.eval(`document.querySelector('#davCancel').click(); return 1;`);
      const shMsg = await waitFor(`/401|没有有效/.test(document.querySelector('#shelfList').textContent) && document.querySelector('#shelfList').textContent`, 4000);
      check('取消账号框 → 书架给出提示而不是一直转圈', !!shMsg, shMsg);
      await cdp.eval(`document.querySelector('#shelf [data-close]').click(); return 1;`);
      await cdp.eval(`document.body.focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true })); return 1;`);
      check('快捷键 L 打开书架', !!(await waitFor(shelfOpenExpr, 3000)));
      await cdp.eval(`document.querySelector('#shelf [data-close]').click(); return 1;`);

      /* ---- 8d) Reader 式首页：启动自动显示书架 + 「继续阅读」（云端进度）+ 书上的进度条 ---- */
      {
        const HOMEKEY = 'dav:' + RELE;
        await fresh(IVURL);
        const h1 = await cdp.eval(`return IVCore.hash53(${JSON.stringify(HOMEKEY)});`);
        iv.progDir = true;
        for (const k of Object.keys(iv.prog)) delete iv.prog[k];
        iv.prog['/users/gary/iv-progress/' + h1 + '.json'] = JSON.stringify({ v: 1, key: HOMEKEY, at: Date.now() - 3600e3 - 5000, index: 3, chapter: 0, total: 5,
          direction: 'rtl', title: 'sample_comic.epub', dev: '手机/平板' });
        const hg = await cdp.eval(`return IVCore.hash53('dav:gone.epub');`);
        iv.prog['/users/gary/iv-progress/' + hg + '.json'] = JSON.stringify({ v: 1, key: 'dav:gone.epub', at: Date.now() - 7200e3, index: 1, chapter: 0, total: 9, direction: 'ltr', title: 'gone.epub', dev: '电脑' });   // 书已被删
        iv.prog['/users/gary/iv-progress/ffffffffffffff.json'] = 'not json';          // 坏文件：不能让「继续阅读」崩
        await cdp.eval(cfgJs(`{ syncDir: 'users/gary/iv-progress', syncUser: 'writer', syncPass: 'w pass' }`));
        await cdp.eval(`sessionStorage.setItem('iv.e2e.home', '1'); localStorage.removeItem('iv.home.shelf.v1'); localStorage.removeItem('iv.books.v1'); localStorage.removeItem('iv.shelf.dir.v1'); return 1;`);
        await fresh(IVURL);                                    // 新设备：本地没有任何进度
        const auto = await waitFor(`${shelfOpenExpr} && document.querySelector('#shelfRecent .shelf-row')`, 10000);
        check('启动页自动显示书架（账号已存、无启动链接）', !!auto);
        const rec = await cdp.eval(`const r = document.querySelector('#shelfRecent .shelf-row[data-book="小说/sample_comic.epub"]'); return r ? { t: r.querySelector('.nm').textContent, meta: r.querySelector('.meta').innerHTML, bar: !!r.querySelector('.shelf-bar i'), n: document.querySelectorAll('#shelfRecent .shelf-row').length, head: document.querySelector('#shelfRecent .shelf-h').textContent } : null;`);
        check('「继续阅读」来自云端进度：书名 / 第 4 / 5 页 / 1 小时前 / 进度条；坏文件被忽略', rec && rec.t === 'sample_comic.epub' && /第 <b>4<\/b> \/ 5 页/.test(rec.meta) && /1 小时前/.test(rec.meta) && rec.bar && rec.n === 2 && rec.head === '继续阅读', rec);
        // 点一个已经不存在的书：提示失败，并回到书架（不是对着空白页）
        await cdp.eval(`document.querySelector('#shelfRecent .shelf-row[data-book="gone.epub"]').click(); return 1;`);
        await waitFor(`/404|失败/.test(document.querySelector('#toast').textContent)`, 8000);
        check('点已被删的书 → 提示失败并回到书架', await waitFor(shelfOpenExpr, 4000), await cdp.eval(`return document.querySelector('#toast').textContent;`));
        await cdp.eval(`document.querySelector('#shelfRecent .shelf-row[data-book="小说/sample_comic.epub"]').click(); return 1;`);
        await waitFor(`window.__IV.state().total === 5 && window.__IV.state().bookKey === ${JSON.stringify(HOMEKEY)}`, 10000);
        check('点「继续阅读」→ 打开并接上云端页码（第 4 页）', (await stateOf()).index === 3, (await stateOf()).index);
        // 目录视图：这本书带进度条，读过的排在前面
        await cdp.eval(`localStorage.setItem('iv.shelf.dir.v1', '小说'); window.__IV.openShelf(); return 1;`);
        await waitFor(`document.querySelector('#shelfList .shelf-row[data-book] .shelf-bar')`, 8000);
        const first = await cdp.eval(`const r = document.querySelector('#shelfList .shelf-row[data-book]'); return { t: r.querySelector('.nm').textContent, meta: r.querySelector('.meta').textContent };`);
        check('书架里读过的书带进度条和「读到第 N / M 页」', first.t === 'sample_comic.epub' && /读到第 \d+ \/ 5 页/.test(first.meta), first);
        // 关掉「启动时显示」→ 下次不再自动弹出
        await cdp.eval(`document.querySelector('#shelfHome').click(); return 1;`);
        check('「启动时显示」可以关掉并被记住', await cdp.eval(`return localStorage.getItem('iv.home.shelf.v1') === '0';`));
        await fresh(IVURL);
        await sleep(700);
        check('关掉之后启动不再自动显示书架', await cdp.eval(`return document.querySelector('#shelf').classList.contains('hidden');`));
        // 带启动链接时（来自 PyReader 的跳转）不能被书架打断
        await cdp.eval(`localStorage.removeItem('iv.home.shelf.v1'); return 1;`);
        await fresh(IVURL + hashFor(RELE));
        await waitFor(`window.__IV.state().total === 5`, 10000);
        check('带 #open= 启动链接时直接开书，不弹书架', await cdp.eval(`return document.querySelector('#shelf').classList.contains('hidden');`));
        await cdp.eval(`sessionStorage.removeItem('iv.e2e.home'); localStorage.setItem('iv.home.shelf.v1', '0'); return 1;`);
        await cdp.eval(cfgJs(`{ syncDir: 'users/gary/iv-progress' }`));
      }

      /* ---- 8e) 打开云端书时的进度条（慢网络：每个 /library 请求慢 150ms） ---- */
      {
        await fresh(IVURL);
        iv.log.length = 0;
        await cdp.eval(`window.__ops = []; window.__of = window.fetch;
          window.fetch = (u, i) => /\\/library\\//.test(String(u)) ? new Promise((r) => setTimeout(r, 150)).then(() => window.__of(u, i)) : window.__of(u, i);
          const e = document.querySelector('#openProg');
          new MutationObserver(() => { if (e.classList.contains('show')) window.__ops.push(e.querySelector('.op-t').textContent + '|' + e.querySelector('.op-s').textContent + '|' + e.querySelector('.op-bar i').style.width); })
            .observe(e, { subtree: true, childList: true, characterData: true, attributes: true });
          window.__open = window.__IV.applyLaunchHash(${JSON.stringify(hashFor(RELE))}); return 1;`);
        await waitFor(`window.__IV.state().total === 5`, 15000);
        await sleep(200);
        const ops = await cdp.eval(`return window.__ops;`);
        const shownEarly = await cdp.eval(`return document.querySelector('#openProg').classList.contains('show');`);
        check('慢开书：进度条出现，标题 = 书名，显示「解析章节 N / M」+ 百分比 + 进度宽度',
          ops.some((s) => /^sample_comic\.epub\|/.test(s)) && ops.some((s) => /\|解析章节 \d+ \/ \d+ +\d+%\|\d/.test(s)), ops.slice(0, 12));
        check('书打开后进度条已收起', shownEarly === false, shownEarly);
        await cdp.eval(`window.fetch = window.__of; return 1;`);
        // 失败（云端没有这本书）也要收起，不能一直挂在屏幕上
        await cdp.eval(`window.__IV.applyLaunchHash(${JSON.stringify(hashFor('不存在的书.epub'))}); return 1;`);
        await sleep(1500);
        check('打开失败后进度条也收起', await cdp.eval(`return !document.querySelector('#openProg').classList.contains('show');`));
        // 直接用钩子：先不定长，再有百分比，end 之后收起；快的（<0.35s）根本不出现
        await cdp.eval(`window.__pg = window.__IV.openProg('X 书'); window.__pg.set('读取目录…', null); return 1;`);
        await sleep(500);
        const indet = await cdp.eval(`const e = document.querySelector('#openProg'); return { show: e.classList.contains('show'), indet: e.classList.contains('indet'), s: e.querySelector('.op-s').textContent };`);
        await cdp.eval(`window.__pg.set('解析章节 3 / 10', 0.3); return 1;`);
        const pct = await cdp.eval(`const e = document.querySelector('#openProg'); return { indet: e.classList.contains('indet'), s: e.querySelector('.op-s').textContent, w: e.querySelector('.op-bar i').style.width };`);
        await cdp.eval(`window.__pg.end(); return 1;`);
        check('钩子：不定长 → 有百分比 → end 收起', indet.show && indet.indet && !pct.indet && /30%/.test(pct.s) && pct.w === '30%' &&
          await cdp.eval(`return !document.querySelector('#openProg').classList.contains('show');`), { indet, pct });
        await cdp.eval(`const q = window.__IV.openProg('快'); q.set('x', 0.5); q.end(); return 1;`);
        await sleep(500);
        check('开得很快（调用 end 早于 0.35 秒）→ 从不出现', await cdp.eval(`return !document.querySelector('#openProg').classList.contains('show');`));
      }

      /* ---- 9) 忘记此设备；返回键 ---- */
      await fresh(IVURL);
      const forgot = await cdp.eval(`
        const had = await window.__IV.davEnsure();
        window.__IV.askDav();
        for (let i = 0; i < 50 && document.querySelector('#dav').classList.contains('hidden'); i++) await window.__IV.wait(50);
        document.querySelector('#davForget').click();
        await window.__IV.wait(300);
        const db = await new Promise((res, rej) => { const r = indexedDB.open('iv-settings'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        const rec = await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get('dav'); q.onsuccess = () => res(q.result); });
        db.close();
        return { had: !!had, rec: rec === undefined, open: !document.querySelector('#dav').classList.contains('hidden'), mem: await window.__IV.davEnsure() };`);
      check('「忘记此设备」清掉 IndexedDB 里的账号并关框', forgot.had && forgot.rec && !forgot.open && forgot.mem === null, forgot);
      await fresh(IVURL + hashFor(RELE));
      check('忘记之后再从链接打开 → 重新要账号', !!(await waitFor(dlgOpen, 6000)));
      await cdp.eval(`document.querySelector('#davBase').value = '${iv.origin}'; document.querySelector('#davUser').value = 'viewer'; document.querySelector('#davPass').value = 'pä ss'; document.querySelector('#davSave').click(); return 1;`);
      await waitFor(`window.__IV.state().total === 5`, 8000);
      await cdp.eval(`location.hash = '#open=' + encodeURIComponent(${JSON.stringify(RELE)}) + '&back=%2Freader%2F'; return 1;`);
      await waitFor(`window.__IV.launchInfo().back === '/reader/'`, 8000);
      const csp2 = await cdp.eval(`return window.__csp || [];`);
      check('CSP 零违规（走完打开 / 翻页 / 弹框后的 /iv/ 页面）', csp2.length === 0, csp2);
      iv.hits.length = 0;
      await cdp.eval(`document.querySelector('#btnBack').click(); return 1;`);
      await sleep(900);
      check('点「← 返回」回到 back 指定的同源页面', iv.hits.some((h) => h === 'GET /reader/'), iv.hits.slice(0, 5));
      /* ======== [23c] 读书时上一本 / 下一本：从云端书架打开 / #open= 打开 / rar·pdf 说明 ======== */
      log('\n[23c] 云端书：读书时「上一本 / 下一本」（同一文件夹相邻的书）；#open= 指向 rar / cbr / pdf 的说明');
      const mkCbz = (hexes) => buildZip(hexes.map((h, i) => ({ name: String(i + 1).padStart(2, '0') + '.png', store: true, data: pngBytes(120, 180, h) })));
      const SER = 'lib/系列A/';
      bookBufs[SER + 'vol 1.cbz'] = mkCbz(['aa0000', '00aa00', '0000aa']);
      bookBufs[SER + 'vol 2.cbz'] = mkCbz(['aa5500', '55aa00', '0055aa']);
      bookBufs[SER + 'vol 3.rar'] = Buffer.from('Rar!\x1a\x07\x00 not a real rar');
      bookBufs[SER + 'vol 5.epub'] = epubBuf;
      bookBufs[SER + 'vol 10.cbz'] = mkCbz(['aa00aa', '00aaaa', 'aaaa00', '888888']);
      bookBufs[SER + '第二部/ch1.cbz'] = mkCbz(['123456']);
      bookBufs['lib/doc.pdf'] = Buffer.from('%PDF-1.4 fake');
      bookBufs['lib/old.cbr'] = Buffer.from('Rar!');
      iv.virtual['lib/系列A'] = [{ name: 'notes.txt', size: 5 }, { name: '.DS_Store', size: 6148 }, { name: 'Thumbs.db', size: 9 }];
      const plog = () => iv.log.filter((e) => e.method === 'PROPFIND');
      const toastText = () => cdp.eval(`return document.querySelector('#toast').textContent;`);
      const disp = (sel) => cdp.eval(`return getComputedStyle(document.querySelector(${JSON.stringify(sel)})).display;`);
      const key = (k) => cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true })); return 1;`);
      const bookKeyIs = (rel, n) => `window.__IV.state().bookKey === ${JSON.stringify('dav:' + rel)} && window.__IV.state().total === ${n}`;
      const shelfIs = (rel) => `!document.querySelector('#shelf').classList.contains('hidden') && window.__IV.shelfState().rel === ${JSON.stringify(rel)} && !!window.__IV.shelfState().data`;

      /* ---- 0) file:// 没有 WebDAV：上一本 / 下一本不显示，按 N 只给提示 ---- */
      await fresh(url.pathToFileURL(PAGE).href);
      const fileMode = await cdp.eval(`window.__IV.volStep(1); await window.__IV.wait(150);
        return { prev: getComputedStyle(document.querySelector('#btnVolPrev')).display, next: getComputedStyle(document.querySelector('#btnVolNext')).display,
          toast: document.querySelector('#toast').textContent };`);
      check('file://（没有 WebDAV）：上一本 / 下一本不显示；N 只提示「不是从云端书库打开的」', fileMode.prev === 'none' && fileMode.next === 'none' && /不是从云端书库/.test(fileMode.toast), fileMode);

      /* ---- 1) 从书架进「lib/系列A」：书架这一次 PROPFIND 同时把列表缓存给「换书」用 ---- */
      await fresh(IVURL);
      check('http 页面、没打开书：没有上一本 / 下一本', (await disp('#btnVolNext')) === 'none' && (await disp('#btnVolPrev')) === 'none');
      await cdp.eval(`localStorage.setItem('iv.home.shelf.v1', '0'); localStorage.setItem('iv.shelf.dir.v1', 'lib/系列A'); document.querySelector('#startShelf').click(); return 1;`);
      await waitFor(shelfIs('lib/系列A'), 8000);
      const serRows = await cdp.eval(`return Array.from(document.querySelectorAll('#shelfList .shelf-row')).map((b) => b.querySelector('.nm').textContent);`);
      check('书架只列 epub / cbz / zip（rar / txt 不列），书按自然顺序（vol 2 < vol 10）', JSON.stringify(serRows) === JSON.stringify(['第二部', 'vol 1.cbz', 'vol 2.cbz', 'vol 5.epub', 'vol 10.cbz']), serRows);
      check('书架列过的文件夹进了「换书」缓存', (await cdp.eval(`return window.__IV.volCache();`)).includes('lib/系列A'));
      const g0 = iv.log.length, pn = plog().length;
      await cdp.eval(`document.querySelector('#shelfList .shelf-row[data-book="lib/系列A/vol 2.cbz"]').click(); return 1;`);
      await waitFor(bookKeyIs(SER + 'vol 2.cbz', 3), 8000);
      const s2 = await stateOf();
      check('点书：key = dav:<相对路径>，3 页', s2.bookKey === 'dav:' + SER + 'vol 2.cbz' && s2.total === 3 && s2.bookTitle === 'vol 2.cbz', { k: s2.bookKey, t: s2.total });
      check('打开书没有多发 PROPFIND', plog().length === pn, iv.log.slice(g0).map((e) => e.method + ' ' + e.status));

      /* ---- 2) 上一本 / 下一本：同一文件夹，保留每本书自己的进度与方向 ---- */
      check('按钮出现；vol 2 前后都有书（缓存里已有这个文件夹的列表）', (await disp('#btnVolNext')) !== 'none' && (await disp('#btnVolPrev')) !== 'none' &&
        await cdp.eval(`return !document.querySelector('#btnVolPrev').disabled && !document.querySelector('#btnVolNext').disabled;`));
      await cdp.eval(`document.querySelector('#btnVolPrev').click(); return 1;`);
      await waitFor(bookKeyIs(SER + 'vol 1.cbz', 3), 8000);
      check('「上一本」→ vol 1；它是第一本，上一本按钮变灰', await cdp.eval(`return document.querySelector('#btnVolPrev').disabled && !document.querySelector('#btnVolNext').disabled;`));
      const dirNow = await cdp.eval(`window.__IV.showPage(2); await __tick(); window.__IV.toggleDirection(); await __tick(); window.__IV.saveProgress(); return window.__IV.state().S.direction;`);
      await cdp.eval(`document.querySelector('#btnVolNext').click(); return 1;`);
      await waitFor(bookKeyIs(SER + 'vol 2.cbz', 3), 8000);
      await cdp.eval(`window.__IV.showPage(1); await __tick(); window.__IV.saveProgress(); return 1;`);
      await key('p');
      await waitFor(bookKeyIs(SER + 'vol 1.cbz', 3), 8000);
      await cdp.eval(`await __tick(); return 1;`);
      const back1 = await stateOf();
      check('P 键 → vol 1：回来仍在第 3 页、阅读方向没丢（每本书各自记住）', back1.index === 2 && back1.S.direction === dirNow, { idx: back1.index, dir: back1.S.direction, want: dirNow });
      await key('n');
      await waitFor(bookKeyIs(SER + 'vol 2.cbz', 3), 8000);
      await key('n');
      await waitFor(bookKeyIs(SER + 'vol 5.epub', 5), 8000);
      check('N 键：vol 2 → vol 5.epub（5 页；书架不列 vol 3.rar，换书也不会落到它）', (await stateOf()).bookTitle === 'vol 5.epub');
      await cdp.eval(`document.querySelector('#btnVolNext').click(); return 1;`);
      await waitFor(bookKeyIs(SER + 'vol 10.cbz', 4), 8000);
      check('→ vol 10.cbz（4 页）；已是最后一本：下一本按钮变灰', await cdp.eval(`return document.querySelector('#btnVolNext').disabled;`));
      await cdp.eval(`await window.__IV.volStep(1); return 1;`);
      check('最后一本再下一本 → 提示，书不变', /最后一本/.test(await toastText()) && (await stateOf()).bookKey === 'dav:' + SER + 'vol 10.cbz');
      check('整个换书过程只用了缓存的列表：没有新的 PROPFIND', plog().length === pn);

      /* ---- 3) 读到最后一页：温和的「下一本」入口 ---- */
      await key('p'); await waitFor(bookKeyIs(SER + 'vol 5.epub', 5), 8000);
      await key('p'); await waitFor(bookKeyIs(SER + 'vol 2.cbz', 3), 8000);
      await cdp.eval(`window.__IV.showPage(0); await __tick(); return 1;`);
      check('在第 1 页：没有「下一本」浮层', (await disp('#volNext')) === 'none');
      await cdp.eval(`window.__IV.showPage(2); await __tick(); return 1;`);
      const chip = await cdp.eval(`return { d: getComputedStyle(document.querySelector('#volNext')).display, t: document.querySelector('#volNext').textContent };`);
      check('最后一页：出现「下一本：vol 5.epub」', chip.d !== 'none' && /vol 5\.epub/.test(chip.t), chip);
      await cdp.eval(`document.querySelector('#toast').textContent = ''; window.__IV.next(); await window.__IV.wait(100); return 1;`);
      check('最后一页再翻页 → 提示还有下一本（按 N）', /最后一页/.test(await toastText()) && /vol 5/.test(await toastText()), await toastText());
      await cdp.eval(`document.querySelector('#volNext').click(); return 1;`);
      await waitFor(bookKeyIs(SER + 'vol 5.epub', 5), 8000);
      check('点浮层 → 打开 vol 5.epub，浮层收起', (await disp('#volNext')) === 'none');

      /* ---- 4) #open= 打开的书：第一次用到才去列父文件夹 ---- */
      // vol 2 上次停在最后一页：先把它的进度改回第 1 页，否则一打开就读到末页、立刻去列文件夹
      await cdp.eval(`const b = window.__IV.books(); b['dav:lib/系列A/vol 2.cbz'].index = 0; localStorage.setItem('iv.books.v1', JSON.stringify(b)); return 1;`);
      const pLazy = plog().length;
      await fresh(IVURL + hashFor(SER + 'vol 2.cbz'));
      await waitFor(bookKeyIs(SER + 'vol 2.cbz', 3), 8000);
      check('#open= 打开后，上一本 / 下一本 按钮出现，但还没有列文件夹（没发 PROPFIND）', (await disp('#btnVolNext')) !== 'none' && plog().length === pLazy);
      await cdp.eval(`window.__IV.showPage(0); await __tick(); window.__IV.showPage(2); await __tick(); return 1;`);
      await waitFor(`getComputedStyle(document.querySelector('#volNext')).display !== 'none'`, 8000);
      const lazyReq = plog().slice(pLazy);
      check('读到最后一页才列一次父文件夹（1 个 PROPFIND，Depth:1），随后出现「下一本」', lazyReq.length === 1 && lazyReq[0].path === '/library/lib/%E7%B3%BB%E5%88%97A/' && lazyReq[0].depth === '1', lazyReq.map((e) => e.path));
      await cdp.eval(`document.querySelector('#btnVolNext').click(); return 1;`);
      await waitFor(bookKeyIs(SER + 'vol 5.epub', 5), 8000);
      check('随后换书用的是刚列出的缓存，不再请求', plog().length === pLazy + 1);
      check('从 #open= 来的书换书后 hash 仍是干净的', (await cdp.eval(`return location.hash;`)) === '');

      /* ---- 5) 书架重新读目录 / 忘记账号：换书缓存一起作废（旧账号看到的目录不能再用） ---- */
      check('（前置）换书缓存里有 lib/系列A', (await cdp.eval(`return window.__IV.volCache();`)).includes('lib/系列A'));
      await cdp.eval(`localStorage.setItem('iv.shelf.dir.v1', ''); document.querySelector('#btnShelf').click(); return 1;`);
      await waitFor(shelfIs(''), 8000);
      check('打开书架（= 重新读目录）：旧缓存先清掉，只剩书架刚列的根目录', JSON.stringify(await cdp.eval(`return window.__IV.volCache();`)) === '[""]', await cdp.eval(`return window.__IV.volCache();`));
      await cdp.eval(`document.querySelector('#shelf [data-close]').click(); window.__IV.askDav(); return 1;`);
      await waitFor(dlgOpen, 5000);
      await cdp.eval(`document.querySelector('#davForget').click(); return 1;`);
      await waitFor(`!${dlgOpen}`, 5000);
      check('忘记此设备：换书缓存清空', (await cdp.eval(`return window.__IV.volCache();`)).length === 0);

      /* ---- 6) rar / cbr 不能打开（说明原因）；pdf 走钩子，没接上就提示 ---- */
      await fresh(IVURL);
      await cdp.eval(`window.__IV.askDav(); return 1;`);
      await waitFor(dlgOpen, 5000);
      await cdp.eval(`document.querySelector('#davBase').value = '${iv.origin}'; document.querySelector('#davUser').value = 'viewer'; document.querySelector('#davPass').value = 'pä ss'; document.querySelector('#davSave').click(); return 1;`);
      await waitFor(`!${dlgOpen}`, 5000);
      const gRar = iv.log.length;
      await cdp.eval(`window.__IV.applyLaunchHash(${JSON.stringify(hashFor(SER + 'vol 3.rar'))}); return 1;`);
      await sleep(500);
      check('#open= 指向 rar：解释为什么打不开（浏览器不能随机读取 → 先转成 cbz），没打开任何书', /这是 rar.*不能随机读取.*cbz/.test(await toastText()) && (await stateOf()).total === 0, await toastText());
      check('指向 rar 没有向服务器取这个文件', iv.log.slice(gRar).every((e) => !/vol%203\.rar/.test(e.path)));
      await cdp.eval(`window.__IV.applyLaunchHash(${JSON.stringify(hashFor('lib/old.cbr'))}); return 1;`);
      await sleep(400);
      check('#open= 指向 cbr 同样解释，同样没请求这个文件', /这是 cbr.*cbz/.test(await toastText()) && iv.log.slice(gRar).every((e) => !/old\.cbr/.test(e.path)), await toastText());
      await cdp.eval(`window.__IV.applyLaunchHash(${JSON.stringify(hashFor('lib/doc.pdf'))}); return 1;`);
      await sleep(400);
      check('#open= 指向 pdf（还没接 pdf 阅读器）→「暂不支持 PDF」，没请求这个文件', /暂不支持 PDF/.test(await toastText()) && iv.log.slice(gRar).every((e) => !/doc\.pdf/.test(e.path)), await toastText());
      await cdp.eval(`window.__pdf = []; window.__IV.setDavPdfHook((p, ctx) => { window.__pdf.push({ rel: p.rel, url: ctx.url, key: ctx.key,
        auth: typeof ctx.authHeader === 'function' && /^Basic /.test(ctx.authHeader()) }); return Promise.resolve(true); }); return 1;`);
      await cdp.eval(`window.__IV.applyLaunchHash(${JSON.stringify(hashFor('lib/doc.pdf'))}); return 1;`);
      await sleep(400);
      const pdfCalls = await cdp.eval(`return window.__pdf;`);
      check('pdf 钩子接上之后：调用钩子（相对路径 / URL / key / 带账号头）', pdfCalls.length === 1 && pdfCalls[0].rel === 'lib/doc.pdf' &&
        pdfCalls[0].url === iv.origin + '/library/lib/doc.pdf' && pdfCalls[0].key === 'dav:lib/doc.pdf' && pdfCalls[0].auth, pdfCalls);
      await cdp.eval(`window.__IV.setDavPdfHook(null); return 1;`);
      check('换书 / 打开全程 CSP 零违规', (await cdp.eval(`return window.__csp || [];`)).length === 0, await cdp.eval(`return window.__csp || [];`));
      await fresh(IVURL);
      {
      /* ======== [23d] 换书评审修复：连按「下一本」/ 打不开的下一本 / 换账号作废缓存 / 书架开着时换书热键 / 手机换书条 ======== */
      log('\n[23d] 换书评审修复：连按「下一本」、下一本打不开、换账号 / 忘记作废缓存、书架开着时热键、手机换书条');
      for (const n of ['a', 'b', 'c', 'd']) bookBufs['fast/' + n + '.cbz'] = mkCbz(['aa0000', '00aa00', '0000aa']);
      for (const n of ['a', 'c']) bookBufs['bad/' + n + '.cbz'] = mkCbz(['aa0000', '00aa00', '0000aa']);
      iv.virtual['bad'] = [{ name: 'b-ghost.cbz', size: 123 }];             // 列得出来，取书时 404：打不开的下一本
      bookBufs['chap/ch.cbz'] = buildZip(['c1/01.png', 'c1/02.png', 'c2/01.png'].map((n, i) => ({ name: n, store: true, data: pngBytes(100, 150, ['aa0000', '00aa00', '0000aa'][i]) })));
      const hitsOf = (rel) => iv.log.filter((e) => e.path === '/library/' + rel.split('/').map(encodeURIComponent).join('/')).length;

      /* ---- 3) 连按「下一本」：只换一次，不重复打开 / 不连跳；下一本打不开 → 留在当前这本 ---- */
      iv.slow['fast/b.cbz'] = 400;                  // b 每个请求慢 400ms：开书要好几百毫秒，期间会有新的按键进来
      await fresh(IVURL + hashFor('fast/a.cbz'));
      await waitFor(bookKeyIs('fast/a.cbz', 3), 8000);
      const hb0 = hitsOf('fast/b.cbz');
      await key('n');
      await waitFor(bookKeyIs('fast/b.cbz', 3), 8000);
      await sleep(400);
      const oneOpen = hitsOf('fast/b.cbz') - hb0;
      check('（基线）按一次 N：换到 b.cbz', (await stateOf()).bookKey === 'dav:fast/b.cbz' && oneOpen > 0, oneOpen);
      await fresh(IVURL + hashFor('fast/a.cbz'));
      await waitFor(bookKeyIs('fast/a.cbz', 3), 8000);
      const hb1 = hitsOf('fast/b.cbz'), hc1 = hitsOf('fast/c.cbz');
      await cdp.eval(`for (let i = 0; i < 5; i++) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true })); await window.__IV.wait(120); } return 1;`);
      await waitFor(bookKeyIs('fast/b.cbz', 3), 8000);
      await sleep(900);
      check('b 还在打开的时候又连按 5 次 N：只换一本（停在 b，没有连跳到 c / d）', (await stateOf()).bookKey === 'dav:fast/b.cbz' && hitsOf('fast/c.cbz') === hc1, { key: (await stateOf()).bookKey, c: hitsOf('fast/c.cbz') - hc1 });
      check('连按期间 b.cbz 只被打开一次（请求数和只按一次时相同）', hitsOf('fast/b.cbz') - hb1 === oneOpen, { one: oneOpen, many: hitsOf('fast/b.cbz') - hb1 });
      delete iv.slow['fast/b.cbz'];
      await key('n');
      await waitFor(bookKeyIs('fast/c.cbz', 3), 8000);
      check('换完之后再按 N 照常继续（锁已释放）：c.cbz', (await stateOf()).bookKey === 'dav:fast/c.cbz');
      /* 打不开的下一本 */
      await fresh(IVURL + hashFor('bad/a.cbz'));
      await waitFor(bookKeyIs('bad/a.cbz', 3), 8000);
      await cdp.eval(`window.__IV.showPage(1); await __tick(); window.__IV.saveProgress(); return 1;`);
      const badRes = await cdp.eval(`await window.__IV.volStep(1); await window.__IV.wait(150);
        const s = window.__IV.state(), b = window.__IV.books()['dav:bad/a.cbz'];
        return { key: s.bookKey, total: s.total, index: s.index, toast: document.querySelector('#toast').textContent, rec: b && b.index };`);
      check('下一本（b-ghost.cbz）打不开 → 仍停在当前这本：书 / 页码不变，进度记录还在，提示说明停在当前这本',
        badRes.key === 'dav:bad/a.cbz' && badRes.total === 3 && badRes.index === 1 && badRes.rec === 1 && /b-ghost\.cbz/.test(badRes.toast) && /仍停在当前这本/.test(badRes.toast), badRes);
      const again = await cdp.eval(`document.querySelector('#toast').textContent = ''; const t0 = Date.now(); await window.__IV.volStep(1); return { ms: Date.now() - t0, toast: document.querySelector('#toast').textContent };`);
      check('失败之后锁也释放了：再按一次同样给提示（没有卡住）', again.ms < 5000 && /仍停在当前这本/.test(again.toast), again);

      /* ---- 4) 换账号：换书缓存作废；换完账号再换书时重新列目录 ---- */
      await fresh(IVURL);
      await cdp.eval(`localStorage.setItem('iv.home.shelf.v1', '0'); localStorage.setItem('iv.shelf.dir.v1', 'fast'); document.querySelector('#startShelf').click(); return 1;`);
      await waitFor(shelfIs('fast'), 8000);
      check('（前置）换账号前：换书缓存里有 fast', (await cdp.eval(`return window.__IV.volCache();`)).includes('fast'));
      iv.user = 'viewer2';
      await cdp.eval(`window.__IV.askDav(); return 1;`);
      await waitFor(dlgOpen, 5000);
      await cdp.eval(`document.querySelector('#davUser').value = 'viewer2'; document.querySelector('#davSave').click(); return 1;`);
      await waitFor(`!${dlgOpen}`, 5000);
      check('换成另一个账号：旧账号的换书缓存清空', (await cdp.eval(`return window.__IV.volCache();`)).length === 0, await cdp.eval(`return window.__IV.volCache();`));
      iv.user = 'viewer';
      await cdp.eval(`document.querySelector('#shelf [data-close]').click(); window.__IV.askDav(); return 1;`);
      await waitFor(dlgOpen, 5000);
      await cdp.eval(`document.querySelector('#davUser').value = 'viewer'; document.querySelector('#davSave').click(); return 1;`);
      await waitFor(`!${dlgOpen}`, 5000);

      /* ---- 5) 书架开着：焦点在列表行 / 按钮上，换书 / 翻页等热键都不能穿透 ---- */
      await fresh(IVURL + hashFor('fast/b.cbz'));
      await waitFor(bookKeyIs('fast/b.cbz', 3), 8000);
      await cdp.eval(`window.__IV.showPage(1); await __tick(); localStorage.setItem('iv.shelf.dir.v1', 'fast'); return 1;`);
      await key('l');
      await waitFor(shelfIs('fast'), 8000);
      const before = await cdp.eval(`const s = window.__IV.state(); return { index: s.index, key: s.bookKey, auto: s.autoOn, spread: s.S.spread, dir: s.S.direction, trim: s.S.trim, book: s.S.book };`);
      const hk = await cdp.eval(`const row = document.querySelector('#shelfList .shelf-row'); row.focus();
        const keys = ['ArrowRight', 'ArrowLeft', 'PageDown', 'a', 'A', 'n', 'N', 'p', 'P', 'd', 'm', 'c', 'b', 'g', 'Home', 'End', 'r', 't', 'i', 'h'];
        for (const k of keys) row.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        const btn = document.querySelector('#shelfReload'); btn.focus();
        for (const k of ['ArrowRight', 'a', 'n']) btn.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        await window.__IV.wait(500);
        const s = window.__IV.state();
        return { index: s.index, key: s.bookKey, auto: s.autoOn, spread: s.S.spread, dir: s.S.direction, trim: s.S.trim, book: s.S.book,
          jump: !document.querySelector('#jump').classList.contains('hidden'), help: !document.querySelector('#help').classList.contains('hidden'),
          detail: !document.querySelector('#detail').classList.contains('hidden'), shelf: !document.querySelector('#shelf').classList.contains('hidden') };`);
      check('书架开着、焦点在列表行 / 按钮上：方向键、A、N、P、D、M、G、Home/End… 一个都不触发（页码 / 书 / 模式不变，也不弹别的框）',
        JSON.stringify({ index: hk.index, key: hk.key, auto: hk.auto, spread: hk.spread, dir: hk.dir, trim: hk.trim, book: hk.book }) === JSON.stringify(before) && !hk.jump && !hk.help && !hk.detail && hk.shelf, { before, hk });
      await cdp.eval(`document.querySelector('#shelfList .shelf-row').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1;`);
      check('书架开着时 Esc 照常关闭', !(await cdp.eval(`return !document.querySelector('#shelf').classList.contains('hidden');`)));
      await key('ArrowRight');
      check('关掉书架后热键恢复', (await stateOf()).index === before.index + 1, (await stateOf()).index);

      /* ---- 6) 手机宽度：「上一本 / 下一本」不用横向滚工具栏就够得着 ---- */
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
      await fresh(IVURL + hashFor('fast/b.cbz'));
      await waitFor(bookKeyIs('fast/b.cbz', 3), 8000);
      const ph2 = await cdp.eval(`const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect();
          return { d: getComputedStyle(e).display, l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height), dis: !!e.disabled }; };
        const tb = document.querySelector('#toolbar');
        return { w: innerWidth, next: r('#volBarNext'), prev: r('#volBarPrev'), bar: r('#volBar'), tbNext: r('#btnVolNext'), tbScroll: tb.scrollLeft, tbOverflow: tb.scrollWidth > tb.clientWidth,
          vpTop: parseFloat(document.querySelector('#viewport').style.top), docSw: document.documentElement.scrollWidth };`);
      const inView = (x) => x && x.d !== 'none' && x.l >= 0 && x.r <= ph2.w && x.w >= 60 && x.h >= 36;
      check('手机宽度：「下一本」「上一本」在屏幕内、够大、不用横向滚工具栏（工具栏未滚动）', inView(ph2.next) && inView(ph2.prev) && ph2.tbScroll === 0 && ph2.docSw <= ph2.w, ph2);
      check('手机宽度：工具栏里那两个（会被挤到屏幕外的）不再重复显示；换书条在工具栏下面，图片区让开它', ph2.tbNext && ph2.tbNext.d === 'none' && ph2.bar && ph2.bar.t >= 40 && ph2.vpTop >= ph2.bar.b, ph2);
      await cdp.eval(`document.querySelector('#volBarNext').click(); return 1;`);
      await waitFor(bookKeyIs('fast/c.cbz', 3), 8000);
      check('手机宽度：点换书条上的「下一本」→ 换到 c.cbz', (await stateOf()).bookKey === 'dav:fast/c.cbz');
      await cdp.eval(`document.querySelector('#volBarPrev').click(); return 1;`);
      await waitFor(bookKeyIs('fast/b.cbz', 3), 8000);
      check('手机宽度：点「上一本」→ 回到 b.cbz', (await stateOf()).bookKey === 'dav:fast/b.cbz');
      await fresh(IVURL + hashFor('chap/ch.cbz'));
      await waitFor(bookKeyIs('chap/ch.cbz', 3), 8000);
      const ph3 = await cdp.eval(`const r = (sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom) }; };
        return { ch: document.querySelector('#chapterBar').classList.contains('show'), bar: r('#volBar'), cbar: r('#chapterBar'), vpTop: parseFloat(document.querySelector('#viewport').style.top) };`);
      check('手机宽度 + 多章节：章节条在换书条下面（不重叠），图片区再让开章节条', ph3.ch && ph3.cbar.t >= ph3.bar.b - 1 && ph3.vpTop >= ph3.cbar.b - 1, ph3);
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      /* 桌面宽度：布局不变（换书条不出现，工具栏里的按钮照旧，图片区顶部 = 工具栏高度） */
      await fresh(IVURL + hashFor('fast/b.cbz'));
      await waitFor(bookKeyIs('fast/b.cbz', 3), 8000);
      const dk = await cdp.eval(`const e = document.querySelector('#btnVolNext').getBoundingClientRect();
        return { bar: getComputedStyle(document.querySelector('#volBar')).display, btn: getComputedStyle(document.querySelector('#btnVolNext')).display,
          inView: e.right <= innerWidth && e.left >= 0, vpTop: parseFloat(document.querySelector('#viewport').style.top), tb: document.querySelector('#toolbar').offsetHeight };`);
      check('桌面宽度不变：没有换书条，工具栏里的「下一本」照旧可见，图片区顶部 = 工具栏高度', dk.bar === 'none' && dk.btn !== 'none' && dk.inView && dk.vpTop === dk.tb, dk);
      await fresh(IVURL);
      }
      iv.close();
    }

    log('\n[24] 无未捕获异常');
    const errs = await cdp.eval(`return (window.__errs || []).slice(0, 8)`);
    check('window.onerror / unhandledrejection 干净', !errs || !errs.length, errs);

    log(`\n结果：${pass} 通过 / ${fail} 失败`);
  } catch (e) {
    fail++;
    console.error('\n\x1b[31m测试执行出错：\x1b[0m', (e && e.stack) || e);
    if (stderr) console.error('chrome stderr:\n' + stderr.slice(-600));
  } finally {
    try { ws && ws.close(); } catch (e) {}
    proc.kill();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
  process.exit(fail ? 1 : 0);
})();
