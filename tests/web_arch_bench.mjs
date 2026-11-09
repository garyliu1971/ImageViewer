// rar / 7z / tar（libarchive.js）大包压测：真 Chrome（headless），量「选文件 -> 第一页画出来」的时间、JS 堆、浏览器进程内存、翻到最后一页的时间。
//
// 先造样本（不进仓库）：  python tests/make_archive_fixtures.py --bench <目录> [页数，默认 160；430 页 ≈ 100MB]
// 再跑：                  node tests/web_arch_bench.mjs <目录里的压缩包> [更多压缩包 …]
//   CHROME=路径 可指定浏览器。输出每个包一行 JSON + 一段人话总结。只读本仓库，不联网（本地起一个静态服务器模拟 /iv/）。
//
// 内存口径：jsHeap = 页面主线程 Runtime.getHeapUsage（blob / wasm 堆不在里面）；procMB = 这个 headless 实例所有进程的私有内存（PrivateMemorySize64，含 worker 里的 wasm 堆）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import url from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME;
  for (const c of ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) if (fs.existsSync(c)) return c;
  throw new Error('找不到 Chrome/Edge，请设置环境变量 CHROME');
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) { const { res, rej } = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
    });
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(body) {
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
}

function getJson(port, p) {
  return new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));
}

/** 这个 headless 实例（user-data-dir 里带 profile 路径的进程）的私有内存合计，MB（只在 Windows 上量；别处返回 null） */
function procMB(profile) {
  if (process.platform !== 'win32') return null;
  try {
    const ps = `$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' } | ForEach-Object { $_.ProcessId }; ` +
      `$s = 0; foreach ($i in $p) { try { $s += (Get-Process -Id $i -ErrorAction Stop).PrivateMemorySize64 } catch {} }; [math]::Round($s / 1MB)`;
    return +execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
  } catch (e) { return null; }
}

async function main() {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!files.length) { console.error('用法: node tests/web_arch_bench.mjs <压缩包> [...]'); process.exit(2); }
  const html = fs.readFileSync(path.join(ROOT, 'image-viewer.html'));
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/iv/' || p === '/iv/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" }); return res.end(html); }
    if (p.startsWith('/iv/vendor/libarchive/')) {
      const f = path.join(ROOT, p.slice('/iv/'.length));
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': /\.wasm$/.test(f) ? 'application/wasm' : 'text/javascript', 'Cache-Control': 'no-cache' }); return res.end(fs.readFileSync(f));
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + srv.address().port;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-bench-'));
  const exe = findChrome();
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--window-size=1280,820', '--disable-extensions',
    '--mute-audio', '--js-flags=--expose-gc', '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
  let port = 0;
  for (let i = 0; i < 120 && !port; i++) { await sleep(250); try { port = +fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch (e) { /* 还没起来 */ } }
  if (!port) throw new Error('浏览器没起来');
  const targets = await getJson(port, '/json');
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('DOM.enable');
  const heap = async () => { await cdp.send('HeapProfiler.collectGarbage').catch(() => {}); const h = await cdp.send('Runtime.getHeapUsage'); return Math.round(h.usedSize / 1048576 * 10) / 10; };
  const waitFor = async (expr, ms) => { const t0 = Date.now(); for (;;) { const v = await cdp.eval(`return (${expr});`).catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(40); } };

  const rows = [];
  for (const file of files) {
    await cdp.send('Page.navigate', { url: 'about:blank' }); await sleep(300);
    await cdp.send('Page.navigate', { url: origin + '/iv/' }); await sleep(1200);
    const size = fs.statSync(file).size;
    const base = { heap: await heap(), proc: procMB(profile) };
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#zipInput' });
    const t0 = performance.now();
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [path.resolve(file)] });
    const ok = await waitFor(`window.__IV && window.__IV.state().total > 0 && window.__IV.state().decoded[0] && window.__IV.state().decoded[0].w > 0 && document.querySelector('#pageBox img')`, 180000);
    const tFirst = performance.now() - t0;
    if (!ok) { rows.push({ file: path.basename(file), error: 'timeout', toast: await cdp.eval(`return document.querySelector('#toast').textContent;`) }); continue; }
    const st = await cdp.eval(`const s = window.__IV.state(); return { total: s.total };`);
    // 读几页（相当于翻页 5 次），再跳到最后一页（线性扫到尾部的成本）
    const tPage = [];
    for (const i of [1, 2, 3, 4, 5]) {
      const a = performance.now();
      await cdp.eval(`window.__IV.showPage(${i}); return 1;`);
      await waitFor(`window.__IV.state().index === ${i} && (() => { const m = document.querySelector('#pageBox .page img'); return m && m.complete && m.naturalWidth > 0; })()`, 60000);
      tPage.push(performance.now() - a);
    }
    const mid = { heap: await heap(), proc: procMB(profile) };
    const last = st.total - 1, a = performance.now();
    await cdp.eval(`window.__IV.showPage(${last}); return 1;`);
    await waitFor(`window.__IV.state().index === ${last} && (() => { const m = document.querySelector('#pageBox .page img'); return m && m.complete && m.naturalWidth > 0; })()`, 120000);
    const tLast = performance.now() - a;
    const peak = { heap: await heap(), proc: procMB(profile) };
    // 换书：关掉压缩包（worker terminate），看内存回落
    await cdp.eval(`const cv = document.createElement('canvas'); cv.width = 40; cv.height = 60; cv.getContext('2d').fillRect(0, 0, 40, 60);
      const blob = await new Promise((r) => cv.toBlob(r, 'image/png')); const f = new File([blob], 'x.png', { type: 'image/png' });
      window.__IV.openItems([{ kind: 'file', name: 'x.png', path: 'x.png', size: f.size, file: f }], { kind: 'files', title: 'x' }); return 1;`);
    await sleep(2500);
    const closed = { heap: await heap(), proc: procMB(profile), arch: await cdp.eval(`return window.__IV.archInfo();`).catch(() => 'n/a') };
    rows.push({ file: path.basename(file), sizeMB: Math.round(size / 1048576 * 10) / 10, pages: st.total, firstPageMs: Math.round(tFirst), pageMsAvg5: Math.round(tPage.reduce((x, y) => x + y, 0) / tPage.length),
      lastPageMs: Math.round(tLast), heapMB: { base: base.heap, afterOpen5: mid.heap, afterLast: peak.heap, afterClose: closed.heap },
      procMB: { base: base.proc, afterOpen5: mid.proc, afterLast: peak.proc, afterClose: closed.proc }, archAfterClose: closed.arch });
    console.log(JSON.stringify(rows[rows.length - 1]));
  }
  try { ws.close(); } catch (e) { /* 忽略 */ }
  proc.kill(); srv.close();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  for (const r of rows) {
    if (r.error) { console.log(`${r.file}: ${r.error} ${r.toast || ''}`); continue; }
    console.log(`${r.file}（${r.sizeMB}MB，${r.pages} 页）：选文件 -> 第 1 页画出 ${r.firstPageMs}ms；翻页平均 ${r.pageMsAvg5}ms；跳到最后一页 ${r.lastPageMs}ms；` +
      `JS 堆 ${r.heapMB.base} -> ${r.heapMB.afterOpen5} -> ${r.heapMB.afterLast}（关书后 ${r.heapMB.afterClose}）MB；进程私有内存 ${r.procMB.base} -> ${r.procMB.afterOpen5} -> ${r.procMB.afterLast}（关书后 ${r.procMB.afterClose}）MB`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
