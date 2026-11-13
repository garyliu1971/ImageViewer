// 视频播放层的「加载中 / 缓冲中」状态端到端：真 Chrome + 真后端 + 一个会故意拖慢的 Range 服务器。
// 跑法： node tests/web_video_loading_e2e.mjs
// 覆盖：首字节很慢时显示「加载中… 已等待 N 秒」且不出错误横幅；超过阈值只给中性提示、不中止加载、最终能播；
//       真正的 error 事件仍给原来的中文提示；waiting 显示「缓冲中…」、playing 隐藏；mkv 即使 canPlayType 回 '' 也照样尝试；
//       被判 no 的（avi）仍先拦住并给「仍然尝试」；本机后端文件（.mkv 扩展名）也走同一套。

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const CHROME = process.env.CHROME || (fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : 'google-chrome');

let pass = 0, fail = 0;
const log = (...a) => console.log(...a);
function check(name, ok, detail) {
  if (ok === true) { pass++; log('  \x1b[32m✔\x1b[0m ' + name); }
  else { fail++; log('  \x1b[31m✘\x1b[0m ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function startBackend(cfg) {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, ['-u', 'web_backend.py', '--port', '0', '--no-browser'],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, IV_CONFIG: cfg, PYTHONIOENCODING: 'utf-8' } });
    let out = '', err = '';
    const timer = setTimeout(() => reject(new Error('后端启动超时\n' + err.slice(-1500))), 30000);
    p.stdout.on('data', (d) => { out += d; const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out); if (m) { clearTimeout(timer); resolve({ proc: p, port: +m[1] }); } });
    p.stderr.on('data', (d) => (err += d));
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); p(m); } });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => { this.pending.set(id, (m) => res(m.result !== undefined ? m.result : m)); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(body) {
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
}

/** 会故意拖慢的媒体服务器：?delay=ms 首字节延迟（只对第一个请求）；/bad.mkv 返回一段不是视频的字节；支持 Range */
function slowServer(buf) {
  const firstSeen = new Set();
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = () => {
      if (u.pathname === '/bad.mkv') { res.writeHead(200, { 'Content-Type': 'video/x-matroska', 'Content-Length': 30 }); return res.end('this is definitely not video!!'); }
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (m) {
        const s = m[1] === '' ? Math.max(0, buf.length - +m[2]) : +m[1], e = m[1] !== '' && m[2] !== '' ? Math.min(+m[2], buf.length - 1) : buf.length - 1;
        res.writeHead(206, { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${s}-${e}/${buf.length}`, 'Content-Length': e - s + 1 });
        return res.end(buf.subarray(s, e + 1));
      }
      res.writeHead(200, { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Length': buf.length });
      res.end(buf);
    };
    const delay = +(u.searchParams.get('delay') || 0);
    if (delay && !firstSeen.has(u.pathname + u.search)) { firstSeen.add(u.pathname + u.search); setTimeout(send, delay); } else send();
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port })));
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-vload-'));
  const be = await startBackend(path.join(tmp, 'image_viewer.json'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-vload-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--autoplay-policy=no-user-gesture-required',
    '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let port = 0;
  for (let i = 0; i < 120 && !port; i++) { await sleep(250); try { port = +fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch (e) {} }
  const list = () => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: '/json/list' }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));
  let target = null;
  for (let i = 0; i < 60 && !target; i++) { await sleep(200); const l = await list().catch(() => null); target = l && l.find(t => t.type === 'page'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res));
  const cdp = new CDP(ws);
  let slow = null;
  try {
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + be.port + '/' });
    await sleep(1800);
    await cdp.eval(`window.__wait = (ms) => new Promise(r => setTimeout(r, ms));
      window.__until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { try { const v = fn(); if (v) return v; } catch (e) {} await __wait(100); } return false; };
      for (let i = 0; i < 60; i++) { if (window.__IV && window.__IV.backend().on) break; await __wait(100); } return 1;`);

    log('[0] 造样本：页面里 MediaRecorder 录 2 秒 webm');
    const b64 = await cdp.eval(`
      const c = document.createElement('canvas'); c.width = 320; c.height = 180; const g = c.getContext('2d');
      const rec = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm;codecs=vp8' });
      const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data); const done = new Promise(r => (rec.onstop = r));
      rec.start(); const t0 = performance.now();
      while (performance.now() - t0 < 2000) { g.fillStyle = 'hsl(' + ((performance.now() / 8) % 360) + ',70%,50%)'; g.fillRect(0, 0, 320, 180); await __wait(33); }
      rec.stop(); await done;
      const buf = new Uint8Array(await new Blob(chunks).arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return btoa(s);`);
    const webm = Buffer.from(b64, 'base64');
    check('样本 webm 生成', webm.length > 1000, webm.length);
    slow = await slowServer(webm);
    const base = 'http://127.0.0.1:' + slow.port;
    fs.writeFileSync(path.join(tmp, 'local.mkv'), webm);               // 本机后端文件：webm 内容 + .mkv 扩展名（mkv 的 canPlayType 不可靠）
    await cdp.eval(`window.__IV.videoLoadTuning.showMs = 1000; window.__IV.videoLoadTuning.hintMs = 3500; return 1;`);
    const snap = `const q = (s) => document.querySelector(s), v = q('#vpVideo');
      return { spin: !q('#vpLoad').classList.contains('hidden'), text: q('#vpLoadText').textContent, hint: q('#vpLoadHint').textContent,
        tryBtn: !q('#vpLoadTry').classList.contains('hidden'), msg: !q('#vpMsg').classList.contains('hidden'), msgText: q('#vpMsgText').textContent,
        err: v.error && v.error.code, rs: v.readyState, src: v.getAttribute('src') };`;

    log('\n[1] 首字节很慢（6 秒）：加载中 + 已等待秒数；超阈值给中性提示；不报错；最终能播');
    await cdp.eval(`window.__IV.openVideoList([{ name: 'slow.webm', url: ${JSON.stringify(base + '/slow.webm?delay=6000')} }], 0); await __wait(300); return 1;`);
    const s0 = await cdp.eval(snap);
    check('刚设置 src：立刻出现「加载中…」（还没到 3 秒不带秒数），没有错误横幅', s0.spin && s0.text === '加载中…' && !s0.msg && !s0.hint, s0);
    await sleep(1800);
    const s1 = await cdp.eval(snap);
    check('1~3 秒后：「加载中… 已等待 N 秒」，仍无错误横幅，视频无 error', s1.spin && /^加载中… 已等待 \d+ 秒$/.test(s1.text) && !s1.msg && !s1.err && !s1.hint, s1);
    await sleep(2400);
    const s2 = await cdp.eval(snap);
    check('超过阈值（3.5 秒）还没元数据：中性提示「加载较慢或格式不受浏览器支持…」，转圈继续，有「仍然尝试播放」，没有错误横幅、没有中止',
      s2.spin && /加载较慢或格式不受浏览器支持/.test(s2.hint) && /HEVC/.test(s2.hint) && s2.tryBtn && !s2.msg && !s2.err && !!s2.src, s2);
    const s3 = await cdp.eval(`await __until(() => document.querySelector('#vpLoad').classList.contains('hidden'), 12000); ${snap}`);
    check('首字节终于到了：转圈消失、提示清空、能播（readyState>=2、无 error、无横幅）', !s3.spin && !s3.hint && s3.rs >= 2 && !s3.err && !s3.msg, s3);

    log('\n[2] 真正的 error 事件：仍给原来的中文提示，转圈消失');
    await cdp.eval(`window.__IV.openVideoList([{ name: 'bad.mkv', url: ${JSON.stringify(base + '/bad.mkv')} }], 0); await __until(() => !document.querySelector('#vpMsg').classList.contains('hidden'), 8000); return 1;`);
    const e1 = await cdp.eval(snap);
    check('error 事件 -> 原来的提示（不支持 / 解码 / 格式），转圈已关', e1.msg && /不支持|解码|格式/.test(e1.msgText) && !e1.spin && !!e1.err, e1);

    log('\n[3] 播放中缓冲：waiting -> 「缓冲中…」，playing -> 隐藏');
    await cdp.eval(`window.__IV.openVideoList([{ name: 'ok.webm', url: ${JSON.stringify(base + '/ok.webm')} }], 0); await __until(() => document.querySelector('#vpLoad').classList.contains('hidden') && document.querySelector('#vpVideo').readyState >= 2, 8000); return 1;`);
    const b0 = await cdp.eval(snap);
    const b1 = await cdp.eval(`document.querySelector('#vpVideo').dispatchEvent(new Event('waiting')); await __wait(200); ${snap}`);
    const b2 = await cdp.eval(`await __wait(1400); ${snap}`);
    const b3 = await cdp.eval(`document.querySelector('#vpVideo').dispatchEvent(new Event('playing')); await __wait(200); ${snap}`);
    check('正常播放时没有转圈；waiting 后出现「缓冲中…」，1 秒后带「已等待 N 秒」；playing 后消失',
      !b0.spin && b1.spin && b1.text === '缓冲中…' && /^缓冲中… 已等待 \d+ 秒$/.test(b2.text) && !b3.spin && !b1.msg, [b0, b1, b2, b3]);

    log('\n[4] canPlayType 回 \'\' 也不能拦：mkv 照样尝试；avi 仍先拦并给「仍然尝试」');
    await cdp.eval(`document.querySelector('#vpVideo').canPlayType = () => ''; window.__IV.openVideoList([{ name: 'x.mkv', url: ${JSON.stringify(base + '/x.mkv')} }], 0); await __until(() => document.querySelector('#vpLoad').classList.contains('hidden'), 8000); return 1;`);
    const m1 = await cdp.eval(snap);
    check('mkv + canPlayType 回 \'\'：已设置 src 并加载 / 播放（没有被预检拦下）', !!m1.src && !m1.msg && m1.rs >= 1, m1);
    await cdp.eval(`window.__IV.openVideoList([{ name: 'y.avi', url: ${JSON.stringify(base + '/y.avi')} }], 0); await __wait(400); return 1;`);
    const m2 = await cdp.eval(`${snap.replace('return {', 'return { tryOld: !document.querySelector(\'#vpTry\').classList.contains(\'hidden\'),')}`);
    check('avi + canPlayType 回 \'\'：先拦住并给「仍然尝试播放」，不转圈', m2.msg && /不支持/.test(m2.msgText) && m2.tryOld && !m2.spin && !m2.src, m2);
    await cdp.eval(`delete document.querySelector('#vpVideo').canPlayType; return 1;`);

    log('\n[5] 本机后端文件（.mkv 扩展名）：同一套加载状态，加载完转圈消失');
    await cdp.eval(`window.__IV.openServerPath(${JSON.stringify(path.join(tmp, 'local.mkv'))}); await __until(() => document.querySelector('#vpVideo').getAttribute('src'), 8000); return 1;`);
    const l1 = await cdp.eval(`await __until(() => document.querySelector('#vpLoad').classList.contains('hidden') && document.querySelector('#vpVideo').readyState >= 2, 10000); ${snap}`);
    check('本机 mkv：/api/data 加载完成，转圈消失、无横幅', !l1.spin && !l1.msg && l1.rs >= 2 && /^\/api\/data\?/.test(l1.src || ''), l1);
    await cdp.eval(`document.querySelector('#vpClose').click(); await __wait(200); return 1;`);
    const c1 = await cdp.eval(snap);
    check('关闭播放器：转圈 / 定时器清理', !c1.spin, c1);
  } catch (e) {
    fail++; log('  \x1b[31m✘ 异常\x1b[0m ' + (e && e.stack || e));
  } finally {
    try { chrome.kill(); } catch (e) {}
    try { be.proc.kill(); } catch (e) {}
    try { slow && slow.srv.close(); } catch (e) {}
  }
  log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
