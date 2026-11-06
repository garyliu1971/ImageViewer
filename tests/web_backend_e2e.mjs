// 网页版 + 本地后端 端到端测试（路线 B 第一阶段）。
// 跑法： node tests/web_backend_e2e.mjs
//   需要本机 Python 能 import rarfile / fitz / PIL（缺了会自动跳过对应断言）。
//
// 流程：起 python web_backend.py --port 0 --no-browser → 真 Chrome 打开
// http://127.0.0.1:PORT/ → 用磁盘路径打开 目录 / .cbr(rar) / .pdf → 校验显示、
// 章节、服务端缩略图、与桌面版共享进度。

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const FIX = path.join(ROOT, 'tests', 'fixtures');

const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const CHROME = process.env.CHROME || (fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : 'google-chrome'));

let pass = 0, fail = 0, skip = 0;
const log = (...a) => console.log(...a);
function check(name, ok, detail) {
  if (ok === true) { pass++; log('  \x1b[32m✔\x1b[0m ' + name); }
  else if (ok === 'skip') { skip++; log('  \x1b[33m跳\x1b[0m ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
  else { fail++; log('  \x1b[31m✘\x1b[0m ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- 起后端 ---------- */
function startBackend(cfg) {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, ['-u', 'web_backend.py', '--port', '0', '--no-browser'],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, IV_CONFIG: cfg } });
    let out = '', err = '';
    const timer = setTimeout(() => reject(new Error('后端启动超时\n' + err.slice(-1500))), 30000);
    p.stdout.on('data', (d) => {
      out += d;
      const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
      if (m) { clearTimeout(timer); resolve({ proc: p, port: +m[1], caps: out }); }
    });
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('后端退出 ' + code + '\n' + (err || out).slice(-1500)));
    });
  });
}

/* ---------- 最小 CDP ---------- */
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); p(m); }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => {
      this.pending.set(id, (m) => res(m.result !== undefined ? m.result : m));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(body, tries = 3) {
    for (let i = 0; i < tries; i++) {
      const r = await this.send('Runtime.evaluate', {
        expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true,
      });
      if (!r.exceptionDetails) return r.result.value;
      const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text || '';
      if (/context was destroyed|not bound/i.test(d) && i < tries - 1) { await sleep(700); continue; }
      throw new Error('页面异常: ' + d);
    }
  }
}

(async () => {
  if (!fs.existsSync(path.join(FIX, 'sample.cbr'))) {
    throw new Error('缺少 tests/fixtures/sample.cbr —— 先跑 python tests/make_web_fixtures.py');
  }
  const tmpCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-cfg-'));
  const be = await startBackend(path.join(tmpCfg, 'image_viewer.json'));
  log('后端：http://127.0.0.1:' + be.port + '/');
  const caps0 = await new Promise((res) => {
    http.get({ host: '127.0.0.1', port: be.port, path: '/api/ping' }, (r) => {
      let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res({}); } });
    }).on('error', () => res({}));
  });
  log('能力：' + JSON.stringify({ api: caps0.api, rar: caps0.rar, pdf: caps0.pdf, pillow: caps0.pillow }));

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-be-e2e-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let cerr = '';
  chrome.stderr.on('data', (d) => (cerr += d));
  let port = 0;
  const pf = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 120 && !port; i++) { await sleep(250); try { port = +fs.readFileSync(pf, 'utf8').split('\n')[0]; } catch (e) {} }
  if (!port) { chrome.kill(); be.proc.kill(); throw new Error('Chrome 没起来\n' + cerr.slice(-1200)); }

  const listJson = () => new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: '/json/list' }, (r) => {
      let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) { await sleep(200); const l = await listJson().catch(() => null); target = l && l.find(t => t.type === 'page'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws 失败'))); });
  const cdp = new CDP(ws);
  let beExited = false;

  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + be.port + '/' });
    await sleep(1800);
    await cdp.eval(`
      window.__tick = async () => { for (let i = 0; i < 50; i++) await new Promise(r => setTimeout(r, 25)); };
      window.__wait = (ms) => new Promise(r => setTimeout(r, ms));
      window.__force = async (key, want) => {
        const iv = window.__IV;
        for (let i = 0; i < 4; i++) {
          const cur = key === 'direction' ? (iv.state().S.direction === 'rtl') : iv.state().S[key];
          if (cur === want) break;
          if (key === 'direction') iv.toggleDirection(); else iv.toggleMode(key, key);
          await __tick();
        }
        await __tick();
      };
      return true;`);

    const F = (f) => path.join(FIX, f).replace(/[\\/]+$/, '');
    const slash = (x) => x.split(path.sep).join('/');

    log('\n[1] 后端握手 / 能力');
    /* detectBackend() 是异步的（ping -> progress），机器慢时 1.8s 还没握手完
       —— 先等 has-backend，否则 [1] 会偶发假阴性 */
    await cdp.eval(`
      for (let i = 0; i < 60; i++) {
        if (window.__IV.backend().on) break;
        await __wait(100);
      }
      return true;`);
    const be0 = await cdp.eval(`return window.__IV.backend();`);
    check('BE.on = true（页面由后端供）', be0.on === true, be0);
    check('token 已注入页面', await cdp.eval(`return typeof window.__IV_TOKEN === 'string' && window.__IV_TOKEN.length > 8`));
    check('caps 报告完整', typeof be0.caps.rar === 'boolean' && typeof be0.caps.pdf === 'boolean', be0.caps);
    const shown = await cdp.eval(`
      for (let i = 0; i < 40; i++) {
        if (document.body.classList.contains('has-backend')) break;
        await __wait(100);
      }
      return { cls: document.body.classList.contains('has-backend'),
               disp: getComputedStyle(document.querySelector('#btnDisk')).display,
               note: document.querySelector('#statusNote').textContent };`);
    check('磁盘路径按钮在后端模式可见', shown.cls && shown.disp !== 'none', shown);
    check('状态栏标出后端已连接', /后端已连接/.test(shown.note), shown);

    log('\n[2] 按路径打开目录（绝对路径，桌面版同款行为）');
    const dirPath = path.join(ROOT, '网页版测试样本', '漫画');
    let ok = await cdp.eval(`return window.__IV.openServerPath(${JSON.stringify(dirPath)});`);
    await cdp.eval(`await __force('trim', false); await __force('spread', false); await __tick(); return 1;`);
    let s = await cdp.eval(`return window.__IV.state();`);
    if (!fs.existsSync(dirPath)) {
      log('  （没有 网页版测试样本/，先跑 python tests/make_web_demo.py —— 本节跳过）');
      ok = 'skip';
    }
    if (ok === 'skip') check('目录路径打开', 'skip');
    else {
      check('目录打开成功', ok === true, ok);
      check('进度 key = 绝对路径（和桌面版一致）', s.bookKey === dirPath.replace(/\\/g, '/'), { got: s.bookKey, want: dirPath });
      check('章节识别（根目录/第1话/第2话/第10话）',
        JSON.stringify((s.chapters || []).map(c => c.title)) === JSON.stringify(['根目录', '第1话', '第2话', '第10话']), s.chapters);
      check('图片真的显示出来了', await cdp.eval(`
        return [...document.querySelectorAll('#pageBox .page img')].every(i => i.complete && i.naturalWidth > 0)`), s.decoded[0]);
    }

    log('\n[3] rar / cbr（本次的主角，走后端 rarfile + 7-Zip）');
    if (!caps0.rar) {
      check('cbr 打开', 'skip', '本机没有 rarfile 或 7-Zip/WinRAR');
    } else {
      ok = await cdp.eval(`return window.__IV.openServerPath(${JSON.stringify(F('sample.cbr'))});`);
      await cdp.eval(`await __tick(); return 1;`);
      s = await cdp.eval(`return window.__IV.state();`);
      check('cbr 打开成功', ok === true, ok);
      check('rar 条目数 4（readme.txt 被跳过）', s.total === 4, { total: s.total, skipped: s.skipped });
      check('rar 内子目录 -> 章节',
        JSON.stringify((s.chapters || []).map(c => c.title)) === JSON.stringify(['根目录', '第1话', '第2话']), s.chapters);
      check('rar 里的 PNG 解码成功 120×80', s.decoded[0].w === 120 && s.decoded[0].h === 80, s.decoded[0]);
      const shown = await cdp.eval(`
        const im = document.querySelector('#pageBox .page img');
        return { ok: im && im.complete && im.naturalWidth > 0, src: im && im.getAttribute('src').slice(0, 30) };`);
      check('rar 页面真的渲染出来', shown.ok === true, shown);
      check('src 走后端 /api/data', /^\/api\/data\?/.test(shown.src || ''), shown.src);
      await cdp.eval(`window.__IV.switchChapter(1); await __tick(); return 1;`);
      s = await cdp.eval(`return window.__IV.state();`);
      check('rar 切章（第1话 2 页）', s.pages === 2 && s.decoded[0].w === 100, s.decoded[0]);
      await cdp.eval(`
        const iv = window.__IV;
        await __force('spread', true);
        iv.showPage(0); await __tick();
        return 1;`);
      s = await cdp.eval(`return window.__IV.state();`);
      check('rar 页面也能双页', s.pair.length === 2, s.pair);
      await cdp.eval(`await __force('trim', true); return 1;`);
      s = await cdp.eval(`return window.__IV.state();`);
      // 样本是纯色块（本来就没白边），所以 crop 应为 null 而不是报错
      check('rar 页面开去边不报错（纯色图无需裁）',
        s.crop === null && s.domPages >= 1 && s.decoded[0].w === 100, s);
      // 有白边的书（真实样本目录）走后端时也能裁
      const dirTrim = await cdp.eval(`
        const iv = window.__IV;
        await iv.openServerPath(${JSON.stringify(slash(path.join(ROOT, '网页版测试样本', '漫画')))});
        iv.switchChapter(1); await __tick();
        await __force('trim', true);
        await __tick();
        const st = iv.state();
        await __force('trim', false);
        return { crop: st.crop, dims: st.decoded.map(d => d.w + 'x' + d.h) };`);
      check('有白边的书走后端也能裁（900×1300 → 宽 < 800）',
        dirTrim.crop && dirTrim.crop.w === 900 && (dirTrim.crop.r - dirTrim.crop.l) < 800 &&
        (dirTrim.crop.b - dirTrim.crop.t) < 1200, dirTrim);
      await cdp.eval(`await __force('trim', false); await __force('spread', false); return 1;`);
    }

    log('\n[4] PDF 漫画（后端 PyMuPDF 按页渲染）');
    if (!caps0.pdf) {
      check('PDF 打开', 'skip', '本机没有 PyMuPDF');
    } else {
      ok = await cdp.eval(`return window.__IV.openServerPath(${JSON.stringify(F('sample.pdf'))});`);
      await cdp.eval(`await __tick(); return 1;`);
      s = await cdp.eval(`return window.__IV.state();`);
      check('pdf 打开成功', ok === true, ok);
      check('pdf 展开成 3 页', s.total === 3, s.total);
      check('页名带「第 N 页」', /第 1 页/.test(s.decoded[0].name), s.decoded[0].name);
      // 后端按 scale=2 渲染（和桌面版 _render_pdf_page(scale=2.0) 一致）
      check('第 1 页渲染尺寸 600×800 @2x = 1200×1600',
        s.decoded[0].w === 1200 && s.decoded[0].h === 1600, s.decoded[0]);
      await cdp.eval(`window.__IV.showPage(1); await __tick(); return 1;`);
      s = await cdp.eval(`return window.__IV.state();`);
      check('第 2 页 700×500 @2x（横页）', s.decoded[1].w === 1400 && s.decoded[1].h === 1000, s.decoded[1]);
      await cdp.eval(`window.__IV.showPage(2); await __tick(); return 1;`);
      s = await cdp.eval(`return window.__IV.state();`);
      check('第 3 页 400×900 @2x（竖页可双页）', s.decoded[2].w === 800 && s.decoded[2].h === 1800, s.decoded[2]);
      const src = await cdp.eval(`return document.querySelector('#pageBox .page img').getAttribute('src');`);
      check('pdf 页走 /api/pdfpage', /^\/api\/pdfpage\?/.test(src), src);
      check('pdf 进度 key 是 pdf 路径', /sample\.pdf$/.test(s.bookKey), s.bookKey);
    }

    log('\n[5] 服务端缩略图（不整本拉回浏览器）');
    const thumbReqs = await cdp.eval(`
      window.__IV.openServerPath(${JSON.stringify(F('sample.cbr'))});
      await __tick(); await __tick();
      return performance.getEntriesByType('resource').filter(r => /\\/api\\/thumb/.test(r.name)).length;`);
    check('缩略图请求打到 /api/thumb', thumbReqs >= 1, thumbReqs);
    check('缩略图仍是小 canvas（不是全尺寸 img）', await cdp.eval(`
      return !document.querySelector('#thumbs .thumb img') && document.querySelectorAll('#thumbs .thumb canvas').length >= 1;`));

    log('\n[6] 与桌面版共享进度（写回 image_viewer.json）');
    await cdp.eval(`
      const iv = window.__IV;
      iv.switchChapter(1); await __tick();
      iv.showPage(1); await __tick();
      iv.saveProgress();
      return iv.state().bookKey;`);
    await sleep(400);
    const remote = await cdp.eval(`
      return fetch('/api/progress?t=' + encodeURIComponent(window.__IV_TOKEN)).then(r => r.json());`);
    check('后端进度可读', !!remote && typeof remote.books === 'object', remote && Object.keys(remote.books || {}));
    check('进度写在绝对路径 key 上',
      !!remote && Object.keys(remote.books).some(k => /sample\.cbr$/.test(k) || /漫画$/.test(k)),
      Object.keys((remote && remote.books) || {}));
    const rec = remote && Object.values(remote.books).find(v => v && v.index === 1);
    check('记录含页码/章节/模式', !!rec && rec.chapter === 1 && typeof rec.spread === 'boolean', rec);
    if (caps0.rar) {
      const resumed = await cdp.eval(`
        const iv = window.__IV;
        await iv.openServerPath(${JSON.stringify(F('sample.cbr'))});
        await __tick();
        return iv.state();`);
      check('重开同一 cbr 直接续到第 2 页', resumed.index === 1 && resumed.chapterIndex === 1, { i: resumed.index, c: resumed.chapterIndex });
    } else {
      check('重开同一 cbr 直接续到第 2 页', 'skip', '本机无 rar 后端');
    }

    log('\n[7] 路径浏览器 UI');
    const rows = await cdp.eval(`
      document.querySelector('#btnDisk').click();
      await __wait(120);
      const open = !document.querySelector('#browse').classList.contains('hidden');
      const rows = await window.__IV.browseTo(${JSON.stringify(path.join(ROOT, 'tests', 'fixtures'))});
      await __wait(120);
      const dom = document.querySelectorAll('#browseList .brow-item').length;
      const names = [...document.querySelectorAll('#browseList .brow-name')].map(n => n.textContent);
      return { open, n: rows.length, dom, names };`);
    check('浏览器弹窗打开', rows.open === true, rows);
    check('列出了 fixtures 目录内容', rows.dom >= 3 && rows.names.some(n => /sample\.cbr/.test(n)), rows.names);
    const dbl = await cdp.eval(`
      const list = document.querySelector('#browseList');
      const rows = list._rows;
      const i = rows.findIndex(r => /sample\\.cbz$/.test(r.name));
      if (i < 0) return { skip: '没有 cbz' };
      list.querySelectorAll('.brow-item')[i].classList.add('sel');
      document.querySelector('#browseOpen').click();
      await __tick();
      const s = window.__IV.state();
      return { total: s.total, key: s.bookKey, title: s.bookTitle,
               modalClosed: document.querySelector('#browse').classList.contains('hidden') };`);
    if (dbl.skip) check('选中条目可打开', 'skip', dbl.skip);
    else {
      check('选中 cbz 可直接打开', dbl.total === 7 && /sample\.cbz/.test(dbl.key), dbl);
      check('打开后路径弹窗自动收起', dbl.modalClosed === true, dbl);
    }

    log('\n[8] 📦 压缩包按钮直接选 rar（浏览器拿不到路径 → 上传到后端再解析）');
    if (!caps0.rar) {
      check('压缩包按钮选 .cbr', 'skip', '本机没有 rarfile 或 7-Zip/WinRAR');
    } else {
      const d = await cdp.send('DOM.getDocument');
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: d.root.nodeId, selector: '#zipInput' });
      await cdp.send('DOM.setFileInputFiles', { nodeId, files: [F('sample.cbr')] });
      await sleep(2500);
      const picked = await cdp.eval(`const s = window.__IV.state();
        const im = document.querySelector('#pageBox .page img');
        return { total: s.total, chapters: (s.chapters || []).map(c => c.title), key: s.bookKey,
                 title: s.bookTitle, img: !!im && im.complete && im.naturalWidth > 0,
                 accept: document.querySelector('#zipInput').getAttribute('accept') || '' };`);
      check('选中的 cbr 上传后打开（4 页）', picked.total === 4, picked);
      check('章节照旧（根目录/第1话/第2话）',
        JSON.stringify(picked.chapters) === JSON.stringify(['根目录', '第1话', '第2话']), picked.chapters);
      check('落到后端临时目录（iv-uploads）并可续读', /iv-uploads/.test(picked.key || ''), picked.key);
      check('页面真的渲染出图', picked.img === true, picked.img);
      check('accept 已放宽到 .rar/.cbr（仅后端模式）', /\.rar/.test(picked.accept), picked.accept);
    }

    log('\n[9] 错误处理');
    const err = await cdp.eval(`
      const clear = () => { const t = document.querySelector('#toast'); t.classList.remove('show'); t.textContent=''; };
      clear();
      const a = await window.__IV.openServerPath('C:\\\\不存在的路径xyz');
      await __tick();
      const t1 = document.querySelector('#toast').textContent;
      clear();
      const b = await window.__IV.openServerPath(${JSON.stringify(F('sample_gbk.zip'))});
      await __tick();
      const t2 = document.querySelector('#toast').textContent;
      const s2 = window.__IV.state();
      return { a, t1, b, t2, total: s2.total, chapters: (s2.chapters || []).map(c => c.title) };`);
    check('不存在的路径给出可读错误', err.a === false && /打开失败|没有|不允许|No such/i.test(err.t1), err);
    check('GBK zip 走后端也能开（章节名不乱码）', err.b === true && err.total === 1, err);

    log('\n[10] 无未捕获异常');
    const errs = await cdp.eval(`return (window.__errs || []).slice(0, 8)`);
    check('页面没有未捕获异常', !errs || !errs.length, errs);

    if (process.env.SHOT) {
      log('\n[截图] 后端模式排版');
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
      await cdp.eval(`
        const iv = window.__IV;
        await iv.openServerPath(${JSON.stringify(slash(path.join(ROOT, '网页版测试样本', '漫画')))});
        iv.switchChapter(1); await __tick();
        await __force('spread', true); await __force('trim', true); await __force('book', true);
        iv.showPage(0); await __tick();
        document.querySelector('#thumbs').scrollLeft = 0;
        return true;`);
      await sleep(900);
      let shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(ROOT, '网页版预览-后端阅读.png'), Buffer.from(shot.data, 'base64'));
      await cdp.eval(`document.querySelector('#btnDisk').click(); await __wait(600); return 1;`);
      await sleep(700);
      shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(ROOT, '网页版预览-磁盘路径.png'), Buffer.from(shot.data, 'base64'));
      log('  已写入 网页版预览-后端阅读.png / 网页版预览-磁盘路径.png');
      await cdp.send('Emulation.clearDeviceMetricsOverride');
    }

    log(`\n结果：${pass} 通过 / ${fail} 失败 / ${skip} 跳过`);
  } catch (e) {
    fail++;
    console.error('\n\x1b[31m执行出错：\x1b[0m', (e && e.stack) || e);
    if (cerr) console.error('chrome stderr:', cerr.slice(-600));
  } finally {
    try { ws.close(); } catch (e) {}
    chrome.kill();
    if (!beExited) { try { be.proc.kill(); } catch (e) {} }
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(tmpCfg, { recursive: true, force: true }); } catch (e) {}
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
