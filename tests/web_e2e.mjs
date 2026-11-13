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
const PAGE = process.env.IV_PAGE ? path.resolve(process.env.IV_PAGE) : path.join(ROOT, 'image-viewer.html');   // IV_PAGE：指向别的 html（比如 git 里取出的旧版本），用来验证新增测试在旧代码上会失败

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
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method) for (const l of this.listeners) l(msg);          // 事件（带 sessionId 的是 worker 等子目标的）
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
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

/* ------------------------- Node 侧造 PDF（pdf.js 读取 / 按需取字节测试用）-------------------------
   页面种类：text（Helvetica + ZapfDingbats 非嵌入标准字体 + 黑块）/ image（RGB 图 XObject）/
            cjk（Type0 非嵌入 STSong-Light + UniGB-UCS2-H，逼 pdf.js 取 cmap）/
            scan（页面自带一张 scanKB 大小的整页灰度图，像扫描书：只有读到这一页才需要它那段字节）。
   纸张：w / h（pt）、rot（/Rotate）。classic xref 表在文件末尾，不是线性化、也不是 object stream。
   interleave=false：所有页面对象排在最前面、各页的图像在后面（紧凑：打开 / 翻页只碰开头、结尾和这页自己的图）；
   interleave=true ：每页的图像紧跟在这页后面（pdf.js 走平铺页树找第 N 页时会碰到前面几乎所有页，只能保证「没有 200、不重复下载」）。
   图像内容是常量灰 + 顶部一条深色带（大小靠「不压缩存储」撑起来，渲染和 JPEG 编码都很便宜）。
   encrypt=true 带一个对不上密码的 /Encrypt（应报「需要密码」）；rtl=true 声明 /ViewerPreferences /Direction /R2L。 */
function buildPdf(o) {
  const pages = o.pages, N = pages.length, scanBytes = (o.scanKB || 140) * 1024, SCAN_W = 1024;
  const parts = []; let len = 0; const offs = [];
  const add = (b) => { parts.push(b); len += b.length; };
  const obj = (n, body) => { offs[n] = len; add(Buffer.from(n + ' 0 obj\n')); add(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1')); add(Buffer.from('\nendobj\n')); };
  const stream = (dict, data) => Buffer.concat([Buffer.from('<< ' + dict + ' /Length ' + data.length + ' >>\nstream\n', 'latin1'), data, Buffer.from('\nendstream')]);
  const firstPage = 10, scanId = {}; let nextId = firstPage + 2 * N;
  pages.forEach((p, i) => { if (p.kind === 'scan') scanId[i] = nextId++; });
  const encId = nextId, maxId = o.encrypt ? encId : encId - 1;
  const scanImg = () => {
    const b = Buffer.alloc(scanBytes, 0xc0); b.fill(0x20, 0, SCAN_W * 20);
    return stream('/Type /XObject /Subtype /Image /Width ' + SCAN_W + ' /Height ' + (scanBytes / SCAN_W) + ' /ColorSpace /DeviceGray /BitsPerComponent 8', b);
  };
  add(Buffer.from('%PDF-1.5\n%\xE2\xE3\xCF\xD3\n', 'latin1'));
  obj(1, '<< /Type /Catalog /Pages 2 0 R /PageLayout /SinglePage' + (o.rtl ? ' /ViewerPreferences << /Direction /R2L >>' : '') + ' >>');
  obj(2, '<< /Type /Pages /Kids [' + pages.map((_, i) => (firstPage + 2 * i) + ' 0 R').join(' ') + '] /Count ' + N + ' >>');
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  obj(4, '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light-UniGB-UCS2-H /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>');
  obj(5, '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor 6 0 R /DW 1000 >>');
  obj(6, '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>');
  const img = Buffer.alloc(64 * 64 * 3);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const q = (y * 64 + x) * 3; img[q] = x * 4; img[q + 1] = 40; img[q + 2] = y * 4; }
  obj(7, stream('/Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8', img));
  obj(8, '<< /Font << /F1 3 0 R /F2 4 0 R /F3 9 0 R >> /XObject << /Im1 7 0 R >> >>');
  obj(9, '<< /Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats >>');
  for (let i = 0; i < N; i++) {
    const pg = pages[i], w = pg.w || 612, h = pg.h || 792, n = i + 1;
    let c, res = '/Resources 8 0 R';
    if (pg.kind === 'image') c = 'q 200 0 0 200 72 ' + (h - 320) + ' cm /Im1 Do Q BT /F1 18 Tf 72 ' + (h - 340) + ' Td (image page ' + n + ') Tj ET';
    else if (pg.kind === 'cjk') c = 'BT /F2 28 Tf 72 ' + (h - 100) + ' Td <4E2D65876D4B8BD5> Tj ET 0 0 0 rg 72 ' + (h - 200) + ' 200 40 re f';
    else if (pg.kind === 'ink') c = (pg.bars || [[72, w - 72]]).map((b) => '0 g ' + b[0] + ' 100 ' + (b[1] - b[0]) + ' ' + (h - 200) + ' re f').join(' ');
    else if (pg.kind === 'scan') {
      c = 'q ' + w + ' 0 0 ' + h + ' 0 0 cm /Im1 Do Q BT /F1 20 Tf 72 ' + (h / 2) + ' Td (Scan page ' + n + ') Tj ET';
      res = '/Resources << /Font << /F1 3 0 R >> /XObject << /Im1 ' + scanId[i] + ' 0 R >> >>';
    } else c = 'BT /F1 36 Tf 72 ' + (h - 100) + ' Td (Hello PDF page ' + n + ') Tj ET BT /F3 24 Tf 72 ' + (h - 140) + ' Td (abc) Tj ET 0 0 0 rg 72 ' + (h - 220) + ' 200 40 re f';
    obj(firstPage + 2 * i, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + w + ' ' + h + '] ' + (pg.rot ? '/Rotate ' + pg.rot + ' ' : '') + res + ' /Contents ' + (firstPage + 2 * i + 1) + ' 0 R >>');
    obj(firstPage + 2 * i + 1, stream('', Buffer.from(c, 'latin1')));
    if (o.interleave && pg.kind === 'scan') obj(scanId[i], scanImg());
  }
  if (!o.interleave) pages.forEach((p, i) => { if (p.kind === 'scan') obj(scanId[i], scanImg()); });
  if (o.encrypt) obj(encId, '<< /Filter /Standard /V 1 /R 2 /O <' + 'ab'.repeat(32) + '> /U <' + 'cd'.repeat(32) + '> /P -4 >>');
  const xref = len;
  let x = 'xref\n0 ' + (maxId + 1) + '\n0000000000 65535 f \n';
  for (let n = 1; n <= maxId; n++) x += String(offs[n]).padStart(10, '0') + ' 00000 n \n';
  x += 'trailer\n<< /Size ' + (maxId + 1) + ' /Root 1 0 R' + (o.encrypt ? ' /Encrypt ' + encId + ' 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>]' : '') + ' >>\nstartxref\n' + xref + '\n%%EOF\n';
  add(Buffer.from(x, 'latin1'));
  return Buffer.concat(parts);
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
    virtual: {}, listSlow: {}, denyList: false, vendor: [],
    ocr: { log: [], token: 'ocr-secret', script: null, delay: 5, inflight: 0, maxInflight: 0, usageLog: [], pagesToday: 0 } };   // /ocr/v1/*：假的识别服务（和 deploy/server/ocr/server.py 同一份契约）
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
    if (p.startsWith('/iv/vendor/')) {      // pdf.js 本体 + cmaps + 标准字体（真实部署里同样是 /iv/ 下的静态文件，带同一条 CSP；不带也不该带账号头）
      const f = path.normalize(path.join(ROOT, p.slice('/iv/'.length)));
      const ok = f.startsWith(path.join(ROOT, 'vendor') + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile();
      S.vendor.push({ path: p, status: ok ? 200 : 404, auth: !!req.headers.authorization, range: !!req.headers.range });
      if (!ok) return send(404, 'text/plain', 'nf');
      return send(200, /\.js$/.test(f) ? 'text/javascript' : /\.wasm$/.test(f) ? 'application/wasm' : 'application/octet-stream', fs.readFileSync(f),
        { 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' });
    }
    if (p === '/reader/') return send(200, 'text/html; charset=utf-8', '<title>reader</title>reader');
    if (p.startsWith('/ocr/v1/')) {     // 同源 /ocr/v1/*（真实部署里 Caddy 反代到识别服务；页面 CSP connect-src 'self' 就够）
      const O = S.ocr, auth = req.headers.authorization || '';
      const json = (code, obj, extra) => send(code, 'application/json; charset=utf-8', JSON.stringify(obj), Object.assign({ 'Cache-Control': 'no-store' }, extra || {}));
      if (p === '/ocr/v1/usage' && req.method === 'GET') {
        O.usageLog.push({ auth });
        if (auth !== 'Bearer ' + O.token) return json(401, { error: 'unauthorized', code: 'unauthorized' });
        return json(200, { pagesToday: O.pagesToday, pagesLimit: 300, pagesMonth: O.pagesToday, monthLimit: 6000, model: 'qwen3.8-flash' });
      }
      if (p === '/ocr/v1/page' && req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const ent = { auth, ok: false, status: 0, aborted: false, t: Date.now(), n: O.log.length };
          O.log.push(ent);
          res.on('close', () => { if (!res.writableFinished) ent.aborted = true; });
          const body = Buffer.concat(chunks);
          if (auth !== 'Bearer ' + O.token) { ent.status = 401; return json(401, { error: 'unauthorized', code: 'unauthorized' }); }
          let rq;
          try { rq = JSON.parse(body.toString('utf8')); } catch (e) { ent.status = 400; return json(400, { error: 'bad request', code: 'bad_request' }); }
          ent.mode = rq.mode; ent.pageId = rq.pageId; ent.bodyBytes = body.length;
          const m = /^b[0-9a-f]+:p(\d+):([A-Z])$/.exec(rq.pageId || '');
          ent.page = m ? +m[1] : 0; ent.leaf = m ? m[2] : '?';
          if (!['vertical-classical', 'horizontal'].includes(rq.mode)) { ent.status = 400; return json(400, { error: 'unknown mode', code: 'bad_mode' }); }
          if (rq.mime !== 'image/jpeg') { ent.status = 415; return json(415, { error: 'only jpeg', code: 'bad_image' }); }
          const img = Buffer.from(String(rq.image || ''), 'base64');
          ent.bytes = img.length;
          if (img.length > 1200 * 1024) { ent.status = 413; return json(413, { error: 'too large', code: 'too_large' }); }
          // 和服务端 jpeg_dims 一样：只走标记头读宽高
          let dims = null;
          if (img.length > 4 && img[0] === 0xff && img[1] === 0xd8) {
            for (let i = 2; i + 9 < img.length;) {
              if (img[i] !== 0xff) break;
              const mk = img[i + 1];
              if (mk === 0xff) { i++; continue; }
              if (mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7)) { i += 2; continue; }
              if (mk === 0xd9 || mk === 0xda) break;
              const len = (img[i + 2] << 8) | img[i + 3];
              if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(mk)) { dims = { h: (img[i + 5] << 8) | img[i + 6], w: (img[i + 7] << 8) | img[i + 8] }; break; }
              i += 2 + len;
            }
          }
          ent.dims = dims;
          if (!dims) { ent.status = 415; return json(415, { error: 'not a jpeg', code: 'bad_image' }); }
          if (Math.max(dims.w, dims.h) > 2048) { ent.status = 413; return json(413, { error: 'dims', code: 'too_large' }); }
          ent.ok = true;
          O.inflight++; O.maxInflight = Math.max(O.maxInflight, O.inflight);
          const plan = (O.script && O.script(ent, O.log.length - 1)) || {};
          setTimeout(() => {
            O.inflight--;
            if (ent.aborted) return;
            if (plan.status && plan.status !== 200) { ent.status = plan.status; return json(plan.status, plan.body || { error: 'x', code: 'x' }, plan.headers); }
            ent.status = 200;
            if (!plan.cached) O.pagesToday++;
            const text = plan.text !== undefined ? plan.text
              : '第' + ent.page + '页' + (ent.leaf === 'R' ? '右叶' : ent.leaf === 'L' ? '左叶' : '') + '正文，天地玄黄。【注：小注' + ent.page + '】宇宙洪荒。';
            json(200, { text, sentences: text.split(/(?<=[。！？])/), model: 'qwen3.8-flash', promptVer: 1, mode: rq.mode, cached: false,
              usage: { promptTokens: 2600, completionTokens: 200, pagesToday: O.pagesToday, pagesLimit: 300, pagesMonth: O.pagesToday, monthLimit: 6000 } });
          }, plan.delay !== undefined ? plan.delay : O.delay);
        });
        return;
      }
      req.resume();
      return json(404, { error: 'not found', code: 'not_found' });
    }
    if (p.startsWith('/library/')) {
      const ent = { method: req.method, path: u.pathname, range: req.headers.range || null,
        auth: !!req.headers.authorization, status: 0, bytes: 0 };
      S.log.push(ent);
      const want = 'Basic ' + Buffer.from(S.user + ':' + S.pass, 'utf8').toString('base64');
      if (req.headers.authorization !== want || S.denyList) {
        ent.status = 401;
        const reject = () => { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="lib"' }); res.end('no'); };
        const slow = req.method === 'PROPFIND' ? (S.listSlow[p.replace(/^\/library\/?/, '').replace(/\/+$/, '')] || 0) : 0;   // 慢列表的 401 也慢（模拟「飞着的时候账号被禁」）
        req.resume();
        return slow ? setTimeout(reject, slow) : reject();
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
        if (data.length === 0) {      // 空文件上任何 Range 都不可满足（Go http.ServeContent / Caddy / SFTPGo 的真实行为）
          ent.status = 416; ent.bytes = 0;
          res.writeHead(416, { 'Content-Range': 'bytes */0', 'Content-Length': 0 }); return res.end();
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
          const cur = key === 'direction' ? (iv.state().S.direction === 'rtl') : key === 'spread' ? iv.state().spread : iv.state().S[key];   // spread：PDF 里是书级的有效值，不是全局 S.spread
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
      const vp0 = document.querySelector('#hit');      // 鼠标 / 触摸事件的真实目标是不带变换的 #hit 命中层（见 [11b]），不是带 translate/scale 的 #viewport
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
      const vp = document.querySelector('#hit');      // 真实事件的目标：不带变换的命中层（[11b] 用真实 CDP 输入验证它确实接得到）
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
      // 滚轮 / 触控板（整页放得进窗口时滚轮缩放；捏合放大后页面已经比窗口大，先回适应窗口）
      iv.applyFit('window'); await __wait(30);
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
      const libReq0 = () => iv.vendor.filter((v) => /\/vendor\/libarchive\//.test(v.path)).length;
      /* ======== [23c] 读书时上一本 / 下一本：从云端书架打开 / #open= 打开 / rar·pdf 说明 ======== */
      log('\n[23c] 云端书：读书时「上一本 / 下一本」（同一文件夹相邻的书）；#open= 指向 rar / cbr / pdf 的说明');
      check('懒加载：[23c] 之前的所有 zip / cbz / epub / 本地 / 云端流程，没有发出任何 vendor/libarchive 请求', libReq0() === 0, iv.vendor.filter((v) => /libarchive/.test(v.path)).map((v) => v.path));
      const mkCbz = (hexes) => buildZip(hexes.map((h, i) => ({ name: String(i + 1).padStart(2, '0') + '.png', store: true, data: pngBytes(120, 180, h) })));
      const SER = 'lib/系列A/';
      bookBufs[SER + 'vol 1.cbz'] = mkCbz(['aa0000', '00aa00', '0000aa']);
      bookBufs[SER + 'vol 2.cbz'] = mkCbz(['aa5500', '55aa00', '0055aa']);
      bookBufs[SER + 'vol 3.mobi'] = Buffer.from('BOOKMOBI not a supported kind');
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

      /* ---- 0) 按钮的显示条件：http(s) 页 + 没连本地后端 + 打开的是云端书（dav: key）才出现 ----
         光「没开书所以不显示」什么也证明不了；这里每个场景都真的打开一本带 dav: key 的书，只改一个条件 */
      const openKeyed = `const it = [await __mk('01.png', 'b/01.png', 100, 150), await __mk('02.png', 'b/02.png', 100, 150)];
        window.__IV.openItems(it, { kind: 'dir', title: 'b', key: 'dav:lib/x/vol 1.cbz' }); await __tick(); return 1;`;
      const volVis = () => cdp.eval(`return { has: document.body.classList.contains('has-vol'), prev: getComputedStyle(document.querySelector('#btnVolPrev')).display, next: getComputedStyle(document.querySelector('#btnVolNext')).display };`);
      await fresh(url.pathToFileURL(PAGE).href);
      const fileNoBook = await cdp.eval(`await window.__IV.volStep(1); await window.__IV.wait(150); return document.querySelector('#toast').textContent;`);
      check('没打开云端书时按 N：只提示「不是从云端书库打开的」', /不是从云端书库/.test(fileNoBook), fileNoBook);
      await cdp.eval(openKeyed);
      const fileKeyed = await volVis();
      check('file://（没有 WebDAV）：就算打开的是 dav: key 的书，上一本 / 下一本也不显示', !fileKeyed.has && fileKeyed.prev === 'none' && fileKeyed.next === 'none', fileKeyed);
      await fresh(IVURL);
      await cdp.eval(openKeyed);
      const httpKeyed = await volVis();
      check('（对照）同一本书在 http 页面：按钮出现 —— 上一条的差别只来自 file:// 这一个条件', httpKeyed.has && httpKeyed.prev !== 'none' && httpKeyed.next !== 'none', httpKeyed);
      await cdp.eval(`window.__IV.backend().on = true; window.__IV.setDavPdfHook(null); return 1;`);
      const beKeyed = await volVis();
      check('连上本地后端（BE.on）：同一本书的按钮消失', !beKeyed.has && beKeyed.prev === 'none' && beKeyed.next === 'none', beKeyed);
      await cdp.eval(`window.__IV.backend().on = false; window.__IV.setDavPdfHook(null); return 1;`);
      const beOff = await volVis();
      check('后端断开（BE.on 复位）：按钮回来', beOff.has && beOff.next !== 'none', beOff);

      /* ---- 1) 从书架进「lib/系列A」：书架这一次 PROPFIND 同时把列表缓存给「换书」用 ---- */
      await fresh(IVURL);
      await cdp.eval(`localStorage.setItem('iv.home.shelf.v1', '0'); localStorage.setItem('iv.shelf.dir.v1', 'lib/系列A'); document.querySelector('#startShelf').click(); return 1;`);
      await waitFor(shelfIs('lib/系列A'), 8000);
      const serRows = await cdp.eval(`return Array.from(document.querySelectorAll('#shelfList .shelf-row')).map((b) => b.querySelector('.nm').textContent);`);
      check('书架只列能打开的书（vol 3.mobi / txt 不列），书按自然顺序（vol 2 < vol 10）', JSON.stringify(serRows) === JSON.stringify(['第二部', 'vol 1.cbz', 'vol 2.cbz', 'vol 5.epub', 'vol 10.cbz']), serRows);
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
      check('N 键：vol 2 → vol 5.epub（5 页；书架不列 vol 3.mobi，换书也不会落到它）', (await stateOf()).bookTitle === 'vol 5.epub');
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
      /* rar / cbr 现在由 libarchive.js 读（见 [23f]）：下载整个文件（一次 GET，没有 Range）再解；这里的文件不是真压缩包 → 明确的失败提示，没打开任何书 */
      await cdp.eval(`window.__IV.applyLaunchHash(${JSON.stringify(hashFor('lib/old.cbr'))}); return 1;`);
      await waitFor(`/压缩包(打开失败|里没有找到)/.test(document.querySelector('#toast').textContent)`, 20000);
      check('#open= 指向（假的）cbr：整本下载后交给解压组件，失败给出「压缩包…」提示，没打开任何书', /压缩包(打开失败|里没有找到)/.test(await toastText()) && (await stateOf()).total === 0, await toastText());
      const oldReq = iv.log.slice(gRar).filter((e) => /old\.cbr/.test(e.path));
      check('指向 cbr：只取了一次这个文件（整本 GET，不是 Range）', oldReq.length === 1 && oldReq[0].status === 200 && !oldReq[0].range, oldReq);
      await cdp.eval(`window.__IV.setDavPdfHook(null); return 1;`);      // 默认就接了真的 pdf 阅读器（见 [23e]）；这里测钩子没接上时的行为
      await cdp.eval(`window.__IV.applyLaunchHash(${JSON.stringify(hashFor('lib/doc.pdf'))}); return 1;`);
      await sleep(400);
      check('#open= 指向 pdf（钩子没接上）→「暂不支持 PDF」，没请求这个文件', /暂不支持 PDF/.test(await toastText()) && iv.log.slice(gRar).every((e) => !/doc\.pdf/.test(e.path)), await toastText());
      await cdp.eval(`window.__pdf = []; window.__IV.setDavPdfHook((p, ctx) => { window.__pdf.push({ rel: p.rel, url: ctx.url, key: ctx.key,
        auth: typeof ctx.authHeader === 'function' && /^Basic /.test(ctx.authHeader()) }); return Promise.resolve(true); }); return 1;`);
      await cdp.eval(`window.__IV.applyLaunchHash(${JSON.stringify(hashFor('lib/doc.pdf'))}); return 1;`);
      await sleep(400);
      const pdfCalls = await cdp.eval(`return window.__pdf;`);
      check('pdf 钩子接上之后：调用钩子（相对路径 / URL / key / 带账号头）', pdfCalls.length === 1 && pdfCalls[0].rel === 'lib/doc.pdf' &&
        pdfCalls[0].url === iv.origin + '/library/lib/doc.pdf' && pdfCalls[0].key === 'dav:lib/doc.pdf' && pdfCalls[0].auth, pdfCalls);
      await cdp.eval(`window.__IV.setDavPdfHook('default'); return 1;`);
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

      /* ---- 1) 连按「下一本」：只换一次，不重复打开 / 不连跳；下一本打不开 → 留在当前这本 ---- */
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

      /* ---- 2) 换账号：换书缓存作废；换完账号再换书时重新列目录 ---- */
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

      /* ---- 3) 书架开着：焦点在列表行 / 按钮上，换书 / 翻页等热键都不能穿透 ---- */
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

      /* ---- 4) 别的弹窗（帮助 / 详情）开着时，N / P 不换书（书架那一条在更前面就被拦了，测不到 !anyModal()） ---- */
      for (const [k, id] of [['h', 'help'], ['i', 'detail']]) {
        await key(k);
        const opened = await cdp.eval(`return !document.querySelector('#${id}').classList.contains('hidden');`);
        const bk0 = (await stateOf()).bookKey;
        await key('n'); await key('N'); await key('p'); await key('P');
        await sleep(500);
        const bk1 = (await stateOf()).bookKey;
        check('「' + id + '」开着：N / P 不换书', opened && bk1 === bk0 && bk0 === 'dav:fast/b.cbz', { opened, bk0, bk1 });
        await key('Escape');
      }
      await key('n');
      await waitFor(bookKeyIs('fast/c.cbz', 3), 8000);
      check('（对照）弹窗都关了：N 照常换书 → c.cbz', (await stateOf()).bookKey === 'dav:fast/c.cbz');

      /* ---- 5) 书架「刷新」按钮：清掉换书缓存（和换账号一样），再只登记刷新出来的这个文件夹 ---- */
      await fresh(IVURL);
      await cdp.eval(`localStorage.setItem('iv.home.shelf.v1', '0'); localStorage.setItem('iv.shelf.dir.v1', ''); document.querySelector('#startShelf').click(); return 1;`);
      await waitFor(shelfIs(''), 8000);
      await cdp.eval(`document.querySelector('#shelfList .shelf-row[data-dir="fast"]').click(); return 1;`);
      await waitFor(shelfIs('fast'), 8000);
      const cacheBefore = await cdp.eval(`return window.__IV.volCache().slice().sort();`);
      check('（前置）逛了根目录和 fast：换书缓存里有这两个文件夹', JSON.stringify(cacheBefore) === JSON.stringify(['', 'fast']), cacheBefore);
      const pr0 = plog().length;
      await cdp.eval(`document.querySelector('#shelfReload').click(); return 1;`);
      for (let i = 0; i < 40 && plog().length === pr0; i++) await sleep(100);
      await waitFor(shelfIs('fast'), 8000);
      const cacheAfter = await cdp.eval(`return window.__IV.volCache();`);
      check('点书架「刷新」：旧缓存作废（根目录那份没了），只剩刷新出来的 fast', plog().length === pr0 + 1 && JSON.stringify(cacheAfter) === JSON.stringify(['fast']), { n: plog().length - pr0, cacheAfter });

      /* ---- 6) 换书那一刻：旧书的最后一页就存、就推到云端（不等 3 秒去抖，那时 bookKey 已经是新书了） ---- */
      await fresh(IVURL);
      await cdp.eval(`await window.__IV.davStore({ base: '${iv.origin}', library: 'library', user: 'viewer', pass: 'pä ss', syncDir: 'users/gary/iv-progress', syncUser: 'writer', syncPass: 'w pass' }); return 1;`);
      await fresh(IVURL + hashFor('fast/a.cbz'));
      await waitFor(bookKeyIs('fast/a.cbz', 3), 8000);
      await sleep(300);
      iv.progLog.length = 0;
      const keyA = 'dav:fast/a.cbz';
      const atA = await cdp.eval(`window.__IV.showPage(2); await __tick(); const t = window.__IV.books()[${JSON.stringify(keyA)}].at; await window.__IV.wait(80); return t;`);
      await key('n');
      await waitFor(bookKeyIs('fast/b.cbz', 3), 8000);
      const recA = await cdp.eval(`return window.__IV.books()[${JSON.stringify(keyA)}];`);
      check('换书那一刻旧书的进度又存了一次（at 变新、停在最后一页）', recA && recA.at > atA && recA.index === 2, { atA, rec: recA });
      const putsOf = (k) => iv.progLog.filter((e) => e.method === 'PUT' && e.status === 201 && (() => { try { return JSON.parse(e.body).key === k; } catch (x) { return false; } })());
      for (let i = 0; i < 25 && !putsOf(keyA).length; i++) await sleep(100);
      const pushedA = putsOf(keyA).map((e) => JSON.parse(e.body));
      check('换书后马上（远不到 3 秒）把旧书最后一页推到云端，不是等去抖时推成新书', pushedA.length >= 1 && pushedA[pushedA.length - 1].index === 2, { pushedA, all: iv.progLog.map((e) => e.method + e.status) });
      await fresh(IVURL);
      await cdp.eval(`await window.__IV.davStore({ base: '${iv.origin}', library: 'library', user: 'viewer', pass: 'pä ss', syncDir: '' }); return 1;`);

      /* ---- 6b) 列目录在路上时换账号：旧结果不能写回缓存；换账号本身不去发新的列目录；之后换书重新列 ---- */
      const rewindA = `const b = window.__IV.books(); b['dav:fast/a.cbz'].index = 0; localStorage.setItem('iv.books.v1', JSON.stringify(b)); return 1;`;   // 上次停在最后一页的话，一打开就会去列文件夹
      await fresh(IVURL); await cdp.eval(rewindA);
      await fresh(IVURL + hashFor('fast/a.cbz'));
      await waitFor(bookKeyIs('fast/a.cbz', 3), 8000);
      check('（前置）从第 1 页打开：还没列过文件夹（换书缓存是空的）', (await cdp.eval(`return window.__IV.volCache().length;`)) === 0);
      iv.listSlow['fast'] = 700;
      const ps0 = plog().length;
      await cdp.eval(`window.__IV.showPage(2); return 1;`);                       // 最后一页 → 后台预取父文件夹
      for (let i = 0; i < 40 && plog().length === ps0; i++) await sleep(50);
      check('（前置）最后一页触发了一次后台列目录，还在路上', plog().length === ps0 + 1 && (await cdp.eval(`return window.__IV.volCache().length;`)) === 0, plog().length - ps0);
      await cdp.eval(`window.__IV.askDav(); return 1;`);
      await waitFor(dlgOpen, 5000);
      await cdp.eval(`document.querySelector('#davUser').value = 'viewer'; document.querySelector('#davSave').click(); return 1;`);
      await waitFor(`!${dlgOpen}`, 5000);
      await sleep(1200);
      delete iv.listSlow['fast'];
      check('在路上的旧列表回来后被丢弃：没有写进换书缓存', (await cdp.eval(`return window.__IV.volCache();`)).length === 0, await cdp.eval(`return window.__IV.volCache();`));
      check('换账号本身没有顺手去列目录（只有最初那一次请求）', plog().length === ps0 + 1, plog().length - ps0);
      await key('n');
      await waitFor(bookKeyIs('fast/b.cbz', 3), 8000);
      check('换完账号再按 N：重新列了一次目录，照常换到 b.cbz', plog().length === ps0 + 2 && (await stateOf()).bookKey === 'dav:fast/b.cbz', plog().length - ps0);

      /* ---- 6c) 后台预取还在飞时按「下一本」：预取失败（401）后要走正常路径弹账号框，而不是只给个 toast ---- */
      await fresh(IVURL); await cdp.eval(rewindA);
      await fresh(IVURL + hashFor('fast/a.cbz'));
      await waitFor(bookKeyIs('fast/a.cbz', 3), 8000);
      iv.user = 'nobody'; iv.listSlow['fast'] = 700;                              // 之后的列目录：慢，而且 401
      const pj0 = plog().length;
      await cdp.eval(`window.__IV.showPage(2); return 1;`);
      for (let i = 0; i < 40 && plog().length === pj0; i++) await sleep(50);
      await cdp.eval(`window.__volP = window.__IV.volStep(1); return 1;`);        // 不等：趁预取还在飞
      const re401b = await waitFor(`${dlgOpen} && /401/.test(document.querySelector('#davMsg').textContent)`, 6000);
      check('预取还在飞时按「下一本」，预取 401 失败后弹出账号框（不是只有一条 toast）；账号框前确实走过一次 401 的列目录', !!re401b && plog().slice(pj0).filter((e) => e.status === 401).length >= 1 && (await cdp.eval(`return window.__IV.volCache().length;`)) === 0, plog().slice(pj0).map((e) => e.status));
      await cdp.eval(`document.querySelector('#davCancel').click(); return 1;`);
      check('取消账号框 → 这次换书结束（没换成）', (await cdp.eval(`return await window.__volP;`)) === false && (await stateOf()).bookKey === 'dav:fast/a.cbz');
      iv.user = 'viewer'; delete iv.listSlow['fast'];
      await fresh(IVURL);

      /* ---- 7) 手机宽度：「上一本 / 下一本」不用横向滚工具栏就够得着 ---- */
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
      {   // [23e] 用块作用域：这一节的 const 很多（s1 / w1 …），别和前面的重名
      /* ======== [23f] rar / cbr / 7z / cb7 / tar / cbt / tgz（libarchive.js，WASM，module worker）======== */
      log('\n[23f] rar / 7z / tar 系：云端（整本下载）+ 本地选文件；同一条页面管线；懒加载；CSP 零违规；加密 / 损坏 / 无图；关书释放 worker 与 blob 地址');
      const FX = (n) => fs.readFileSync(path.join(HERE, 'fixtures', n));
      const archRels = { 'arch/flat.rar': 'arch_flat.rar', 'arch/flat.cbr': 'arch_flat.cbr', 'arch/flat.7z': 'arch_flat.7z', 'arch/flat.cb7': 'arch_flat.cb7',
        'arch/flat.tar': 'arch_flat.tar', 'arch/flat.cbt': 'arch_flat.cbt', 'arch/flat.tgz': 'arch_flat.tgz', 'arch/flat.tar.gz': 'arch_flat.tar.gz' };
      for (const [rel, fx] of Object.entries(archRels)) bookBufs[rel] = FX(fx);
      bookBufs['arch/chapters.tar'] = FX('arch_chapters.tar');
      bookBufs['arch/old3.cbr'] = fs.readFileSync(path.join(HERE, 'fixtures', 'sample.cbr'));      // RAR3 stored（make_web_fixtures.py 手拼的）
      bookBufs['arch/enc.7z'] = FX('arch_enc.7z');
      bookBufs['arch/noimg.tar'] = FX('arch_noimg.tar');
      bookBufs['arch/bad.rar'] = FX('arch_bad.rar');
      bookBufs['arch/ok.cbz'] = buildZip([{ name: '1.png', store: true, data: pngBytes(40, 60, '336699') }, { name: '2.png', store: true, data: pngBytes(40, 60, '996633') }]);
      const archHook = (await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source:
        "try{localStorage.setItem('iv.ui.v1',JSON.stringify({thumbs:false}))}catch(e){};window.__workers=[];window.__urls={c:0,r:0};" +
        "(function(){var W=window.Worker;window.Worker=function(u,o){var rec={url:String(u),term:false};var w=new W(u,o);var t=w.terminate.bind(w);w.terminate=function(){rec.term=true;t()};window.__workers.push(rec);return w};window.Worker.prototype=W.prototype;" +
        "var C=URL.createObjectURL.bind(URL),R=URL.revokeObjectURL.bind(URL);URL.createObjectURL=function(b){window.__urls.c++;return C(b)};URL.revokeObjectURL=function(u){window.__urls.r++;return R(u)}})();" })).identifier;
      const colorOfShown = () => cdp.eval(`const im = document.querySelector('#pageBox .page img'); if (!im) return null;
        await new Promise((r) => (im.complete ? r() : (im.onload = r)));
        const cv = document.createElement('canvas'); cv.width = 8; cv.height = 8; const g = cv.getContext('2d', { willReadFrequently: true });
        g.drawImage(im, 0, 0, 8, 8); const d = g.getImageData(4, 4, 1, 1).data; return [d[0], d[1], d[2]];`);
      const near3 = (c, w) => c && c.every((v, i) => Math.abs(v - w[i]) < 40);
      const archToast = () => cdp.eval(`return document.querySelector('#toast').textContent;`);
      const cspNow = () => cdp.eval(`return window.__csp;`);
      const libReq = (since) => iv.vendor.slice(since || 0).filter((v) => /\/vendor\/libarchive\//.test(v.path));
      const NAMES = ['01.jpg', '02.png', '03.png', '10.jpg'];
      const COLORS4 = [[200, 40, 40], [40, 200, 40], [40, 40, 200], [200, 200, 40]];

      /* ---- 0) 懒加载：先打开一本 cbz（zip 路径不变），一个字节的 libarchive 都不该取；之后才有 ---- */
      await fresh(IVURL + hashFor('arch/ok.cbz'));
      const okZip = await waitFor(`window.__IV.state().total === 2 && document.querySelector('#pageBox img')`, 15000);
      const lazy0 = iv.vendor.length, libN0 = libReq().length;
      check('zip / cbz 路径不受影响：cbz 照常打开，没有再取 vendor/libarchive，也没有起 worker', !!okZip && libReq().length === libN0 && (await cdp.eval(`return window.__workers.length;`)) === 0 && (await cdp.eval(`return window.__IV.archInfo();`)) === null,
        { total: (await stateOf()).total, lib: libReq().length, libN0 });

      /* ---- 1) 8 种后缀 × 云端（#open=）：自然排序、解出正确的图、书 key、整本下载 ---- */
      let firstLog = null;
      for (const rel of Object.keys(archRels)) {
        const l0 = iv.log.length, v0 = iv.vendor.length;
        await fresh(IVURL + hashFor(rel));
        const ok = await waitFor(`window.__IV.state().total === 4 && window.__IV.state().decoded[0] && window.__IV.state().decoded[0].w > 0 && document.querySelector('#pageBox img')`, 20000);
        const st = await stateOf();
        const reqs = iv.log.slice(l0).filter((e) => e.path === '/library/' + rel.split('/').map(encodeURIComponent).join('/'));
        if (!firstLog) firstLog = reqs;
        check(rel + '：打开 4 页（readme.txt / __MACOSX 被丢掉），自然排序 01 02 03 10，书 key = dav:' + rel + '，标题 = 文件名',
          !!ok && st.decoded.map((d) => d.name).join() === NAMES.join() && st.bookKey === 'dav:' + rel && st.bookTitle === rel.split('/').pop() && !st.chapters,
          { names: st.decoded.map((d) => d.name), key: st.bookKey, title: st.bookTitle, toast: await archToast() });
        check(rel + '：整本下载一次（GET、带 Authorization、没有 Range、200），没有别的请求打这个文件', reqs.length === 1 && reqs[0].method === 'GET' && reqs[0].auth && !reqs[0].range && reqs[0].status === 200, reqs);
        check(rel + '：第 1 页是红色（01.jpg），翻到第 2 页是绿色（02.png）— 解出来的是对的字节', near3(await colorOfShown(), COLORS4[0]), await colorOfShown());
        await cdp.eval(`window.__IV.showPage(1); return 1;`);
        await waitFor(`window.__IV.state().index === 1 && (() => { const m = document.querySelector('#pageBox .page img'); return m && m.complete && m.naturalWidth > 0; })()`, 8000);
        check(rel + '：第 2 页绿色', near3(await colorOfShown(), COLORS4[1]), await colorOfShown());
        const lr = libReq(v0);
        check(rel + '：libarchive 从 /iv/vendor/libarchive/ 同源加载（js + worker + wasm 全 200，没有账号头 / Range），CSP 零违规',
          lr.every((v) => v.status === 200 && !v.auth && !v.range) && (await cspNow()).length === 0, { lr: lr.slice(0, 4), csp: await cspNow() });
      }
      check('整个运行里 vendor/libarchive 的 js / worker / wasm 都取过且全是 200（没带账号头 / Range；之后的打开走 service worker 缓存）', ['libarchive.js', 'worker-bundle.js', 'libarchive.wasm'].every((n) => libReq().some((v) => v.path.endsWith('/' + n))) && libReq().every((v) => v.status === 200 && !v.auth && !v.range), libReq());

      /* ---- 2) 章节目录 / 进度 / 方向 / 双页：和 zip 一样 ---- */
      await fresh(IVURL + hashFor('arch/chapters.tar'));
      const okCh = await waitFor(`window.__IV.state().total === 6 && window.__IV.state().chapters && document.querySelector('#pageBox img')`, 20000);
      const stCh = await stateOf();
      check('tar 里的子目录 = 章节（ch1 有 4 张、ch2 有 2 张），和 zip 一样', !!okCh && stCh.chapters.length === 2 && stCh.chapters[0].n === 4 && stCh.chapters[1].n === 2 && /ch1/.test(stCh.chapters[0].title), stCh);
      await cdp.eval(`window.__IV.switchChapter(1); return 1;`);
      await waitFor(`window.__IV.state().chapterIndex === 1 && window.__IV.state().pages === 2`, 8000);
      await cdp.eval(`window.__IV.showPage(1); window.__IV.saveProgress(); return 1;`);
      await waitFor(`window.__IV.state().index === 1`, 4000);
      const progKey = (await stateOf()).bookKey;
      await fresh(IVURL + hashFor('arch/chapters.tar'));
      const okCh2 = await waitFor(`window.__IV.state().total === 6 && window.__IV.state().chapterIndex === 1 && window.__IV.state().index === 1 && document.querySelector('#pageBox img')`, 20000);
      check('进度（章节 + 页码）按书 key 保存，重新打开自动续读', !!okCh2 && progKey === 'dav:arch/chapters.tar', await stateOf());
      await cdp.eval(`window.__IV.toggleDirection(); return 1;`);
      await cdp.eval(`window.__IV.showPage(0); return 1;`);
      const stRtl = await stateOf();
      check('rtl / 双页等开关照常（切方向后 S.direction=rtl 且仍然是同一本书）', stRtl.S.direction === 'rtl' && stRtl.bookKey === 'dav:arch/chapters.tar', { dir: stRtl.S.direction });
      await cdp.eval(`window.__IV.toggleDirection(); return 1;`);

      /* ---- 3) RAR3（make_web_fixtures 手拼的 stored .cbr，含中文章节目录）也能读 ---- */
      await fresh(IVURL + hashFor('arch/old3.cbr'));
      const okR3 = await waitFor(`window.__IV.state().total === 4 && window.__IV.state().chapters && document.querySelector('#pageBox img')`, 20000);
      const stR3 = await stateOf();
      check('RAR3（.cbr）：4 张图（00_cover.png 在根 + 第1话 2 张 + 第2话 1 张）= 3 个章节，标题是中文', !!okR3 && stR3.chapters.length === 3 && stR3.chapters.some((c) => c.title === '第1话' && c.n === 2) && stR3.chapters.some((c) => c.title === '第2话' && c.n === 1), stR3);

      /* ---- 4) 本地：📦 选文件（file input）和 drop ---- */
      await fresh(IVURL);
      const acc = await cdp.eval(`return document.querySelector('#zipInput').getAttribute('accept');`);
      check('📦 的 accept 含 .rar .cbr .7z .cb7 .tar .cbt .tgz .tar.gz（手机选择器才不会把它们灰掉）', ['.rar', '.cbr', '.7z', '.cb7', '.tar', '.cbt', '.tgz', '.tar.gz'].every((x) => acc.split(',').includes(x)), acc);
      for (const [fx, key] of [['arch_flat.cbr', 'arch_flat.cbr'], ['arch_flat.7z', 'arch_flat.7z'], ['arch_flat.tar.gz', 'arch_flat.tar.gz']]) {
        await fresh(IVURL);
        const v0 = iv.vendor.length, h0 = iv.hits.length;
        await setInputFiles('#zipInput', [path.join(HERE, 'fixtures', fx)]);
        const okL = await waitFor(`window.__IV.state().total === 4 && window.__IV.state().decoded[0] && window.__IV.state().decoded[0].w > 0`, 20000);
        const stL = await stateOf();
        check('📦 选 ' + fx + '：4 页、自然排序、书 key 是本地书（arch:…，不是 dav:）、不发任何 /library 请求', !!okL && stL.decoded.map((d) => d.name).join() === NAMES.join() && /^arch:/.test(stL.bookKey) && stL.bookTitle === key &&
          iv.hits.slice(h0).every((h) => !/\/library\//.test(h)), { names: stL.decoded.map((d) => d.name), key: stL.bookKey, title: stL.bookTitle });
      }
      /* drop：合成的 drop 事件（DataTransfer 里放 File）走 handleDrop 的真实代码路径 */
      for (const [fx, nm] of [['arch_flat.cb7', 'dropped.cb7'], ['arch_flat.rar', 'dropped.rar']]) {
        await fresh(IVURL);
        await cdp.eval(`const bin = atob(${JSON.stringify(FX(fx).toString('base64'))}); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
          const dt = new DataTransfer(); dt.items.add(new File([u], ${JSON.stringify(nm)}));
          window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return 1;`);
        const okD = await waitFor(`window.__IV.state().total === 4 && window.__IV.state().decoded[0] && window.__IV.state().decoded[0].w > 0`, 20000);
        const stD = await stateOf();
        check('拖进来 ' + nm + '：和选文件一样打开 4 页（压缩包走 libarchive，不当成图片跳过）', !!okD && stD.bookTitle === nm && /^arch:/.test(stD.bookKey), { title: stD.bookTitle, key: stD.bookKey, toast: await archToast() });
      }

      /* ---- 5) 加密 / 损坏 / 没有图片：清楚的提示，不留半开的书，worker 不泄漏 ---- */
      const errCase = async (rel, re, label) => {
        await fresh(IVURL + hashFor('arch/ok.cbz'));
        await waitFor(`window.__IV.state().total === 2`, 15000);
        await cdp.eval(`window.__workers.length = 0; return 1;`);
        await cdp.eval(`window.__IV.applyLaunchHash(${JSON.stringify(hashFor(rel))}); return 1;`);
        await waitFor(`${re.toString()}.test(document.querySelector('#toast').textContent)`, 20000);
        await sleep(300);
        const t = await archToast(), st = await stateOf(), ws = await cdp.eval(`return window.__workers.map((w) => w.term);`);
        check(label + '：提示「' + t.slice(0, 40) + '」，还是上一本书（没有半开的书）', re.test(t) && st.bookKey === 'dav:arch/ok.cbz' && st.total === 2, { t, key: st.bookKey });
        check(label + '：失败后起过的 worker 全部被终止', ws.every((x) => x === true), ws);
      };
      await errCase('arch/enc.7z', /有密码/, '加密的 7z');
      await errCase('arch/bad.rar', /压缩包打开失败/, '损坏的 .rar（不是压缩包）');
      await errCase('arch/noimg.tar', /没有找到浏览器能显示的图片/, '只有文本的 tar');

      /* ---- 6) 云端 401：弹账号框重输（和 zip 一样），404：提示 ---- */
      await fresh(IVURL + hashFor('arch/missing.rar'));
      await waitFor(`/找不到|404|云端打开失败/.test(document.querySelector('#toast').textContent)`, 10000);
      check('云端没有这个 rar：提示（404），没有打开任何书', /404|找不到|云端打开失败/.test(await archToast()) && (await stateOf()).total === 0, await archToast());

      /* ---- 7) >300MB 提醒（把阈值调小来触发）；关书 / 换书：worker 终止、blob 地址 revoke、archInfo 清空 ---- */
      await fresh(IVURL + hashFor('arch/flat.cbr'));
      await waitFor(`window.__IV.state().total === 4 && document.querySelector('#pageBox img')`, 20000);
      for (let i = 0; i < 4; i++) { await cdp.eval(`window.__IV.showPage(${i}); return 1;`); await sleep(250); }
      const live = await cdp.eval(`return { info: window.__IV.archInfo(), w: window.__workers.map((w) => ({ term: w.term, url: w.url.replace(/^.*\\/vendor\\//, '') })), urls: window.__urls };`);
      check('读书时：archInfo 在线、解过页、只有 1 个 worker 且没终止（worker-bundle.js）', live.info && !live.info.closed && live.info.extracts >= 2 && live.w.length === 1 && !live.w[0].term && /libarchive\/worker-bundle\.js$/.test(live.w[0].url), live);
      const cbzBytes = bookBufs['arch/ok.cbz'];
      await cdp.eval(`const bin = atob(${JSON.stringify(cbzBytes.toString('base64'))}); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        await window.__IV.openZipFile(new File([u], 'next.cbz')); return 1;`);
      await waitFor(`window.__IV.state().total === 2 && window.__IV.state().bookTitle === 'next.cbz'`, 10000);
      await sleep(2200);
      const after = await cdp.eval(`return { info: window.__IV.archInfo(), w: window.__workers.map((w) => w.term), urls: window.__urls };`);
      check('换书（打开 cbz）：archInfo 清空、worker 被 terminate()', after.info === null && after.w.length === 1 && after.w[0] === true, after);
      check('换书后旧书的 blob: 地址被 revoke（create 的比 revoke 多不过本书新开的那几张）', after.urls.r >= live.urls.c - 1 && after.urls.r > 0, { live: live.urls, after: after.urls });

      await fresh(IVURL);
      await cdp.eval(`window.IVCore.ARCH_WARN_BYTES = 1000; window.__toasts = []; new MutationObserver(() => window.__toasts.push(document.querySelector('#toast').textContent)).observe(document.querySelector('#toast'), { childList: true, characterData: true, subtree: true }); return 1;`);
      await setInputFiles('#zipInput', [path.join(HERE, 'fixtures', 'arch_flat.tar')]);
      await waitFor(`window.__IV.state().total === 4`, 15000);
      const toasts = await cdp.eval(`return window.__toasts;`);
      check('超过阈值（这里调成 1000 字节）：先提示「整本要读进内存」，随后仍然照常打开 4 页', toasts.some((t) => /arch_flat\.tar.*整本要读进内存/.test(t)) && (await stateOf()).total === 4, toasts);

      /* ---- 8) service worker：libarchive 进独立的 iv-vendor-libarchive-2.0.2 缓存；cleanup 不动别人的缓存；Range / Authorization 仍不缓存 ---- */
      await fresh(IVURL + hashFor('arch/flat.7z'));
      await waitFor(`window.__IV.state().total === 4`, 20000);
      const swcL = await waitFor(`(async () => { const ks = await caches.keys(); const out = {}; for (const k of ks) { out[k] = (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname); }
        return out['iv-vendor-libarchive-2.0.2'] && out['iv-vendor-libarchive-2.0.2'].length >= 3 ? out : null; })()`, 12000);
      check('SW 缓存 iv-vendor-libarchive-2.0.2 里有 libarchive.js / worker-bundle.js / libarchive.wasm', swcL && ['libarchive.js', 'worker-bundle.js', 'libarchive.wasm'].every((n) => swcL['iv-vendor-libarchive-2.0.2'].some((u) => u.endsWith('/vendor/libarchive/' + n))), swcL);
      check('书本数据（/library/…）一个字节都没进任何缓存；外壳缓存里也没有 libarchive', swcL && Object.entries(swcL).every(([k, v]) => v.every((u) => !/\/library\//.test(u)) && (k === 'iv-vendor-libarchive-2.0.2' || !/libarchive/.test(v.join()))), swcL);

      await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: archHook });      // 别影响后面各节（缩略图默认开、Worker / URL 原样）
      await fresh(IVURL);
      await cdp.eval(`try { localStorage.removeItem('iv.ui.v1'); localStorage.removeItem('iv.books.v1'); } catch (e) {} return 1;`);

      /* ======== [23e] PDF（pdf.js）：按需取字节（Range）/ 渲染进现有页面管线 / CSP / 面积上限 / 401 / 加密 / 损坏 ======== */
      log('\n[23e] PDF：只发 Range、懒读（>100 页）、页面管线（适配 / 旋转 / 双页 / 裁边 / 缩略图 / 进度）、手机面积上限、CSP 零违规、401 重输、加密 / 损坏');
      const pdfKinds = (n) => Array.from({ length: n }, (_, i) => {
        const k = i + 1;
        if (k === 1) return { kind: 'text' };
        if (k === 2) return { kind: 'image' };
        if (k === 3) return { kind: 'cjk' };
        if (k === 4) return { kind: 'text', rot: 90 };                       // /Rotate 90：竖版纸张，显示时是横的
        if (k === 5) return { kind: 'text', w: 792, h: 612 };                // 横版纸张
        if (k === 6) return { kind: 'text', w: 300, h: 400 };
        if (k === 7) return { kind: 'text', w: 5000, h: 5000 };              // 超大纸张：必须被面积上限压住
        return { kind: 'scan' };                                             // 第 8 页起：每页自带一张整页扫描图
      });
      const PDF_PAGES = 150;
      bookBufs['pdf/big.pdf'] = buildPdf({ pages: pdfKinds(PDF_PAGES), scanKB: 140 });                                    // 约 20MB，页面对象紧凑排在前面、各页的扫描图在后面
      bookBufs['pdf/inter.pdf'] = buildPdf({ pages: pdfKinds(120), scanKB: 100, interleave: true });                         // 页面对象和扫描图交错
      bookBufs['pdf/small.pdf'] = buildPdf({ pages: pdfKinds(12).map((p, i) => (i === 6 ? { kind: 'text' } : p)), scanKB: 60 });
      bookBufs['pdf/rtl.pdf'] = buildPdf({ pages: pdfKinds(3), rtl: true });
      bookBufs['pdf/locked.pdf'] = buildPdf({ pages: pdfKinds(2), encrypt: true });
      bookBufs['pdf/broken.pdf'] = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('this is not a pdf body '.repeat(200))]);
      const BIG = bookBufs['pdf/big.pdf'].length;
      log('    big.pdf ' + (BIG / 1048576).toFixed(1) + ' MB，' + PDF_PAGES + ' 页；inter.pdf ' + (bookBufs['pdf/inter.pdf'].length / 1048576).toFixed(1) + ' MB');

      /* CDP：worker 里的 CSP 违规不会到页面的 securitypolicyviolation 监听 → 自动挂上 worker 目标，收它们的 Log / 异常 */
      /* 缩略图条在桌面默认是开的：每张缩略图都要读那一页的扫描图，会盖住「只取需要的字节」的断言 → 这一节先关掉，缩略图单独测 */
      const noThumbs = (await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: "try{localStorage.setItem('iv.ui.v1',JSON.stringify({thumbs:false}))}catch(e){}" })).identifier;
      const wlog = [], liveWorkers = new Set(); let nWorkers = 0;
      cdp.listeners.push((m) => {
        if (m.method === 'Target.detachedFromTarget') liveWorkers.delete(m.params.sessionId);
        if (m.method === 'Target.attachedToTarget' && /^(worker|service_worker)$/.test(m.params.targetInfo.type)) {
          const sid = m.params.sessionId;
          if (m.params.targetInfo.type === 'worker') { nWorkers++; liveWorkers.add(sid); }
          cdp.send('Log.enable', {}, sid).catch(() => {});
          cdp.send('Runtime.enable', {}, sid).catch(() => {});
          cdp.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
        } else if (m.method === 'Log.entryAdded') wlog.push((m.params.entry.source || '') + ': ' + m.params.entry.text);
        else if (m.method === 'Runtime.exceptionThrown') wlog.push('exception: ' + ((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text));
        else if (m.method === 'Runtime.consoleAPICalled' && /error|warning/.test(m.params.type)) wlog.push('console.' + m.params.type + ': ' + m.params.args.map((a) => a.value || a.description || '').join(' '));
      });
      await cdp.send('Log.enable');
      await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      const bigLog = (since) => iv.log.slice(since || 0).filter((e) => /\/library\/pdf\/big\.pdf$/.test(e.path));
      const sumBytes = (arr) => arr.reduce((a, e) => a + (e.bytes || 0), 0);
      const pdfOpen = async (rel, total) => {
        await fresh(IVURL + hashFor(rel));
        return waitFor(`window.__IV.state().total === ${total} && window.__IV.state().decoded[0] && window.__IV.state().decoded[0].w > 0 && document.querySelector('#pageBox img')`, 25000);
      };
      /** 当前显示的第一张图：天然尺寸 + 深色像素数（证明真的画了字，不是白纸） */
      const shot = () => cdp.eval(`const im = document.querySelector('#pageBox .page img'); if (!im) return null;
        await new Promise((r) => (im.complete ? r() : (im.onload = r)));
        const cv = document.createElement('canvas'); cv.width = Math.min(im.naturalWidth, 800); cv.height = Math.round(cv.width * im.naturalHeight / im.naturalWidth);
        const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0, cv.width, cv.height);
        const d = g.getImageData(0, 0, cv.width, cv.height).data; let dark = 0, color = 0;
        for (let i = 0; i < d.length; i += 4) { if (d[i] < 100 && d[i + 1] < 100 && d[i + 2] < 100) dark++; if (Math.abs(d[i] - d[i + 2]) > 60) color++; }
        return { w: im.naturalWidth, h: im.naturalHeight, dark, color };`);
      const gotoPage = async (i) => { await cdp.eval(`window.__IV.showPage(${i}); return 1;`);
        await waitFor(`window.__IV.state().index === ${i} && window.__IV.state().pair[0] && window.__IV.state().pair[0].endsWith('第 ${i + 1} 页') && (() => { const m = document.querySelector('#pageBox .page img'); return m && m.complete && m.naturalWidth > 0; })()`, 25000); await sleep(150); };
      const pdfLog0 = iv.log.length, vend0 = iv.vendor.length;

      /* ---- 1) 懒读：打开 150 页 / 20MB 的 PDF，只取开头 + 结尾，不下整本，没有 200 ---- */
      const okOpen = await pdfOpen('pdf/big.pdf', PDF_PAGES);
      check('云端 PDF 打开：150 页、书 key = dav:pdf/big.pdf、标题 big', !!okOpen && (await stateOf()).total === PDF_PAGES && (await stateOf()).bookKey === 'dav:pdf/big.pdf' && (await stateOf()).bookTitle === 'big.pdf', await stateOf());
      await sleep(1500);
      const L1 = bigLog(pdfLog0);
      const b1 = sumBytes(L1);
      check('打开 + 画出第 1 页，累计只取 ' + (b1 / 1024).toFixed(0) + ' KB（< 文件 ' + (BIG / 1048576).toFixed(1) + 'MB 的 20%，且 < 2MB）', b1 < BIG * 0.2 && b1 < 2 * 1048576 && b1 > 0, { b1, BIG, n: L1.length });
      check('每个 PDF 请求都是 Range（GET bytes=…，没有无 Range 的 GET）、都带 Authorization、没有一个 200', L1.length > 0 && L1.every((e) => e.range && /^bytes=\d+-\d+$/.test(e.range) && e.auth && e.status === 206 && e.method === 'GET'), L1.filter((e) => !(e.range && e.auth && e.status === 206)).slice(0, 3));
      check('PDF 地址不带账号 / 查询串（凭据只在 Authorization 头里）', L1.every((e) => e.path === '/library/pdf/big.pdf'), L1.slice(0, 2).map((e) => e.path));
      check('同时在途的请求不超过 4 个', iv.maxInflight <= 4, iv.maxInflight);
      const s1 = await shot();
      check('第 1 页真的画出来了（有黑色文字 / 黑块像素，不是白纸）', !!s1 && s1.dark > 300 && s1.w > 1000, s1);
      const i1 = await cdp.eval(`return window.__IV.pdfInfo();`);
      check('渲染完共用 canvas 立刻清零（Safari 不泄漏），没有致命错误', i1 && i1.canvasPx === 0 && !i1.fatal && i1.renders >= 1, i1);
      const stA = await stateOf();
      check('PDF 页进了普通页面管线：一个章节、页名「big · 第 N 页」，书架 / 上一本下一本可用', !stA.chapters && stA.decoded[0].name === 'big · 第 1 页' && stA.decoded[149].path === 'big#0150', { ch: stA.chapters, n0: stA.decoded[0].name, p: stA.decoded[149].path });
      check('第一次打开的 PDF：默认按页宽适配 + 单页（手机上字才看得清）', stA.fitMode === 'width' && stA.spread === false && stA.S.spread === true && stA.pair.length === 1, { fit: stA.fitMode, spread: stA.S.spread });
      const topY = await cdp.eval(`return Math.round(document.querySelector('#pageBox .page').getBoundingClientRect().top);`);
      check('按页宽显示 → 从页面顶部开始读（不是从中间）：panY > 0，页面顶边在窗口顶部附近', stA.panY > 0 && topY >= -2 && topY < 100, { panY: stA.panY, topY });
      const w1 = iv.vendor.slice(vend0);
      check('pdf.js 从 /iv/vendor/pdfjs/ 同源加载：主文件 + worker，全部 200，没有带 Authorization / Range', w1.some((v) => /pdf\.min\.js$/.test(v.path)) && w1.some((v) => /pdf\.worker\.min\.js$/.test(v.path)) && w1.every((v) => v.status === 200 && !v.auth && !v.range), w1.slice(0, 4));
      const fontFetch = await cdp.eval(`const r = await fetch(new URL('vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf', document.baseURI)); const b = await r.arrayBuffer(); const r2 = await fetch(new URL('vendor/pdfjs/cmaps/UniGB-UCS2-H.bcmap', document.baseURI)); return { st: r.status, n: b.byteLength, st2: r2.status };`);
      check('standard_fonts / cmaps 目录随包发布、同源可取（pdf.js 按需读；Windows / macOS 上 Helvetica 会走系统字体，所以这里不依赖它被请求）', fontFetch.st === 200 && fontFetch.n > 100000 && fontFetch.st2 === 200, fontFetch);

      /* ---- 2) 空闲后不再有请求（disableAutoFetch：不会后台下完整本） ---- */
      const idle0 = sumBytes(bigLog(pdfLog0)), n0 = bigLog(pdfLog0).length;
      await sleep(3000);
      check('空闲 3 秒：没有任何新的 PDF 请求（不会后台把整本下完）', sumBytes(bigLog(pdfLog0)) === idle0 && bigLog(pdfLog0).length === n0, { idle0, now: sumBytes(bigLog(pdfLog0)) });

      /* ---- 3) 翻页 / 各种页：图片页、CJK（cmap）、/Rotate、横版、超大纸张 ---- */
      await gotoPage(1);
      const s2 = await shot();
      check('第 2 页（RGB 图像）：画出了图像（有彩色像素）', !!s2 && s2.color > 500, s2);
      await gotoPage(2);
      const s3 = await shot();
      const w3 = iv.vendor.slice(vend0);
      check('第 3 页（中文，非嵌入 STSong + UniGB-UCS2-H）：pdf.js 按需取了 cmaps/UniGB-UCS2-H.bcmap，画出了字', w3.some((v) => /cmaps\/UniGB-UCS2-H\.bcmap$/.test(v.path) && v.status === 200 && !v.auth) && !!s3 && s3.dark > 300, { s3, cm: w3.filter((v) => /cmaps/.test(v.path)).map((v) => v.path) });
      await gotoPage(3);
      const stR = await stateOf();
      const dR = stR.decoded[3];
      check('第 4 页（/Rotate 90 的竖版纸张）：显示尺寸是横的（宽 > 高），探测值 = 真实图片尺寸', dR.w > dR.h && (await shot()).w === dR.w && (await shot()).h === dR.h, { dR, s: await shot() });
      await gotoPage(4);
      const stL = await stateOf();
      check('第 5 页（横版 792×612）：宽 > 高', stL.decoded[4].w > stL.decoded[4].h, stL.decoded[4]);
      await gotoPage(6);
      await waitFor(`window.__IV.pdfInfo() && !window.__IV.pdfInfo().busy && window.__IV.pdfInfo().queue === 0`, 15000);   // 邻页预渲染还在占着 canvas 时读 canvasPx 会偶发非 0
      const stH = await stateOf(), hi = await cdp.eval(`return window.__IV.pdfInfo();`), dH = stH.decoded[6];
      check('第 7 页（5000×5000pt 超大纸张）：像素数 ≤ 面积上限（桌面 1200 万）、最长边 ≤ 4000，不是 25M 像素', dH.w * dH.h <= hi.areaCap && Math.max(dH.w, dH.h) <= 4000 && dH.w * dH.h < 13e6, { dH, cap: hi.areaCap });
      const sH = await shot();
      check('超大纸张：真实图片尺寸 = 探测尺寸，且画出了字', !!sH && sH.w === dH.w && sH.h === dH.h && sH.dark > 100, { sH, dH });
      check('渲染中用过的最大 canvas ≤ 面积上限；渲染完 canvas 仍为 0×0', hi.maxCanvas <= hi.areaCap && hi.canvasPx === 0, hi);

      /* ---- 4) 逐页翻 12 页：URL 缓存不超过 8 个；翻页只发需要的请求 ---- */
      for (let i = 7; i < 14; i++) await gotoPage(i);
      const stU = await stateOf();
      check('连续翻到第 14 页：objectURL 缓存 ≤ 8（旧页的位图被释放）', stU.urls <= 8, stU.urls);
      const pinfo = await cdp.eval(`return window.__IV.pdfInfo();`);
      check('翻页队列清空、没有致命错误、没有 unhandled', pinfo.queue === 0 && !pinfo.fatal && !(await cdp.eval(`return (window.__errs || []).length;`)), pinfo);

      /* doc.cleanup() 返回 Promise：文档已销毁等情形会 reject，不接住就是 unhandledrejection */
      await cdp.eval(`const c = window.__IV.pdfCtx(); window.__cleanupCalls = 0;
        c.doc.cleanup = () => { window.__cleanupCalls++; return Promise.reject(new Error('cleanup boom')); }; c.renders = 19; return 1;`);
      await gotoPage(14); await sleep(600);
      const cl = await cdp.eval(`return { calls: window.__cleanupCalls, errs: window.__errs || [] };`);
      check('doc.cleanup() 被拒绝也不产生 unhandledrejection（每 20 页清理一次，这里让它在第 20 次渲染上被调用并 reject）', cl.calls >= 1 && cl.errs.length === 0, cl);

      /* ---- 5) 跳到很后面的页（页面对象紧凑）：额外只取一小段 ---- */
      const bBefore = sumBytes(bigLog(pdfLog0));
      await gotoPage(139);
      const bAfter = sumBytes(bigLog(pdfLog0));
      check('跳到第 140 页：额外只取 ' + ((bAfter - bBefore) / 1024).toFixed(0) + ' KB（< 文件 10%），累计 < 20%', bAfter - bBefore < BIG * 0.1 && bAfter < BIG * 0.2, { add: bAfter - bBefore, total: bAfter });
      const s140 = await shot();
      check('第 140 页画出来了', !!s140 && s140.dark > 300, s140);
      await sleep(1500);
      check('整个过程里 big.pdf 没有一个 200、没有一次整本下载', bigLog(pdfLog0).every((e) => e.status === 206) && sumBytes(bigLog(pdfLog0)) < BIG, { total: sumBytes(bigLog(pdfLog0)) });

      /* ---- 6) 适配 / 缩放 / 旋转 / 双页 / 裁白边 / 跳页 / 进度 ---- */
      await gotoPage(7);
      await cdp.eval(`window.__IV.rotateBy(90); return 1;`); await sleep(150);
      check('旋转 90°：rotation = 90（沿用图片管线）', (await stateOf()).rotation === 90, (await stateOf()).rotation);
      await cdp.eval(`window.__IV.zoomBy(1.5); window.__IV.applyFit('window'); return 1;`); await sleep(150);
      const stF = await stateOf();
      check('适应窗口 / 缩放：图整张在窗口内（zoom 合理）', stF.fitMode === 'window' && stF.zoom > 0 && stF.zoom < 1, { fit: stF.fitMode, zoom: stF.zoom });
      /* 双页：横屏窗口 + 打开双页 */
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 600, deviceScaleFactor: 1, mobile: false });
      await sleep(400);
      await cdp.eval(`window.__IV.showPage(7); return 1;`); await sleep(300);
      await cdp.eval(`window.__force('spread', true); return 1;`); await sleep(300);
      await waitFor(`window.__IV.state().pair.length === 2`, 15000);
      const stS = await stateOf();
      check('横屏 + 双页开：两张竖版 PDF 页并排（第 8、9 页）', stS.pair.length === 2 && /第 8 页/.test(stS.pair[0]) && /第 9 页/.test(stS.pair[1]), stS.pair);
      await cdp.eval(`window.__IV.showPage(4); return 1;`);
      await waitFor(`window.__IV.state().index === 4 && window.__IV.state().pair.length >= 1`, 15000); await sleep(400);
      const stS2 = await stateOf();
      check('当前是横版页（第 5 页）：单页显示，不并排；下一页没有为了判断去解码（只靠页面尺寸探测，也不渲染成图再看）', stS2.pair.length === 1 && stS2.decoded[5].w === 0, { pair: stS2.pair, next: stS2.decoded[5] });
      await cdp.eval(`window.__force('spread', false); return 1;`);
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      await sleep(300);
      /* 裁白边 */
      await gotoPage(0);
      await cdp.eval(`window.__force('trim', true); return 1;`);
      await waitFor(`window.__IV.state().crop`, 15000);
      const stT = await stateOf();
      check('裁白边开：PDF 渲染成图后量到了页边空白（第 1 页 crop 非空，左 > 0 且小于整页）', !!stT.crop && stT.crop.l > 0 && stT.crop.r < stT.decoded[0].w, stT.crop);
      await cdp.eval(`window.__force('trim', false); return 1;`); await sleep(400);
      check('裁白边关：crop 清掉，页面尺寸恢复探测值', !(await stateOf()).crop && (await stateOf()).decoded[0].w > 0);
      /* 缩略图：展开缩略图条，滚到可见的缩略图会按小尺寸渲染（不是整页大图） */
      if (!(await stateOf()).S.thumbs) { await cdp.eval(`document.querySelector('#btnThumbs').click(); return 1;`); await sleep(300); }
      const th = await waitFor(`document.querySelectorAll('#thumbs .thumb canvas').length >= 3`, 20000);
      check('缩略图：展开后滚到可见的页按小尺寸渲染出缩略图 canvas（高 80px）', !!th && await cdp.eval(`return Array.from(document.querySelectorAll('#thumbs .thumb canvas')).every((c) => c.height === 80);`), await cdp.eval(`return document.querySelectorAll('#thumbs .thumb canvas').length;`));
      /* 进度：跳到第 20 页，刷新后续读 */
      await gotoPage(19);
      await cdp.eval(`window.__IV.saveProgress(); return 1;`);
      await fresh(IVURL + hashFor('pdf/big.pdf'));
      await waitFor(`window.__IV.state().total === ${PDF_PAGES} && window.__IV.state().index === 19`, 20000);
      check('进度按书记住：重新打开同一本 PDF 回到第 20 页', (await stateOf()).index === 19 && (await stateOf()).bookKey === 'dav:pdf/big.pdf', { idx: (await stateOf()).index });

      /* ---- 7) CSP：页面和 worker 里零违规 ---- */
      const cspPage = await cdp.eval(`return window.__csp || [];`);
      const badLog = wlog.filter((t) => /Refused|Content Security Policy|violat|EvalError|unsafe-eval/i.test(t));
      check('CSP 零违规：页面（securitypolicyviolation）+ worker（CDP Log / 异常）；用的是 Caddy 片段里的同一条 CSP', cspPage.length === 0 && badLog.length === 0, { cspPage, badLog: badLog.slice(0, 4), allWorkerLogs: wlog.slice(0, 5) });
      check('worker 是 /iv/vendor/pdfjs/pdf.worker.min.js 同源的 module worker（CDP 挂上了它，所以上面的「worker 零违规」不是空转）', nWorkers >= 1 && iv.vendor.some((v) => /pdf\.worker\.min\.js$/.test(v.path)), { nWorkers });

      /* ---- 8) 页面对象交错的 PDF：只保证「没有 200、不超过文件大小、空闲后不再请求」 ---- */
      const interLog0 = iv.log.length;
      await fresh(IVURL + hashFor('pdf/inter.pdf'));
      await waitFor(`window.__IV.state().total === 120 && document.querySelector('#pageBox img')`, 25000);
      await gotoPage(100);
      const IL = iv.log.slice(interLog0).filter((e) => /inter\.pdf$/.test(e.path));
      const INTER = bookBufs['pdf/inter.pdf'].length, ib = sumBytes(IL);
      await sleep(2000);
      const ib2 = sumBytes(iv.log.slice(interLog0).filter((e) => /inter\.pdf$/.test(e.path)));
      check('交错布局：翻到第 101 页也全是 206 Range，总取量 ' + (ib / 1048576).toFixed(1) + 'MB ≤ 文件大小（容许 1% 重叠）' + (INTER / 1048576).toFixed(1) + 'MB，空闲后不再增加', IL.every((e) => e.status === 206 && e.range) && ib <= INTER * 1.01 && ib2 === ib, { ib, ib2, INTER });

      /* ---- 9) 小 PDF：几乎整本在开头那块里；方向、书库流程 ---- */
      const smallLog0 = iv.log.length;
      await pdfOpen('pdf/small.pdf', 12);
      const SL = iv.log.slice(smallLog0).filter((e) => /small\.pdf$/.test(e.path));
      check('小 PDF 能打开，全是 206', (await stateOf()).total === 12 && SL.every((e) => e.status === 206), SL.map((e) => e.status));
      await pdfOpen('pdf/rtl.pdf', 3);
      check('PDF 自己声明从右到左（/ViewerPreferences /Direction /R2L）→ 阅读方向初值 rtl', (await stateOf()).S.direction === 'rtl', (await stateOf()).S);
      await cdp.eval(`window.__force('direction', false); return 1;`);
      /* PDF 的临时默认值（按页宽 + 单页）不能带到下一本书：再开一本从没读过的漫画，回到打开 PDF 之前的值 */
      bookBufs['pdfx/fresh.cbz'] = mkCbz(['336699', '993366']);
      bookBufs['pdfx/new.pdf'] = bookBufs['pdf/small.pdf'];            // 从没打开过的 PDF（打开过的会用它自己保存的模式）
      await pdfOpen('pdfx/new.pdf', 12);
      const bf = await stateOf();
      await cdp.eval(`location.hash = '#open=' + encodeURIComponent('pdfx/fresh.cbz'); return 1;`);
      await waitFor(`window.__IV.state().bookKey === 'dav:pdfx/fresh.cbz' && window.__IV.state().total === 2`, 15000);
      const af = await stateOf();
      check('PDF 的临时默认值（按页宽 + 单页）不带到下一本：PDF 里 width / 单页，接着开漫画回到 window / 双页', bf.fitMode === 'width' && bf.spread === false && bf.S.spread === true && af.fitMode === 'window' && af.spread === true && af.S.spread === true, { bf: [bf.fitMode, bf.spread, bf.S.spread], af: [af.fitMode, af.spread, af.S.spread] });

      /* 全局「双页」偏好不被 PDF 的单页默认值覆盖：第一次打开 PDF 默认单页是书级的，saveUI() 写进 localStorage 的 spread 仍是用户的值 */
      bookBufs['pdfx/leak.pdf'] = bookBufs['pdf/small.pdf'];
      await fresh(IVURL);
      await cdp.eval(`localStorage.setItem('iv.ui.v1', JSON.stringify({ spread: true, thumbs: false })); return 1;`);
      await pdfOpen('pdfx/leak.pdf', 12);
      const uiLs = () => cdp.eval(`return JSON.parse(localStorage.getItem('iv.ui.v1') || '{}');`);
      const lk0 = await stateOf();
      await cdp.eval(`window.__IV.toggleDirection(); return 1;`); await sleep(200);        // 任何一个会 saveUI() 的操作
      const lk1 = await uiLs();
      check('PDF 第一次打开默认单页（书级）：全局 S.spread 仍是 true，toggle 方向（saveUI）后 localStorage iv.ui.v1 里 spread 仍是 true',
        lk0.spread === false && lk0.S.spread === true && lk1.spread === true, { eff: lk0.spread, S: lk0.S.spread, ls: lk1.spread });
      await cdp.eval(`window.__IV.toggleMode('spread', '双页模式'); return 1;`); await sleep(200);
      const lk2 = await stateOf(), lk2ls = await uiLs();
      await cdp.eval(`window.__IV.toggleMode('spread', '双页模式'); return 1;`); await sleep(200);
      const lk3 = await stateOf(), lk3ls = await uiLs();
      check('在 PDF 里开 / 关双页只改这本书（有效值 true -> false），全局 S.spread 和 localStorage 都不动',
        lk2.spread === true && lk3.spread === false && lk2.S.spread === true && lk3.S.spread === true && lk2ls.spread === true && lk3ls.spread === true, { lk2: lk2.spread, lk3: lk3.spread, S: [lk2.S.spread, lk3.S.spread], ls: [lk2ls.spread, lk3ls.spread] });
      await cdp.eval(`window.__IV.toggleMode('spread', '双页模式'); window.__IV.saveProgress(); return 1;`); await sleep(200);
      await cdp.eval(`location.hash = '#open=' + encodeURIComponent('pdfx/fresh.cbz'); return 1;`);
      await waitFor(`window.__IV.state().bookKey === 'dav:pdfx/fresh.cbz' && window.__IV.state().total === 2`, 15000);
      const lk4 = await stateOf();
      check('接着开漫画：双页沿用用户自己的偏好（开）', lk4.spread === true && lk4.S.spread === true, { eff: lk4.spread, S: lk4.S.spread });
      await pdfOpen('pdfx/leak.pdf', 12);
      check('这本 PDF 自己的双页设置按书记住（刚才开了，重开仍是开），全局偏好不变', (await stateOf()).spread === true && (await stateOf()).S.spread === true, await stateOf());

      /* ---- 10) 从云端书架点开 PDF（钩子默认就是 pdf 阅读器；书架和换书共用 LIB_OPEN_KINDS）；上一本 / 下一本跨 PDF 与 cbz ---- */
      await fresh(IVURL);
      await cdp.eval(`localStorage.setItem('iv.shelf.dir.v1', 'pdf'); document.querySelector('#startShelf').click(); return 1;`);
      await waitFor(shelfIs('pdf'), 8000);
      const pdfRows = await rowsOf();
      check('书架里 PDF 列出来、可以点开（有 data-book，没有变灰）', pdfRows.filter((r) => /\.pdf$/.test(r.t) && !r.dir).length >= 5, pdfRows.map((r) => r.t));
      check('书架页脚不再把 pdf 算进「暂不支持」', !/pdf/i.test(await cdp.eval(`return document.querySelector('#shelfInfo').textContent;`)), await cdp.eval(`return document.querySelector('#shelfInfo').textContent;`));
      await cdp.eval(`document.querySelector('#shelfList .shelf-row[data-book="pdf/small.pdf"]').click(); return 1;`);
      await waitFor(`window.__IV.state().bookKey === 'dav:pdf/small.pdf' && window.__IV.state().total === 12 && document.querySelector('#pageBox img')`, 20000);
      check('点书架里的 PDF → 打开，书架收起', (await stateOf()).total === 12 && (await cdp.eval(`return ${shelfOpenExpr} === false;`)));
      const tb = await cdp.eval(`return { next: getComputedStyle(document.querySelector('#btnVolNext')).display, prev: getComputedStyle(document.querySelector('#btnVolPrev')).display };`);
      check('读 PDF 时「上一本 / 下一本」按钮可见（同一文件夹相邻的书）', tb.next !== 'none' || tb.prev !== 'none', tb);
      await cdp.eval(`window.__IV.volStep(-1); return 1;`);
      await waitFor(`window.__IV.state().bookKey === 'dav:pdf/rtl.pdf' && window.__IV.state().total === 3 && document.querySelector('#pageBox img')`, 20000);
      await sleep(600);
      await sleep(800);
      check('「上一本」从 PDF 换到相邻的另一本 PDF（rtl.pdf，3 页）：新书能画出来', (await stateOf()).bookKey === 'dav:pdf/rtl.pdf' && (await cdp.eval(`return window.__IV.pdfInfo().pages;`)) === 3 && (await shot()).dark > 100, (await stateOf()).bookKey);
      check('换书后上一本 PDF 的 worker 被终止（活着的 pdf.js worker 只剩 1 个，不会越开越多）', liveWorkers.size === 1, { live: liveWorkers.size, attached: nWorkers });

      /* ---- 10b) 下一本 / 上一本是打不开的 PDF（加密）：停在当前这本，提示里带着具体原因（PDF 失败不抛，原因靠 onFail 传给 volStep） ---- */
      await cdp.eval(`window.__IV.saveProgress(); return 1;`);
      const volBad = await cdp.eval(`document.querySelector('#toast').textContent = ''; await window.__IV.volStep(-1); await window.__IV.wait(150);
        return { key: window.__IV.state().bookKey, total: window.__IV.state().total, toast: document.querySelector('#toast').textContent };`);
      check('「上一本」是加密的 PDF（locked.pdf）→ 仍停在当前这本（rtl.pdf），提示带着原因「有密码」，不只是「打不开」',
        volBad.key === 'dav:pdf/rtl.pdf' && volBad.total === 3 && /locked\.pdf/.test(volBad.toast) && /仍停在当前这本/.test(volBad.toast) && /密码/.test(volBad.toast), volBad);

      /* ---- 10c) 空文件夹 / 没有可读的书：提示里的格式清单和书架实际能打开的一致（含 pdf） ---- */
      iv.virtual['pdf/nothing'] = [{ name: 'notes.txt', size: 5 }];
      await fresh(IVURL);
      await cdp.eval(`localStorage.setItem('iv.shelf.dir.v1', 'pdf/nothing'); document.querySelector('#startShelf').click(); return 1;`);
      await waitFor(shelfIs('pdf/nothing'), 8000);
      await waitFor(`!/读取中/.test(document.querySelector('#shelfList').textContent)`, 5000);
      const emptyMsg = await cdp.eval(`return document.querySelector('#shelfList').textContent;`);
      check('书架里没有可读的书的文件夹：提示列出 epub / cbz / zip / pdf 全部格式（不再漏写 pdf）', /没有/.test(emptyMsg) && ['epub', 'cbz', 'zip', 'pdf'].every((k) => emptyMsg.includes(k)), emptyMsg);
      const copy = await cdp.eval(`return { note: document.querySelector('#statusNote').textContent, start: document.querySelector('.start-note').textContent, help: document.querySelector('#help').textContent };`);
      check('没有后端时：状态栏 / 起始页 / 帮助表不再说 PDF 要桌面版或本地后端，而是说 PDF 能直接读',
        /PDF/.test(copy.note) && !/PDF[^；]*桌面版/.test(copy.note) && !/PDF\s*需连本地后端/.test(copy.start) && !/rar\s*\/\s*cbr\s*\/\s*PDF/.test(copy.help) && /PDF 通过网址/.test(copy.help), copy);

      /* ---- 11) 加密 / 损坏 / 404 / 服务器忽略 Range ---- */
      await fresh(IVURL + hashFor('pdf/locked.pdf'));
      await waitFor(`/密码|加密/.test(document.querySelector('#toast').textContent)`, 15000);
      check('加密的 PDF → 明确提示「有密码（已加密），暂不支持」', /密码.*暂不支持/.test(await toastText()) && (await stateOf()).total === 0, await toastText());
      await fresh(IVURL + hashFor('pdf/broken.pdf'));
      await waitFor(`/PDF 打开失败/.test(document.querySelector('#toast').textContent)`, 15000);
      check('损坏的 PDF → 可读的错误（PDF 打开失败：…损坏或不是有效的 PDF），没打开任何书', /PDF 打开失败.*(损坏|无效|不是)/.test(await toastText()) && (await stateOf()).total === 0, await toastText());
      await fresh(IVURL + hashFor('pdf/none.pdf'));
      await waitFor(`/404/.test(document.querySelector('#toast').textContent)`, 10000);
      check('PDF 不存在 → 提示找不到（HTTP 404）', /404/.test(await toastText()), await toastText());
      bookBufs['pdf/empty.pdf'] = Buffer.alloc(0);
      await fresh(IVURL + hashFor('pdf/empty.pdf'));
      await waitFor(`/空/.test(document.querySelector('#toast').textContent)`, 10000);
      const tEmpty = await toastText();
      check('0 字节的云端 PDF → 明确提示「空文件（0 字节）」，不是「服务器忽略 Range」/ 取不到大小，没打开任何书', /空/.test(tEmpty) && !/Range|取不到/.test(tEmpty) && (await stateOf()).total === 0, tEmpty);
      bookBufs['pdf/zero.pdf'] = buildPdf({ pages: [] });
      await fresh(IVURL + hashFor('pdf/zero.pdf'));
      await waitFor(`/PDF|页|图片/.test(document.querySelector('#toast').textContent)`, 15000);
      const tZero = await toastText();
      check('0 页的 PDF → PDF 专用提示（没有页面），不是「没有找到浏览器能显示的图片（png / jpg…）」，没打开任何书', /PDF.*没有页面/.test(tZero) && !/png|jpg|图片/.test(tZero) && (await stateOf()).total === 0, tZero);
      const ig0 = iv.log.length;
      await fresh(IVURL + hashFor('ignore/pdf/small.pdf'));
      await sleep(1500);
      const IG = iv.log.slice(ig0).filter((e) => /ignore/.test(e.path));
      check('服务器忽略 Range（回 200）→ 和 zip 一样硬失败：提示 server ignores Range，没有打开书', /Range/.test(await toastText()) && (await stateOf()).total === 0, await toastText());
      check('忽略 Range 的服务器：只发了一次探测请求（bytes=0-0）就中止，没有整本下载', IG.length >= 1 && IG.length <= 2 && IG.every((e) => e.bytes <= bookBufs['pdf/small.pdf'].length), IG.map((e) => e.range));

      /* ---- 11b) 打开阶段就遇到 401（密码错）：弹账号框，输入后自动重新打开，不是报错 ---- */
      iv.pass = 'changed0';
      await fresh(IVURL + hashFor('pdf/small.pdf'));
      const d0 = await waitFor(`${dlgOpen} && /401/.test(document.querySelector('#davMsg').textContent)`, 15000);
      check('打开 PDF 时账号不对（401）→ 弹出账号框并提示', !!d0 && (await stateOf()).total === 0);
      await cdp.eval(`document.querySelector('#davPass').value = 'changed0'; document.querySelector('#davSave').click(); return 1;`);
      await waitFor(`window.__IV.state().total === 12 && document.querySelector('#pageBox img')`, 20000);
      check('输入新密码后自动重新打开这本 PDF（不用再点一次）', (await stateOf()).total === 12 && (await stateOf()).bookKey === 'dav:pdf/small.pdf', await toastText());

      /* ---- 12) 打开之后密码被改：翻到没读过的地方 → 401 → 弹账号框 → 输入新密码后继续渲染（不用重新打开） ---- */
      await pdfOpen('pdf/big.pdf', PDF_PAGES);
      iv.pass = 'changed';        // 页面里此刻存的是 changed0
      await cdp.eval(`window.__IV.showPage(90); return 1;`);
      const d401 = await waitFor(`${dlgOpen} && /401/.test(document.querySelector('#davMsg').textContent)`, 15000);
      check('已打开的 PDF 翻到没读过的页遇到 401 → 自动弹出账号框', !!d401);
      await cdp.eval(`document.querySelector('#davPass').value = 'changed'; document.querySelector('#davSave').click(); return 1;`);
      await waitFor(`window.__IV.state().index === 90 && document.querySelector('#pageBox img') && window.__IV.pdfInfo() && !window.__IV.pdfInfo().busy && window.__IV.pdfInfo().queue === 0`, 25000);
      const s90 = await shot(), i90 = await cdp.eval(`return window.__IV.pdfInfo();`);
      check('输入新密码后自动重试：第 91 页画出来了，没有重新打开，没有致命错误', !!s90 && s90.dark > 300 && !i90.fatal && i90.authGen === 1, { s90, i90 });
      check('重试用的是新密码（服务器端最后一个 big.pdf 请求是 206，不是 401），账号框已关', !(await cdp.eval(`return ${dlgOpen};`)) && bigLog(0).slice(-1)[0].status === 206, bigLog(0).slice(-1));
      /* 取消账号框 → 整本停下并提示（不会永远转圈），已画出的页仍在 */
      iv.pass = 'changed2';
      await cdp.eval(`window.__IV.showPage(120); return 1;`);
      await waitFor(`${dlgOpen}`, 15000);
      await cdp.eval(`document.querySelector('#davCancel').click(); return 1;`);
      await waitFor(`window.__IV.pdfInfo() && window.__IV.pdfInfo().fatal`, 15000);
      const tf = await toastText();
      check('账号框取消 → 这本 PDF 停止读取，并提示「没有有效的书库账号 / 重新打开」（不是无限等待）', /书库账号|重新打开/.test(tf) && (await cdp.eval(`return window.__IV.pdfInfo().fatal;`)) && (await cdp.eval(`return window.__IV.pdfInfo().queue;`)) === 0, tf);
      iv.pass = 'changed';        // 页面里存着刚输入的新密码：后面的步骤沿用它（服务器端改回去，浏览器里的账号才对得上）

      /* ---- 13) 手机：触屏小窗（390 宽）：面积上限 600 万像素；宽度不溢出 ---- */
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 3, mobile: true });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await pdfOpen('pdf/small.pdf', 12);
      const ph = await cdp.eval(`const st = window.__IV.state(), i = window.__IV.pdfInfo();
        return { cap: i.areaCap, w0: st.decoded[0].w, h0: st.decoded[0].h, docSw: document.documentElement.scrollWidth, iw: innerWidth, fit: st.fitMode, spread: st.spread, zoom: st.zoom };`);
      check('手机（触屏 / 窄屏）：面积上限 600 万像素，Letter 页 = ' + ph.w0 + '×' + ph.h0 + '（≈250dpi，≤ 6M，≤ 4000 边）', ph.cap === 6e6 && ph.w0 * ph.h0 <= 6e6 && ph.w0 * ph.h0 > 4e6 && Math.max(ph.w0, ph.h0) <= 4000, ph);
      check('手机：页面没有横向滚动，按页宽适配（zoom = 窗口宽 / 页宽）', ph.docSw <= ph.iw && ph.fit === 'width', ph);
      await gotoPage(5);
      const phh = await cdp.eval(`const d = window.__IV.state().decoded[5], i = window.__IV.pdfInfo(); return { w: d.w, h: d.h, cap: i.areaCap, max: i.maxCanvas };`);
      check('手机：第 6 页（小开本 300×400pt）放大到 4 倍封顶 = 1200×1600；最大 canvas ≤ 600 万', phh.w === 1200 && phh.h === 1600 && phh.max <= 6e6, phh);
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      await fresh(IVURL);

      /* ---- 14) Service Worker：不预缓存 pdf.js，用到才缓存，绝不存 WebDAV ---- */
      const swc = await cdp.eval(`const keys = await caches.keys(); let urls = [];
        for (const k of keys) { const c = await caches.open(k); urls = urls.concat((await c.keys()).map((r) => new URL(r.url).pathname)); }
        return { keys, urls };`);
      check('Service Worker 缓存：名字都以 iv- 开头；pdf.js 主文件 / worker 是用到才缓存的（版本号命名的独立缓存）', swc.keys.every((k) => /^iv-/.test(k)) && swc.keys.some((k) => /^iv-vendor-pdfjs-4\.10\.38$/.test(k)) && swc.urls.some((u) => /vendor\/pdfjs\/pdf\.worker\.min\.js$/.test(u)), swc);
      check('缓存里没有任何 /library 的内容（书本数据 / Range / 带账号的请求绝不缓存），也没有预缓存的全部 cmap / 字体', swc.urls.every((u) => !/\/library\//.test(u)) && swc.urls.filter((u) => /cmaps\//.test(u)).length < 5 && swc.urls.filter((u) => /standard_fonts\//.test(u)).length < 5, swc.urls.length);
      check('PDF 全程 CSP 零违规（含书库路径 / 401 / 手机）', (await cdp.eval(`return window.__csp || [];`)).length === 0 && wlog.filter((t) => /Refused|Content Security Policy|violat/i.test(t)).length === 0, wlog.slice(0, 4));
      await cdp.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
      await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: noThumbs });

      /* ---- 14b) 云端 PDF 的缩略图默认不自动取（opt-in）：默认桌面布局（缩略图条开着）下，打开 + 空闲 6 秒只取需要的字节；滚缩略图条不下载 ---- */
      await fresh(IVURL);
      await cdp.eval(`localStorage.removeItem('iv.ui.v1'); localStorage.removeItem('iv.books.v1'); return 1;`);      // 新用户：默认布局、没有续读进度
      const th0 = iv.log.length;
      await fresh(IVURL + hashFor('pdf/big.pdf'));
      await waitFor(`window.__IV.state().total === ${PDF_PAGES} && window.__IV.state().decoded[0] && window.__IV.state().decoded[0].w > 0 && document.querySelector('#pageBox img')`, 25000);
      await sleep(6000);
      const thS = await cdp.eval(`const t = document.querySelector('#thumbs'); return { on: window.__IV.state().S.thumbs, hidden: t.classList.contains('hidden'), w: innerWidth, h: innerHeight,
        nodes: t.querySelectorAll('.thumb').length, canvases: t.querySelectorAll('.thumb canvas').length, scrollW: t.scrollWidth, clientW: t.clientWidth, idx: window.__IV.state().index };`);
      const thB1 = sumBytes(bigLog(th0));
      check('默认桌面布局（--window-size=1280,820、缩略图条开着、没有续读进度）：打开 150 页 / ' + (BIG / 1048576).toFixed(1) + ' MB 的云端 PDF 空闲 6 秒后，只取了 ' + (thB1 / 1048576).toFixed(2) + ' MB（< 文件 12%）',
        thS.on && !thS.hidden && thS.w >= 1200 && thS.w <= 1280 && thS.idx === 0 && thS.nodes === PDF_PAGES && thB1 < BIG * 0.12, { thS, thB1, BIG });
      check('缩略图条在，但云端 PDF 只留页码占位：看过的页（≤ 3 张）才有缩略图 canvas，没有铺满整条', thS.scrollW > thS.clientW && thS.canvases <= 3, thS);
      for (let k = 1; k <= 8; k++) { await cdp.eval(`const t = document.querySelector('#thumbs'); t.scrollLeft = ${k} / 8 * t.scrollWidth; return 1;`); await sleep(250); }
      await sleep(2500);
      const thB2 = sumBytes(bigLog(th0)), thI = await cdp.eval(`return { info: window.__IV.pdfInfo(), canvases: document.querySelectorAll('#thumbs .thumb canvas').length };`);
      check('把缩略图条从头滚到尾：没有额外下载（累计仍 < 12%），没有渲染缩略图', thB2 - thB1 < 64 * 1024 && thB2 < BIG * 0.12 && thI.canvases <= 3 && thI.info.thumbsOptIn === false, { thB1, thB2, thI });
      await gotoPage(30);
      await waitFor(`!!document.querySelector('#thumbs .thumb[data-i="30"] canvas')`, 15000);
      const thV = await cdp.eval(`return { has: !!document.querySelector('#thumbs .thumb[data-i="30"] canvas'), canvases: document.querySelectorAll('#thumbs .thumb canvas').length };`);
      check('翻过的页补出缩略图（第 31 页），仍不是整条', thV.has && thV.canvases <= 8, thV);
      const thB3 = sumBytes(bigLog(th0));
      await cdp.eval(`document.querySelector('#btnThumbs').click(); return 1;`); await sleep(300);
      await cdp.eval(`document.querySelector('#btnThumbs').click(); return 1;`);          // 关掉再打开 = 明确要这本书的缩略图
      await waitFor(`document.querySelectorAll('#thumbs .thumb canvas').length >= 12`, 25000);
      check('用户关掉再打开缩略图 = 为这本书明确开启：可见的缩略图开始生成（并提示会多用流量）', (await cdp.eval(`return window.__IV.pdfInfo().thumbsOptIn;`)) === true && /缩略图/.test(await toastText()) && sumBytes(bigLog(th0)) > thB3, { toast: await toastText(), b3: thB3, now: sumBytes(bigLog(th0)) });
      await cdp.eval(`localStorage.setItem('iv.ui.v1', JSON.stringify({ thumbs: false })); return 1;`);      // 还原成这一节之前（init 脚本写的）状态，后面的小节不受影响

      /* ---- 15) 本地 PDF（📦 压缩包按钮选文件；http 页面）：同一条渲染路径，不发任何 /library 请求；file:// 页面给出明确提示 ---- */
      const localPdf = path.join(HERE, 'fixtures', 'sample_rich.pdf');          // 入库的小样本（tests/make_web_fixtures.py 的 rich_pdf 生成，8 页）
      if (!fs.existsSync(localPdf)) check('本地 PDF', 'skip', '没有 tests/fixtures/sample_rich.pdf（先跑 python tests/make_web_fixtures.py）');
      else {
      await fresh(IVURL);
      const lib0 = iv.log.length;
      await setInputFiles('#zipInput', [localPdf]);
      await waitFor(`window.__IV.state().total === 8 && document.querySelector('#pageBox img')`, 20000);
      const sLoc = await shot();
      check('本地选 PDF（入库的 sample_rich.pdf）：打开 8 页、画出第 1 页，进度 key 是本地书（不是 dav:），没有任何 /library 请求', (await stateOf()).total === 8 && !!sLoc && sLoc.dark > 100 && !/^dav:/.test((await stateOf()).bookKey) && iv.log.length === lib0, { key: (await stateOf()).bookKey, n: iv.log.length - lib0 });
      check('选文件的 accept 里有 .pdf（手机选择器能选到）', /\.pdf/.test(await cdp.eval(`return document.querySelector('#zipInput').accept;`)));
      const zeroDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-zero-'));
      const zeroPdf = path.join(zeroDir, 'empty.pdf');
      fs.writeFileSync(zeroPdf, Buffer.alloc(0));
      await fresh(IVURL);
      const lib1 = iv.log.length;
      await setInputFiles('#zipInput', [zeroPdf]);
      await sleep(600);
      const tZeroLocal = await toastText();
      check('本地选 0 字节的 PDF → 明确提示「空文件（0 字节）」（不是 pdf.js 的泛泛错误），没打开任何书，也没发 /library 请求',
        /空文件.*0 字节/.test(tZeroLocal) && /PDF 打开失败/.test(tZeroLocal) && (await stateOf()).total === 0 && iv.log.length === lib1, { toast: tZeroLocal, n: iv.log.length - lib1 });
      try { fs.rmSync(zeroDir, { recursive: true, force: true }); } catch (e) { /* 临时目录，删不掉也无妨 */ }
      await fresh(url.pathToFileURL(PAGE).href);
      await setInputFiles('#zipInput', [localPdf]);
      await sleep(600);
      check('file:// 页面选 PDF：提示要通过网址（http / https）打开，不会卡住', /http/.test(await toastText()) && (await stateOf()).total === 0, await toastText());
      }
      }
      /*BMTTS-BEGIN*/
      {   // [23f] 书签 + 朗读（带文字层的 PDF、假引擎）。块作用域：变量别和前后重名
      log('\n[23f] 书签（加 / 取消 / 列表 / 备注 / 删除 / 跨设备合并）+ 朗读（文字层提取 / 假引擎 / 翻页 / 暂停 / 跨页半句 / 无文字停下 / CSP media-src）');
      const textPdf = path.join(HERE, 'fixtures', 'sample_text.pdf');
      if (!fs.existsSync(textPdf)) { check('书签 / 朗读', 'skip', '没有 tests/fixtures/sample_text.pdf（先跑 python tests/make_web_fixtures.py）'); }
      else {
      bookBufs['pdf/text.pdf'] = fs.readFileSync(textPdf);
      const TKEY = 'dav:pdf/text.pdf';
      const CSPH = (/header Content-Security-Policy "([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, 'deploy', 'Caddyfile.iv.snippet'), 'utf8')) || [])[1];
      const C_live = (l) => (l || []).filter((b) => !b.x);
      const has = (sel, cls) => cdp.eval(`const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.classList.contains(${JSON.stringify(cls)});`);
      const K = (k, o) => cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: ${JSON.stringify(k)}, bubbles: true }, ${JSON.stringify(o || {})}))); return 1;`);
      const q = (sel, prop) => cdp.eval(`const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.${prop} : null;`);
      const hidden = (id) => cdp.eval(`return document.querySelector('#${id}').classList.contains('hidden');`);
      const openText = async (syncOn) => {
        await fresh(IVURL);
        await cdp.eval(`localStorage.removeItem('iv.books.v1'); localStorage.removeItem('iv.tts.v1'); await window.__IV.davStore(Object.assign({ base: '${iv.origin}', library: 'library', user: 'viewer', pass: 'pä ss' }, ${syncOn ? `{ syncDir: 'users/gary/iv-progress', syncUser: 'writer', syncPass: 'w pass' }` : `{ syncDir: '' }`})); return 1;`);
        await fresh(IVURL + hashFor('pdf/text.pdf'));
        return waitFor(`window.__IV.state().total === 8 && window.__IV.state().decoded[0] && window.__IV.state().decoded[0].w > 0 && document.querySelector('#pageBox img')`, 25000);
      };
      const fakeEngine = (delay) => cdp.eval(`window.__fake = { spoken: [], idx: [], cancels: 0, paused: false, delay: ${delay}, lastError: null, _gen: 0, _wait: null,
        speak(t) { const g = this._gen; return new Promise((res) => { const fin = () => { if (g !== this._gen) return res('cancel'); this.spoken.push(t); this.idx.push(window.__IV.state().index); res('end'); };
          const go = () => { if (this.paused) this._wait = fin; else fin(); };        // 暂停时正在读的这一句不结束（真引擎也是：音频停住）
          setTimeout(go, this.delay); }); },
        prefetch() {}, cancel() { this._gen++; this.cancels++; this.paused = false; }, pause() { this.paused = true; },
        resume() { this.paused = false; const w = this._wait; this._wait = null; if (w) setTimeout(w, 5); } };
        window.__IV.tts.useEngine(window.__fake); return 1;`);
      iv.pass = 'pä ss';                                   // [23e] 末尾把服务器密码改成 changed：这一节用原来的账号
      const bmRec = () => cdp.eval(`const r = window.__IV.books()[${JSON.stringify(TKEY)}]; return r ? (r.bookmarks || []) : null;`);

      /* ---- 1) 文字层提取：页眉 / 页码 / 脚注被清掉，缩进开新段，跨页标记，没文字的页是空的 ---- */
      const openedText = !!(await openText(false)) && (await stateOf()).bookKey === TKEY;
      check('打开带文字层的 PDF（8 页）', openedText, { toast: await toastText(), errs: await cdp.eval(`return (window.__errs || []).slice(0, 3)`), csp: await cdp.eval(`return window.__csp`), s: (await stateOf()).bookKey });
      if (openedText) {
      const T = (p) => cdp.eval(`const o = await window.__IV.tts.page(${p}); return o && { paras: o.paras, indentFirst: o.indentFirst, open: o.open };`);
      const t1 = await T(1), t2 = await T(2), t3 = await T(3), t4 = await T(4);
      check('第 1 页：2 段，页眉「示例：朗读测试书」/ 页码 / 脚注「〔1〕…」都不在里面',
        t1 && t1.paras.length === 2 && t1.paras[0].startsWith('春天到了，山上的雪慢慢融化。') && !/示例|脚注|〔1〕/.test(t1.paras.join('')) && !/(^|\D)1$/.test(t1.paras.join('')), t1);
      check('第 1 页最后一行顶满、没有句号 = 句子跨页（open）；第 2 页开头不缩进（indentFirst=false）', t1.open === true && t2.indentFirst === false && t2.paras[0].startsWith('红薯。'), { t1, t2 });
      check('第 2 页：中文段 + 英文段，页码「2」不在里面', t2.paras.length === 3 && t2.paras[2] === 'Reading aloud works with English too. It is fine.' && !t2.paras.some((p) => /^2$/.test(p)), t2);
      check('第 3 页：「第二章 旅途」标题自成一段（大字号）', t3.paras.length === 2 && /^第二章/.test(t3.paras[0]) && t3.paras[1].startsWith('路上遇到了一位旅人'), t3);
      check('第 4 页没有文字层 → paras 为空', t4 && t4.paras.length === 0, t4);

      /* ---- 2) 书签：K / 按钮 / 列表 / 备注 / 删除 ---- */
      check('刚打开：没有书签，按钮不亮，书签条不显示', (await bmRec()) === null || (await bmRec()).length === 0, await bmRec());
      await K('k'); await sleep(150);
      let bm = await bmRec();
      check('按 K：给当前页（第 1 页）加书签；按钮亮起、书签条出现、有提示', bm.length === 1 && bm[0].i === 0 && bm[0].c === 0 && !bm[0].x && /已加书签：第 1 页/.test(await toastText()) &&
        (await has('#btnBm', 'on')) && (await has('#bmRibbon', 'show')), { bm, toast: await toastText() });
      await sleep(600);
      bm = await bmRec();
      check('PDF 有文字层：书签标题自动用这一页开头的 24 个字（异步补上）', bm[0].s === t1.paras[0].slice(0, 24) && bm[0].s.length === 24, bm);
      await cdp.eval(`window.__IV.showPage(4); return 1;`); await sleep(400);
      check('翻到没有书签的页：按钮 / 书签条熄灭', !(await has('#btnBm', 'on')) && !(await has('#bmRibbon', 'show')));
      await cdp.eval(`document.querySelector('#btnBm').click(); return 1;`); await sleep(150);
      bm = await bmRec();
      check('点 🔖 按钮：给第 5 页加书签（点一下就是加 / 取消，不弹窗）', C_live(bm).length === 2 && C_live(bm).some((b) => b.i === 4) && (await hidden('bm')), bm);
      await K('K', { shiftKey: true }); await sleep(200);
      const rows = await cdp.eval(`return Array.from(document.querySelectorAll('#bmList .bm-row')).map((r) => ({ pg: r.querySelector('.bm-pg').textContent, tx: r.querySelector('.bm-tx').textContent, cur: r.classList.contains('cur') }));`);
      check('Shift+K 打开书签列表：按页序 2 条，当前页高亮，第 1 条带页首文字', !(await hidden('bm')) && rows.length === 2 && rows[0].pg === '第 1 页' && rows[1].pg === '第 5 页' && rows[1].cur && !rows[0].cur && /春天到了/.test(rows[0].tx), rows);
      await cdp.eval(`document.querySelectorAll('#bmList .bm-row')[0].querySelector('.bm-go').click(); return 1;`); await sleep(400);
      check('点列表第 1 条：跳到第 1 页，列表关闭', (await stateOf()).index === 0 && (await hidden('bm')), await stateOf());
      await K('K', { shiftKey: true }); await sleep(150);
      await cdp.eval(`document.querySelectorAll('#bmList .bm-row')[1].querySelector('.bm-ed').click(); return 1;`); await sleep(100);
      await cdp.eval(`const i = document.querySelector('#bmList .bm-in'); i.value = '最后一页的故事'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1;`); await sleep(200);
      bm = C_live(await bmRec());
      const rows2 = await cdp.eval(`return Array.from(document.querySelectorAll('#bmList .bm-row .bm-tx')).map((e) => e.textContent);`);
      check('✎ 写备注：保存进书签并显示在列表里（Enter 提交）', bm.find((b) => b.i === 4).n === '最后一页的故事' && rows2[1] === '最后一页的故事', { bm, rows2 });
      await cdp.eval(`document.querySelectorAll('#bmList .bm-row')[0].querySelector('.bm-del').click(); return 1;`); await sleep(200);
      const raw = await bmRec();
      check('✕ 删除：从列表消失，留一条墓碑（x=1，用来同步删除）', C_live(raw).length === 1 && raw.some((b) => b.x === 1 && b.i === 0), raw);
      await cdp.eval(`document.querySelector('[data-close=bm]').click(); return 1;`);
      await K('k'); await sleep(150); await K('k'); await sleep(150);
      const raw2 = await bmRec();
      check('当前页（第 1 页）按 K 加、再按 K 取消：不重复，最后是取消状态', C_live(raw2).length === 1 && C_live(raw2)[0].i === 4, raw2);
      const persisted = await cdp.eval(`return JSON.parse(localStorage.getItem('iv.books.v1'))[${JSON.stringify(TKEY)}].bookmarks.length;`);
      check('书签写进了 localStorage 的进度记录（刷新后还在）', persisted >= 2, persisted);

      /* ---- 3) 书签跟着云端进度走：推上去带 bm；另一台设备的书签合并（不是覆盖）、它删的我这边也删 ---- */
      check('（同步）重新打开，开启进度同步', !!(await openText(true)));
      iv.progLog.length = 0;
      await K('k'); await sleep(200);
      await cdp.eval(`window.__IV.showPage(2); return 1;`); await sleep(300);
      await K('k'); await sleep(200);
      await cdp.eval(`await window.__IV.syncPush(false); return 1;`);
      for (let i = 0; i < 30 && !iv.progLog.some((e) => e.method === 'PUT' && e.status === 201); i++) await sleep(100);
      const lastPut = iv.progLog.filter((e) => e.method === 'PUT' && e.status === 201).map((e) => JSON.parse(e.body)).pop();
      check('推到云端的进度 JSON 带 bm（2 条，页 0 和 2），其余字段照旧', lastPut && lastPut.v === 1 && lastPut.key === TKEY && Array.isArray(lastPut.bm) && lastPut.bm.length === 2 &&
        lastPut.bm.map((b) => b.i).sort().join() === '0,2', lastPut);
      const h53 = await cdp.eval(`return window.IVCore.hash53(${JSON.stringify(TKEY)});`);
      const progPath = '/users/gary/iv-progress/' + h53 + '.json';
      const mineIds = lastPut.bm.map((b) => b.id);
      const other = { v: 1, key: TKEY, at: Date.now() - 5000, index: 6, chapter: 0, total: 8, direction: 'ltr', title: 'text.pdf', dev: '手机/平板',
        bm: [{ id: 'other1', c: 0, i: 6, n: '手机上加的', s: '', t: Date.now() - 4000, u: Date.now() - 4000 },
          { id: mineIds[0], c: 0, i: lastPut.bm[0].i, n: '', s: '', t: lastPut.bm[0].t, u: Date.now() + 5000, x: 1 }] };       // 手机上把我的第一条删了（比我新）
      await cdp.send('Page.navigate', { url: 'about:blank' }); await sleep(500);        // 离开页面时 pagehide 会把本地进度推上去：先让它推完，再放进「另一台设备写的」
      iv.prog[progPath] = JSON.stringify(other);
      await fresh(IVURL + hashFor('pdf/text.pdf'));
      await waitFor(`window.__IV.state().total === 8 && document.querySelector('#pageBox img')`, 25000);
      await sleep(500);
      const merged = await bmRec();
      check('再打开：云端的书签合并进来（手机加的第 7 页有了；我的另一条还在；手机删的那条消失）—— 合并不是覆盖',
        C_live(merged).some((b) => b.id === 'other1' && b.i === 6) && C_live(merged).some((b) => b.id === mineIds[1]) && !C_live(merged).some((b) => b.id === mineIds[0]) && merged.some((b) => b.id === mineIds[0] && b.x), { merged, gets: iv.progLog.filter((e) => e.method === 'GET').map((e) => e.path + ' ' + e.status), progPath, keys: Object.keys(iv.prog) });
      iv.progLog.length = 0;
      await cdp.eval(`window.__IV.showPage(3); return 1;`); await sleep(300);
      await cdp.eval(`await window.__IV.syncPush(false); return 1;`);
      for (let i = 0; i < 30 && !iv.progLog.some((e) => e.method === 'PUT' && e.status === 201); i++) await sleep(100);
      const put2 = iv.progLog.filter((e) => e.method === 'PUT' && e.status === 201).map((e) => JSON.parse(e.body)).pop();
      check('之后的推送带的是合并结果（含手机的书签和我删掉的墓碑），不会把手机的书签冲掉', put2 && put2.bm && put2.bm.some((b) => b.id === 'other1' && !b.x) && put2.bm.some((b) => b.id === mineIds[0] && b.x), put2);
      const oldFormat = { v: 1, key: TKEY, at: Date.now() - 1000, index: 1, chapter: 0, total: 8, direction: 'ltr', title: 'text.pdf', dev: '电脑' };       // 旧版本写的：没有 bm
      const before = C_live(await bmRec()).length;
      await cdp.send('Page.navigate', { url: 'about:blank' }); await sleep(500);
      iv.prog[progPath] = JSON.stringify(oldFormat);
      await fresh(IVURL + hashFor('pdf/text.pdf'));
      await waitFor(`window.__IV.state().total === 8 && document.querySelector('#pageBox img')`, 25000);
      check('云端是旧格式（没有 bm）：本地书签不丢', C_live(await bmRec()).length === before, { before, now: await bmRec() });

      /* ---- 4) 朗读：假引擎，V 开始，一路读到最后；页眉 / 页码 / 脚注不读；跨页半句拼成一句；跟着翻页；没文字的页停下并解释 ---- */
      check('（朗读）重新打开', !!(await openText(false)));
      await fakeEngine(4);
      await K('v');
      await waitFor(`window.__IV.tts.state().state === 'idle' && window.__fake.spoken.length > 5`, 20000);
      const said = await cdp.eval(`return { spoken: window.__fake.spoken, idx: window.__fake.idx };`);
      const expect = ['春天到了，山上的雪慢慢融化。', '溪水从石缝里流出来，带着泥土的气息。', '村里的孩子们早早起床，拿着竹篮去河边捡柴。', '老人坐在门口晒太阳，他说今年的收成一定不错。',
        '孩子们听了都很高兴，因为这意味着秋天可以吃到更多的甜瓜，还有妈妈亲手在灶台边做出来的那些香喷喷的红薯。', '夜里，月亮升起来，整个山谷安静得像一幅画。', '第二天一早，他们又出发了。',
        'Reading aloud works with English too.', 'It is fine.', '第二章旅途', '路上遇到了一位旅人，他背着一个很大的包袱。', '他说自己从很远的地方来，要去看望多年不见的朋友。', '最后一页的故事很短。'];
      check('读出来的就是这 13 句（页眉 / 页码 / 脚注没读；第 1 页的半句和第 2 页开头拼成一句；没文字的第 4 页被跳过）', JSON.stringify(said.spoken) === JSON.stringify(expect), said.spoken);
      check('读到哪页，画面就翻到哪页（第 1 页的 4 句在第 1 页；拼出来的那句在第 2 页；英文在第 2 页；标题在第 3 页；最后一句在第 5 页）',
        JSON.stringify(said.idx) === JSON.stringify([0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 4]), said.idx);
      const endSt = await stateOf();
      check('后面连续 3 页（6、7、8）没有文字层 → 停在第 8 页并解释「是扫描图片，需要先 OCR」', endSt.index === 7 && /扫描的图片/.test(await toastText()) && /OCR/.test(await toastText()), { index: endSt.index, toast: await toastText() });
      check('朗读条显示、按钮回到 ▶', !(await hidden('ttsBar')) && (await q('#ttsPlay', 'textContent')) === '▶', await q('#ttsPlay', 'textContent'));

      /* ---- 5) 暂停 / 继续 / 自己翻页 / 速度 / 停止 / 换书 ---- */
      await cdp.eval(`window.__IV.showPage(0); return 1;`); await sleep(200);
      await fakeEngine(60);
      await K('v'); await waitFor(`window.__fake.spoken.length >= 1`, 5000);
      check('朗读中：按钮是 ⏸，状态 playing', (await q('#ttsPlay', 'textContent')) === '⏸' && (await cdp.eval(`return window.__IV.tts.state().state;`)) === 'playing');
      await K('v'); await sleep(40);
      const n1 = await cdp.eval(`return window.__fake.spoken.length;`); await sleep(250);
      check('按 V 暂停：状态 paused、按钮 ▶，250ms 内不再前进', (await cdp.eval(`return window.__IV.tts.state().state;`)) === 'paused' && (await cdp.eval(`return window.__fake.spoken.length;`)) === n1 && (await q('#ttsPlay', 'textContent')) === '▶', n1);
      await K('v');
      await waitFor(`window.__fake.spoken.length > ${n1}`, 5000);
      check('再按 V 继续：接着读', (await cdp.eval(`return window.__IV.tts.state().state;`)) === 'playing');
      await cdp.eval(`window.__fake.spoken.length = 0; window.__fake.idx.length = 0; return 1;`);
      const idxBefore = (await stateOf()).index;
      await K('ArrowRight'); await waitFor(`window.__fake.spoken.length >= 1`, 5000);
      const nav = await cdp.eval(`return { first: window.__fake.spoken[0], idx: window.__fake.idx[0], page: window.__IV.state().index };`);
      const pageFirst = { 1: '红薯。', 2: '第二章旅途', 4: '最后一页的故事很短。' };
      check('朗读中自己翻页（→）：从新页开头重新读（不接着读旧页，也不带上一页的半句）', nav.page === idxBefore + 1 && nav.idx === nav.page && nav.first === pageFirst[nav.page], { idxBefore, nav });
      await cdp.eval(`document.querySelector('#ttsRate').value = '1.5'; document.querySelector('#ttsRate').dispatchEvent(new Event('change')); return 1;`);
      check('语速选择存进设置（rate = 1.5）', (await cdp.eval(`return window.__IV.tts.cfg().rate;`)) === 1.5);
      await cdp.eval(`document.querySelector('#ttsPrev').click(); return 1;`); await sleep(300);
      check('⏮ 上一页：翻到上一页并从那页读', (await stateOf()).index <= 1 && (await cdp.eval(`return window.__IV.tts.state().state;`)) === 'playing', await stateOf());
      await cdp.eval(`document.querySelector('#ttsStop').click(); return 1;`); await sleep(100);
      const cancels = await cdp.eval(`return window.__fake.cancels;`);
      const nStop = await cdp.eval(`return window.__fake.spoken.length;`); await sleep(200);
      check('⏹ 停止：引擎被取消、状态 idle、之后不再读', (await cdp.eval(`return window.__IV.tts.state().state;`)) === 'idle' && cancels > 0 && (await cdp.eval(`return window.__fake.spoken.length;`)) === nStop && !(await hidden('ttsBar')));
      await K('v'); await waitFor(`window.__IV.tts.state().state === 'playing'`, 3000);
      await cdp.eval(`window.__IV.openItems([await __mk('x1.png', 'zz/x1.png', 100, 150)], { kind: 'dir', title: 'zz' }); return 1;`); await sleep(400);
      check('读着读着换了一本书：朗读停止、朗读条收起', (await cdp.eval(`return window.__IV.tts.state().state;`)) === 'idle' && (await hidden('ttsBar')));
      await K('v'); await sleep(200);
      check('不是 PDF（没有文字层）按 V：提示只支持带文字层的 PDF，不会开始', /只支持 PDF/.test(await toastText()) && (await cdp.eval(`return window.__IV.tts.state().state;`)) === 'idle');

      /* ---- 6) 朗读设置：在线语音要令牌 + 同意；保存进 localStorage；CSP 允许 blob: 音频 ---- */
      check('（设置）重新打开', !!(await openText(false)));
      await fakeEngine(200);
      await K('v'); await sleep(150);
      await cdp.eval(`window.__IV.tts.stop(false); return 1;`);
      await cdp.eval(`document.querySelector('#ttsCfg').click(); return 1;`); await sleep(100);
      check('⚙ 打开朗读设置', !(await hidden('ttsSet')));
      await cdp.eval(`const s = (id, v) => { const e = document.querySelector(id); e.value = v; }; s('#ttsEngine', 'cloud'); s('#ttsToken', ''); document.querySelector('#ttsConsent').checked = false; document.querySelector('#ttsSave').click(); return 1;`);
      check('选在线语音但没填令牌 / 没同意：不保存，提示原因，对话框不关', /令牌/.test(await q('#ttsSetMsg', 'textContent')) && !(await hidden('ttsSet')) && (await cdp.eval(`return localStorage.getItem('iv.tts.v1');`)) === null);
      await cdp.eval(`document.querySelector('#ttsToken').value = 'secret-token'; document.querySelector('#ttsConsent').checked = true; document.querySelector('#ttsVoice').value = 'zh-CN-YunxiNeural'; document.querySelector('#ttsSave').click(); return 1;`);
      const sv = await cdp.eval(`return JSON.parse(localStorage.getItem('iv.tts.v1'));`);
      check('填令牌 + 同意后保存：写进 localStorage（只在这台设备）、对话框关闭', sv && sv.engine === 'cloud' && sv.token === 'secret-token' && sv.consent === true && sv.voice === 'zh-CN-YunxiNeural' && (await hidden('ttsSet')), sv);
      check('令牌没有出现在页面地址 / 进度同步里（只在设置和 Authorization 头）', !(await cdp.eval(`return location.href;`)).includes('secret-token'));
      const cspProbe = await cdp.eval(`window.__csp.length = 0;
        const wav = new Uint8Array([82,73,70,70,36,0,0,0,87,65,86,69,102,109,116,32,16,0,0,0,1,0,1,0,64,31,0,0,64,31,0,0,1,0,8,0,100,97,116,97,0,0,0,0]);
        const a = new Audio(); a.src = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
        const r = await new Promise((res) => { a.onloadedmetadata = () => res('loaded'); a.onerror = () => res('error:' + (a.error && a.error.code)); setTimeout(() => res('timeout'), 3000); });
        await new Promise((r2) => setTimeout(r2, 100));
        return { r, csp: window.__csp.slice() };`);
      check('页面 CSP 带 media-src \'self\' blob:，blob: 音频能加载、没有 CSP 违规（在线朗读要用）', /media-src 'self' blob:/.test(CSPH) && cspProbe.csp.length === 0 && cspProbe.r !== 'timeout', cspProbe);
      }
      }
      }
      /*BMTTS-END*/
      /*AIREAD-BEGIN*/
      {   // [23g] AI 朗读：无文字层的扫描 PDF -> 同源 /ocr/v1/page（假服务，和 deploy/server/ocr/server.py 同一份契约）-> 现有朗读管线。块作用域：变量别和前后重名
      log('\n[23g] AI 朗读（无文字层 PDF）：开关只在无文字层时出现 / 一次性同意 / 令牌 / 切叶顺序 / 预取 / 缓存（含重开页面）/ 跳过注文 / 429 重试 / 422 跳页 / 翻页取消 / 额度停止 / 撤回同意');
      const O = iv.ocr;
      const sp = (w, h, bars) => ({ kind: 'ink', w, h, bars });
      bookBufs['pdf/scan.pdf'] = buildPdf({ pages: [
        sp(1200, 1000, [[60, 520], [640, 1140]]),     // 1 合页，装订线在 ~48.3%（偏离中点）
        sp(1200, 1000, [[60, 560], [640, 1140]]),     // 2 合页，装订线居中
        sp(612, 792, [[72, 540]]),                    // 3 单页（宽 < 高：不切）
        sp(1200, 1000, [[60, 560], [640, 1140]]),     // 4
        sp(1200, 1000, [[60, 560], [640, 1140]]),     // 5
        sp(612, 792, [[72, 540]])] });                // 6 单页
      const TOK = 'ocr-secret';
      const CSPH_AI = (/header Content-Security-Policy "([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, 'deploy', 'Caddyfile.iv.snippet'), 'utf8')) || [])[1];
      const hid = (id) => cdp.eval(`return document.querySelector('#${id}').classList.contains('hidden');`);
      const qq = (sel, prop) => cdp.eval(`const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.${prop} : null;`);
      const click = (sel) => cdp.eval(`document.querySelector(${JSON.stringify(sel)}).click(); return 1;`);
      const lsCfg = () => cdp.eval(`return JSON.parse(localStorage.getItem('iv.tts.v1') || 'null');`);
      const aiSt = () => cdp.eval(`return window.__IV.ai.state();`);
      const toasts = () => cdp.eval(`return (window.__toasts || []).slice();`);
      const spokenNow = () => cdp.eval(`return window.__fake.spoken.slice();`);
      const idleW = (ms) => waitFor(`window.__IV.tts.state().state === 'idle'`, ms || 25000);
      const okReqs = () => O.log.filter((l) => l.status === 200);
      const fake = (delay) => cdp.eval(`window.__fake = { spoken: [], idx: [], cancels: 0, delay: ${delay}, lastError: null, _gen: 0,
        speak(t) { const g = this._gen; return new Promise((res) => { setTimeout(() => { if (g !== this._gen) return res('cancel'); this.spoken.push(t); this.idx.push(window.__IV.state().index); res('end'); }, this.delay); }); },
        prefetch() {}, cancel() { this._gen++; this.cancels++; }, pause() {}, resume() {} };
        window.__IV.tts.useEngine(window.__fake); return 1;`);
      const watchToasts = () => cdp.eval(`window.__toasts = []; const t = document.querySelector('#toast');
        new MutationObserver(() => { const x = t.textContent; if (x && window.__toasts[window.__toasts.length - 1] !== x) window.__toasts.push(x); }).observe(t, { childList: true, characterData: true, subtree: true }); return 1;`);
      const sentsOf = (pgs, skip) => {
        const out = [];
        for (const n of pgs) for (const lf of (n === 3 || n === 6 ? [''] : ['右叶', '左叶'])) { out.push('第' + n + '页' + lf + '正文，天地玄黄。'); out.push(skip ? '宇宙洪荒。' : '【注：小注' + n + '】宇宙洪荒。'); }
        return out;
      };
      const openBook = async (rel, total, wipe) => {
        await fresh(IVURL);
        await cdp.eval(`${wipe ? `localStorage.removeItem('iv.tts.v1'); await new Promise((r) => { const q = indexedDB.deleteDatabase('iv-ocr'); q.onsuccess = q.onerror = q.onblocked = () => r(); });` : ''}
          localStorage.removeItem('iv.books.v1'); await window.__IV.davStore({ base: '${iv.origin}', library: 'library', user: 'viewer', pass: 'pä ss', syncDir: '' }); return 1;`);
        await fresh(IVURL + hashFor(rel));
        const ok = await waitFor(`window.__IV.state().total === ${total} && window.__IV.state().decoded[0] && window.__IV.state().decoded[0].w > 0`, 25000);
        await watchToasts(); await fake(5);
        return ok;
      };
      iv.pass = 'pä ss';
      const clearCache = async () => { await cdp.eval(`document.querySelector('#aiClear').click(); return 1;`); await sleep(150); };

      /* ---- 1) 开关只在无文字层的 PDF 上出现；没开 / 没同意 = 零请求 ---- */
      const opened = await openBook('pdf/scan.pdf', 6, true);
      check('打开 6 页的扫描 PDF（只有矢量黑块，没有文字层）', !!opened && (await stateOf()).bookKey === 'dav:pdf/scan.pdf', { toast: await toastText() });
      await waitFor(`window.__IV.ai.state().probed !== null`, 15000);
      let a0 = await aiSt();
      check('探测（抽样第 1 / 3 / 6 页都没有文字）→ 无文字层，🤖 开关显示', a0.noText === true && a0.btnHidden === false && JSON.stringify(a0.probed) === '[false,false,false]', a0);
      check('还没开启：没有任何 /ocr 请求（连用量也不查）', O.log.length === 0 && O.usageLog.length === 0);
      await cdp.eval(`window.__IV.tts.start(1); return 1;`);
      await waitFor(`window.__toasts.some((t) => /🤖/.test(t))`, 15000);
      check('没开 AI 直接按朗读：连续 3 页没文字就停，提示改成「点 🤖 开启 AI 朗读（页面图片会发送到阿里云）」，不再只说「需要先 OCR」',
        (await toasts()).some((t) => /🤖/.test(t) && /阿里云/.test(t)) && O.log.length === 0, await toasts());

      await openBook('pdf/text.pdf', 8, false);
      await waitFor(`window.__IV.ai.state().probed !== null`, 15000);
      const aT = await aiSt();
      check('带文字层的 PDF：🤖 开关不显示，朗读行为不变', aT.noText === false && aT.btnHidden === true && aT.active === false, aT);
      await cdp.eval(`window.__IV.tts.start(1); return 1;`); await waitFor(`window.__fake.spoken.length >= 2`, 8000);
      check('带文字层的 PDF 照常朗读（走文字层，没有 /ocr 请求）', (await spokenNow())[0] === '春天到了，山上的雪慢慢融化。' && O.log.length === 0, await spokenNow());
      await cdp.eval(`window.__IV.tts.stop(false); return 1;`);

      /* ---- 2) 一次性同意 + 令牌 ---- */
      await openBook('pdf/scan.pdf', 6, false);
      await waitFor(`window.__IV.ai.state().probed !== null`, 15000);
      await click('#btnAi'); await sleep(150);
      check('点 🤖：先弹一次性同意框（页面图片将发送到阿里云（通义千问）），此时一个请求都没有', !(await hid('aiConsent')) && /页面图片将发送到阿里云（通义千问）进行文字识别/.test(await qq('#aiConsent', 'textContent')) && O.log.length === 0);
      await click('#aiConsent [data-close="aiConsent"]'); await sleep(100);
      const cfgNo = await lsCfg();
      check('取消同意：不保存同意、AI 没开、仍然零请求', (await hid('aiConsent')) && !(cfgNo && cfgNo.aiConsent) && (await aiSt()).active === false && O.log.length === 0, cfgNo);
      await click('#btnAi'); await click('#aiConsentOk'); await sleep(200);
      const cfgC = await lsCfg();
      check('同意 → 保存 aiConsent（和逐句朗读的 consent 是两份）；还没有令牌 → 打开设置框并提示填令牌，仍无请求',
        cfgC && cfgC.aiConsent === true && !cfgC.consent && !(await hid('ttsSet')) && /令牌/.test(await qq('#ttsSetMsg', 'textContent')) && (await aiSt()).active === false && O.log.length === 0, { cfgC, msg: await qq('#ttsSetMsg', 'textContent') });
      check('设置框里 AI 区：同意已勾选、版面默认竖排古籍、「跳过注文」默认关', (await qq('#aiConsentChk', 'checked')) === true && (await qq('#aiMode', 'value')) === 'vertical-classical' && (await qq('#aiSkipNotes', 'checked')) === false);
      await cdp.eval(`document.querySelector('#ttsEngine').value = 'browser'; document.querySelector('#ttsToken').value = '${TOK}'; document.querySelector('#ttsSave').click(); return 1;`); await sleep(150);
      const cfgT = await lsCfg();
      check('保存设置：令牌复用 TTS 令牌；AI 同意没有被保存动作冲掉', cfgT && cfgT.token === TOK && cfgT.aiConsent === true && cfgT.engine === 'browser' && (await hid('ttsSet')), cfgT);
      await click('#btnAi');
      await waitFor(`/今日 0\\/300/.test(document.querySelector('#aiUse').textContent)`, 5000);
      const aOn = await aiSt();
      check('再点 🤖：开启（按钮亮），查一次用量（Bearer 令牌）并显示「今日 0/300」', aOn.active === true && (await qq('#btnAi', 'classList.contains("on")')) && O.usageLog.length === 1 && O.usageLog[0].auth === 'Bearer ' + TOK && /今日 0\/300/.test(await qq('#aiUse', 'textContent')), { aOn, u: O.usageLog });

      /* ---- 3) 预取（只看后两页）、并发 ≤ 2、右叶先于左叶；单页不切 ---- */
      await fake(1500);
      await cdp.eval(`window.__IV.tts.start(1); return 1;`);
      await waitFor(`window.__fake.spoken.length >= 1`, 20000);
      for (let i = 0; i < 60 && okReqs().length < 5; i++) await sleep(100);
      await sleep(300);
      const pgsSeen = [...new Set(O.log.map((l) => l.page))].sort();
      check('读第 1 页时预取后两页（1、2、3 都已识别），没有多取第 4 页；同时在飞的请求 ≤ 2', JSON.stringify(pgsSeen) === '[1,2,3]' && okReqs().length === 5 && O.maxInflight <= 2 && (await spokenNow()).length <= 2, { pgsSeen, ok: okReqs().length, max: O.maxInflight });
      const order = O.log.map((l) => l.page + l.leaf);
      check('每个合页：右叶请求在左叶之前（竖排古籍），单页（第 3 页）只有一张图（S）', order.indexOf('1R') >= 0 && order.indexOf('1R') < order.indexOf('1L') && order.indexOf('2R') < order.indexOf('2L') && order.includes('3S') && !order.includes('3R'), order);
      check('每个请求：Bearer 令牌、mode=vertical-classical、JPEG 长边 ≤ 2048 且 ≤ 1.2MB（假服务端和真服务端同一套校验，全部 200）',
        O.log.every((l) => l.auth === 'Bearer ' + TOK && l.mode === 'vertical-classical' && l.ok && l.status === 200 && l.dims && Math.max(l.dims.w, l.dims.h) <= 2048 && l.bytes <= 1200 * 1024), O.log.map((l) => [l.page, l.leaf, l.status, l.dims, l.bytes]));
      await cdp.eval(`window.__IV.tts.stop(false); return 1;`);
      await sleep(200);
      const g1 = await cdp.eval(`return await window.__IV.ai.render(1);`), g2 = await cdp.eval(`return await window.__IV.ai.render(2);`), g3 = await cdp.eval(`return await window.__IV.ai.render(3);`);
      const gut = (g) => (g.leaves[0].x + 0.02 * g.leaves[0].W) / g.leaves[0].W;       // 右叶左缘 + 外扩 2% = 装订线位置
      check('装订线按墨迹找：第 1 页偏心（≈48.3%，不是固定中点），第 2 页居中（≈50%）；叶序 = [右, 左]',
        Math.abs(gut(g1) - 0.483) < 0.012 && Math.abs(gut(g2) - 0.5) < 0.012 && g1.leaves[0].leaf === 'R' && g1.leaves[1].leaf === 'L' && g2.leaves[0].leaf === 'R', { g1: gut(g1), g2: gut(g2), l: g1.leaves.map((x) => x.leaf) });
      check('右叶、左叶各 ≈ 一半多一点（外扩 2%）；每叶编码后长边 ≤ 2000、≤ 1.1MB；单页只一叶',
        g1.leaves.every((x) => Math.max(x.jw, x.jh) <= 2000 && x.bytes <= 1100 * 1024 && x.w > g1.leaves[0].W * 0.45 && x.w < g1.leaves[0].W * 0.6) && g3.leaves.length === 1 && g3.leaves[0].leaf === 'S', { g1: g1.leaves, g3: g3.leaves });

      /* ---- 4) 整本读：句子顺序（右叶先、左叶后，注文照读）、进度、用量；CSP / SW ---- */
      await fake(5);
      await cdp.eval(`window.__IV.tts.start(1); return 1;`);
      await idleW(40000);
      const said = await spokenNow();
      check('从第 1 页读到第 6 页：每个合页先读右叶再读左叶，【注：……】默认照读（20 句，顺序精确）', JSON.stringify(said) === JSON.stringify(sentsOf([1, 2, 3, 4, 5, 6], false)), said);
      check('整本只发了 10 个识别请求（前 3 页来自缓存，没有重复）；读完提示「朗读完毕」', okReqs().length === 10 && O.log.length === 10 && (await toasts()).some((t) => /朗读完毕/.test(t)), { n: O.log.length });
      check('朗读条显示「今日 10/300」（用量来自响应）', /今日 10\/300/.test(await qq('#aiUse', 'textContent')), await qq('#aiUse', 'textContent'));
      check('全程 CSP 零违规（同源 connect-src \'self\' 就够，不用改 CSP）', (await cdp.eval(`return window.__csp || [];`)).length === 0 && /connect-src 'self'/.test(CSPH_AI) && !/ocr/.test(CSPH_AI), await cdp.eval(`return window.__csp`));
      const swSeen = await cdp.eval(`const ks = await caches.keys(); const urls = []; for (const k of ks) { const c = await caches.open(k); (await c.keys()).forEach((r) => urls.push(r.url)); } return urls;`);
      check('service worker 没缓存任何 /ocr 请求（POST / 带 Authorization / 不在 /iv/ 范围）', !swSeen.some((u) => /\/ocr\//.test(u)), swSeen);

      /* ---- 5) 缓存：同一会话再读、重开页面再读都零请求；跳过注文只在朗读时生效 ---- */
      const nBefore = O.log.length;
      await cdp.eval(`window.__fake.spoken.length = 0; window.__IV.tts.start(1); return 1;`); await idleW(40000);
      check('再读一遍：缓存命中，零新请求，内容相同', O.log.length === nBefore && JSON.stringify(await spokenNow()) === JSON.stringify(sentsOf([1, 2, 3, 4, 5, 6], false)), { n: O.log.length });
      await openBook('pdf/scan.pdf', 6, false);
      await waitFor(`window.__IV.ai.state().probed !== null`, 15000);
      await cdp.eval(`window.__IV.tts.start(1); return 1;`); await idleW(40000);
      const aRe = await aiSt(), cs = await cdp.eval(`return window.__IV.ai.cacheStats();`);
      check('关掉页面重新打开再读：IndexedDB 缓存命中，零新请求（识别结果跟着这台设备走）', O.log.length === nBefore && aRe.hits >= 6 && cs && cs.usingIdb === true && JSON.stringify(await spokenNow()) === JSON.stringify(sentsOf([1, 2, 3, 4, 5, 6], false)), { n: O.log.length, hits: aRe.hits, cs });
      await click('#ttsCfg'); await sleep(150);
      await waitFor(`/今日已识别 10 \\/ 300 页/.test(document.querySelector('#aiUsage').textContent)`, 5000);
      check('设置框显示用量「今日已识别 10 / 300 页」', /今日已识别 10 \/ 300 页/.test(await qq('#aiUsage', 'textContent')), await qq('#aiUsage', 'textContent'));
      await cdp.eval(`document.querySelector('#aiSkipNotes').checked = true; document.querySelector('#ttsSave').click(); return 1;`); await sleep(150);
      const cfgS = await lsCfg();
      check('勾「跳过注文」并保存：写进设置，AI 开关 / 同意仍在', cfgS && cfgS.aiSkipNotes === true && cfgS.ai === true && cfgS.aiConsent === true, cfgS);
      await cdp.eval(`window.__fake.spoken.length = 0; window.__IV.tts.start(1); return 1;`); await idleW(40000);
      check('跳过注文：同样的缓存，朗读时去掉【注：……】（不用重新请求）', O.log.length === nBefore && JSON.stringify(await spokenNow()) === JSON.stringify(sentsOf([1, 2, 3, 4, 5, 6], true)) && !(await spokenNow()).some((t) => /注/.test(t)), (await spokenNow()).slice(0, 4));

      /* ---- 6) 横排：合页先读左叶，请求 mode=horizontal；清缓存按钮 ---- */
      await click('#ttsCfg'); await sleep(100);
      await cdp.eval(`document.querySelector('#aiSkipNotes').checked = false; document.querySelector('#aiMode').value = 'horizontal'; document.querySelector('#ttsSave').click(); return 1;`); await sleep(150);
      await clearCache();
      const nH = O.log.length;
      await cdp.eval(`window.__fake.spoken.length = 0; window.__IV.tts.start(1); return 1;`);
      await waitFor(`window.__fake.spoken.length >= 4`, 20000);
      const hOrder = O.log.slice(nH).filter((l) => l.page === 1).slice(0, 2).map((l) => l.page + l.leaf + ':' + l.mode);
      check('横排版面：先左叶后右叶，请求 mode=horizontal；清除缓存后重新识别（有新请求）', JSON.stringify(hOrder) === JSON.stringify(['1L:horizontal', '1R:horizontal']) && /第1页左叶/.test((await spokenNow())[0]), { hOrder, s: (await spokenNow()).slice(0, 2) });
      await cdp.eval(`window.__IV.tts.stop(false); return 1;`);
      await click('#ttsCfg'); await sleep(100);
      await cdp.eval(`document.querySelector('#aiMode').value = 'vertical-classical'; document.querySelector('#ttsSave').click(); return 1;`); await sleep(150);

      /* ---- 7) 429 + Retry-After：按等待时间重试一次后成功 ---- */
      await clearCache(); await fake(5);
      let tripped = false;
      O.script = (ent) => (ent.page === 3 && !tripped ? (tripped = true, { status: 429, headers: { 'Retry-After': '1' }, body: { error: 'rate limited', code: 'rate_limited', retryAfter: 1 } }) : null);
      const n7 = O.log.length;
      await cdp.eval(`window.__IV.tts.start(3); return 1;`);
      await waitFor(`window.__fake.spoken.some((t) => /第3页正文/.test(t))`, 20000);
      const p3 = O.log.slice(n7).filter((l) => l.page === 3);
      check('429（Retry-After: 1）：不丢页，等约 1 秒后重发同一页并成功；读出第 3 页', p3.length === 2 && p3[0].status === 429 && p3[1].status === 200 && p3[1].t - p3[0].t >= 900 && (await spokenNow()).includes('第3页正文，天地玄黄。'), p3.map((l) => [l.status, l.t - p3[0].t]));
      await idleW(30000); O.script = null;

      /* ---- 8) 422 refused：这一页跳过并提示原因，不重试；🔄 重试这一页 ---- */
      await clearCache();
      O.script = (ent) => (ent.page === 5 ? { status: 422, body: { error: 'refused', code: 'refused' } } : null);
      const n8 = O.log.length;
      await cdp.eval(`window.__fake.spoken.length = 0; window.__IV.tts.start(4); return 1;`);
      await idleW(30000);
      const s8 = await spokenNow(), t8 = await toasts(), r5 = O.log.slice(n8).filter((l) => l.page === 5);
      check('第 5 页被拒（422 refused）：提示「第 5 页识别失败：模型拒绝识别…」并跳过，第 4、6 页照读', t8.some((t) => /第 5 页识别失败：模型拒绝识别/.test(t)) && s8.some((t) => /第4页/.test(t)) && s8.some((t) => /第6页/.test(t)) && !s8.some((t) => /第5页/.test(t)), { t8, s8 });
      check('refused 不重试：第 5 页只请求了 1 次（预取和朗读合并）', r5.length === 1 && r5[0].status === 422, r5.map((l) => l.status));
      O.script = null;
      await cdp.eval(`window.__IV.showPage(4); return 1;`); await sleep(150);
      await cdp.eval(`window.__fake.spoken.length = 0; return 1;`);
      await click('#ttsRetry');
      await waitFor(`window.__fake.spoken.some((t) => /第5页右叶/.test(t))`, 15000);
      check('🔄 重试这一页（跳过缓存）：这回识别成功并读出第 5 页', (await spokenNow()).some((t) => /第5页右叶正文/.test(t)), await spokenNow());
      await idleW(30000);

      /* ---- 9) 翻页取消：还在飞的识别请求被中止，新页立刻开始 ---- */
      await clearCache(); await fake(5);
      O.script = (ent) => (ent.page === 2 ? { delay: 4000 } : null);
      const n9 = O.log.length;
      await cdp.eval(`window.__IV.tts.start(2); return 1;`);
      await waitFor(`/AI 识别中/.test(document.querySelector('#ttsText').textContent)`, 8000);
      const hint = await qq('#ttsText', 'textContent');
      for (let i = 0; i < 40 && !O.log.slice(n9).some((l) => l.page === 2); i++) await sleep(100);
      await sleep(200);
      await cdp.eval(`window.__IV.showPage(5); return 1;`);                           // 用户翻到第 6 页（离开 2..4 的预取窗口）
      await waitFor(`window.__fake.spoken.some((t) => /第6页正文/.test(t))`, 15000);
      await sleep(300);
      const l9 = O.log.slice(n9), p2 = l9.filter((l) => l.page === 2);
      check('读第 2 页时朗读条显示「AI 识别中…（第 2 页）」', /AI 识别中…（第 2 页）/.test(hint), hint);
      check('翻到第 6 页：第 2 页还在飞的请求被中止（服务端看到连接断开），不再重发；第 6 页立刻读出，没读第 2 页',
        p2.length === 1 && p2[0].aborted === true && (await spokenNow()).some((t) => /第6页正文/.test(t)) && !(await spokenNow()).some((t) => /第2页/.test(t)), { p2: p2.map((l) => [l.status, l.aborted]), s: await spokenNow() });
      O.script = null; await idleW(20000);

      /* ---- 10) 额度用完（429 daily_cap）：整体停止、说明原因、不重试 ---- */
      await clearCache(); await fake(5);
      O.script = () => ({ status: 429, headers: { 'Retry-After': '7200' }, body: { error: 'daily page quota exceeded', code: 'daily_cap', retryAfter: 7200 } });
      const n10 = O.log.length;
      await cdp.eval(`window.__IV.tts.start(1); return 1;`);
      await waitFor(`window.__toasts.some((t) => /AI 朗读已停止/.test(t))`, 15000);
      await sleep(400);
      const l10 = O.log.slice(n10), t10 = await toasts();
      check('daily_cap：提示「今日 AI 识别额度用完了（约 2 小时后恢复）」，朗读停止，不自动重试（每个请求只发一次）',
        t10.some((t) => /AI 朗读已停止：今日 AI 识别额度用完了（约 2 小时后恢复）/.test(t)) && (await cdp.eval(`return window.__IV.tts.state().state;`)) === 'idle' && l10.length >= 1 && l10.length <= 3 && l10.every((l) => l.status === 429) && new Set(l10.map((l) => l.page + l.leaf)).size === l10.length, { t10, l10: l10.map((l) => l.page + l.leaf) });
      O.script = null;

      /* ---- 11) 撤回同意：AI 关闭，再读不发任何请求 ---- */
      await click('#ttsCfg'); await sleep(100);
      await cdp.eval(`document.querySelector('#aiConsentChk').checked = false; document.querySelector('#ttsSave').click(); return 1;`); await sleep(200);
      const cfgW = await lsCfg(), n11 = O.log.length;
      check('设置里撤回同意：AI 同意和开关都清掉，🤖 按钮不再亮', cfgW && cfgW.aiConsent === false && cfgW.ai === false && !(await qq('#btnAi', 'classList.contains("on")')), cfgW);
      await cdp.eval(`window.__IV.tts.start(1); return 1;`); await sleep(1500);
      check('撤回后再读：不发任何 /ocr 请求', O.log.length === n11 && (await aiSt()).active === false);
      }
      /*AIREAD-END*/
      /*SCROLLFIX-BEGIN*/
      {   // [11b] 真实输入：命中层 / 滚轮 / 拖拽 / 方向键 / 点击分区 / UI 在命中层之上（块作用域，别和前面的变量重名）
      /* ======== [11b] 为什么要单独一节：[11] 里的手势测试是 vp.dispatchEvent(...)，事件直接塞给监听器，根本不经过命中测试，
         所以「真实鼠标事件打不到监听器」这类 bug（监听器挂在带 translate/scale 的 #viewport 上，命中框缩小 / 移出窗口）它看不见。
         这一节全部用 CDP Input.dispatchMouseEvent / dispatchKeyEvent / dispatchTouchEvent 发真实输入，并用 elementFromPoint 网格验证命中。 ======== */
      log('\n[11b] 真实输入（CDP Input.*）：命中层网格 / 滚轮 / 拖拽 / 方向键 / 点击分区 / 触摸 / UI 在命中层之上');
      bookBufs['pdf/scroll.pdf'] = buildPdf({ pages: Array.from({ length: 6 }, () => ({ kind: 'text' })) });   // 6 页 Letter 竖版：按页宽读时比窗口高
      const mouse = (type, x, y, o) => cdp.send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'none' }, o || {}));
      const wheel = (x, y, dx, dy, mod) => mouse('mouseWheel', x, y, { deltaX: dx, deltaY: dy, modifiers: mod || 0 });
      const CTRL = 2;
      const click = async (x, y, n) => {
        await mouse('mouseMoved', x, y);
        for (let i = 1; i <= (n || 1); i++) {
          await mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: i });
          await mouse('mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: i });
        }
      };
      const drag = async (x0, y0, x1, y1, steps) => {
        steps = steps || 8;
        await mouse('mouseMoved', x0, y0);
        await mouse('mousePressed', x0, y0, { button: 'left', buttons: 1, clickCount: 1 });
        for (let i = 1; i <= steps; i++) await mouse('mouseMoved', x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, { buttons: 1 });
        await mouse('mouseReleased', x1, y1, { button: 'left', buttons: 0, clickCount: 1 });
      };
      const KEYS = { ArrowDown: ['ArrowDown', 40], ArrowUp: ['ArrowUp', 38], PageDown: ['PageDown', 34], PageUp: ['PageUp', 33],
        ' ': ['Space', 32], ArrowRight: ['ArrowRight', 39], ArrowLeft: ['ArrowLeft', 37], t: ['KeyT', 84], '0': ['Digit0', 48], '1': ['Digit1', 49], '2': ['Digit2', 50] };
      const key = async (k, o) => {
        const [code, vk] = KEYS[k];
        const text = k === ' ' ? ' ' : (k.length === 1 ? k : undefined);
        await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text }, o || {}));
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      };
      const st = () => cdp.eval(`const s = window.__IV.state(); return { index: s.index, zoom: s.zoom, panX: s.panX, panY: s.panY, fitMode: s.fitMode, total: s.total };`);
      const geo = () => cdp.eval(`const t = parseFloat(document.querySelector('#viewport').style.top) || 0, b = parseFloat(document.querySelector('#viewport').style.bottom) || 0;
        return { w: innerWidth, h: innerHeight, top: t, bottom: b, vh: innerHeight - t - b, hidden: document.body.classList.contains('ui-hidden') };`);
      const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1.5 : tol);
      /** 可视区里 13×13 个点的 elementFromPoint：落在命中层（#hit）= 好；落在工具栏 / 弹窗 / 翻页箭头等真实控件上 = 不算；其它（#viewport / BODY / 图片 …）= 坏 */
      const hitGrid = () => cdp.eval(`
        const t = parseFloat(document.querySelector('#viewport').style.top) || 0, b = parseFloat(document.querySelector('#viewport').style.bottom) || 0;
        const N = 13, bad = {}; let hitN = 0, uiN = 0, badN = 0;
        for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
          const x = innerWidth * (0.02 + 0.96 * i / (N - 1)), y = t + (innerHeight - t - b) * (0.02 + 0.96 * j / (N - 1));
          const el = document.elementFromPoint(x, y);
          if (el && el.id === 'hit') hitN++;
          else if (el && el.closest('#toolbar,#chapterBar,#volBar,#thumbs,#statusbar,.nav,#start,.modal,#toast')) uiN++;
          else { badN++; const k = el ? el.tagName + (el.id ? '#' + el.id : '') : 'null'; bad[k] = (bad[k] || 0) + 1; }
        }
        return { total: N * N, hitN, uiN, badN, bad };`);
      const hitOk = (g) => g.badN === 0 && g.hitN >= g.total * 0.85;
      const settle = async (idx) => {
        await waitFor(`window.__IV.state().index === ${idx} && window.__IV.state().pair[0] && window.__IV.state().pair[0].endsWith('第 ${idx + 1} 页') && (() => { const m = document.querySelector('#pageBox .page img'); return m && m.complete && m.naturalWidth > 0; })()`, 25000);
        await sleep(350);
      };
      const openScrollPdf = async () => {
        await fresh(IVURL + hashFor('pdf/scroll.pdf'));
        await waitFor(`window.__IV.state().total === 6 && window.__IV.state().decoded[0] && window.__IV.state().decoded[0].w > 0 && (() => { const m = document.querySelector('#pageBox .page img'); return m && m.complete && m.naturalWidth > 0; })()`, 25000);
        await cdp.eval(`window.__IV.showPage(0); return 1;`);               // 前面的用例存过进度（页码 / 适配方式）：每次都从第 1 页、按页宽开始
        await settle(0);
        await cdp.eval(`window.__IV.applyFit('width'); return 1;`);
        await sleep(400);
      };
      const wheelN = async (x, y, dy, n, gap) => { for (let i = 0; i < n; i++) { await wheel(x, y, 0, dy); await sleep(gap || 25); } };

      /* ---- 1) PDF 按页宽打开（默认）：命中网格、真实滚轮 / 拖拽 / 方向键 ---- */
      await openScrollPdf();
      let G = await geo(), s0 = await st();
      const CX = Math.round(G.w / 2), CY = Math.round(G.top + G.vh / 2);
      check('PDF 首次打开：按页宽（width），页面比可视区高（panY 在页首 > 0）', s0.fitMode === 'width' && s0.panY > 50 && s0.index === 0, s0);
      const gW = await hitGrid();
      check('命中网格 PDF 按页宽：可视区 169 个点全部落在 #hit（或真实控件），没有一个落在 #viewport / BODY / 图片上', hitOk(gW), gW);
      const compW = await cdp.eval(`const h = document.querySelector('#hit'), c = h ? getComputedStyle(h) : null, v = getComputedStyle(document.querySelector('#viewport'));
        return { hasHit: !!h, hitTouch: c ? c.touchAction : null, hitZ: c ? c.zIndex : null, vpPE: v.pointerEvents };`);
      check('命中层 #hit：touch-action:none（触摸手势在它上面）；#viewport pointer-events:none', compW.hasHit && compW.hitTouch === 'none' && compW.vpPE === 'none', compW);

      /* 真实滚轮：整页比窗口高 -> 上下滚动，不缩放，不改适配方式 */
      const pw0 = await st();
      await wheelN(CX, CY, 100, 3);
      const pw1 = await st();
      check('真实滚轮（deltaY=100 ×3，窗口中心）：panY 下移 300、zoom 不变、fitMode 仍为 width', near(pw0.panY - pw1.panY, 300) && pw1.zoom === pw0.zoom && pw1.fitMode === 'width' && pw1.index === 0, { pw0, pw1 });
      await wheelN(60, G.top + 80, -100, 2);       // 离中心很远的点（靠左上）
      const pw2 = await st();
      check('真实滚轮向上（deltaY=-100 ×2，靠边的点 (60, 顶部+80)）：panY 回升 200，zoom 不变', near(pw2.panY - pw1.panY, 200) && pw2.zoom === pw1.zoom, { pw1, pw2 });
      await wheelN(CX, CY, 100, 60, 5);            // 60 格（计划里的复现量）：原代码里 zoom 一路缩到最小
      const pw3 = await st();
      check('真实滚轮 60 格：zoom 仍是原值（原代码这里会缩到最小值）、停在页尾（panY = -页首 panY）、没有翻页', pw3.zoom === pw0.zoom && near(pw3.panY, -pw0.panY, 2) && pw3.index === 0, { pw0, pw3 });

      /* Ctrl+滚轮 / 捏合：任何时候都缩放 */
      await openScrollPdf();
      const cz0 = await st();
      await wheel(CX, CY, 0, -200, CTRL); await sleep(40);
      const cz1 = await st();
      check('Ctrl+滚轮（deltaY=-200）在比窗口高的页上照样缩放：zoom ×e^0.3、fitMode=custom', near(cz1.zoom / cz0.zoom, Math.exp(0.3), 0.01) && cz1.fitMode === 'custom', { cz0, cz1 });

      /* 真实拖拽：离中心很远的点，平移量 ≈ 拖动距离 */
      await openScrollPdf();
      const d0 = await st();
      await drag(200, CY, 200, CY - 120);
      const d1 = await st();
      await drag(200, CY - 120, 200, CY - 20);
      const d2 = await st();
      check('真实拖拽（起点 (200,中部) 偏离中心）：向上拖 120 -> panY 减 120；再向下拖 100 -> 加 100；zoom 不变、没翻页',
        near(d0.panY - d1.panY, 120, 2) && near(d2.panY - d1.panY, 100, 2) && d1.zoom === d0.zoom && d2.index === 0 && d2.fitMode === 'width', { d0, d1, d2 });
      await drag(560, CY, 300, CY - 10, 3);        // 快速横拖（鼠标）：向左 = ltr 的「下一页」方向（向右是上一页，在第 1 页本来就是空操作，测不出守卫）
      await sleep(100);
      check('鼠标在比窗口高的页上快速向左横拖（>60px、<320ms，下一页方向）：不翻页（触屏快滑翻页保留）', (await st()).index === 0, await st());
      await cdp.eval(`window.__IV.showPage(2); return 1;`); await settle(2);
      await drag(300, CY, 560, CY - 10, 3);        // 第 3 页上向右快拖 = 上一页方向（这回是真的会翻的方向）
      await sleep(100);
      check('鼠标在比窗口高的页上快速向右横拖（上一页方向，从第 3 页）：也不翻页', (await st()).index === 2, await st());
      /* 按下鼠标时命中层要拿到指针捕获（setPointerCapture）：拖到窗口外 / 工具栏上方时移动和抬起仍交给它。
         CDP 注入的鼠标事件不会按捕获重定向（实测：hasPointerCapture 为 true，事件目标仍是工具栏），所以这里直接断言捕获状态，不断言拖拽结果。 */
      await openScrollPdf();
      await mouse('mouseMoved', 300, CY);
      await mouse('mousePressed', 300, CY, { button: 'left', buttons: 1, clickCount: 1 });
      const hasCap = await cdp.eval(`return document.querySelector('#hit').hasPointerCapture(1);`);
      await mouse('mouseReleased', 300, CY, { button: 'left', buttons: 0, clickCount: 1 });
      check('鼠标按下后命中层持有指针捕获（hasPointerCapture）', hasCap === true, { hasCap });
      await mouse('mouseMoved', 600, CY);

      /* 方向键 / PageUp·PageDown / 空格：滚动 10% / 90% 可视区高度，到边才翻页，翻页后保持按页宽 */
      await openScrollPdf();
      G = await geo();
      const k0 = await st();
      for (let i = 0; i < 3; i++) await key('ArrowDown');
      const k1 = await st();
      check('ArrowDown ×3：panY 下移 0.3 × 可视区高度，没翻页', near(k0.panY - k1.panY, 0.3 * G.vh, 1) && k1.index === 0 && k1.zoom === k0.zoom, { k0, k1, vh: G.vh });
      for (let i = 0; i < 3; i++) await key('ArrowUp');
      const k2 = await st();
      check('ArrowUp ×3：回到页首（panY 恢复）', near(k2.panY, k0.panY, 1) && k2.index === 0, { k0, k2 });
      await key('PageDown');
      const k3 = await st();
      check('PageDown：panY 下移 0.9 × 可视区高度', near(k0.panY - k3.panY, 0.9 * G.vh, 1) && k3.index === 0, { k0, k3, vh: G.vh });
      await key('PageUp');
      check('PageUp：回到页首', near((await st()).panY, k0.panY, 1) && (await st()).index === 0, await st());
      await key(' ');
      check('空格：同样下移 0.9 × 可视区高度（不是翻页）', near(k0.panY - (await st()).panY, 0.9 * G.vh, 1) && (await st()).index === 0, await st());
      await key(' ');
      const k4 = await st();
      check('空格再按一次：滚到页尾（panY = -页首 panY），仍没翻页', near(k4.panY, -k0.panY, 1.5) && k4.index === 0, { k0, k4 });
      await key('ArrowDown', { autoRepeat: true });
      await sleep(250);
      check('在页尾长按（autoRepeat）ArrowDown：不连翻', (await st()).index === 0, await st());
      await key('PageDown');
      await settle(1);
      const k5 = await st();
      check('页尾再按 PageDown：翻到第 2 页，保持按页宽（width），从页首开始（panY = 页首值）', k5.index === 1 && k5.fitMode === 'width' && near(k5.panY, k0.panY, 2) && near(k5.zoom, k0.zoom, 1e-6), { k0, k5 });
      await key('PageUp');
      await settle(0);
      const k6 = await st();
      check('页首再按 PageUp：回到第 1 页，落在页尾（接着往上读：panY = -页首值），保持 width', k6.index === 0 && k6.fitMode === 'width' && near(k6.panY, -k0.panY, 2), { k0, k6 });
      await key('ArrowDown');
      await settle(1);
      const k7 = await st();
      check('从页尾落点按 ArrowDown：已在页尾 -> 翻到下一页，从页首开始（只在边上才翻）', k7.index === 1 && k7.fitMode === 'width' && near(k7.panY, k0.panY, 2), { k0, k7 });
      await key('ArrowRight');
      await settle(2);
      check('ArrowRight 照旧翻页（不受页面是否溢出影响）且保持 width', (await st()).index === 2 && (await st()).fitMode === 'width', await st());
      /* Ctrl+滚轮缩放（fitMode=custom）后换页：PDF 回到按页宽（不是适应窗口）；漫画仍回适应窗口 */
      await wheel(CX, CY, 0, -300, CTRL); await sleep(40);
      const fc = await st();
      await key('ArrowRight');
      await settle(3);
      const fc2 = await st();
      check('PDF：Ctrl+滚轮缩放（custom）后换页 -> 回到 width（原来掉成 window，约 16-24% 看不清）', fc.fitMode === 'custom' && fc2.fitMode === 'width' && fc2.index === 3 && fc2.zoom > fc.zoom * 0.5, { fc, fc2 });

      /* 滚轮滚到页尾后继续滚才翻页：连续一口气滚过页尾不翻；停一下再滚（两格）才翻；翻页后保持 width；往上同理落在页尾 */
      await openScrollPdf();
      const e0 = await st();
      await wheelN(CX, CY, 100, 14, 30);          // 一口气滚过页尾（连续，间隔 30ms）
      const e1 = await st();
      check('一口气滚过页尾（14 格，间隔 30ms）：停在页尾、不翻页（避免一次连滚误翻）', e1.index === 0 && near(e1.panY, -e0.panY, 2), { e0, e1 });
      await sleep(320);
      await wheel(CX, CY, 0, 100);
      await sleep(120);
      check('页尾停一下后只滚一格：还不翻页（累计 100px < 200px）', (await st()).index === 0, await st());
      await wheel(CX, CY, 0, 100);
      await settle(1);
      const e2 = await st();
      check('再滚一格（累计 200px）：翻到第 2 页，保持 width，从页首开始', e2.index === 1 && e2.fitMode === 'width' && near(e2.panY, e0.panY, 2), { e0, e2 });
      await sleep(320);
      await wheelN(CX, CY, -100, 2, 30);
      await settle(0);
      const e3 = await st();
      check('页首往上滚两格：回到第 1 页，落在页尾，保持 width', e3.index === 0 && e3.fitMode === 'width' && near(e3.panY, -e0.panY, 2), { e0, e3 });

      /* 滚轮「慢慢一格一格」滚到页尾：每格隔 1 秒也能累计翻页（原来 800ms 就清零，一格 100px 永远凑不够 200px），并有提示 */
      await openScrollPdf();
      const sw0 = await st();
      await wheelN(CX, CY, 100, 14, 30);
      await sleep(320);
      await wheel(CX, CY, 0, 100);
      await sleep(150);
      const swHint = await cdp.eval(`const t = document.querySelector('#toast'); return t.classList.contains('show') ? t.textContent : '';`);
      await sleep(850);
      check('页尾第一格：给提示（已到页尾，再滚一下翻到下一页），还没翻页', /再滚一下翻到下一页/.test(swHint) && (await st()).index === 0, { swHint, st: await st() });
      await wheel(CX, CY, 0, 100);       // 距上一格约 1 秒
      await settle(1);
      const sw1 = await st();
      check('每格隔约 1 秒的两格滚轮也能翻到下一页，保持 width、从页首开始', sw1.index === 1 && sw1.fitMode === 'width' && near(sw1.panY, sw0.panY, 2), { sw0, sw1 });

      /* 翻页后的惯性：翻页后 250ms 内不断有滚轮事件（触控板惯性尾巴）时，不翻第二页、也不带着新页往下滚 */
      await openScrollPdf();
      const lk0 = await st();
      await wheelN(CX, CY, 100, 14, 30);
      await sleep(320);
      await wheelN(CX, CY, 100, 2, 30);      // 累计 200px：翻到第 2 页
      await wheelN(CX, CY, 100, 45, 30);     // 继续 ~1.4 秒的惯性（间隔 30ms < 250ms）
      await sleep(300);
      const lk1 = await st();
      check('翻页后继续来惯性滚轮事件（45 个、间隔 30ms）：停在第 2 页的页首，没有被带着往下滚或再翻一页', lk1.index === 1 && near(lk1.panY, lk0.panY, 2), { lk0, lk1 });

      /* 滚轮 deltaMode：行（×16px）和页（×可视区高度），CDP 的 mouseWheel 没法设 deltaMode，直接发合成 WheelEvent */
      await openScrollPdf();
      G = await geo();
      const dm0 = await st();
      const synWheel = (dy, mode) => cdp.eval(`const h = document.querySelector('#hit'); h.dispatchEvent(new WheelEvent('wheel', { deltaY: ${dy}, deltaMode: ${mode}, clientX: 600, clientY: 400, bubbles: true, cancelable: true })); return 1;`);
      await synWheel(3, 1); await sleep(30);
      const dm1 = await st();
      await synWheel(0.5, 2); await sleep(30);
      const dm2 = await st();
      check('滚轮 deltaMode=1（3 行）：下移 48px；deltaMode=2（0.5 页）：下移 0.5 × 可视区高度', near(dm0.panY - dm1.panY, 48, 1) && near(dm1.panY - dm2.panY, 0.5 * G.vh, 1.5), { dm0, dm1, dm2, vh: G.vh });

      /* 最后一页滚到页尾后继续滚 / 按键：停在页尾，不能被甩回页首 */
      await openScrollPdf();
      await cdp.eval(`window.__IV.showPage(5); return 1;`); await settle(5);
      const lp0 = await st();
      await wheelN(CX, CY, 100, 20, 30);
      const lp1 = await st();
      await sleep(320);
      await wheelN(CX, CY, 100, 3, 30);
      await sleep(400);
      const lp2 = await st();
      check('最后一页滚到页尾后继续滚（再来 3 格）：仍停在页尾（panY = -页首值），没有被甩回页首，没翻页', lp1.index === 5 && near(lp1.panY, -lp0.panY, 2) && lp2.index === 5 && near(lp2.panY, lp1.panY, 1), { lp0, lp1, lp2 });
      await key(' '); await sleep(300);
      await key(' '); await sleep(300);
      const lp3 = await st();
      check('最后一页页尾再按空格 ×2：panY 不变、仍是最后一页', lp3.index === 5 && near(lp3.panY, lp1.panY, 1), { lp1, lp3 });

      /* 连按两次翻页键（同一个任务里发两个 keydown）：新页还没画好，第二下被吞掉，只翻一页 */
      await openScrollPdf();
      await key(' '); await key(' ');
      await cdp.eval(`for (let i = 0; i < 2; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true })); return 1;`);
      await settle(1);
      check('页尾处同一时刻发两次 PageDown：只翻一页（新页画好之前的按键被吞掉）', (await st()).index === 1, await st());

      /* 弹窗打开时 ↑↓ 不滚动页面（它们属于弹窗，比如帮助里滚动文字） */
      await openScrollPdf();
      await cdp.eval(`document.querySelector('#help').classList.remove('hidden'); return 1;`);
      const mo0 = await st();
      await key('ArrowDown'); await key('ArrowDown');
      const mo1 = await st();
      await cdp.eval(`document.querySelector('#help').classList.add('hidden'); return 1;`);
      check('帮助弹窗打开时按 ArrowDown ×2：页面不动（panY、页码不变）', mo1.panY === mo0.panY && mo1.index === mo0.index, { mo0, mo1 });
      await key('ArrowDown');
      check('弹窗关掉后 ArrowDown 又能滚', (await st()).panY < mo0.panY - 10, { mo0, now: await st() });

      /* 适应窗口的 PDF：Ctrl+滚轮缩放（custom）后换页 -> 回「适应窗口」（lastFit 记的是最近一次非 custom 的适配），不是 width；缩放过的 PDF 存进度也记原来的适配方式 */
      await openScrollPdf();
      await key('0'); await sleep(250);
      await wheel(CX, CY, 0, -300, CTRL); await sleep(60);
      const lf0 = await st();
      await cdp.eval(`window.__IV.saveProgress(); return 1;`);
      const savedFit = await cdp.eval(`const s = window.__IV.state(); const r = window.__IV.books()[s.bookKey]; return r ? r.fit : null;`);
      await key('ArrowRight'); await settle(1);
      const lf1 = await st();
      check('PDF 适应窗口 -> Ctrl+滚轮缩放 -> 换页：回到 window（不是 width）；缩放状态下存的进度 fit 也是 window', lf0.fitMode === 'custom' && lf1.fitMode === 'window' && savedFit === 'window', { lf0, lf1, savedFit });
      await openScrollPdf();
      await wheel(CX, CY, 0, -300, CTRL); await sleep(60);
      await cdp.eval(`window.__IV.saveProgress(); return 1;`);
      const savedFit2 = await cdp.eval(`const s = window.__IV.state(); const r = window.__IV.books()[s.bookKey]; return r ? r.fit : null;`);
      check('PDF 按页宽 -> Ctrl+滚轮缩放（custom）后存进度：fit 记 width（重开仍按页宽，不是 window）', (await st()).fitMode === 'custom' && savedFit2 === 'width', { savedFit2 });

      /* 点击分区里的「快速连点」「非左键」 */
      await openScrollPdf();
      G = await geo();
      await cdp.eval(`window.__IV.showPage(1); return 1;`); await settle(1);
      const edc0 = await st();
      await click(G.w - 60, CY, 2);       // 右边缘快速连点两下 = 翻两页（浏览器随后还会发 dblclick）
      await sleep(900);
      const edc1 = await st();
      await key('ArrowRight'); await sleep(900);
      const edc2 = await st();
      check('右边缘快速连点两下：翻两页（第 2 -> 4 页），适配方式仍是 width（原来 dblclick 把它切成 actual 100%，之后每页都是）', edc0.index === 1 && edc1.index === 3 && edc1.fitMode === 'width' && near(edc1.zoom, edc0.zoom, 1e-6) && edc2.index === 4 && edc2.fitMode === 'width', { edc0, edc1, edc2 });
      await click(60, CY, 2);
      await sleep(900);
      const edc3 = await st();
      check('左边缘快速连点两下：翻回两页（5 -> 3），仍是 width', edc3.index === 2 && edc3.fitMode === 'width', { edc3 });
      const nb0 = await st();
      const ui0 = (await geo()).hidden;
      const nbBad = [];      // 每一下都要和起点比（翻过去又翻回来、显示又隐藏会互相抵消）
      for (const btn of ['right', 'middle']) {
        for (const xx of [60, G.w - 60, CX]) {
          await mouse('mouseMoved', xx, CY);
          await mouse('mousePressed', xx, CY, { button: btn, buttons: btn === 'right' ? 2 : 4, clickCount: 1 });
          await mouse('mouseReleased', xx, CY, { button: btn, buttons: 0, clickCount: 1 });
          await sleep(450);
          const nbNow = await st();
          if (nbNow.index !== nb0.index || (await geo()).hidden !== ui0) nbBad.push({ btn, xx, index: nbNow.index, hidden: (await geo()).hidden });
        }
      }
      const nb1 = await st();
      check('右键 / 中键点左边缘、右边缘、中间（逐个检查）：不翻页、不切换工具栏（只有左键算点击）', nb1.index === nb0.index && (await geo()).hidden === ui0 && nbBad.length === 0, { nb0, nb1, ui0, nbBad });
      await click(60, CY); await settle(nb0.index - 1);
      check('（对照）左键点左边缘仍然翻页', (await st()).index === nb0.index - 1, await st());
      await openScrollPdf();      // 下面「触控板横向滚」接着从第 1 页开始

      /* 触控板横向滚：照旧翻页（页面比窗口高时也是） */
      await sleep(320);
      await wheel(CX, CY, 90, 2);
      await settle(1);
      check('横向为主的滚轮（deltaX=90, deltaY=2）仍然翻页', (await st()).index === 1, await st());

      /* 点击分区：真实点击左 / 右 18% 翻页，中间切换工具栏，双击切换适配 */
      await openScrollPdf();
      await cdp.eval(`window.__IV.showPage(2); return 1;`); await settle(2);
      G = await geo();
      await click(60, CY); await settle(1);
      check('真实点击左边缘（x=60）：上一页（原代码：点不到，页码纹丝不动）', (await st()).index === 1, await st());
      await click(G.w - 60, CY); await settle(2);
      check('真实点击右边缘（x=窗口宽-60）：下一页', (await st()).index === 2, await st());
      await click(CX, CY); await sleep(400);
      const ui1 = (await geo()).hidden;
      await click(CX, CY); await sleep(400);
      check('真实点击中间：隐藏 / 再点显示工具栏', ui1 === true && (await geo()).hidden === false, { ui1 });
      await sleep(300);
      const fz0 = (await st()).fitMode;
      await click(CX, CY, 2); await sleep(500);
      const fz1 = await st();
      check('真实双击中间：按页宽（width）-> 实际大小（actual），工具栏显隐不变', fz0 === 'width' && fz1.fitMode === 'actual' && (await geo()).hidden === false, { fz0, fz1 });

      /* PDF：适应窗口 / 实际大小下的命中网格；适应窗口时整页放得进窗口 -> 滚轮缩放 */
      await key('0'); await sleep(200);
      const gWin = await hitGrid();
      check('命中网格 PDF 适应窗口：全部落在 #hit（或真实控件）', hitOk(gWin), gWin);
      const wz0 = await st();
      await wheel(CX, CY, 0, -240); await sleep(60);
      const wz1 = await st();
      check('PDF 适应窗口（整页放得进窗口）：滚轮照旧缩放（zoom ×e^0.36、custom、panY 不乱动）', wz0.fitMode === 'window' && near(wz1.zoom / wz0.zoom, Math.exp(0.36), 0.01) && wz1.fitMode === 'custom', { wz0, wz1 });
      await key('1'); await sleep(250);
      const gAct = await hitGrid();
      check('命中网格 PDF 实际大小：全部落在 #hit（或真实控件）', hitOk(gAct), gAct);
      await key('2'); await sleep(250);

      /* 翻页箭头 / 工具栏 / 缩略图条 / 弹窗 / 开始页 / 账号框：必须在命中层之上，真实点击照常收到 */
      G = await geo();
      const navPos = await cdp.eval(`const r = document.querySelector('#navNext').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2).closest('#navNext') !== null };`);
      const iN0 = (await st()).index;
      await click(navPos.x, navPos.y); await settle(iN0 + 1);
      check('真实点击右侧翻页箭头 #navNext（在命中层之上）：下一页，而不是被命中层当成「右边缘点击」吞掉两次', navPos.top && (await st()).index === iN0 + 1, { navPos, idx: (await st()).index, iN0 });
      const centerOf = (sel) => cdp.eval(`const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, ok: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) !== null && e.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) };`);
      const isOpen = (id) => cdp.eval(`return !document.querySelector('#${id}').classList.contains('hidden');`);
      const bh = await centerOf('#btnHelp');
      await click(bh.x, bh.y); await sleep(150);
      const helpOpen = await isOpen('help');
      const hc = await centerOf('[data-close="help"]');
      await click(hc.x, hc.y); await sleep(150);
      check('工具栏「?」真实点击打开帮助；弹窗右上角 ✕ 真实点击关闭', bh.ok && helpOpen && hc.ok && !(await isOpen('help')), { bh, helpOpen, hc });
      await click(bh.x, bh.y); await sleep(150);
      await click(20, G.h - 20); await sleep(150);
      check('弹窗打开时点它的背景（窗口左下角）：关闭弹窗，且没有穿透到命中层翻页', helpOpen && !(await isOpen('help')) && (await st()).index === iN0 + 1, await st());
      const pi = await centerOf('#pageInfo');
      await click(pi.x, pi.y); await sleep(150);
      const jumpOpen = await isOpen('jump');
      const jc = await centerOf('[data-close="jump"]');
      await click(jc.x, jc.y); await sleep(150);
      check('点页码弹出跳页框；真实点「取消」关闭', pi.ok && jumpOpen && jc.ok && !(await isOpen('jump')), { pi, jumpOpen, jc });
      const bd = await centerOf('#btnDetail');
      await click(bd.x, bd.y); await sleep(200);
      const detOpen = await isOpen('detail');
      const dc = await centerOf('[data-close="detail"]');
      await click(dc.x, dc.y); await sleep(150);
      check('工具栏详情按钮 -> 详情弹窗；✕ 真实点击关闭', bd.ok && detOpen && dc.ok && !(await isOpen('detail')), { bd, detOpen, dc });
      /* 书架 / 账号框（它们的内容靠网络，这里直接显示出来，只验证盖在命中层上、按钮真实点击有效） */
      await cdp.eval(`document.querySelector('#shelf').classList.remove('hidden'); return 1;`);
      const shOn = await cdp.eval(`const c = document.querySelector('#shelf .modal-card').getBoundingClientRect(); const e = document.elementFromPoint(c.left + c.width / 2, c.top + 40); return e && e.closest('#shelf') !== null;`);
      const sc = await centerOf('#shelf .modal-close');
      await click(sc.x, sc.y); await sleep(150);
      check('书架弹窗盖在命中层之上（中心点命中它自己）；✕ 真实点击关闭', shOn === true && sc.ok && !(await isOpen('shelf')), { shOn, sc });
      await cdp.eval(`document.querySelector('#dav').classList.remove('hidden'); return 1;`);
      const dvOn = await cdp.eval(`const c = document.querySelector('#dav .modal-card').getBoundingClientRect(); const e = document.elementFromPoint(c.left + c.width / 2, c.top + 30); return e && e.closest('#dav') !== null;`);
      const dcx = await centerOf('#davCancel');
      await click(dcx.x, dcx.y); await sleep(200);
      check('账号框盖在命中层之上；「取消」真实点击关闭', dvOn === true && dcx.ok && !(await isOpen('dav')), { dvOn, dcx });
      /* 缩略图条 */
      await key('t'); await sleep(500);
      const thOn = await cdp.eval(`const t = document.querySelector('#thumbs'); return !t.classList.contains('hidden') && document.querySelectorAll('#thumbs .thumb').length;`);
      const th4 = await centerOf('#thumbs .thumb:nth-child(5)');
      await click(th4.x, th4.y); await settle(4);
      check('缩略图条（T 打开）：真实点击第 5 张缩略图 -> 跳到第 5 页', thOn === 6 && th4.ok && (await st()).index === 4, { thOn, th4, idx: (await st()).index });
      const hitMirror = await cdp.eval(`const h = document.querySelector('#hit'), v = document.querySelector('#viewport'); return { ht: h.style.top, hb: h.style.bottom, vt: v.style.top, vb: v.style.bottom };`);
      check('缩略图条打开时：命中层的上 / 下缩进和图片层（#viewport）一致（点击分区、可视区高度同一块区域）', hitMirror.hb !== '' && hitMirror.hb !== '0px' && hitMirror.ht === hitMirror.vt && hitMirror.hb === hitMirror.vb, hitMirror);
      await key('t'); await sleep(300);
      const gTh = await hitGrid();
      check('命中网格（缩略图条关闭后）：命中层随可视区重新铺满、全部点都落在 #hit', hitOk(gTh), gTh);
      /* 开始页（没有打开书）：按钮真实可点；命中层不挡 */
      await fresh(IVURL);
      const sd = await centerOf('#startDav');
      await click(sd.x, sd.y); await sleep(200);
      const startDav = await isOpen('dav');
      const dc2 = await centerOf('#davCancel');
      await click(dc2.x, dc2.y); await sleep(150);
      check('开始页：「书库账号」按钮真实点击 -> 账号框打开；「取消」关闭', sd.ok && startDav && dc2.ok && !(await isOpen('dav')), { sd, startDav, dc2 });

      /* ---- 2) 漫画（整页放得进窗口）：滚轮仍缩放；Ctrl+滚轮；拖拽；键盘；换页回适应窗口 ---- */
      await fresh(IVURL);
      await cdp.eval(`
        const it = [];
        for (let i = 1; i <= 4; i++) it.push(await __mk(i + '.png', 'cm/' + i + '.png', 600, 900, { rect: '#345', rectW: 600, rectH: 900 }));
        window.__IV.openItems(it, { kind: 'dir', title: 'cm' });
        await __force('spread', false); await __force('compare', false); await __force('trim', false);
        window.__IV.showPage(0); await __tick(); return 1;`);
      await sleep(400);
      G = await geo();
      const cy = Math.round(G.top + G.vh / 2);
      const m0 = await st();
      check('漫画：适应窗口，整页放得进窗口（panY=0）', m0.fitMode === 'window' && m0.panY === 0 && m0.index === 0, m0);
      const gC = await hitGrid();
      check('命中网格 漫画适应窗口：全部落在 #hit（或真实控件）（原代码里只有约 4% 的点打得到）', hitOk(gC), gC);
      await wheel(CX, cy, 0, -240); await sleep(60);
      const m1 = await st();
      check('漫画（整页放得进窗口）：滚轮照旧缩放（deltaY=-240 -> zoom ×e^0.36），fitMode=custom', near(m1.zoom / m0.zoom, Math.exp(0.36), 0.01) && m1.fitMode === 'custom', { m0, m1 });
      await wheel(CX, cy, 0, 100, CTRL); await sleep(60);
      const m2 = await st();
      check('漫画：Ctrl+滚轮缩小', m2.zoom < m1.zoom && near(m2.zoom / m1.zoom, Math.exp(-0.15), 0.01), { m1, m2 });
      await key('0'); await sleep(200);          // 回到适应窗口：滚轮缩放那一轮结束（滚轮缩放过的页放大后仍继续缩放，见本节末尾）
      await wheel(CX, cy, 0, -900, CTRL); await sleep(60);
      const m3 = await st();
      await wheel(CX, cy, 0, 100); await sleep(60);
      const m4 = await st();
      check('漫画用 Ctrl+滚轮放大到比窗口高之后：普通滚轮改为上下滚动（owner 决定：页面溢出才滚动），不再缩放', m3.fitMode === 'custom' && m4.zoom === m3.zoom && m4.panY < m3.panY, { m3, m4 });
      await drag(500, 300, 450, 250);
      const m5 = await st();
      check('漫画放大后真实拖拽（起点 (500,300)，向左上 50,50）：panX / panY 各 -50', near(m5.panX - m4.panX, -50, 2) && near(m5.panY - m4.panY, -50, 2), { m4, m5 });
      await click(CX, cy, 2); await sleep(500);
      const m6 = await st();
      check('漫画真实双击：custom -> 回到适应窗口（window）', m6.fitMode === 'window' && near(m6.zoom, m0.zoom, 1e-6), { m0, m6 });
      await key('ArrowDown');
      const m7 = await st();
      check('漫画整页放得进窗口时 ArrowDown 不动（照旧）：panY、页码都不变', m7.panY === 0 && m7.index === 0, m7);
      await key('PageDown'); await sleep(400);
      check('漫画 PageDown 照旧翻页', (await st()).index === 1, await st());
      await wheel(CX, cy, 0, -300, CTRL); await sleep(60);
      const mf = await st();
      await key('ArrowRight'); await sleep(500);
      const mf2 = await st();
      check('漫画：Ctrl+滚轮缩放（custom）后换页 -> 仍回「适应窗口」（旧行为不变，只有 PDF 保持按页宽）', mf.fitMode === 'custom' && mf2.fitMode === 'window' && mf2.index === 2, { mf, mf2 });
      await wheel(CX, cy, 90, 2); await sleep(300);
      check('漫画：横向为主的滚轮照旧翻页', (await st()).index === 3, await st());
      await click(60, cy); await sleep(400);
      check('漫画：真实点击左边缘翻上一页', (await st()).index === 2, await st());
      /* 普通滚轮在整页放得进窗口的漫画上缩放：一格放大后页面就比窗口高了，但这一轮滚轮缩放要一直缩放下去（不能第一格之后就变成上下滚动），也能缩回来 */
      await key('0'); await sleep(250);
      const wz0c = await st();
      await wheelN(CX, cy, -100, 6, 400);        // 每格隔 400ms（> 250ms 空闲间隔）
      const wz1c = await st();
      check('漫画适应窗口：普通滚轮连放大 6 格（每格隔 400ms）：zoom 每格 ×e^0.15（共 ×e^0.9），不会第一格之后就停', wz1c.fitMode === 'custom' && near(wz1c.zoom / wz0c.zoom, Math.exp(0.9), 0.02), { wz0c, wz1c });
      await wheelN(CX, cy, 100, 4, 400);
      const wz2c = await st();
      check('接着普通滚轮缩小 4 格：zoom 缩回（×e^-0.6）', near(wz2c.zoom / wz1c.zoom, Math.exp(-0.6), 0.02), { wz1c, wz2c });
      await key('0'); await sleep(250);
      const wz3c = await st();
      await wheelN(CX, cy, -100, 2, 400);
      check('回到适应窗口（0 键）后重新开始一轮：滚轮又从缩放开始', wz3c.fitMode === 'window' && near((await st()).zoom / wz3c.zoom, Math.exp(0.3), 0.02), { wz3c, now: await st() });

      /* 一页画不出来（损坏的图）：前一页是溢出的长页时，PageUp / PageDown / 空格仍然翻页（不能被「新页还没画好」的守卫吞掉） */
      await fresh(IVURL);
      await cdp.eval(`
        const it = [];
        it.push(await __mk('1.png', 'bad/1.png', 600, 2400, { rect: '#345', rectW: 600, rectH: 2400 }));
        const garbage = new File([new Uint8Array(2000).fill(7)], '2.png', { type: 'image/png' });
        it.push({ kind: 'file', file: garbage, name: '2.png', path: 'bad/2.png', size: 2000 });
        for (let i = 3; i <= 5; i++) it.push(await __mk(i + '.png', 'bad/' + i + '.png', 600, 2400, { rect: '#345', rectW: 600, rectH: 2400 }));
        window.__IV.openItems(it, { kind: 'dir', title: 'bad' });
        await __force('spread', false); await __force('compare', false); await __force('trim', false);
        window.__IV.showPage(0); await __tick(); window.__IV.applyFit('width'); await __tick(); return 1;`);
      await sleep(400);
      const bd0 = await st();
      await key('ArrowRight'); await sleep(900);
      const bd1 = await st();
      const bdToast = await cdp.eval(`return document.querySelector('#toast').textContent;`);
      check('（前提）第 2 页是坏图：翻到它时提示「图片打开失败」，前一页（长页，按页宽）仍是溢出的', bd0.total === 5 && bd1.index === 1 && /图片打开失败/.test(bdToast) && bd1.fitMode === 'width', { bd0, bd1, bdToast });
      await key('PageDown'); await sleep(600);
      check('停在画不出来的页上按 PageDown：照旧翻到下一页', (await st()).index === 2, await st());
      await key('ArrowLeft'); await sleep(900);
      const bd2 = await st();
      await key('PageUp'); await sleep(600);
      check('回到坏图页后按 PageUp：照旧翻到上一页', bd2.index === 1 && (await st()).index === 0, { bd2, now: await st() });
      await key('ArrowRight'); await sleep(900);
      await key(' '); await sleep(600);
      check('停在坏图页上按空格：照旧翻到下一页', (await st()).index === 2, await st());

      /* ---- 3) 触摸：单指拖动 / 双指捏合（touch-action:none 在接触摸的那一层）---- */
      await openScrollPdf();
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      const tp = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p[0], y: p[1], id: i + 1 })) });
      const t0 = await st();
      await tp('touchStart', [[300, CY]]);
      for (let i = 1; i <= 6; i++) await tp('touchMove', [[300, CY - 20 * i]]);
      await tp('touchEnd', []);
      await sleep(150);
      const t1 = await st();
      check('触摸单指向上拖 120px：panY 减 120，zoom 不变（touch-action:none 在命中层上，浏览器没抢走手势）', near(t0.panY - t1.panY, 120, 3) && t1.zoom === t0.zoom, { t0, t1 });
      await tp('touchStart', [[900, CY]]);
      for (let i = 1; i <= 3; i++) await tp('touchMove', [[900 - 130 * i, CY]]);
      await tp('touchEnd', []);
      await settle(1);
      check('触摸快滑（向左 390px、几十毫秒）：在比窗口高的页上照样翻页（触屏的快滑翻页保留，只有鼠标不翻）', (await st()).index === 1, await st());
      await tp('touchStart', [[CX - 40, CY], [CX + 40, CY]]);
      for (let i = 1; i <= 6; i++) await tp('touchMove', [[CX - 40 - 20 * i, CY], [CX + 40 + 20 * i, CY]]);
      await tp('touchEnd', []);
      await sleep(150);
      const t2 = await st();
      check('触摸双指捏合（间距 80 -> 320）：放大，fitMode=custom', t2.zoom > t1.zoom * 2 && t2.fitMode === 'custom', { t1, t2 });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      }
      /*SCROLLFIX-END*/
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
