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
