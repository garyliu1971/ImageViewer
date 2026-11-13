// ffmpeg 辅助的播放端到端：真 Chrome + 真后端 + 真 ffmpeg（没装就整体跳过并说明原因）。
// 跑法： node tests/web_video_ffmpeg_e2e.mjs
// 覆盖：编码信息行；「有画面没声音」提示（桩 webkitAudioDecodedByteCount；并记录真实 Chrome 对 AC3 的读数）；
//       转成可播放音轨（ffmpeg 转码流）、转码流自绘进度条（拖动 = 以新起点重启）、续播 / 时长按原文件记；
//       内嵌字幕下拉；用 VLC 打开；没有 ffmpeg 时功能隐藏但提示仍在。

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-ffe2e-'));
const fx = spawnSync(PY, ['tests/make_ff_fixtures.py', tmp], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 180000 });
let fixtures = {};
try { fixtures = JSON.parse(fx.stdout.trim().split('\n').pop()); } catch (e) { /* 无 */ }
if (!fixtures.ac3) {
  console.log('跳过：没找到 ffmpeg / ffprobe（winget install Gyan.FFmpeg；或设 FFMPEG_PATH）。' + (fx.stderr ? ' ' + fx.stderr.slice(-200) : ''));
  process.exit(0);
}

function startBackend(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, ['-u', 'web_backend.py', '--port', '0', '--no-browser'],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...env } });
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
const PRE = `window.__wait = (ms) => new Promise(r => setTimeout(r, ms));
  window.__until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { try { const v = fn(); if (v) return v; } catch (e) {} await __wait(100); } return false; };`;

(async () => {
  const be = await startBackend({ IV_CONFIG: path.join(tmp, 'cfg.json'), IV_VLC_PATH: process.execPath });   // 「VLC」换成 node.exe：被启动后因参数不是脚本而立刻退出，无副作用
  const be0 = await startBackend({ IV_CONFIG: path.join(tmp, 'cfg0.json'), IV_NO_FFMPEG: '1' });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-ffe2e-chrome-'));
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
  const open = async (bePort) => {
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + bePort + '/' });
    await sleep(1500);
    await cdp.eval(PRE + ` await __until(() => window.__IV && window.__IV.backend().on); window.__IV.videoLoadTuning.silentSecs = 2; return 1;`);
  };
  const snap = `const q = (s) => document.querySelector(s), v = q('#vpVideo');
    return { info: q('#vpInfo').textContent, infoWarn: q('#vpInfo').classList.contains('warn'), infoShown: !q('#vpInfo').classList.contains('hidden'),
      note: !q('#vpNote').classList.contains('hidden'), noteText: q('#vpNoteText').textContent,
      vlcBtn: !q('#vpNoteVlc').classList.contains('hidden'), ffBtn: !q('#vpNoteFf').classList.contains('hidden'),
      tc: !q('#vpTc').classList.contains('hidden'), controls: v.controls, src: v.getAttribute('src'), rs: v.readyState, t: v.currentTime, paused: v.paused,
      audioBytes: v.webkitAudioDecodedByteCount, tcTime: q('#vpTcTime').textContent, msg: !q('#vpMsg').classList.contains('hidden') };`;
  try {
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    await open(be.port);
    log('[1] 能力 + 编码信息行');
    const caps = await cdp.eval(`const c = window.__IV.backend().caps; return { ff: c.ffmpeg, vlc: c.vlc, tag: document.querySelector('#backendTag').textContent };`);
    check('/api/ping 带 ffmpeg 能力（available / 版本 / 编码器），状态标签显示 ffmpeg ✓', caps.ff.available && /^\d/.test(caps.ff.version) && caps.ff.encoders.includes('libx264') && /ffmpeg ✓/.test(caps.tag), caps);
    await cdp.eval(`window.__IV.openServerPath(${JSON.stringify(fixtures.ac3)}); await __until(() => document.querySelector('#vpInfo') && !document.querySelector('#vpInfo').classList.contains('hidden'), 15000); return 1;`);
    const s1 = await cdp.eval(snap);
    check('播放器标题栏显示编码信息「MKV · H264 320×180 · AC3 …」，因 AC3 浏览器解不了标成警告色', /^MKV · H264 320×180 · AC3/.test(s1.info) && s1.infoWarn && s1.infoShown, s1);

    log('\n[2] 「有画面没声音」提示');
    const real = await cdp.eval(`await __until(() => !document.querySelector('#vpNote').classList.contains('hidden'), 9000); ${snap}`);
    log('  （真实 Chrome 读数：webkitAudioDecodedByteCount=' + real.audioBytes + '，提示' + (real.note ? '已出现' : '没出现') + '，无头 Chrome 不一定真解码音频）');
    // 确定性版本：桩 webkitAudioDecodedByteCount = 0
    await cdp.eval(`window.__IV.openServerPath(${JSON.stringify(fixtures.aac)}); await __until(() => document.querySelector('#vpInfo') && /AAC/.test(document.querySelector('#vpInfo').textContent), 15000);
      Object.defineProperty(document.querySelector('#vpVideo'), 'webkitAudioDecodedByteCount', { configurable: true, get: () => 0 });
      document.querySelector('#vpNoteX').click(); window.__IV.vpState().noteShown = false;
      await __until(() => !document.querySelector('#vpNote').classList.contains('hidden'), 9000); return 1;`);
    const st = await cdp.eval(snap);
    check('桩读数 0 -> 非阻塞提示出现（AAC 的话不点名编码，用通用措辞），带「用 VLC 打开」和「转成可播放音轨（ffmpeg）」', st.note && /浏览器无法解码，所以没有声音/.test(st.noteText) && st.vlcBtn && st.ffBtn && !st.msg, st);
    await cdp.eval(`Object.defineProperty(document.querySelector('#vpVideo'), 'webkitAudioDecodedByteCount', { configurable: true, get: () => 4096 }); window.__IV.openServerPath(${JSON.stringify(fixtures.aac)}); await __wait(6000); return 1;`);
    const st2 = await cdp.eval(snap);
    check('桩读数 > 0（有声音）-> 不出提示', !st2.note, st2);

    log('\n[3] 转成可播放音轨（ffmpeg 转码流）');
    await cdp.eval(`delete document.querySelector('#vpVideo').webkitAudioDecodedByteCount; window.__IV.openServerPath(${JSON.stringify(fixtures.ac3)}); await __until(() => document.querySelector('#vpInfo') && !document.querySelector('#vpInfo').classList.contains('hidden'), 15000);
      Object.defineProperty(document.querySelector('#vpVideo'), 'webkitAudioDecodedByteCount', { configurable: true, get: () => 0 });
      await __until(() => !document.querySelector('#vpNote').classList.contains('hidden'), 9000);
      document.querySelector('#vpNoteFf').click();
      await __until(() => document.querySelector('#vpVideo').readyState >= 3 && document.querySelector('#vpVideo').currentTime > 0.5, 25000); return 1;`);
    const t1 = await cdp.eval(snap);
    check('点后切到转码流：src=/api/media/stream、原生控件关掉、自绘控制条出现、提示收起、能播', t1.tc && !t1.controls && /^\/api\/media\/stream\?/.test(t1.src) && !t1.note && t1.rs >= 3 && t1.t > 0.5 && !t1.msg, t1);
    check('控制条显示的是探测出的真实时长（0:30）而不是流的无限时长', /\/ 0:30$/.test(t1.tcTime), t1.tcTime);
    log('  （转码流的 webkitAudioDecodedByteCount=' + t1.audioBytes + '）');

    log('\n[4] 转码流的进度条：拖动 = 以新起点重启；续播 / 时长按原文件');
    await cdp.eval(`const sk = document.querySelector('#vpTcSeek'); sk.value = '12'; sk.dispatchEvent(new Event('input')); sk.dispatchEvent(new Event('change'));
      await __until(() => /[?&]start=12\\b/.test(document.querySelector('#vpVideo').getAttribute('src') || ''), 5000);
      await __until(() => document.querySelector('#vpVideo').readyState >= 3 && document.querySelector('#vpVideo').currentTime > 0.3, 25000); return 1;`);
    const t2 = await cdp.eval(snap);
    const posOk = /^0:1[2-5] \/ 0:30$/.test(t2.tcTime);
    check('拖到 12 秒：流重启（start=12），时间显示从 0:12 起、总长仍 0:30', /start=12/.test(t2.src) && posOk && t2.rs >= 3, t2);
    await cdp.eval(`document.querySelector('#vpVideo').pause(); await __wait(800); return 1;`);
    const rs = await cdp.eval(`const t = window.__IV.backend().token; const j = await (await fetch('/api/videoresume?path=' + encodeURIComponent(${JSON.stringify(fixtures.ac3)}) + '&t=' + t)).json(); return j;`);
    check('续播点记在「原文件」上，按偏移换算（≈12~16 秒），不是流内的 0~4 秒', rs.ms >= 11500 && rs.ms <= 17000, rs);
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await __wait(1500); return 1;`);
    const t3 = await cdp.eval(snap);
    check('→ 键在转码流里也能「快进 5 秒」（重启流，起点前进）', /start=1[6-9]|start=2\d/.test(t3.src), t3.src);
    await cdp.eval(`document.querySelector('#vpTcStereo').click(); await __until(() => /stereo=1/.test(document.querySelector('#vpVideo').getAttribute('src') || ''), 5000); return 1;`);
    check('「立体声混音」开关会带 stereo=1 重启流', /stereo=1/.test((await cdp.eval(snap)).src));
    await cdp.eval(`document.querySelector('#vpTcOff').click(); await __wait(1200); return 1;`);
    const t4 = await cdp.eval(snap);
    check('「退出转码」回到直接播放：原生控件回来、控制条收起、src 回到 /api/data', !t4.tc && t4.controls && /^\/api\/data\?/.test(t4.src), t4);

    log('\n[5] 内嵌字幕');
    await cdp.eval(`window.__IV.openServerPath(${JSON.stringify(fixtures.subs)}); await __until(() => Array.from(document.querySelectorAll('#vpSubSel option')).some(o => /内嵌/.test(o.textContent)), 15000);
      const sel = document.querySelector('#vpSubSel'); const o = Array.from(sel.options).find(o => /内嵌/.test(o.textContent)); sel.value = o.value; sel.dispatchEvent(new Event('change'));
      await __until(() => { const t = document.querySelector('#vpVideo').textTracks[0]; return t && t.cues && t.cues.length >= 2; }, 20000); return 1;`);
    const sb = await cdp.eval(`const t = document.querySelector('#vpVideo').textTracks[0]; return { opts: Array.from(document.querySelectorAll('#vpSubSel option')).map(o => o.textContent), cues: t && t.cues ? Array.from(t.cues).map(c => c.text) : null };`);
    check('下拉里有「内嵌 #1 …(subrip)」，选中后挂上 ffmpeg 提取的字幕（你好 hello / 第二句）', sb.opts.some(o => /内嵌 #1.*subrip/.test(o)) && sb.cues && sb.cues[0] === '你好 hello' && sb.cues[1] === '第二句', sb);

    log('\n[6] 用 VLC 打开');
    await cdp.eval(`window.__IV.openServerPath(${JSON.stringify(fixtures.ac3)}); await __until(() => !document.querySelector('#vpInfo').classList.contains('hidden'), 15000);
      document.querySelector('#vpNoteVlc').classList.remove('hidden'); document.querySelector('#vpNoteVlc').click();
      return !!(await __until(() => document.body.innerText.includes('已交给 VLC'), 8000));`).then((x) => (globalThis.__vl = x));
    const vl = globalThis.__vl;
    check('点「用 VLC 打开」：后端启动了（测试里换成 node.exe）并提示「已交给 VLC 打开」', vl === true || process.platform !== 'win32', vl);

    log('\n[7] 没有 ffmpeg：功能隐藏，播放与提示照旧');
    await open(be0.port);
    const nf = await cdp.eval(`const c = window.__IV.backend().caps; return { ff: c.ffmpeg, tag: document.querySelector('#backendTag').textContent };`);
    check('后端报告 ffmpeg 不可用，状态标签给出安装提示', nf.ff.available === false && /ffmpeg ✗.*winget install Gyan\.FFmpeg/.test(nf.tag), nf);
    await cdp.eval(`window.__IV.openServerPath(${JSON.stringify(fixtures.aac)}); await __until(() => document.querySelector('#vpVideo').readyState >= 2, 12000);
      Object.defineProperty(document.querySelector('#vpVideo'), 'webkitAudioDecodedByteCount', { configurable: true, get: () => 0 });
      await __until(() => !document.querySelector('#vpNote').classList.contains('hidden'), 9000); return 1;`);
    const nf2 = await cdp.eval(snap);
    check('没有 ffmpeg：无编码信息行、提示仍出现但没有「转成可播放音轨」按钮；视频照常播放', !nf2.infoShown && nf2.note && !nf2.ffBtn && nf2.rs >= 2 && !nf2.msg, nf2);
  } catch (e) {
    fail++; log('  \x1b[31m✘ 异常\x1b[0m ' + (e && e.stack || e));
  } finally {
    try { chrome.kill(); } catch (e) {}
    try { be.proc.kill(); } catch (e) {}
    try { be0.proc.kill(); } catch (e) {}
  }
  log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
