// 海报墙 / 媒体刮削 端到端：真 Chrome + 真后端 + 假 TMDB（tests/fake_tmdb.py），不联网。
// 跑法： node tests/web_scrape_e2e.mjs        （SHOT_DIR=某目录 可顺便保存截图）
// 覆盖：海报墙渲染 / 懒加载匹配 / 待确认·未匹配徽标 / 剧集合并成一张卡 / 排序·筛选 / 详情页（双语、分集）/
//       修正匹配 + 锁定（刷新后仍在）/ 刮削当前目录 + 取消 / 未配置令牌提示 / 令牌不进 DOM 与网络响应 / 署名。

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
const SHOT_DIR = process.env.SHOT_DIR || '';
const TOKEN = 'E2E_SECRET_TMDB_TOKEN_5c1d9e';

let pass = 0, fail = 0;
const log = (...a) => console.log(...a);
function check(name, ok, detail) {
  if (ok === true) { pass++; log('  \x1b[32m✔\x1b[0m ' + name); }
  else { fail++; log('  \x1b[31m✘\x1b[0m ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function spawnLine(cmd, args, env, re, what) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...env } });
    let out = '', err = '';
    const timer = setTimeout(() => reject(new Error(what + ' 启动超时\n' + err.slice(-1500))), 30000);
    p.stdout.on('data', (d) => { out += d; const m = re.exec(out); if (m) { clearTimeout(timer); resolve({ proc: p, m, out }); } });
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', (code) => { clearTimeout(timer); if (code) reject(new Error(what + ' 退出 ' + code + '\n' + (err || out).slice(-1500))); });
  });
}
const startBackend = (env) => spawnLine(PY, ['-u', 'web_backend.py', '--port', '0', '--no-browser'], env, /http:\/\/127\.0\.0\.1:(\d+)\//, '后端');

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); p(m); }
      else if (m.method) this.events.push(m);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => { this.pending.set(id, (m) => res(m.result !== undefined ? m.result : m)); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(body, tries = 3) {
    for (let i = 0; i < tries; i++) {
      const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
      if (!r.exceptionDetails) return r.result.value;
      const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text || '';
      if (/context was destroyed|not bound/i.test(d) && i < tries - 1) { await sleep(700); continue; }
      throw new Error('页面异常: ' + d);
    }
  }
}

async function launchChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-scr-e2e-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--user-data-dir=' + profile,
    '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let port = 0;
  const pf = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 120 && !port; i++) { await sleep(250); try { port = +fs.readFileSync(pf, 'utf8').split('\n')[0]; } catch (e) {} }
  if (!port) { chrome.kill(); throw new Error('Chrome 没起来'); }
  const list = () => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: '/json/list' }, (r) => {
    let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej));
  let target = null;
  for (let i = 0; i < 60 && !target; i++) { await sleep(200); const l = await list().catch(() => null); target = l && l.find(t => t.type === 'page'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws 失败'))); });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Network.enable');
  return { chrome, cdp, profile };
}

async function shot(cdp, name, w, h) {
  if (!SHOT_DIR) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w || 1100, height: h || 820, deviceScaleFactor: 1, mobile: !!(w && w < 600) });
  await sleep(500);
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(r.data, 'base64'));
  await cdp.send('Emulation.clearDeviceMetricsOverride');
}

const WAIT = `window.__wait = (ms) => new Promise(r => setTimeout(r, ms));
  window.__until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { try { const v = fn(); if (v) return v; } catch (e) {} await __wait(100); } return false; };`;

async function openWall(cdp, port, dir) {
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
  await sleep(1500);
  await cdp.eval(WAIT + ` await __until(() => window.__IV && window.__IV.backend().on); return 1;`);
  return cdp.eval(`
    document.querySelector('#startDisk').click(); await __wait(300);
    document.querySelector('#browsePath').value = ${JSON.stringify(dir)};
    document.querySelector('#browseGo').click();
    await __until(() => document.querySelectorAll('#browseList .brow-item').length > 1);
    document.querySelector('#viewWall').click();
    await __until(() => document.querySelectorAll('#wallGrid .wc').length > 0);
    return document.querySelectorAll('#wallGrid .wc').length;`);
}

const cards = `Array.from(document.querySelectorAll('#wallGrid .wc')).map(e => ({
  id: e.dataset.id, title: e.querySelector('.wc-title').textContent, sub: e.querySelector('.wc-sub').textContent,
  badge: (e.querySelector('.wc-badge') || {}).textContent || '', cnt: (e.querySelector('.wc-cnt') || {}).textContent || '',
  mark: (e.querySelector('.wc-mark') || {}).textContent || '', img: (e.querySelector('img') || {}).src || '', ph: e.querySelector('.wc-poster').childNodes[0] && e.querySelector('.wc-poster').childNodes[0].nodeType === 3 ? e.querySelector('.wc-poster').childNodes[0].textContent : '' }))`;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-scr-'));
  const media = path.join(tmp, '片库'); fs.mkdirSync(media);
  for (const n of ['流浪地球 (2019).mp4', 'The.Matrix.1999.1080p.BluRay.x264-GRP.mkv', 'Dune.mkv', 'Zzzz Unknown Film 2001.mkv',
    'Breaking.Bad.S01E01.720p.mkv', 'Breaking.Bad.S01E02.720p.mkv', 'Breaking.Bad.S01E03.720p.mkv', 'Breaking.Bad.S02E01.720p.mkv'])
    fs.writeFileSync(path.join(media, n), Buffer.from('not really a video ' + n));
  const big = path.join(tmp, '大目录'); fs.mkdirSync(big);
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(big, 'Unknown Film Number ' + String.fromCharCode(97 + i % 26) + String.fromCharCode(97 + (i / 26 | 0)) + ' (20' + (10 + i % 10) + ').mp4'), 'x');
  const sub = path.join(media, '子目录'); fs.mkdirSync(sub); fs.writeFileSync(path.join(sub, 'The.Matrix.1999.deep.mkv'), 'x');

  const fake = await spawnLine(PY, ['-u', 'tests/fake_tmdb.py', '0', TOKEN], {}, /API base\s*:\s*(\S+)\s+image base:\s*(\S+)/, '假 TMDB');
  const apiBase = fake.m[1], imgBase = fake.m[2];
  const fakeCount = () => new Promise((res) => http.get(apiBase.replace('/3', '') + '/3/configuration', { headers: { Authorization: 'Bearer ' + TOKEN } }, (r) => { r.resume(); r.on('end', () => res(1)); }).on('error', () => res(0)));
  void fakeCount;
  const scrDir = path.join(tmp, 'scrape'); const cfg = path.join(tmp, 'image_viewer.json');
  const be = await startBackend({ IV_CONFIG: cfg, IV_SCRAPE_DIR: scrDir, TMDB_TOKEN: TOKEN, TMDB_API_BASE: apiBase, TMDB_IMAGE_BASE: imgBase });
  const port = +be.m[1];
  log('后端 ' + port + '，假 TMDB ' + apiBase);
  const { chrome, cdp, profile } = await launchChrome();
  let be2 = null;
  try {
    log('\n[1] 海报墙渲染 + 懒加载匹配');
    const n = await openWall(cdp, port, media);
    check('目录里 8 个视频 -> 5 张卡（4 部电影 + 4 集合并成 1 张剧集卡）', n === 5, n);
    await cdp.eval(`await __until(() => document.querySelectorAll('#wallGrid .wc img').length >= 4, 15000); await __wait(800); return 1;`);
    let cs = await cdp.eval("return " + cards);
    const by = (t) => cs.find(c => c.title.includes(t));
    check('流浪地球：中文标题 + 年份 + 海报走 /api/scrape/image w342', by('流浪地球') && by('流浪地球').sub.includes('2019') && /\/api\/scrape\/image\?.*size=w342/.test(by('流浪地球').img), by('流浪地球'));
    check('Matrix 文件名 -> 中文译名「黑客帝国」', !!by('黑客帝国'), cs.map(c => c.title));
    const series = cs.find(c => c.cnt);
    check('剧集卡：4 集合成一张，标题「绝命毒师」', series && series.cnt === '4 集' && series.title === '绝命毒师', series);
    check('Dune 同名两部 -> 「待确认」徽标', cs.some(c => c.badge === '待确认'), cs);
    check('未知片 -> 「未匹配」徽标，海报位显示文件名占位', cs.some(c => c.badge === '未匹配' && /Zzzz/.test(c.ph + c.title)), cs);
    check('未知片没有海报 img（占位）', cs.filter(c => c.badge === '未匹配').every(c => !c.img), cs);
    await shot(cdp, 'wall-desktop.png', 1100, 860);

    log('\n[2] 排序 / 筛选');
    const ord = await cdp.eval(`
      const s = document.querySelector('#wallSort'); s.value = 'year'; s.dispatchEvent(new Event('change'));
      await __wait(300);
      const years = ${cards}.map(c => parseInt(c.sub) || 0);
      const f = document.querySelector('#wallFilter'); f.value = '黑客'; f.dispatchEvent(new Event('input')); await __wait(300);
      const filtered = ${cards}.map(c => c.title);
      f.value = 'matrix'; f.dispatchEvent(new Event('input')); await __wait(300);
      const byFile = ${cards}.length;
      f.value = ''; f.dispatchEvent(new Event('input')); await __wait(200);
      s.value = 'name'; s.dispatchEvent(new Event('change')); await __wait(200);
      return { years, filtered, byFile };`);
    check('按年份排序：新 -> 旧', ord.years.slice(0, 3).every((y, i, a) => i === 0 || a[i - 1] >= y), ord.years);
    check('筛选「黑客」只剩 1 张；按文件名 matrix 也能筛到', ord.filtered.length === 1 && ord.filtered[0].includes('黑客帝国') && ord.byFile === 1, ord);

    log('\n[3] 电影详情页（双语 / 播放）');
    const d1 = await cdp.eval(`
      document.querySelector('#wallGrid .wc[data-id^="m:"][title*="流浪地球"]').click();
      await __until(() => document.querySelector('#sdOver').textContent.includes('太阳'));
      const o = { shown: !document.querySelector('#scrDetail').classList.contains('hidden'),
        title: document.querySelector('#sdTitle').textContent, en: document.querySelector('#sdEn').textContent,
        meta: document.querySelector('#sdMeta').textContent, over: document.querySelector('#sdOver').textContent, overEn: document.querySelector('#sdOverEn').textContent,
        poster: document.querySelector('#sdPoster').style.backgroundImage, hero: document.querySelector('#sdHero').style.backgroundImage,
        play: document.querySelector('#sdPlay').textContent, body: document.querySelector('#sdBody').innerHTML };
      return o;`);
    check('详情：中文主标题 + 英文副标题', d1.shown && d1.title === '流浪地球' && d1.en === 'The Wandering Earth', d1);
    check('详情：年份 / 评分 / 时长 / 类型', /2019/.test(d1.meta) && /★ 8\.1/.test(d1.meta) && /125 分钟/.test(d1.meta) && /科幻/.test(d1.meta), d1.meta);
    check('详情：简介中文为主、英文为辅', d1.over.includes('太阳') && d1.overEn.includes('sun'), d1);
    check('详情：海报 w342 + 背景图 w780', /w342/.test(d1.poster) && /w780/.test(d1.hero), d1);
    await shot(cdp, 'detail-movie.png', 1100, 860);
    await cdp.eval(`document.querySelector('#scrDetail .modal-close').click(); await __wait(200); return 1;`);

    log('\n[4] 剧集详情：季标签 + 分集（中英片名 / 剧照）');
    const d2 = await cdp.eval(`
      document.querySelector('#wallGrid .wc[data-id^="s:"]').click();
      await __until(() => document.querySelectorAll('#sdBody .sd-ep .sd-still[style*="url"]').length >= 3, 12000);
      const o = { title: document.querySelector('#sdTitle').textContent, seasons: Array.from(document.querySelectorAll('#sdBody .sd-seasons .btn')).map(b => b.textContent),
        eps: Array.from(document.querySelectorAll('#sdBody .sd-ep')).map(e => e.querySelector('.sd-ep-t').textContent),
        stills: document.querySelectorAll('#sdBody .sd-ep .sd-still[style*="url"]').length, meta: document.querySelector('#sdMeta').textContent };
      return o;`);
    check('剧集：两个季标签（第 1 季 / 第 2 季）', d2.seasons.length === 2 && d2.seasons[0] === '第 1 季', d2);
    check('第 1 季 3 集，带中文片名 + 英文片名 + 剧照', d2.eps.length === 3 && d2.eps[1].includes('猫在袋子里') && d2.eps[1].includes("Cat's in the Bag") && d2.stills === 3, d2);
    await shot(cdp, 'detail-series.png', 1100, 860);
    const s2 = await cdp.eval(`
      document.querySelectorAll('#sdBody .sd-seasons .btn')[1].click();
      await __until(() => document.querySelector('#sdBody .sd-ep-t') && document.querySelector('#sdBody .sd-ep-t').textContent.includes('第二季第一集'), 8000);
      return Array.from(document.querySelectorAll('#sdBody .sd-ep')).map(e => e.querySelector('.sd-ep-t').textContent);`);
    check('切到第 2 季显示第 2 季的分集', s2.length === 1 && s2[0].includes('第二季第一集'), s2);
    await cdp.eval(`document.querySelector('#scrDetail .modal-close').click(); await __wait(200); return 1;`);

    log('\n[5] 修正匹配：搜索 -> 选择 -> 锁定，刷新后仍在');
    const f1 = await cdp.eval(`
      document.querySelector('#wallGrid .wc[title*="Dune"], #wallGrid .wc[data-id^="m:"] .wc-badge.b-review').closest('.wc').click();
      await __until(() => !document.querySelector('#scrDetail').classList.contains('hidden') && document.querySelector('#sdNote').textContent.includes('暂定'));
      const note = document.querySelector('#sdNote').textContent;
      document.querySelector('#sdFix').click();
      await __until(() => document.querySelectorAll('#fxList .fx-row').length >= 2);
      const o = { note, q: document.querySelector('#fxQ').value, cur: document.querySelector('#fxCur').textContent,
        rows: Array.from(document.querySelectorAll('#fxList .fx-row')).map(r => r.textContent), unpin: document.querySelector('#fxUnpin').style.display };
      return o;`);
    check('待确认条目详情里有「暂定」提示；搜索框预填 Dune；列出 2 个候选', /暂定/.test(f1.note) && f1.q === 'Dune' && f1.rows.length === 2, f1);
    await shot(cdp, 'fix-match.png', 1100, 860);
    const f2 = await cdp.eval(`
      const rows = Array.from(document.querySelectorAll('#fxList .fx-row'));
      const r84 = rows.find(r => r.textContent.includes('1984') || r.textContent.includes('The 1984'));
      (r84 || rows[0]).click();
      await __until(() => document.querySelector('#wallGrid .wc-badge.b-pin'));
      await __wait(500);
      return { cards: ${cards} };`);
    check('选「沙丘」后：卡片出现 📌 锁定徽标，不再是待确认', f2.cards.some(c => c.badge === '📌' && c.title === '沙丘') && !f2.cards.some(c => c.badge === '待确认'), f2.cards);
    // 刷新页面重新进入
    await openWall(cdp, port, media);
    await cdp.eval(`await __until(() => document.querySelectorAll('#wallGrid .wc-badge.b-pin').length, 8000); return 1;`);
    cs = await cdp.eval("return " + cards);
    check('刷新页面后锁定仍在（📌 + 沙丘）', cs.some(c => c.badge === '📌' && c.title === '沙丘'), cs);
    const stp = await cdp.eval(`const j = await (await fetch('/api/scrape/status?t=' + encodeURIComponent(window.__IV.backend().token))).json(); return j;`);
    check('后端 status：1 条手动锁定、令牌已配置（只给 true）', stp.pins === 1 && stp.token_configured === true && !JSON.stringify(stp).includes(TOKEN), stp);

    log('\n[6] 继续观看 / 已看标记（复用 _video_resume_）');
    const mk = await cdp.eval(`
      const tok = window.__IV.backend().token;
      const p = ${JSON.stringify(path.join(media, '流浪地球 (2019).mp4'))};
      await fetch('/api/videoresume?t=' + encodeURIComponent(tok), { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path: p, ms: 754000, length: 7200000 }) });
      document.querySelector('#browseGo').click(); await __wait(1200);
      await __until(() => document.querySelectorAll('#wallGrid .wc').length);
      await __wait(500);
      const c = ${cards}.find(c => c.title.includes('流浪地球'));
      document.querySelector('#wallGrid .wc[title*="流浪地球"]').click();
      await __until(() => document.querySelector('#sdPlay').textContent.includes('继续'));
      return { mark: c.mark, play: document.querySelector('#sdPlay').textContent };`);
    check('卡片显示「▶ 12:34」，详情按钮「继续观看 12:34」', mk.mark.includes('12:34') && mk.play.includes('12:34'), mk);
    const pl = await cdp.eval(`document.querySelector('#sdPlay').click(); await __until(() => !document.querySelector('#vplayer').classList.contains('hidden')); return { shown: !document.querySelector('#vplayer').classList.contains('hidden'), title: document.querySelector('#vpTitle').textContent };`);
    check('点播放：复用现有播放器', pl.shown && pl.title.includes('流浪地球'), pl);

    log('\n[7] 刮削当前目录：进度 + 取消');
    await openWall(cdp, port, big);
    const sc = await cdp.eval(`
      document.querySelector('#wallScan').click();
      await __until(() => document.querySelector('#wallProg').classList.contains('on') && /\\d+\\/60/.test(document.querySelector('#wallProgText').textContent), 6000);
      const mid = document.querySelector('#wallProgText').textContent;
      document.querySelector('#wallCancel').click();
      await __until(() => document.querySelector('#wallProgText').textContent.startsWith('已结束'), 15000);
      const end = document.querySelector('#wallProgText').textContent;
      await __wait(300);
      return { mid, end, btn: document.querySelector('#wallScan').disabled };`);
    const dn = /已结束 (\d+)\/60/.exec(sc.end);
    check('显示进度「刮削中 n/60 · 已匹配 …」', /刮削中|已结束/.test(sc.mid) && /\/60/.test(sc.mid), sc);
    check('点取消后任务提前结束（done < 60），按钮恢复可点', dn && +dn[1] < 60 && sc.btn === false, sc);
    // 完整跑一遍（小目录）
    await openWall(cdp, port, media);
    const full = await cdp.eval(`
      document.querySelector('#wallScan').click();
      await __until(() => document.querySelector('#wallProgText').textContent.startsWith('已结束'), 20000);
      return document.querySelector('#wallProgText').textContent;`);
    check('小目录完整刮削：8/8 完成', /已结束 8\/8/.test(full), full);
    const nrec = await cdp.eval(`const t = window.__IV.backend().token; const q = (await (await fetch('/api/scrape/peek?t=' + t, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({items:[{path: ${JSON.stringify(path.join(media, '子目录', 'The.Matrix.1999.deep.mkv'))}}]})})).json()); return q.items[0].item;`);
    check('刮削只做当前这一层（不递归：子目录里的文件没被刮）', nrec === null, nrec);

    log('\n[8] 令牌不泄露 + 署名');
    const leak = await cdp.eval(`
      const t = window.__IV.backend().token; const out = [];
      for (const u of ['/api/scrape/status', '/api/scrape/search?q=dune&type=movie', '/api/scrape/job?id=zzz', '/api/ping', '/api/progress']) {
        const r = await fetch(u + (u.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(t)); out.push(await r.text());
      }
      const ls = JSON.stringify(Object.assign({}, localStorage));
      return { dom: document.documentElement.outerHTML.includes(${JSON.stringify(TOKEN)}), api: out.join('').includes(${JSON.stringify(TOKEN)}), ls: ls.includes(${JSON.stringify(TOKEN)}) };`);
    check('令牌不在 DOM / 接口响应 / localStorage', !leak.dom && !leak.api && !leak.ls, leak);
    let netLeak = 0, netSeen = 0;
    for (const ev of cdp.events) {
      if (ev.method !== 'Network.responseReceived' || !/\/api\//.test(ev.params.response.url)) continue;
      const b = await cdp.send('Network.getResponseBody', { requestId: ev.params.requestId });
      if (b && typeof b.body === 'string') { netSeen++; if (b.body.includes(TOKEN)) netLeak++; }
      if (/[?&]t=/.test('') ) {}
      if (ev.params.response.url.includes(TOKEN)) netLeak++;
    }
    check('抓到的网络响应（' + netSeen + ' 个 /api/ 响应）里没有令牌', netSeen > 20 && netLeak === 0, { netSeen, netLeak });
    const att = await cdp.eval(`
      document.querySelector('#wallPane .wall-foot img').complete;
      const foot = document.querySelector('#wallPane .wall-foot').textContent;
      const logoH = document.querySelector('#wallPane .wall-foot img').getBoundingClientRect().height;
      document.querySelector('#browse .modal-close').click(); await __wait(200);
      document.querySelector('#btnHelp, [data-open="help"], #helpBtn') && document.querySelector('#btnHelp, [data-open="help"], #helpBtn').click();
      const helpHtml = document.querySelector('#helpTmdb').textContent;
      const hlogo = document.querySelector('#helpTmdb img');
      return { foot, helpHtml, logoH, helpLogo: !!hlogo && hlogo.src.startsWith('data:image/svg+xml'), helpLogoH: hlogo.style.height };`);
    check('海报墙脚注 + 帮助页底部都有 TMDB 声明与 logo（logo 12px 高，小于应用自身标识）',
      /not endorsed or certified by TMDB/.test(att.foot) && /not endorsed or certified by TMDB/.test(att.helpHtml) && att.helpLogo && att.logoH <= 14, att);

    log('\n[9] 未配置令牌：中文说明、不联网、仍可浏览');
    const fakeBefore = await new Promise((res) => http.get(apiBase.replace(/\/3$/, '') + '/__none', (r) => { r.resume(); res(1); }).on('error', () => res(0)));
    void fakeBefore;
    be2 = await startBackend({ IV_CONFIG: path.join(tmp, 'cfg2.json'), IV_SCRAPE_DIR: path.join(tmp, 'scrape2'), TMDB_TOKEN: '', TMDB_API_BASE: apiBase, TMDB_IMAGE_BASE: imgBase });
    const n2 = await openWall(cdp, +be2.m[1], media);
    await sleep(800);
    const nt = await cdp.eval(`return { notice: document.querySelector('#wallNotice').textContent, on: document.querySelector('#wallNotice').classList.contains('on'),
      cards: ${cards}, stats: document.querySelector('#wallStats').textContent, inputs: document.querySelectorAll('#wallPane input[type=password], #wallPane input[placeholder*="令牌"], #wallPane input[placeholder*="token" i]').length };`);
    check('提示块出现，含设置用户级环境变量的命令与「重启后端」', nt.on && /TMDB_TOKEN/.test(nt.notice) && /SetEnvironmentVariable/.test(nt.notice) && /重新启动后端/.test(nt.notice), nt.notice);
    check('仍显示 5 张按文件名解析的卡片（无海报）', n2 === 5 && nt.cards.every(c => !c.img), nt.cards);
    check('状态行「未配置令牌」；界面没有任何令牌输入框', /未配置令牌/.test(nt.stats) && nt.inputs === 0, nt);
    const sc0 = await cdp.eval(`document.querySelector('#wallScan').click(); await __wait(500); return document.querySelector('#wallNotice').classList.contains('on');`);
    check('点「刮削当前目录」仍给出配置说明（不发请求）', sc0 === true);
    await shot(cdp, 'wall-no-token.png', 1100, 860);
    await openWall(cdp, port, media);
    await shot(cdp, 'wall-mobile.png', 390, 820);
  } catch (e) {
    fail++; log('  \x1b[31m✘ 异常\x1b[0m ' + (e && e.stack || e));
  } finally {
    try { chrome.kill(); } catch (e) {}
    try { be.proc.kill(); } catch (e) {}
    try { fake.proc.kill(); } catch (e) {}
    try { be2 && be2.proc.kill(); } catch (e) {}
  }
  log('\n结果：通过 ' + pass + '，失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
