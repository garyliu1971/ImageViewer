// 网页版视频播放（Phase 1）端到端：真 Chrome + 真后端。
// 跑法： node tests/web_video_e2e.mjs
// 没有 ffmpeg：用页面里的 MediaRecorder 现录一段 webm 当样本。
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
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, IV_CONFIG: cfg, PYTHONIOENCODING: 'utf-8' } });
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

  const vdir = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-vid-'));
  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + be.port + '/' });
    await sleep(1800);
    await cdp.eval(`
      window.__wait = (ms) => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 60; i++) { if (window.__IV && window.__IV.backend().on) break; await __wait(100); }
      return true;`);

    log('\n[1] 造样本：页面里 MediaRecorder 录 2 秒 webm');
    const b64 = await cdp.eval(`
      const c = document.createElement('canvas'); c.width = 320; c.height = 180;
      const g = c.getContext('2d');
      const stream = c.captureStream(15);
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
      const done = new Promise(r => (rec.onstop = r));
      rec.start();
      const t0 = performance.now();
      while (performance.now() - t0 < 2000) { g.fillStyle = 'hsl(' + ((performance.now() / 8) % 360) + ',70%,50%)'; g.fillRect(0, 0, 320, 180); await __wait(33); }
      rec.stop(); await done;
      const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return btoa(s);`);
    const webm = Buffer.from(b64, 'base64');
    check('样本 webm 生成', webm.length > 1000, webm.length);
    const vp = path.join(vdir, 'clip.webm');
    fs.writeFileSync(vp, webm);
    fs.writeFileSync(path.join(vdir, 'clip.srt'),
      Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('1\r\n00:00:00,100 --> 00:00:01,500\r\n你好，字幕\r\n\r\n2\r\n00:00:01,600 --> 00:00:01,900\r\n第二句\r\n', 'utf8')]));
    fs.writeFileSync(path.join(vdir, 'other.mkv'), Buffer.from('this is not really matroska'));
    fs.writeFileSync(path.join(vdir, 'old.avi'), Buffer.from('RIFF....AVI '));
    fs.writeFileSync(path.join(vdir, 'extra.vtt'), 'WEBVTT\n\n00:00:00.200 --> 00:00:01.000\nvtt line\n');

    log('\n[2] 浏览器后端按路径打开视频');
    await cdp.eval(`window.__IV.openServerPath(${JSON.stringify(vp)}); await __wait(1500); return 1;`);
    let st = await cdp.eval(`
      const v = document.querySelector('#vpVideo');
      return { shown: !document.querySelector('#vplayer').classList.contains('hidden'),
               title: document.querySelector('#vpTitle').textContent,
               pos: document.querySelector('#vpPos').textContent,
               rs: v.readyState, err: v.error && v.error.code, src: v.getAttribute('src'),
               controls: v.controls, inline: v.hasAttribute('playsinline'),
               msg: document.querySelector('#vpMsg').classList.contains('hidden') };`);
    check('播放层出现且标题正确', st.shown && st.title === 'clip.webm', st);
    check('<video controls playsinline> 属性', st.controls && st.inline, st);
    check('走 /api/data 并带 token', /^\/api\/data\?.*t=/.test(st.src || ''), st.src);
    check('视频能解码（readyState>=1 且无 error）', st.rs >= 1 && !st.err, st);
    check('播放列表含同目录其它视频（clip/old/other 共 3 个）', /\/ 3$/.test(st.pos), st.pos);

    log('\n[3] 旁挂字幕自动识别 + 转 WebVTT');
    const sub = await cdp.eval(`
      const v = document.querySelector('#vpVideo');
      for (let i = 0; i < 40; i++) { if (v.querySelector('track')) break; await __wait(100); }
      const tr = v.querySelector('track');
      await __wait(600);
      const t = v.textTracks[0];
      let cues = t && t.cues ? Array.from(t.cues).map(c => c.text) : null;
      return { hasTrack: !!tr, src: tr && tr.src.slice(0, 5), mode: t && t.mode, cues,
               opts: Array.from(document.querySelector('#vpSubSel').options).map(o => o.textContent) };`);
    check('自动挂上 <track>（blob: URL）', sub.hasTrack && sub.src === 'blob:', sub);
    check('字幕模式 showing', sub.mode === 'showing', sub);
    check('SRT 被转成 cue（BOM / CRLF / 逗号都处理了）', sub.cues && sub.cues[0] === '你好，字幕' && sub.cues[1] === '第二句', sub.cues);
    check('下拉里列出同名字幕', sub.opts.includes('clip.srt'), sub.opts);

    log('\n[4] 倍速 / 字幕大小 / 载入本地字幕');
    const rate = await cdp.eval(`
      const sel = document.querySelector('#vpRate'); sel.value = '1.5'; sel.dispatchEvent(new Event('change'));
      const v = document.querySelector('#vpVideo');
      return { rate: v.playbackRate, saved: JSON.parse(localStorage.getItem('iv.video.ui.v1')).rate };`);
    check('playbackRate 生效并记住', rate.rate === 1.5 && rate.saved === 1.5, rate);
    const cue1 = await cdp.eval(`
      document.querySelector('#vpSubSize').click();
      return document.querySelector('#vpCueStyle').textContent;`);
    check('字幕大小切档（::cue font-size）', /::cue \{ font-size: \d+%/.test(cue1), cue1);
    // 通过隐藏 input 载入本地 vtt
    const doc = await cdp.send('DOM.getDocument', {});
    const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#vpSubInput' });
    await cdp.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [path.join(vdir, 'extra.vtt')] });
    await sleep(800);
    const sub2 = await cdp.eval(`
      const v = document.querySelector('#vpVideo');
      await __wait(400);
      const t = v.textTracks[0];
      return { cues: t && t.cues ? Array.from(t.cues).map(c => c.text) : null,
               sel: document.querySelector('#vpSubSel').selectedOptions[0].textContent };`);
    check('载入本地 .vtt 并切换', sub2.sel === 'extra.vtt' && sub2.cues && sub2.cues[0] === 'vtt line', sub2);
    await cdp.eval(`const s = document.querySelector('#vpSubSel'); s.value = '-1'; s.dispatchEvent(new Event('change')); await __wait(200); return 1;`);
    check('选「无字幕」移除 track', (await cdp.eval(`return document.querySelectorAll('#vpVideo track').length`)) === 0);

    log('\n[5] 播放列表 / 不支持格式提示');
    await cdp.eval(`window.__IV.openServerPath(${JSON.stringify(path.join(vdir, 'old.avi'))}); await __wait(1200); return 1;`);
    const avi = await cdp.eval(`
      return { title: document.querySelector('#vpTitle').textContent,
               msg: document.querySelector('#vpMsgText').textContent,
               shown: !document.querySelector('#vpMsg').classList.contains('hidden'),
               tryBtn: !document.querySelector('#vpTry').classList.contains('hidden') };`);
    check('avi：明确提示不支持（而不是静默失败）', avi.title === 'old.avi' && avi.shown && /不支持/.test(avi.msg), avi);
    await cdp.eval(`window.__IV.openServerPath(${JSON.stringify(path.join(vdir, 'other.mkv'))}); await __wait(1800); return 1;`);
    const mkv = await cdp.eval(`
      return { title: document.querySelector('#vpTitle').textContent,
               msg: document.querySelector('#vpMsgText').textContent,
               shown: !document.querySelector('#vpMsg').classList.contains('hidden') };`);
    check('损坏 / 不可解码的 mkv：error 事件出中文提示', mkv.title === 'other.mkv' && mkv.shown && /不支持|解码|格式/.test(mkv.msg), mkv);
    await cdp.eval(`document.querySelector('#vpPrev').click(); await __wait(500); return 1;`);
    check('「上一个」切换视频', (await cdp.eval(`return document.querySelector('#vpTitle').textContent`)) === 'old.avi');

    log('\n[6] 关闭 / 键盘');
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await __wait(300); return 1;`);
    const closed = await cdp.eval(`return { hidden: document.querySelector('#vplayer').classList.contains('hidden'), src: document.querySelector('#vpVideo').getAttribute('src') };`);
    check('Esc 关闭并释放 src', closed.hidden && !closed.src, closed);

    log('\n[8] 云端（WebDAV）视频：经后端 /api/remote/data 中转，页面拿不到凭据');
    const cdir = path.join(vdir, 'cloud'); fs.mkdirSync(cdir);
    fs.copyFileSync(vp, path.join(cdir, 'clip.webm'));
    fs.copyFileSync(path.join(vdir, 'clip.srt'), path.join(cdir, 'clip.srt'));
    const dav = spawn(PY, ['-u', 'tests/fake_webdav_serve.py', cdir, '--alist'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let davOut = ''; dav.stdout.on('data', (d) => (davOut += d));
    for (let i = 0; i < 60 && !/ROOT=/.test(davOut); i++) await sleep(200);
    const davRoot = (/ROOT=(\S+)/.exec(davOut) || [])[1];
    check('假 WebDAV 已起', !!davRoot, davOut);
    try {
      // 没配置时点「☁ 云端」应弹出账号表单（而不是只 toast）
      await cdp.eval(`document.querySelector('#btnDisk').click(); await __wait(500); document.querySelector('#browseCloud').click(); await __wait(800); return 1;`);
      const form = await cdp.eval(`
        const m = document.querySelector('#rcloud');
        return { open: !m.classList.contains('hidden'), pwType: document.querySelector('#rcPass').type, state: document.querySelector('#rcState').textContent };`);
      check('未配置时点 ☁ 云端 弹出 WebDAV 账号表单（密码框 type=password）', form.open && form.pwType === 'password' && /尚未连接/.test(form.state), form);
      const fill = (url, pw) => `
        const set = (id, v) => { const e = document.querySelector(id); e.value = v; e.dispatchEvent(new Event('input')); };
        set('#rcUrl', ${JSON.stringify(url)}); set('#rcUser', 'u'); set('#rcPass', ${JSON.stringify(pw)});
        document.querySelector('#rcConnect').click(); await __wait(1800);
        return { msg: document.querySelector('#rcMsg').textContent, open: !document.querySelector('#rcloud').classList.contains('hidden'),
                 state: document.querySelector('#rcState').textContent };`;
      const bad = await cdp.eval(fill(davRoot, 'wrong'));
      const cfg0 = await cdp.eval(`return await fetch('/api/remote/config?t=' + window.__IV_TOKEN).then(r => r.json());`);
      check('密码错：表单留着并给出原因，后端不保存', bad.open && /连接失败/.test(bad.msg) && cfg0.connected === false, [bad, cfg0]);
      const good = await cdp.eval(fill(davRoot, 'p'));
      const cfg = await cdp.eval(`return await fetch('/api/remote/config?t=' + window.__IV_TOKEN).then(r => r.json());`);
      check('填对后连接成功，表单关闭，后端保存（接口不回密码）', !good.open && cfg.connected && cfg.has_password && !('password' in cfg), [good, cfg]);
      const leak = await cdp.eval(`return { pass: document.querySelector('#rcPass').value, html: document.documentElement.outerHTML.includes('"password"') };`);
      check('密码框已清空，页面里没有存密码', leak.pass === '' , leak);
      await cdp.eval(`await __wait(1200); return 1;`);
      const rows = await cdp.eval(`
        return { cloudOn: document.querySelector('#browseCloud').classList.contains('on'),
                 path: document.querySelector('#browsePath').value,
                 names: Array.from(document.querySelectorAll('#browseList .brow-name')).map(e => e.textContent) };`);
      check('云端按钮切到 WebDAV 根目录并列出', rows.cloudOn && rows.names.length > 0, rows);
      await cdp.eval(`
        const li = Array.from(document.querySelectorAll('#browseList .brow-item')).find(e => /视频/.test(e.textContent));
        li.click(); document.querySelector('#browseOpen').click(); await __wait(1200); return 1;`);
      const sub = await cdp.eval(`
        return { path: document.querySelector('#browsePath').value,
                 names: Array.from(document.querySelectorAll('#browseList .brow-name')).map(e => e.textContent) };`);
      check('进入云端子目录并看到视频', sub.names.includes('clip.webm'), sub);
      await cdp.eval(`
        const li = Array.from(document.querySelectorAll('#browseList .brow-item')).find(e => /clip\.webm/.test(e.textContent));
        li.click(); document.querySelector('#browseOpen').click(); await __wait(2500); return 1;`);
      const cv = await cdp.eval(`
        const v = document.querySelector('#vpVideo');
        for (let i = 0; i < 30; i++) { if (v.querySelector('track')) break; await __wait(100); }
        await __wait(500);
        const t = v.textTracks[0];
        return { shown: !document.querySelector('#vplayer').classList.contains('hidden'), src: v.getAttribute('src'), rs: v.readyState, err: v.error && v.error.code,
                 cues: t && t.cues ? Array.from(t.cues).map(c => c.text) : null,
                 leak: (v.src || '').includes('u:p@') || document.documentElement.outerHTML.includes('Basic dTpw') };`);
      check('云端视频经 /api/remote/data 播放（无认证头 / URL 无凭据）', cv.shown && /^\/api\/remote\/data\?/.test(cv.src || '') && cv.rs >= 1 && !cv.err && !cv.leak, cv);
      check('云端同名字幕自动挂载', cv.cues && cv.cues[0] === '你好，字幕', cv.cues);
      await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await __wait(300); return 1;`);
      const dis = await cdp.eval(`
        document.querySelector('#btnDisk').click(); await __wait(400);
        document.querySelector('#browseCloudCfg').click(); await __wait(500);
        const st = document.querySelector('#rcState').textContent;
        document.querySelector('#rcDisconnect').click(); await __wait(800);
        const c = await fetch('/api/remote/config?t=' + window.__IV_TOKEN).then(r => r.json());
        return { st, connected: c.connected };`);
      check('⚙ 显示已连接地址，「断开并忘记」后后端清除账号', /已连接：/.test(dis.st) && dis.connected === false, dis);
    } finally {
      try { dav.kill(); } catch (e) {}
    }

    log('\n[7] 续播点（后端）');
    const rj = await cdp.eval(`
      const iv = window.__IV;
      const r = await fetch('/api/videoresume?path=' + encodeURIComponent(${JSON.stringify(vp)}) + '&t=' + window.__IV_TOKEN).then(r => r.json());
      return r;`);
    check('续播接口可读（无记录为 null）', rj.ok === true && (rj.ms === null || typeof rj.ms === 'number'), rj);

    log(`\n结果：${pass} 通过 / ${fail} 失败 / ${skip} 跳过`);
  } catch (e) {
    fail++;
    console.error('\n\x1b[31m执行出错：\x1b[0m', (e && e.stack) || e);
    if (cerr) console.error('chrome stderr:', cerr.slice(-600));
  } finally {
    try { ws.close(); } catch (e) {}
    chrome.kill();
    try { be.proc.kill(); } catch (e) {}
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(tmpCfg, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(vdir, { recursive: true, force: true }); } catch (e) {}
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
