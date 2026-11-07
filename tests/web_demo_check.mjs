// 用真实样本（python tests/make_web_demo.py 生成）过一遍网页版。
// 运行： node tests/web_demo_check.mjs
// 样本不存在时直接跳过（返回 0），不干扰 CI。
//
// 这一份走的是「真人会点的路径」：Pillow 生成的真实 PNG、真实 cbz、
// GBK 条目名的 zip、6000×900 超宽图、tif/pdf/rar 提示。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import url from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PAGE = path.join(ROOT, 'image-viewer.html');
const SAMPLE = path.join(ROOT, '网页版测试样本');

if (!fs.existsSync(SAMPLE)) {
  console.log('没有 网页版测试样本/，先跑： python tests/make_web_demo.py（已跳过检查）');
  process.exit(0);
}
const walk = (d, base = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name), base) : [path.join(d, e.name)]);

const bookFiles = walk(path.join(SAMPLE, '漫画'));
const cbz = path.join(SAMPLE, '漫画.cbz');
const gbk = path.join(SAMPLE, '漫画_gbk.zip');
const big = path.join(SAMPLE, '单图', '超宽图.png');
const bad = walk(path.join(SAMPLE, '不支持'));

const exe = process.env.CHROME || (fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : 'chrome');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-demo-'));
const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--user-data-dir=' + profile,
  '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function getJson(port, p) {
  return new Promise((res, rej) => {
    const q = http.get({ host: '127.0.0.1', port, path: p }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); });
    q.on('error', rej);
  });
}
let port = 0;
for (let i = 0; i < 120 && !port; i++) { await sleep(250); try { port = +fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch (e) {} }
if (!port) { proc.kill(); throw new Error('Chrome 没起来'); }
let target = null;
for (let i = 0; i < 60 && !target; i++) { await sleep(200); const l = await getJson(port, '/json/list').catch(() => null); target = l && l.find(t => t.type === 'page'); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
let id = 0; const pend = new Map(); const events = [];
ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } else if (m.method === 'Runtime.consoleAPICalled') events.push(m.args.map(a => a.value ?? a.description).join(' ')); else if (m.method === 'Runtime.exceptionThrown') events.push('EXC ' + (m.params.exceptionDetails.exception?.description || '')); });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, m => r(m.result !== undefined ? m.result : m)); ws.send(JSON.stringify({ id: i, method, params })); });
const evl = async (body) => {
  const r = await send('Runtime.evaluate', { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? (pass++, console.log('  \x1b[32m✔\x1b[0m ' + n)) : (fail++, console.log('  \x1b[31m✘\x1b[0m ' + n + '  → ' + JSON.stringify(d))); };

await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable');
await send('Page.navigate', { url: url.pathToFileURL(PAGE).href });
await sleep(1500);
await evl(`window.__tick = async () => { for (let i = 0; i < 60; i++) await new Promise(r => setTimeout(r, 25)); }; return true;`);

async function pick(selector, files) {
  const d = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: d.root.nodeId, selector });
  await send('DOM.setFileInputFiles', { nodeId, files });
  await sleep(2200);
}
const st = () => evl(`return window.__IV.state();`);

console.log('\n样本目录：' + SAMPLE);

console.log('\n[A] 真实 cbz（16 页 / 3 章 + 垃圾条目）');
await pick('#zipInput', [cbz]);
let s = await st();
check('总页数 17', s.total === 17, s.total);
check('章节 = 根目录/第1话/第2话/第10话',
  JSON.stringify((s.chapters || []).map(c => c.title)) === JSON.stringify(['根目录', '第1话', '第2话', '第10话']), s.chapters);
check('pdf 条目被跳过并进 skipped', s.skipped.length === 1 && /scan\.pdf/.test(s.skipped[0].name), s.skipped);
check('封面是横图 1400×820', s.decoded[0].w === 1400 && s.decoded[0].h === 820, s.decoded[0]);
await evl(`window.__IV.switchChapter(1); await __tick(); return 1;`);
s = await st();
check('第1话 8 页', s.pages === 8, s.pages);
check('页图 900×1300 竖图', s.decoded[0].w === 900 && s.decoded[0].h === 1300, s.decoded[0]);

console.log('\n[B] cbz + 双页 + 裁白边 + 纸质（真人会开的组合）');
await evl(`
  const iv = window.__IV;
  iv.showPage(1); await __tick();
  return true;`);
s = await st();
check('两张竖图自动并排', s.pair.length === 2, s.pair);
check('并排后按 1800×1300 适配', Math.abs(s.cssW - 1800) <= 2 && Math.abs(s.cssH - 1300) <= 2, { w: s.cssW, h: s.cssH });
await evl(`
  const iv = window.__IV;
  if (!iv.state().S.trim) iv.toggleMode('trim', '裁白边');
  await __tick();
  return true;`);
s = await st();
check('裁白边生效（宽从 1800 降到 ~1560）', s.cssW < 1700 && s.cssW > 1400, s.cssW);
check('crop 记录在案', !!s.crop, s.crop);
await evl(`const iv = window.__IV; if (!iv.state().S.book) iv.toggleMode('book', '纸质'); return 1;`);
check('纸质质感层已开', await evl(`return document.body.classList.contains('book-on') && getComputedStyle(document.querySelector('#bookFx')).display !== 'none';`));
const fit = await evl(`
  const vw = document.querySelector('#viewport').clientWidth, vh = document.querySelector('#viewport').clientHeight;
  window.__IV.applyFit('window'); await __tick();
  const r = document.querySelector('#pageBox').getBoundingClientRect();
  return { vw, vh, zoom: window.__IV.state().zoom, top: Math.round(r.top), bottom: Math.round(r.bottom) };
`);
check('窗口适配后图片不被工具栏/缩略图盖住', fit.top >= 40 && fit.bottom <= fit.vh + fit.top + 2, fit);

console.log('\n[C] GBK 条目名的 zip（老压缩软件常见）');
await pick('#zipInput', [gbk]);
s = await st();
check('中文章节名解出来了且按码位排（同桌面版）',
  JSON.stringify((s.chapters || []).map(c => c.title)) === JSON.stringify(['第一章', '第二章']), s.chapters);
check('3 页', s.total === 3, s.total);

console.log('\n[D] 6000×900 超宽图（先关掉去边，单看降采样）');
await evl(`if (window.__IV.state().S.trim) window.__IV.toggleMode('trim', '裁白边'); await __tick(); return 1;`);
await pick('#fileInput', [big]);
s = await st();
check('原始尺寸仍是 6000×900', s.decoded[0].w === 6000 && s.decoded[0].h === 900, s.decoded[0]);
check('显示盒按 4000px 上限降采样', s.box[0].w === 4000 && s.box[0].h === 600, s.box[0]);

console.log('\n[E] tif / pdf / rar 提示');
await pick('#fileInput', bad);
const toast = await evl(`return document.querySelector('#toast').textContent;`);
check('提示走桌面版', /桌面版/.test(toast), toast);
s = await st();
check('旧书保持不变（不假装加载成功）', s.pages === 1 && /超宽图/.test(s.decoded[0].name), s.decoded);

console.log('\n[F] 真实文件夹（17 张真实 PNG + 说明.txt）');
const dirRes = await evl(`
  const paths = ${JSON.stringify(bookFiles.map(f => path.relative(path.join(SAMPLE, '漫画'), f).replace(/\\\\/g, '/')))};
  const files = [];
  for (const rel of paths) {
    const f = new File([new Uint8Array(1)], rel.split('/').pop(), { type: 'image/png' });
    Object.defineProperty(f, 'webkitRelativePath', { value: '漫画/' + rel, configurable: true });
    files.push(f);
  }
  const inp = document.querySelector('#folderInput');
  if (files.some(f => !f.webkitRelativePath)) return { skipReason: '无法伪装相对路径' };
  Object.defineProperty(inp, 'files', { value: files, configurable: true, writable: true });
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  await __tick();
  return window.__IV.state();
`);
if (dirRes.skipReason) console.log('  \x1b[33m跳过\x1b[0m [F]：' + dirRes.skipReason);
else {
  check('目录 -> 17 页 / 4 章', dirRes.total === 17 && dirRes.chapters.length === 4, { t: dirRes.total, c: dirRes.chapters });
  check('txt 被跳过', dirRes.skipped.length === 1 && /说明\.txt/.test(dirRes.skipped[0].name), dirRes.skipped);
}

console.log('\n[G] 控制台 / 异常');
const errs = await evl(`return (window.__errs || []).slice(0, 8);`);
check('无未捕获异常', !errs.length, errs);
const noisy = events.filter(e => /error|Error|uncaught|failed/i.test(e) && !/Failed to load resource/.test(e));
check('console 无报错', !noisy.length, noisy.slice(0, 3));

ws.close(); proc.kill();
await sleep(300);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
