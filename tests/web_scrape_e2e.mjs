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

async function openWall(cdp, port, dir, pre) {
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' });
  await sleep(1500);
  await cdp.eval(WAIT + ` await __until(() => window.__IV && window.__IV.backend().on); return 1;`);
  if (pre) await cdp.eval(pre + ' return 1;');
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
  const lib = path.join(tmp, '剧集库');
  for (const [d, files] of [['Breaking Bad/Season 1', ['S01E01.mkv', 'S01E02.mkv', 'S01E03.mkv']], ['Breaking Bad/Season 2', ['S02E01.mkv']],
    ['进击的巨人 S01', ['01.mkv', '02.mkv', '03.mkv']], ['进击的巨人 第二季', ['01.mkv']]]) {
    fs.mkdirSync(path.join(lib, d), { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(lib, d, f), 'x');
  }
  const liu = path.join(tmp, '流人库', '流人');
  fs.mkdirSync(liu, { recursive: true });
  fs.writeFileSync(path.join(liu, '流人第六季.2026.S06E01.HD1080P.AAC.H264.CHS-ENG.BT世界网.[www.btsj6.com].mp4'), 'x');
  fs.writeFileSync(path.join(liu, '流人第六季.2026.S06E02.HD1080P.AAC.H264.CHS-ENG.BT世界网.[www.btsj6.com].mp4'), 'x');
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
    check('目录 8 个视频 + 子目录 1 个 -> 6 张卡（5 部电影 + 4 集合并成 1 张剧集卡）', n === 6, n);
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
    check('筛选「黑客」只剩 2 张（含子目录那份）；按文件名 matrix 也能筛到', ord.filtered.length === 2 && ord.filtered.every(t => t.includes('黑客帝国')) && ord.byFile === 2, ord);

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
    const sub2 = path.join(media, '子目录2');
    await openWall(cdp, port, media);
    await cdp.eval(`document.querySelector('#wallSub').click(); await __wait(1200); return 1;`);
    fs.mkdirSync(sub2); fs.writeFileSync(path.join(sub2, 'Blade.Runner.2049.2017.deep.mkv'), 'x');
    const full = await cdp.eval(`
      document.querySelector('#wallScan').click();
      await __until(() => document.querySelector('#wallProgText').textContent.startsWith('已结束'), 20000);
      return document.querySelector('#wallProgText').textContent;`);
    check('小目录完整刮削：8/8 完成', /已结束 8\/8/.test(full), full);
    const nrec = await cdp.eval(`const t = window.__IV.backend().token; const q = (await (await fetch('/api/scrape/peek?t=' + t, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({items:[{path: ${JSON.stringify(path.join(sub2, 'Blade.Runner.2049.2017.deep.mkv'))}}]})})).json()); return q.items[0].item;`);
    check('刮削只做当前这一层（不递归：子目录里的文件没被刮）', nrec === null, nrec);


    log('\n[7b] 分季目录合并成一张剧集卡（按 TMDB id）');
    const ensureSub = `const cb = document.querySelector('#wallSub'); if (!cb.checked) { cb.click(); await __wait(800); } return 1;`;
    await openWall(cdp, port, lib);
    await cdp.eval(ensureSub);
    const m1 = await cdp.eval(`
      await __until(() => { const c = ${cards}; return c.length === 2 && c.every(x => x.img); }, 15000);
      return ${cards};`);
    check('剧集库 4 个目录 -> 合并成 2 张卡（Breaking Bad 的 Season 1/2；进击的巨人 S01 + 第二季 按 TMDB id 合并）',
      m1.length === 2 && m1.map(c => c.title).sort().join() === '绝命毒师,进击的巨人' && m1.every(c => c.cnt === '4 集'), m1);
    await shot(cdp, 'wall-merged-seasons.png', 1100, 860);
    const m2 = await cdp.eval(`
      document.querySelector('#wallGrid .wc[title*="进击的巨人"]').click();
      await __until(() => document.querySelectorAll('#sdBody .sd-ep .sd-still[style*="url"]').length >= 3, 12000);
      const tabs = Array.from(document.querySelectorAll('#sdBody .sd-seasons .btn')).map(b => b.textContent);
      const eps1 = Array.from(document.querySelectorAll('#sdBody .sd-ep-t')).map(e => e.textContent);
      document.querySelectorAll('#sdBody .sd-seasons .btn')[1].click();
      await __until(() => document.querySelectorAll('#sdBody .sd-ep').length === 1 && document.querySelector('#sdBody .sd-ep-t').textContent.includes('野兽巨人'), 8000);
      const eps2 = Array.from(document.querySelectorAll('#sdBody .sd-ep-t')).map(e => e.textContent);
      document.querySelector('#sdBody .sd-ep').click();
      await __until(() => !document.querySelector('#vplayer').classList.contains('hidden'));
      await __wait(300);
      const src = decodeURIComponent(document.querySelector('#vpVideo').getAttribute('src') || '');
      return { tabs, eps1, eps2, src };`);
    check('详情页列出全部季（第 1 季 / 第 2 季），第 1 季 3 集带片名', m2.tabs.join() === '第 1 季,第 2 季' && m2.eps1.length === 3 && m2.eps1[0].includes('致两千年后的你'), m2);
    check('第 2 季的分集链接到它自己目录里的文件（…/进击的巨人 第二季/01.mkv）', m2.eps2.length === 1 && /进击的巨人 第二季[\\/]01\.mkv/.test(m2.src), m2);
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await __wait(800); return 1;`);
    const one = await openWall(cdp, port, path.join(lib, 'Breaking Bad', 'Season 1'));
    const m3 = await cdp.eval(`await __wait(600); return ${cards};`);
    check('直接浏览单个季目录仍正常：1 张剧集卡，3 集', one === 1 && m3[0].cnt === '3 集', m3);

    log('\n[7c] 已看状态（_video_watched_，桌面版共用）');
    const w1 = await cdp.eval(`
      await __until(() => document.querySelector('#wallGrid .wc img'));
      document.querySelector('#wallGrid .wc').click();
      await __until(() => document.querySelectorAll('#sdBody .sd-ep').length === 3);
      document.querySelector('#sdBody .sd-ep-w').click();
      await __until(() => document.querySelector('#sdBody .sd-ep-m.done'));
      const afterOne = { mark: ${cards}[0].mark, ep: document.querySelector('#sdBody .sd-ep-m').textContent, btn: document.querySelector('#sdBody .sd-ep-w').textContent, btn2: document.querySelectorAll('#sdBody .sd-ep-w')[1].textContent, all: document.querySelector('#sdWatch').textContent };
      document.querySelector('#sdWatch').click();
      await __until(() => document.querySelectorAll('#sdBody .sd-ep-m.done').length === 3);
      const afterAll = { mark: ${cards}[0].mark, all: document.querySelector('#sdWatch').textContent };
      return { afterOne, afterAll };`);
    check('单集标记已看 -> 卡片「✓ 1/3」；「全部标为已看」后整部剧「✓ 已看完」（所有可见集都已看才算）',
      w1.afterOne.mark === '✓ 1/3' && w1.afterOne.ep === '状态：已看' && w1.afterOne.btn === '取消已看' && w1.afterOne.btn2 === '标为已看' && w1.afterOne.all === '全部标为已看' && w1.afterAll.mark === '✓ 已看完' && w1.afterAll.all === '全部取消已看', w1);
    const s1 = path.join(lib, 'Breaking Bad', 'Season 1', 'S01E01.mkv');
    const w2 = await cdp.eval(`
      const t = window.__IV.backend().token;
      const g = async (p) => (await (await fetch('/api/videoresume?path=' + encodeURIComponent(p) + '&t=' + encodeURIComponent(t))).json());
      const a = await g(${JSON.stringify(s1)});
      const mv = ${JSON.stringify(path.join(media, 'Dune.mkv'))};
      const before = (await g(mv)).watched;
      await fetch('/api/videoresume?t=' + encodeURIComponent(t), { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path: mv, ms: 599000, length: 600000 }) });
      const after = await g(mv);
      return { a, before, after };`);
    check('后端：标记写入 _video_watched_；播放到结尾（ms≈length）自动记已看且清掉续播点', w2.a.watched === true && w2.before === false && w2.after.watched === true && w2.after.ms === null, w2);
    const cfgj = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    check('配置文件：_video_watched_ 是 {key: 秒} 新 key，_video_resume_ 旧格式（毫秒整数）原样', Object.keys(cfgj._video_watched_ || {}).length >= 4 && Object.values(cfgj._video_resume_ || {}).every(v => Number.isInteger(v)), Object.keys(cfgj));
    await openWall(cdp, port, path.join(lib, 'Breaking Bad', 'Season 1'));
    const w3 = await cdp.eval(`await __wait(600); const m = ${cards}[0].mark;
      document.querySelector('#wallGrid .wc').click(); await __until(() => document.querySelector('#sdWatch'));
      await __wait(400);
      document.querySelector('#sdWatch').click();
      await __until(() => document.querySelector('#sdWatch').textContent === '全部标为已看');
      return { m, after: ${cards}[0].mark };`);
    check('刷新后仍是已看完；「全部标为未看」可撤销', w3.m === '✓ 已看完' && w3.after === '', w3);
    await cdp.eval(`document.querySelector('#scrDetail .modal-close').click(); return 1;`);

    log('\n[7d] 播放器关闭后回到原来的目录视图');
    await openWall(cdp, port, media);
    await cdp.eval(ensureSub);
    const r1 = await cdp.eval(`
      await __until(() => document.querySelectorAll('#wallGrid .wc img').length >= 3, 12000);
      const s = document.querySelector('#wallSort'); s.value = 'year'; s.dispatchEvent(new Event('change'));
      const f = document.querySelector('#wallFilter'); f.value = '流浪'; f.dispatchEvent(new Event('input')); await __wait(400);
      document.querySelector('#wallGrid .wc').click();
      await __until(() => document.querySelector('#sdPlay')._file);
      document.querySelector('#sdPlay').click();
      await __until(() => !document.querySelector('#vplayer').classList.contains('hidden'));
      const during = { browse: !document.querySelector('#browse').classList.contains('hidden') };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await __until(() => !document.querySelector('#browse').classList.contains('hidden'), 6000);
      await __until(() => !document.querySelector('#scrDetail').classList.contains('hidden'), 6000);
      return { during, player: !document.querySelector('#vplayer').classList.contains('hidden'),
        browse: !document.querySelector('#browse').classList.contains('hidden'), wall: document.querySelector('#browse').classList.contains('wall-on'),
        path: document.querySelector('#browsePath').value, sort: document.querySelector('#wallSort').value, filter: document.querySelector('#wallFilter').value,
        detail: !document.querySelector('#scrDetail').classList.contains('hidden'), title: document.querySelector('#sdTitle').textContent, cards: ${cards}.length };`);
    check('播放时目录窗口收起；Esc 关播放器后：窗口回来、仍是海报墙、同一路径、同排序、同筛选、详情页也回来',
      r1.during.browse === false && !r1.player && r1.browse && r1.wall && r1.path.endsWith('片库') && r1.sort === 'year' && r1.filter === '流浪' && r1.detail && r1.title === '流浪地球' && r1.cards === 1, r1);
    await cdp.eval(`document.querySelector('#scrDetail .modal-close').click(); return 1;`);
    await openWall(cdp, port, big);
    const r3 = await cdp.eval(`
      await __until(() => document.querySelectorAll('#wallGrid .wc').length >= 60, 8000);
      const g = document.querySelector('#wallGrid'); g.scrollTop = 420; await __wait(300);
      const st = g.scrollTop;
      document.querySelectorAll('#wallGrid .wc')[24].click();
      await __until(() => document.querySelector('#sdPlay')._file);
      document.querySelector('#sdPlay').click();
      await __until(() => !document.querySelector('#vplayer').classList.contains('hidden'));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await __until(() => !document.querySelector('#scrDetail').classList.contains('hidden'), 6000);
      await __wait(500);
      document.querySelector('#scrDetail .modal-close').click();
      return { st, back: document.querySelector('#wallGrid').scrollTop, n: document.querySelectorAll('#wallGrid .wc').length };`);
    check('滚动位置也恢复（60 张卡，滚到 ~420 再播放，回来仍在原位）', r3.st > 300 && Math.abs(r3.back - r3.st) < 40, r3);
    await openWall(cdp, port, media);
    const r4 = await cdp.eval(`
      document.querySelector('#viewList').click(); await __wait(500);
      const row = Array.from(document.querySelectorAll('#browseList .brow-item')).find(e => e.textContent.includes('Dune.mkv'));
      row.click();
      document.querySelector('#browseOpen').click();
      await __until(() => !document.querySelector('#vplayer').classList.contains('hidden'));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await __until(() => !document.querySelector('#browse').classList.contains('hidden'), 6000);
      await __until(() => document.querySelector('#browseList .brow-item.sel'), 6000);
      return { wall: document.querySelector('#browse').classList.contains('wall-on'), sel: (document.querySelector('#browseList .brow-item.sel') || {}).textContent || '' };`);
    check('列表模式：从列表播放视频，Esc 回来仍是列表且选中项不变', r4.wall === false && r4.sel.includes('Dune.mkv'), r4);
    await cdp.eval(`document.querySelector('#viewWall').click(); await __wait(500); return 1;`);


    log('\n[7e] 忽略（不是影视）');
    const ign = path.join(tmp, '忽略库'); fs.mkdirSync(ign);
    fs.writeFileSync(path.join(ign, '夸克.mp4'), 'x');
    fs.writeFileSync(path.join(ign, '流浪地球 (2019).mp4'), 'x');
    const stats = () => new Promise((res) => http.get(apiBase.replace(/\/3$/, '') + '/__stats', (r) => { let b = ''; r.on('data', d => (b += d)); r.on('end', () => res(JSON.parse(b))); }));
    await openWall(cdp, port, ign);
    await cdp.eval(ensureSub);
    await cdp.eval(`await __until(() => document.querySelectorAll('#wallGrid .wc-badge').length >= 1 || document.querySelectorAll('#wallGrid .wc img').length >= 1, 10000); await __wait(1200); return 1;`);
    const i0 = await cdp.eval(`return ${cards};`);
    check('「夸克」只能靠外语别名命中德国老片：不自动接受 -> 未匹配（不是待确认）', i0.some(c => c.title.includes('夸克') && c.badge === '未匹配'), i0);
    const ig = await cdp.eval(`
      Array.from(document.querySelectorAll('#wallGrid .wc')).find(e => e.textContent.includes('夸克')).click();
      await __until(() => !document.querySelector('#scrDetail').classList.contains('hidden'));
      document.querySelector('#sdFix').click();
      await __until(() => !document.querySelector('#scrFix').classList.contains('hidden'));
      const label = document.querySelector('#fxIgnore').textContent;
      document.querySelector('#fxIgnore').click();
      await __until(() => document.querySelector('#wallGrid .wc-badge.b-ign'), 8000);
      await __wait(500);
      const cs = ${cards};
      return { label, cs };`);
    const ic = ig.cs.find(c => c.badge === '已忽略');
    check('修正匹配里有「忽略此项（不是影视）」；点后变成普通文件卡：文件名标题、「已忽略」小标签、无海报、无待确认 / 未匹配徽标',
      ig.label === '忽略此项（不是影视）' && ic && ic.title === '夸克.mp4' && !ic.img && !ig.cs.some(c => c.title.includes('夸克') && c.badge !== '已忽略'), ig);
    await shot(cdp, 'wall-ignored.png', 1100, 860);
    const before = await stats();
    const sc2 = await cdp.eval(`
      document.querySelector('#wallScan').click();
      await __until(() => document.querySelector('#wallProgText').textContent.startsWith('已结束'), 15000);
      const t = document.querySelector('#wallProgText').textContent;
      await __wait(800);
      return { t, cs: ${cards} };`);
    const after = await stats();
    check('刮削当前目录：已忽略的算「已忽略 1」，且没有为它发任何 TMDB 搜索（只为另一个文件搜）', /已忽略 1/.test(sc2.t) && /已结束 2\/2/.test(sc2.t) && after.search === before.search, { t: sc2.t, before, after });
    const peekIgn = await cdp.eval(`const t = window.__IV.backend().token; const q = await (await fetch('/api/scrape/peek?t=' + t, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({items:[{path: ${JSON.stringify(path.join(ign, '夸克.mp4'))}}]})})).json(); return q.items[0].item.status;`);
    check('peek 返回 ignored；刷新页面后仍是已忽略', peekIgn === 'ignored');
    const purged = await cdp.eval(`const t = window.__IV.backend().token; await fetch('/api/scrape/purge?t=' + t, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({all:true})}); const q = await (await fetch('/api/scrape/status?t=' + t)).json(); return q.pins;`);
    check('清缓存（all）不清忽略记录', purged >= 1, purged);
    const cnt0 = (await stats()).search;
    await openWall(cdp, port, ign);
    await cdp.eval(`await __until(() => document.querySelectorAll('#wallGrid .wc').length === 2); await __wait(1500); return 1;`);
    const cnt1 = (await stats()).search;
    const un = await cdp.eval(`
      const cs = ${cards}; const ok = cs.some(c => c.badge === '已忽略');
      Array.from(document.querySelectorAll('#wallGrid .wc')).find(e => e.textContent.includes('夸克')).click();
      await __until(() => !document.querySelector('#scrDetail').classList.contains('hidden'));
      const note = document.querySelector('#sdNote').textContent;
      document.querySelector('#sdFix').click();
      await __until(() => !document.querySelector('#scrFix').classList.contains('hidden'));
      const label = document.querySelector('#fxIgnore').textContent;
      document.querySelector('#fxIgnore').click();
      await __until(() => !document.querySelector('#wallGrid .wc-badge.b-ign'), 8000);
      await __wait(1500);
      return { ok, note, label, cs2: ${cards} };`);
    check('清缓存后重新打开：夸克仍是已忽略、没有为它搜索（只有流浪地球的重新刮削）；详情页有说明；弹窗里能「取消忽略」恢复刮削',
      un.ok && /不会再向 TMDB 查询/.test(un.note) && un.label === '取消忽略' && un.cs2.some(c => c.title.includes('夸克') && c.badge === '未匹配') && cnt1 - cnt0 <= 2, { un, cnt0, cnt1 });

    log('\n[7f] TMDB 还没有这一季：详情页降级而不是失败（流人 第六季）');
    await openWall(cdp, port, path.join(tmp, '流人库'));
    await cdp.eval(ensureSub);
    const lr = await cdp.eval(`
      await __until(() => { const c = ${cards}; return c.length === 1 && c[0].img; }, 12000);
      const c0 = ${cards};
      document.querySelector('#wallGrid .wc').click();
      await __until(() => document.querySelector('#sdBody .sd-ep'), 8000);
      await __wait(1200);
      const o = { c0, title: document.querySelector('#sdTitle').textContent, en: document.querySelector('#sdEn').textContent,
        note: document.querySelector('#sdNote').textContent, soft: document.querySelector('#sdNote').classList.contains('soft'),
        over: document.querySelector('#sdOver').textContent, poster: document.querySelector('#sdPoster').style.backgroundImage,
        tabs: Array.from(document.querySelectorAll('#sdBody .sd-seasons .btn')).map(b => b.textContent),
        eps: Array.from(document.querySelectorAll('#sdBody .sd-ep-t')).map(e => e.textContent), html: document.body.innerText };
      document.querySelector('#sdBody .sd-ep').click();
      await __until(() => !document.querySelector('#vplayer').classList.contains('hidden'), 6000);
      o.played = !document.querySelector('#vplayer').classList.contains('hidden');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await __wait(800);
      return o;`);
    check('卡片：中文标题「流人」+ 海报（同名的 2026 年干扰剧没有被选中）', lr.c0.length === 1 && lr.c0[0].title === '流人' && /slowhorses|w342/.test(lr.c0[0].img) && lr.c0[0].cnt === '2 集', lr.c0);
    check('详情页：不显示「刮削失败 / 404」，有剧集层面的资料（标题 / 英文名 / 简介 / 海报）', !/刮削失败|404|读取中/.test(lr.html) && lr.title === '流人' && lr.en === 'Slow Horses' && lr.over.includes('特工') && /w342/.test(lr.poster), lr);
    check('只有一条灰色小提示（说明第 6 季暂无分集资料），不是橙色失败横幅', lr.soft && /第 6 季 TMDB 暂时还没有分集资料/.test(lr.note), lr.note);
    check('第 6 季标签 + 本地 2 个文件按解析出的集号列出（E01 / E02 + 文件名），照常可播放',
      lr.tabs.join() === '第 6 季' && lr.eps.length === 2 && lr.eps[0].startsWith('E01') && lr.eps[1].startsWith('E02') && lr.eps[0].includes('流人第六季') && lr.played, lr);
    await shot(cdp, 'detail-season-missing.png', 1100, 860);

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


    log('\n[9b] 「未配置令牌」横幅不能误报（状态加载中 / 读取失败 / TMDB 5xx / 401）');
    const bannerState = `const n = document.querySelector('#wallNotice'); return { on: n.classList.contains('on'), text: n.textContent, stats: document.querySelector('#wallStats').textContent };`;
    const setFetch = (body) => `const of = window.fetch.__orig || window.fetch; const w = (u, o) => { u = String(u); ${body} return of(u, o); }; w.__orig = of; window.fetch = w;`;
    // (i) 状态响应很慢：先渲染卡片，横幅不出现，状态行是「检查中」，回来后是「已配置令牌」
    await openWall(cdp, port, media, setFetch(`if (u.includes('/api/scrape/status')) return new Promise((r) => setTimeout(r, 2000)).then(() => of(u, o));`));
    const tk1 = await cdp.eval(`await __wait(500); const early = (() => { ${bannerState} })(); const nCards = ${cards}.length;
      await __until(() => /已配置令牌/.test(document.querySelector('#wallStats').textContent), 6000); return { early, nCards, late: (() => { ${bannerState} })() };`);
    check('状态慢：先出卡片、横幅不出现、状态行「检查中」；状态回来后「已配置令牌」且仍无横幅', tk1.nCards >= 5 && !tk1.early.on && /检查中/.test(tk1.early.stats) && !tk1.late.on && /已配置令牌/.test(tk1.late.stats), tk1);
    // (ii) 状态请求失败（网络错误）/ (iii) HTTP 500 / (iv) 200 但没有 token_configured 字段
    for (const [name, body, statRe] of [
      ['网络错误', `if (u.includes('/api/scrape/status')) return Promise.reject(new TypeError('Failed to fetch'));`, /状态暂时读不到/],
      ['HTTP 500', `if (u.includes('/api/scrape/status')) return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'boom' }), { status: 500, headers: { 'Content-Type': 'application/json' } }));`, /状态暂时读不到/],
      ['缺字段', `if (u.includes('/api/scrape/status')) return Promise.resolve(new Response(JSON.stringify({ ok: true, cached_responses: 0, images: 0, image_bytes: 0, pins: 0, ttl_days: 150 }), { status: 200, headers: { 'Content-Type': 'application/json' } }));`, /令牌状态未知/]]) {
      await openWall(cdp, port, media, setFetch(body));
      const dd = await cdp.eval(`await __wait(1200); const o = (() => { ${bannerState} })(); o.imgs = document.querySelectorAll('#wallGrid .wc img').length; return o;`);
      check('状态' + name + '：不显示「未配置令牌」横幅，状态行是中性提示，浏览与懒加载海报照常', !dd.on && statRe.test(dd.stats) && !/未配置令牌/.test(dd.stats) && dd.imgs >= 3, dd);
    }
    // (v) TMDB 暂时 5xx：横幅是「TMDB 暂时不可用」，绝不是「未配置令牌」；状态行仍是已配置
    fs.mkdirSync(path.join(tmp, '大目录2'), { recursive: true });
    for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(tmp, '大目录2', 'Never Seen Movie ' + String.fromCharCode(97 + i) + ' (2012).mp4'), 'x');
    const setFake = (q) => new Promise((res) => http.get(apiBase.replace(/\/3$/, '') + '/__set?' + q, (r) => { r.resume(); r.on('end', () => res(1)); }));
    await setFake('fail_500=2000');
    await openWall(cdp, port, path.join(tmp, '大目录2'));
    const tk5 = await cdp.eval(`await __until(() => /暂时不可用/.test(document.querySelector('#wallNotice').textContent), 40000); return (() => { ${bannerState} })();`);
    await setFake('fail_500=0');
    check('TMDB 5xx：横幅是「TMDB 暂时不可用…这不是令牌问题」，没有「还没有配置」，状态行仍「已配置令牌」', tk5.on && /暂时不可用/.test(tk5.text) && /不是令牌问题/.test(tk5.text) && !/还没有配置/.test(tk5.text) && /已配置令牌/.test(tk5.stats), tk5);
    // (vi) 令牌错误（401）：横幅是「令牌无效」而不是「未配置」
    const be3 = await startBackend({ IV_CONFIG: path.join(tmp, 'cfg3.json'), IV_SCRAPE_DIR: path.join(tmp, 'scrape3'), TMDB_TOKEN: 'WRONG_TOKEN_e2e', TMDB_API_BASE: apiBase, TMDB_IMAGE_BASE: imgBase });
    await openWall(cdp, +be3.m[1], path.join(tmp, '大目录2'));
    const tk6 = await cdp.eval(`await __until(() => /令牌无效/.test(document.querySelector('#wallNotice').textContent), 25000); return (() => { ${bannerState} })();`);
    be3.proc.kill();
    check('令牌错误（401）：横幅是「TMDB 令牌无效（401）」，不是「还没有配置」；状态行「已配置令牌」', tk6.on && /令牌无效（401）/.test(tk6.text) && !/还没有配置/.test(tk6.text) && /已配置令牌/.test(tk6.stats), tk6);
    // (vii) 后端这次没读到令牌，但本机缓存里有以前刮过的海报（车主的真实情形）：横幅是真的，但要说明「看到的是缓存」
    fs.cpSync(scrDir, path.join(tmp, 'scrape4'), { recursive: true });
    const be4 = await startBackend({ IV_CONFIG: path.join(tmp, 'cfg4.json'), IV_SCRAPE_DIR: path.join(tmp, 'scrape4'), TMDB_TOKEN: '', TMDB_API_BASE: apiBase, TMDB_IMAGE_BASE: imgBase });
    await openWall(cdp, +be4.m[1], media);
    const tk7 = await cdp.eval(`await __wait(1500); const o = (() => { ${bannerState} })(); o.imgs = document.querySelectorAll('#wallGrid .wc img').length; return o;`);
    be4.proc.kill();
    check('后端没读到令牌但缓存里有海报：海报照常显示，横幅说明「来自本机缓存、后端这次没读到令牌」', tk7.on && tk7.imgs >= 3 && /本机缓存/.test(tk7.text) && /还没有配置/.test(tk7.text) && /未配置令牌/.test(tk7.stats), tk7);

    log('\n[9] 未配置令牌：中文说明、不联网、仍可浏览');
    const fakeBefore = await new Promise((res) => http.get(apiBase.replace(/\/3$/, '') + '/__none', (r) => { r.resume(); res(1); }).on('error', () => res(0)));
    void fakeBefore;
    be2 = await startBackend({ IV_CONFIG: path.join(tmp, 'cfg2.json'), IV_SCRAPE_DIR: path.join(tmp, 'scrape2'), TMDB_TOKEN: '', TMDB_API_BASE: apiBase, TMDB_IMAGE_BASE: imgBase });
    const n2 = await openWall(cdp, +be2.m[1], media);
    await sleep(800);
    const nt = await cdp.eval(`return { notice: document.querySelector('#wallNotice').textContent, on: document.querySelector('#wallNotice').classList.contains('on'),
      cards: ${cards}, stats: document.querySelector('#wallStats').textContent, inputs: document.querySelectorAll('#wallPane input[type=password], #wallPane input[placeholder*="令牌"], #wallPane input[placeholder*="token" i]').length };`);
    check('提示块出现，含设置用户级环境变量的命令与「重启后端」', nt.on && /TMDB_TOKEN/.test(nt.notice) && /SetEnvironmentVariable/.test(nt.notice) && /重新启动后端/.test(nt.notice), nt.notice);
    check('仍显示 7 张按文件名解析的卡片（无海报）', n2 === 7 && nt.cards.every(c => !c.img), nt.cards);
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
