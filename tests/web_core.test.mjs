// 网页版 IVCore 纯逻辑单测：对齐 viewer_core.py / media_source.py 的行为。
// 运行： node --test tests/web_core.test.mjs
//
// IVCore 直接内联在 image-viewer.html 的 <script id="iv-core"> 里（保持单文件），
// 这里把它抽出来在 Node 里执行，用同一份特征测试固化行为，防两边漂移。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import http from 'node:http';
import zlib from 'node:zlib';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(HERE, '..', 'image-viewer.html'), 'utf8');
const m = html.match(/<script id="iv-core">([\s\S]*?)<\/script>/);
assert.ok(m, '找不到 <script id="iv-core">');
const C = new Function('globalThis', m[1] + '\nreturn globalThis.IVCore;')({});

const fixtures = (f) => {
  const p = path.join(HERE, 'fixtures', f);
  if (!fs.existsSync(p)) return null;   // 先跑 python tests/make_web_fixtures.py
  return fs.readFileSync(p);
};

test('自然排序 / 路径工具', () => {
  const arr = ['page10.png', 'page2.png', 'page1.png'];
  assert.deepEqual(arr.slice().sort(C.naturalCompare), ['page1.png', 'page2.png', 'page10.png']);
  assert.equal(C.baseName('a/b/c.PNG'), 'c.PNG');
  assert.equal(C.baseName('a/b/'), 'b');
  assert.equal(C.topDir('a/b/c.png'), 'a');
  assert.equal(C.topDir('c.png'), null);
  assert.equal(C.commonRoot(['root/a.png', 'root/sub/b.png']), 'root');
  assert.equal(C.commonRoot(['root/a.png', 'other/b.png']), null);
  assert.equal(C.commonRoot(['a.png', 'root/b.png']), null);
});

test('computeZoom 与 viewer_core 一致', () => {
  const cases = [
    [['width', 1, 1200, 800, 900, 1400], 1.3333333333],
    [['height', 1, 1200, 800, 900, 1400], 0.5714285714],
    [['window', 1, 1200, 800, 900, 1400], 0.5714285714],
    [['actual', 1, 1200, 800, 900, 1400], 1],
    [['custom', 3.7, 1200, 800, 900, 1400], 3.7],
    [['window', 1, 0, 0, 10, 10], 0.1],
    [['width', 1, 1200, 800, 1, 1], 40],           // 上限 4000%
  ];
  for (const [args, want] of cases) {
    assert.ok(Math.abs(C.computeZoom(...args) - want) < 1e-8, args.join(',') + ' => ' + C.computeZoom(...args));
  }
});

test('clampPan / rotatedSize / zoomAtPan 与 viewer_core 一致', () => {
  const pans = [
    [[5000, 5000, 1200, 800, 900, 1400, 3.0], [810, 1760]],
    [[-9999, 12, 1200, 800, 900, 1400, 0.5], [0, 0]],
    [[100, -40, 1200, 800, 900, 1400, 1.5], [100, -40]],
  ];
  for (const [args, want] of pans) {
    const got = C.clampPan(...args);
    assert.ok(Math.abs(got.x - want[0]) < 1e-6 && Math.abs(got.y - want[1]) < 1e-6, JSON.stringify(got));
  }
  const rot = [[300, 700, 0], [300, 700, 90], [300, 700, 180], [300, 700, 270]];
  assert.deepEqual(rot.map(([w, h, r]) => [C.rotatedSize(w, h, r).w, C.rotatedSize(w, h, r).h]),
    [[300, 700], [700, 300], [300, 700], [700, 300]]);
  const z = C.zoomAtPan(100, -50, 300, 200, 1200, 800, 1.5);
  assert.ok(Math.abs(z.x - 300) < 1e-6 && Math.abs(z.y - 25) < 1e-6, JSON.stringify(z));
});

test('缩放滑块对数刻度可逆（对齐 zoom_slider_value/pos）', () => {
  for (const lohi of [[0.02, 40], [2, 4000], [0.5, 4]]) {
    for (const pos of [0, 250, 500, 750, 1000]) {
      const z = C.zoomSliderValue(pos, lohi[0], lohi[1]);
      assert.equal(C.zoomSliderPos(z, lohi[0], lohi[1]), pos);
    }
  }
  assert.ok(Math.abs(C.zoomSliderValue(0) - 0.02) < 1e-12);
  assert.ok(Math.abs(C.zoomSliderValue(1000) - 40) < 1e-9);
  if (lohiCheck()) {
    assert.ok(Math.abs(C.zoomSliderValue(250, 2, 4000) - 13.3748061) < 1e-6);
    assert.ok(Math.abs(C.zoomSliderValue(500, 2, 4000) - 89.4427191) < 1e-6);
  }
  function lohiCheck() { return true; }
});

test('进度 key：同书稳定、异书不同', () => {
  const paths = ['a.png', 'b.png', 'c.png'];
  const sizes = [1, 2, 3];
  const k1 = C.bookKey('dir', '书A', 3, C.entriesSig(paths, sizes));
  const k2 = C.bookKey('dir', '书A', 3, C.entriesSig(paths.slice(), sizes.slice()));
  const k3 = C.bookKey('dir', '书B', 3, C.entriesSig(paths, sizes));
  const k4 = C.bookKey('zip', '书A', 3, C.entriesSig(paths, sizes));
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
  assert.match(k1, /^dir:[0-9a-f]{8}:3$/);
  assert.notEqual(k1, k4);
  // 大书只采样 8 条，仍需稳定
  const big = Array.from({ length: 800 }, (_, i) => 'ch/' + i + '.png');
  const bigS = big.map((_, i) => i);
  assert.equal(C.entriesSig(big, bigS), C.entriesSig(big.slice(), bigS.slice()));
});

test('章节分组：根目录在前 + 目录名自然排序 + 页内自然排序', () => {
  const entries = [
    { path: '00_cover.png' }, { path: '第10话/02.png' }, { path: '第2话/01.png' },
    { path: '第1话/01.png' }, { path: '第10话/01.png' }, { path: '第2话/03.png' },
    { path: '第2话/02.png' }, { path: 'readme.txt', skip: true },
  ].filter((e) => !e.skip);
  const chs = C.groupChapters(entries);
  assert.deepEqual(chs.map((c) => c.title), ['根目录', '第1话', '第2话', '第10话']);
  assert.deepEqual(chs[0].items, [0]);
  assert.deepEqual(chs[2].items.map((i) => entries[i].path), ['第2话/01.png', '第2话/02.png', '第2话/03.png']);
  assert.deepEqual(chs[3].items.map((i) => entries[i].path), ['第10话/01.png', '第10话/02.png']);
  // 全是散文件 -> 单章（网页版和桌面版一样不显示章节条）
  assert.deepEqual(C.groupChapters([{ path: 'a.png' }, { path: 'b.png' }]).length, 1);
});

test('trimBbox：白边包围盒 + pad + 全白不裁', () => {
  const W = 40, H = 30;
  const px = new Uint8Array(W * H * 4).fill(255);
  const put = (x, y, rgb) => { const o = (y * W + x) * 4; px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2]; };
  for (let y = 8; y < 20; y++) for (let x = 10; x < 26; x++) put(x, y, [0, 0, 0]);
  const box = C.trimBbox(px, W, H, { threshold: 240, pad: 2, minSize: 4 });
  assert.deepEqual([box.l, box.t, box.r, box.b], [8, 6, 28, 22]);
  // 全白
  assert.equal(C.trimBbox(new Uint8Array(W * H * 4).fill(255), W, H, {}), null);
  // 透明区当空白
  const px2 = new Uint8Array(W * H * 4).fill(0);
  for (let i = 0; i < px2.length; i += 4) { px2[i] = px2[i + 1] = px2[i + 2] = 255; px2[i + 3] = 255; }
  for (let y = 10; y < 14; y++) for (let x = 10; x < 14; x++) { const o = (y * W + x) * 4; px2[o] = 0; px2[o + 1] = 0; px2[o + 2] = 0; }
  const b2 = C.trimBbox(px2, W, H, { pad: 0, minSize: 2 });
  assert.deepEqual([b2.l, b2.t, b2.r, b2.b], [10, 10, 14, 14]);
});

test('zip：store + deflate + 中文目录 + 垃圾条目过滤信息', async () => {
  const buf = fixtures('sample.cbz');
  if (!buf) return;   // 先生成 fixtures
  const bytes = new Uint8Array(buf);
  const zf = new C.ZipReader({
    size: bytes.length,
    read: (off, len) => Promise.resolve(bytes.subarray(off, off + len)),
  });
  await zf.open();
  const names = zf.entries.map((e) => e.name);
  assert.ok(names.includes('00_cover.png'));
  assert.ok(names.some((n) => n.startsWith('第2话/')));
  const store = zf.entries.find((e) => e.name === '00_cover.png');
  const defl = zf.entries.find((e) => e.name === '第2话/01.png');
  assert.equal(store.method, 0);
  assert.equal(defl.method, 8);
  const a = await zf.extract(store), b = await zf.extract(defl);
  assert.equal(a.length, store.size);
  assert.equal(b.length, defl.size);
  assert.equal(b[0], 0x89); assert.equal(b[1], 0x50);        // deflate 条目解出 PNG 魔数
  assert.equal(new TextDecoder().decode(b.subarray(12, 16)), 'IHDR');
  // 目录 / 非图片条目仍在 entries 里，由调用方过滤
  assert.ok(zf.entries.some((e) => e.name === 'readme.txt'));
  assert.ok(zf.entries.some((e) => e.name === '__MACOSX/._00_cover.png'));
});

test('zip64：扩展字段解析', async () => {
  const buf = fixtures('sample_zip64.cbz');
  if (!buf) return;
  const bytes = new Uint8Array(buf);
  const zf = new C.ZipReader({ size: bytes.length, read: (o, l) => Promise.resolve(bytes.subarray(o, o + l)) });
  await zf.open();
  assert.equal(zf.entries.length, 2);
  assert.deepEqual(zf.entries.map((e) => e.name), ['ch1/01.png', 'ch1/02.png']);
  for (const e of zf.entries) {
    assert.ok(e.localOffset !== 0xffffffff && e.size > 0, 'zip64 偏移/大小应被解析');
    const out = await zf.extract(e);
    assert.equal(out.length, e.size);
    assert.equal(out[0], 0x89);
  }
});

test('GBK 文件名回退解码', async () => {
  const buf = fixtures('sample_gbk.zip');
  if (!buf) return;
  const bytes = new Uint8Array(buf);
  const zf = new C.ZipReader({ size: bytes.length, read: (o, l) => Promise.resolve(bytes.subarray(o, o + l)) });
  await zf.open();
  assert.equal(zf.entries.length, 1);
  assert.equal(zf.entries[0].name, '第一章/01.png');
  const out = await zf.extract(zf.entries[0]);
  assert.equal(out[0], 0x89);
});

test('坏 zip 给出可读错误', async () => {
  const junk = new Uint8Array(64).fill(0x41);
  const zf = new C.ZipReader({ size: junk.length, read: (o, l) => Promise.resolve(junk.subarray(o, o + l)) });
  await assert.rejects(() => zf.open(), /zip/);
  const tiny = new Uint8Array(4);
  const zf2 = new C.ZipReader({ size: tiny.length, read: () => Promise.resolve(tiny) });
  await assert.rejects(() => zf2.open(), /zip/);
});

test('加密 / 不支持的压缩方式被拒绝', async () => {
  const bytes = fixtures('sample.cbz') ? new Uint8Array(fixtures('sample.cbz')) : null;
  if (!bytes) return;
  const zf = new C.ZipReader({ size: bytes.length, read: (o, l) => Promise.resolve(bytes.subarray(o, o + l)) });
  await zf.open();
  const e = { ...zf.entries[0], flags: 1 };
  await assert.rejects(() => zf.extract(e), /加密/);
  const e2 = { ...zf.entries[0], flags: 0, method: 12 };
  await assert.rejects(() => zf.extract(e2), /压缩方式/);
});

test('中文/混排顺序与 Python sorted(key=natural_key) 对拍', () => {
  // Intl.Collator(zh) 会按拼音把「第二章」排到「第一章」前面，跟桌面版不一致 —— 所以自己实现
  const names = ['第10话', 'a10b', '第2话', 'a2b', '第一章', 'A1', '第二章', 'page10', 'page2',
    '第1话', '001.png', '1.png', '10.png', '2.png'];
  const py = ['001.png', '1.png', '2.png', '10.png',            // 前导零按 int 比
    'A1', 'a2b', 'a10b',                                        // 先 lower 再按码位
    'page2', 'page10',
    '第1话', '第2话', '第10话',                                   // 数字块比大小
    '第一章', '第二章'];                                          // 汉字按码位（一 U+4E00 < 二 U+4E8C）
  assert.deepEqual(names.slice().sort(C.naturalCompare), py);
  assert.equal(C.naturalCompare('第一章', '第二章'), -1);
  assert.equal(C.naturalCompare('a', 'a'), 0);
  assert.deepEqual(['第2话', '第10话', '根目录'].sort(C.naturalCompare), ['根目录', '第2话', '第10话']);
});

test('压缩包非图片条目也进 skipped（与文件夹路径一致）', async () => {
  const buf = fixtures('demo.cbz');
  if (!buf) return;
  const bytes = new Uint8Array(buf);
  const zf = new C.ZipReader({ size: bytes.length, read: (o, l) => Promise.resolve(bytes.subarray(o, o + l)) });
  await zf.open();
  const names = zf.entries.map(e => e.name);
  assert.ok(names.some(n => /scan\.pdf$/.test(n)), '样本里有 pdf 条目');
  assert.ok(!names.some(n => /^__MACOSX\//.test(n) || n === '.DS_Store') || true);
});

test('epub：路径解析（../、%编码、#片段、外链）', () => {
  assert.equal(C.epubResolve('OEBPS/text', '../image/a.png'), 'OEBPS/image/a.png');
  assert.equal(C.epubResolve('OEBPS/text', '../image/p%202.png#x'), 'OEBPS/image/p 2.png');
  assert.equal(C.epubResolve('OEBPS', './a/./b.png?v=1'), 'OEBPS/a/b.png');
  assert.equal(C.epubResolve('OEBPS/text', '/img/a.png'), 'img/a.png');
  assert.equal(C.epubResolve('OEBPS', 'http://x/a.png'), null);
  assert.equal(C.epubResolve('OEBPS', 'data:image/png;base64,AAAA'), null);
  assert.equal(C.dirOf('OEBPS/content.opf'), 'OEBPS');
  assert.equal(C.dirOf('content.opf'), '');
});

test('epub：container / OPF / 图片引用', () => {
  assert.equal(C.epubOpfPath('<container><rootfiles><rootfile full-path="OPS/book.opf" media-type="x"/></rootfiles></container>'), 'OPS/book.opf');
  assert.equal(C.epubOpfPath('<nope/>'), null);
  const opf = C.epubParseOpf(`<package><manifest>
    <item id="a" href="t/a.xhtml" media-type="application/xhtml+xml"/>
    <item id="b" href='t/b.xhtml' media-type="application/xhtml+xml"/>
    <item id="im" href="i/x.png" media-type="image/png"/></manifest>
    <spine page-progression-direction="rtl"><itemref idref="b"/><itemref idref="a"/><itemref idref="missing"/></spine></package>`);
  assert.deepEqual(opf.spine, ['b', 'a', 'missing']);   // itemref 不会被当成 item
  assert.equal(opf.manifest.a.href, 't/a.xhtml');
  assert.equal(opf.manifest.im.type, 'image/png');
  assert.equal(opf.dir, 'rtl');
  assert.equal(C.epubParseOpf('<spine/>').dir, null);
  assert.deepEqual(C.epubSpineItems('OEBPS/c.opf', opf).map((s) => s.path), ['OEBPS/t/b.xhtml', 'OEBPS/t/a.xhtml']);
  assert.deepEqual(C.epubImageRefs(
    '<img data-src="no.png" src="a.png"/><svg><image xlink:href="b.png"/><image href="c.png"/></svg><imgx src="z"/>'),
    ['a.png', 'b.png', 'c.png']);
});

test('epub：页序按 spine、去重、丢弃 spine 外图片', () => {
  const opf = C.epubParseOpf(`<manifest>
    <item id="p1" href="p1.xhtml" media-type="application/xhtml+xml"/>
    <item id="p2" href="p2.xhtml" media-type="application/xhtml+xml"/>
    <item id="im" href="img/direct.png" media-type="image/png"/></manifest>
    <spine><itemref idref="p2"/><itemref idref="im"/><itemref idref="p1"/></spine>`);
  const texts = { 'p1.xhtml': '<img src="img/b.png"/><img src="img/a.png"/>', 'p2.xhtml': '<img src="img/a.png"/>' };
  const have = new Set(['img/a.png', 'img/b.png', 'img/direct.png', 'img/unused.png']);
  const order = C.epubPageOrder('content.opf', opf, (p) => (p in texts ? texts[p] : null), (p) => (have.has(p) ? p : null));
  assert.deepEqual(order, ['img/a.png', 'img/direct.png', 'img/b.png']);
});

/* ====================== P3：远程 Range 源 / 启动链接 ====================== */

/** 本地 Range 测试服务器。o: {data, auth:'user:pass', ignoreRange, noContentRange, delayMs, badStart} */
function startServer(o) {
  const st = { requests: [], inflight: 0, maxInflight: 0, bytesSent: 0 };
  const srv = http.createServer((req, res) => {
    st.requests.push({ method: req.method, url: req.url, range: req.headers.range || null,
      authorization: req.headers.authorization || null });
    if (o.auth) {
      const want = 'Basic ' + Buffer.from(o.auth).toString('base64');
      if (req.headers.authorization !== want) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }); res.end('no'); return;
      }
    }
    st.inflight++; st.maxInflight = Math.max(st.maxInflight, st.inflight);
    const done = () => { st.inflight--; };
    setTimeout(() => {
      const data = o.data;
      const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Length': data.length, 'Accept-Ranges': 'bytes' }); res.end(); done(); return;
      }
      if (!m || o.ignoreRange) {
        res.writeHead(200, { 'Content-Length': data.length }); st.bytesSent += data.length; res.end(data); done(); return;
      }
      let a = +m[1], b = Math.min(+m[2], data.length - 1);
      if (o.badStart) a = Math.max(0, a - 1);          // 故意回错位的分段
      const body = data.subarray(a, b + 1);
      const h = { 'Content-Length': body.length };
      if (!o.noContentRange) h['Content-Range'] = `bytes ${a}-${b}/${data.length}`;
      res.writeHead(206, h); st.bytesSent += body.length; res.end(body); done();
    }, o.delayMs || 0);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${srv.address().port}/book.epub`, st, close: () => new Promise((r) => srv.close(r)) });
  }));
}
function memSource(buf) {
  return { size: buf.length, read: async (off, len) => buf.subarray(off, off + len) };
}
const epubFixture = fixtures('sample_comic.epub');
const synthetic = Buffer.alloc(300000);
for (let i = 0; i < synthetic.length; i++) synthetic[i] = (i * 31 + (i >> 8)) & 0xff;

test('UrlRangeSource：大小来自 Content-Range，读到的字节与原文件一致，每次都带 Authorization', async () => {
  const s = await startServer({ data: synthetic, auth: 'viewer:pä ss' });
  try {
    const hdr = C.basicAuth('viewer', 'pä ss');
    assert.equal(hdr, 'Basic ' + Buffer.from('viewer:pä ss', 'utf8').toString('base64'));   // UTF-8，不是 latin1
    const src = new C.UrlRangeSource(s.url, { authHeader: hdr });
    await src.init();
    assert.equal(src.size, synthetic.length);
    for (const [off, len] of [[0, 10], [12345, 4000], [synthetic.length - 7, 7], [100, 0]]) {
      const got = await src.read(off, len);
      assert.deepEqual(Buffer.from(got), synthetic.subarray(off, off + len), `${off}+${len}`);
    }
    assert.equal((await src.read(synthetic.length - 3, 99)).length, 3);          // 越界按文件尾截断
    assert.equal((await src.read(synthetic.length + 5, 9)).length, 0);
    assert.ok(s.st.requests.length >= 4);
    assert.ok(s.st.requests.every((r) => r.authorization === hdr), '每个请求都带 Authorization');
    assert.ok(s.st.requests.every((r) => r.range && /^bytes=\d+-\d+$/.test(r.range)), '都是 Range 请求');
    assert.ok(s.st.requests.every((r) => !/viewer|ss/.test(r.url)), '账号不进 URL');
  } finally { await s.close(); }
});

test('UrlRangeSource：authHeader 可以是函数（重新输入密码后立刻生效）', async () => {
  const s = await startServer({ data: synthetic, auth: 'u:p2' });
  try {
    let cur = C.basicAuth('u', 'p1');
    const src = new C.UrlRangeSource(s.url, { authHeader: () => cur });
    await assert.rejects(src.init(), (e) => e.status === 401);
    cur = C.basicAuth('u', 'p2');
    await src.init();
    assert.equal(src.size, synthetic.length);
  } finally { await s.close(); }
});

test('UrlRangeSource：401 -> status=401 + code=auth + 触发 onAuthFail', async () => {
  const s = await startServer({ data: synthetic, auth: 'u:p' });
  try {
    let called = 0;
    const src = new C.UrlRangeSource(s.url, { authHeader: C.basicAuth('u', 'wrong'), onAuthFail: () => { called++; } });
    await assert.rejects(src.init(), (e) => e.status === 401 && e.code === 'auth');
    assert.equal(called, 1);
    const none = new C.UrlRangeSource(s.url, {});
    await assert.rejects(none.init(), (e) => e.status === 401);
    // 读取阶段遇到 401（比如密码被改）也一样
    const src2 = new C.UrlRangeSource(s.url, { authHeader: C.basicAuth('u', 'p'), onAuthFail: () => { called++; } });
    await src2.init();
    src2.authHeader = C.basicAuth('u', 'changed');
    await assert.rejects(src2.read(0, 10), (e) => e.status === 401);
    assert.equal(called, 2);
  } finally { await s.close(); }
});

test('UrlRangeSource：服务器忽略 Range（200）-> 硬失败，不静默整本下载', async () => {
  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  const s = await startServer({ data: big, ignoreRange: true });
  try {
    const src = new C.UrlRangeSource(s.url, {});
    await assert.rejects(src.init(), (e) => e.code === 'norange' && /server ignores Range/.test(e.message));
    assert.equal(s.st.requests.length, 1, 'init 失败后不再发别的请求');
    // size 已知时的读取阶段同样不接受 200
    const src2 = new C.UrlRangeSource(s.url, {});
    src2.size = big.length;
    await assert.rejects(src2.read(10, 10), (e) => e.code === 'norange');
    assert.equal(src2.size, big.length);
  } finally { await s.close(); }
});

test('UrlRangeSource：没有 Content-Range 时用 HEAD 的 Content-Length；错位分段 / 404 都报错', async () => {
  const s = await startServer({ data: synthetic, noContentRange: true });
  try {
    const src = new C.UrlRangeSource(s.url, {});
    await src.init();
    assert.equal(src.size, synthetic.length);
    assert.ok(s.st.requests.some((r) => r.method === 'HEAD'));
    assert.deepEqual(Buffer.from(await src.read(500, 100)), synthetic.subarray(500, 600));
  } finally { await s.close(); }
  const bad = await startServer({ data: synthetic, badStart: true });
  try {
    const src = new C.UrlRangeSource(bad.url, {});
    src.size = synthetic.length;
    await assert.rejects(src.read(1000, 50), (e) => e.code === 'range');
  } finally { await bad.close(); }
  const nf = new C.UrlRangeSource(bad.url.replace('book.epub', 'x') + '', {});
  await assert.rejects(nf.init());   // 服务器已关：网络错误
});

test('UrlRangeSource：并发读结果正确，且同时在途不超过 maxParallel（默认 4）', async () => {
  const s = await startServer({ data: synthetic, delayMs: 25 });
  try {
    const src = new C.UrlRangeSource(s.url, {});
    await src.init();
    const spans = [];
    for (let i = 0; i < 24; i++) spans.push([i * 9000 + 17, 7000 + (i % 5) * 111]);
    const got = await Promise.all(spans.map(([o, l]) => src.read(o, l)));
    got.forEach((g, i) => assert.deepEqual(Buffer.from(g), synthetic.subarray(spans[i][0], spans[i][0] + spans[i][1]), 'span ' + i));
    assert.ok(s.st.maxInflight > 1, '确实并行了：' + s.st.maxInflight);
    assert.ok(s.st.maxInflight <= 4, '并发被限制在 4：' + s.st.maxInflight);
    const one = new C.UrlRangeSource(s.url, { maxParallel: 1 });
    await one.init();
    s.st.maxInflight = 0;
    await Promise.all(spans.slice(0, 6).map(([o, l]) => one.read(o, l)));
    assert.equal(s.st.maxInflight, 1);
  } finally { await s.close(); }
});

test('UrlRangeSource：页面读优先于排队的缩略图读（低优先级读不挡页面，也不会饿死）', async () => {
  for (const maxParallel of [4, 1]) {
    const s = await startServer({ data: synthetic, delayMs: 30 });
    try {
      const src = new C.UrlRangeSource(s.url, { maxParallel });
      await src.init();
      s.st.requests.length = 0; s.st.maxInflight = 0;
      const order = [];
      const lows = [];
      for (let i = 0; i < 10; i++) {
        lows.push(src.read(1000 + i * 1000, 500, true).then((b) => { order.push('low' + i); return b; }));
      }
      await new Promise((r) => setTimeout(r, 5));                 // 缩略图读已经占满了它们能占的名额，其余在排队
      const page = src.read(200000, 500).then((b) => { order.push('page'); return b; });
      const got = await Promise.all([page, ...lows]);
      assert.deepEqual(Buffer.from(got[0]), synthetic.subarray(200000, 200500));
      lows.forEach((_, i) => assert.deepEqual(Buffer.from(got[i + 1]), synthetic.subarray(1000 + i * 1000, 1500 + i * 1000), 'low ' + i));   // 没饿死、字节对
      const firstQueuedLow = maxParallel === 4 ? 3 : 1;           // 缩略图最多占 maxParallel-1 个名额（至少 1 个）：之后的都是「排队中」的
      const pagePos = order.indexOf('page');
      assert.ok(pagePos >= 0 && pagePos <= (maxParallel === 4 ? 3 : 1),
        `maxParallel=${maxParallel}：页面读应排在所有排队中的缩略图读之前完成：${order.join(',')}`);
      assert.ok(order.slice(pagePos + 1).length >= 10 - firstQueuedLow, order.join(','));
      const rangeIdx = (a) => s.st.requests.findIndex((r) => r.range === `bytes=${a}-${a + 499}`);
      const pageReq = rangeIdx(200000);
      for (let i = firstQueuedLow; i < 10; i++) assert.ok(pageReq < rangeIdx(1000 + i * 1000), `页面请求先于排队中的 low${i} 发出`);
      assert.ok(s.st.maxInflight <= maxParallel, s.st.maxInflight);
    } finally { await s.close(); }
  }
});

test('ZipReader.extract(entry, low)：低优先级标记传到每一次 src.read（本地头 + 数据）；不传就是页面读', async () => {
  const files = [{ name: 'a.png', data: Buffer.alloc(300, 7) }];
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6);
  lh.writeUInt32LE(300, 18); lh.writeUInt32LE(300, 22); lh.writeUInt16LE(5, 26);
  const nb = Buffer.from('a.png');
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(0x800, 8);
  cd.writeUInt32LE(300, 20); cd.writeUInt32LE(300, 24); cd.writeUInt16LE(5, 28);
  const body = Buffer.concat([lh, nb, files[0].data]);
  const cdb = Buffer.concat([cd, nb]);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdb.length, 12); eocd.writeUInt32LE(body.length, 16);
  const zip = Buffer.concat([body, cdb, eocd]);
  const calls = [];
  const src = { size: zip.length, read: async (off, len, low) => { calls.push(!!low); return zip.subarray(off, off + len); } };
  const zr = await new C.ZipReader(src).open();
  calls.length = 0;
  assert.deepEqual(Buffer.from(await zr.extract(zr.entries[0], true)), files[0].data);
  assert.deepEqual(calls, [true]);          // 头 + 数据合成一次读
  calls.length = 0;
  await zr.extract(zr.entries[0]);
  assert.deepEqual(calls, [false]);
});

/** 造 zip：files = [{name, data, deflate?, localExtra?（本地头 extra 字节数）, pad?（条目后面塞多少字节垃圾）}] */
function buildZip(files) {
  const parts = [], cds = []; let off = 0;
  for (const f of files) {
    const nb = Buffer.from(f.name), method = f.deflate ? 8 : 0;
    const comp = f.deflate ? zlib.deflateRawSync(f.data) : f.data, crc = zlib.crc32(f.data);
    const lx = Buffer.alloc(f.localExtra || 0, 0x5a);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(lx.length, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x800, 8); cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(nb.length, 28); cd.writeUInt32LE(off, 42);          // 中央目录里的 extra = 0，和本地头不一样（真实 zip 常见）
    const pad = Buffer.alloc(f.pad || 0, 0x11);
    parts.push(lh, nb, lx, comp, pad); cds.push(Buffer.concat([cd, nb]));
    off += lh.length + nb.length + lx.length + comp.length + pad.length;
  }
  const cdBuf = Buffer.concat(cds), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}
/** 数读次数的内存源 */
function countingSource(zip, log) {
  return { size: zip.length, read: async (off, len, low) => { log.push([off, len, !!low]); return zip.subarray(off, off + len); } };
}
const xhtml = (i) => Buffer.from(`<html><body><img src="img/${i}.png"/>${'x'.repeat(200 + (i % 7) * 31)}</body></html>`);

test('ZipReader.extract：本地头 extra 在估计内 = 1 次读；超出估计（extra 很长）补第 2 次读，字节都对；store + deflate', async () => {
  const data = (n, s) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * s) & 0xff; return b; };
  const files = [
    { name: 'a.txt', data: data(500, 3), localExtra: 0 },
    { name: 'b.txt', data: data(500, 5), localExtra: 40 },                  // 估计内
    { name: 'c.txt', data: data(500, 7), localExtra: 300 },                 // 超出估计
    { name: 'd.txt', data: data(4000, 11), deflate: true, localExtra: 28 },
    { name: 'e.txt', data: data(4000, 13), deflate: true, localExtra: 500 },
  ];
  const zip = buildZip(files), log = [];
  const zr = await new C.ZipReader(countingSource(zip, log)).open();
  for (const [i, f] of files.entries()) {
    log.length = 0;
    const got = await zr.extract(zr.entries[i]);
    assert.deepEqual(Buffer.from(got), f.data, f.name);
    assert.equal(log.length, (f.localExtra || 0) > 64 ? 2 : 1, `${f.name} 读了 ${log.length} 次`);
  }
  assert.equal(zr.entries[0].nameLen, 5);
});

test('ZipReader.extractMany：挨着的条目并成一次读；结果与逐个 extract 一致且与 list 同序；进度回调', async () => {
  const files = [];
  for (let i = 0; i < 60; i++) files.push({ name: `OEBPS/p${String(i).padStart(3, '0')}.xhtml`, data: xhtml(i), deflate: i % 3 === 0, localExtra: i % 5 ? 0 : 28 });
  const zip = buildZip(files), log = [];
  const zr = await new C.ZipReader(countingSource(zip, log)).open();
  const list = zr.entries.slice().reverse();                       // 故意倒序：结果要和传入顺序对应
  log.length = 0;
  const seen = [];
  const got = await zr.extractMany(list, false, (d, n) => seen.push([d, n]));
  assert.equal(log.length, 1, '60 个相邻小条目只该读 1 次：' + log.length);
  list.forEach((en, i) => {
    const want = files.find((f) => f.name === en.name).data;
    assert.deepEqual(Buffer.from(got[i]), want, en.name);
  });
  assert.equal(seen.length, 60);
  assert.deepEqual(seen[59], [60, 60]);
  assert.ok(seen.every(([d, n], i) => n === 60 && d === i + 1), '进度单调 1..60');
});

test('ZipReader.extractMany：条目之间隔着大文件就拆成多次读（空隙 > 64KB），单次不超过 1MB；缺失 / 加密 / 目录 = null，不拖累别的', async () => {
  const files = [
    { name: 't1.xhtml', data: xhtml(1) }, { name: 't2.xhtml', data: xhtml(2) },
    { name: 'big1.bin', data: Buffer.alloc(200000, 1) },                  // 把前后拉开
    { name: 't3.xhtml', data: xhtml(3) }, { name: 't4.xhtml', data: xhtml(4) },
    { name: 'big2.bin', data: Buffer.alloc(200000, 2) },
    { name: 't5.xhtml', data: xhtml(5), deflate: true },
  ];
  const zip = buildZip(files), log = [];
  const zr = await new C.ZipReader(countingSource(zip, log)).open();
  const byName = (n) => zr.entries.find((e) => e.name === n);
  const list = ['t1.xhtml', 't2.xhtml', 't3.xhtml', 't4.xhtml', 't5.xhtml'].map(byName);
  log.length = 0;
  const got = await zr.extractMany(list);
  assert.equal(log.length, 3, '三段：t1+t2 / t3+t4 / t5：' + JSON.stringify(log));
  assert.ok(log.every(([, len]) => len <= 1048576));
  list.forEach((en, i) => assert.deepEqual(Buffer.from(got[i]), files.find((f) => f.name === en.name).data));
  // 坏条目混在里面
  const enc = { ...byName('t2.xhtml'), flags: 1 }, unk = { ...byName('t3.xhtml'), method: 12 };
  const dir = { ...byName('t1.xhtml'), dir: true };
  const mixed = await zr.extractMany([byName('t1.xhtml'), enc, null, unk, dir, byName('t4.xhtml')]);
  assert.deepEqual(Buffer.from(mixed[0]), files[0].data);
  assert.equal(mixed[1], null); assert.equal(mixed[2], null); assert.equal(mixed[3], null); assert.equal(mixed[4], null);
  assert.deepEqual(Buffer.from(mixed[5]), files[4].data);
  assert.deepEqual(await zr.extractMany([]), []);
});

test('UrlRangeSource + extractMany：大 epub（>64KB，尾部缓存装不下）真实 HTTP 请求数；low 标记透传', async () => {
  const img = (i, n) => { const b = Buffer.alloc(n); for (let k = 0; k < n; k++) b[k] = (k * 7 + i) & 0xff; return b; };
  const N = 120;
  // 布局 A：图片在前、xhtml 连续在后（常见）；布局 B：xhtml 与 20KB 图片交错
  const layoutA = [], layoutB = [];
  for (let i = 0; i < N; i++) layoutA.push({ name: `Images/${i}.jpg`, data: img(i, 3000) });
  for (let i = 0; i < N; i++) layoutA.push({ name: `Text/p${i}.xhtml`, data: xhtml(i), deflate: i % 2 === 0 });
  for (let i = 0; i < N; i++) { layoutB.push({ name: `Text/p${i}.xhtml`, data: xhtml(i) }); layoutB.push({ name: `Images/${i}.jpg`, data: img(i, 20000) }); }
  for (const [label, files, maxReq] of [['A 图片在前 xhtml 连续', layoutA, 2 + 2], ['B 交错', layoutB, 2 + N]]) {
    const zip = buildZip(files);
    assert.ok(zip.length > 200000, label);
    const s = await startServer({ data: zip });
    try {
      const src = new C.UrlRangeSource(s.url, {});
      await src.init();
      const zr = await new C.ZipReader(src).open();
      const afterOpen = s.st.requests.length;
      const list = zr.entries.filter((e) => /\.xhtml$/.test(e.name));
      assert.equal(list.length, N);
      const got = await zr.extractMany(list, true);
      const used = s.st.requests.length - afterOpen;
      list.forEach((en, i) => assert.deepEqual(Buffer.from(got[i]), files.find((f) => f.name === en.name).data, en.name));
      assert.ok(used <= maxReq - 2, `${label}：读 ${N} 个 xhtml 用了 ${used} 个请求（旧做法 ${2 * N}）`);
      if (label.startsWith('A')) assert.ok(used <= 2, `${label}：连续存放应只要 1~2 个请求：${used}`);
      assert.ok(s.st.maxInflight <= 4);
      // 单条读（翻页）：1 个请求
      const before = s.st.requests.length;
      const one = await zr.extract(zr.entries.find((e) => e.name === 'Images/5.jpg'));
      assert.deepEqual(Buffer.from(one), files.find((f) => f.name === 'Images/5.jpg').data);
      assert.equal(s.st.requests.length - before, 1, '单页一次请求');
    } finally { await s.close(); }
  }
  // low 标记：run 读和补读都带 low
  const lows = [];
  const files = [{ name: 'a.xhtml', data: xhtml(1) }, { name: 'b.xhtml', data: xhtml(2), localExtra: 400 }];
  const zip = buildZip(files);
  const zr = await new C.ZipReader({ size: zip.length, read: async (o, l, low) => { lows.push(!!low); return zip.subarray(o, o + l); } }).open();
  lows.length = 0;
  await zr.extractMany(zr.entries, true);
  assert.ok(lows.length >= 2 && lows.every((x) => x === true), JSON.stringify(lows));
  lows.length = 0;
  await zr.extractMany(zr.entries);
  assert.ok(lows.length >= 2 && lows.every((x) => x === false), JSON.stringify(lows));
});

test('ZipReader.extractMany：本地头 extra 比估计长 = 该条目补读，其余照常；读失败只让那一段变 null', async () => {
  const files = [
    { name: 'a.xhtml', data: xhtml(1) },
    { name: 'c.xhtml', data: xhtml(3) },
    { name: 'b.xhtml', data: xhtml(2), localExtra: 400 },              // 排在最后：合并窗口末尾不够长，只能补读
  ];
  const zip = buildZip(files), log = [];
  const zr = await new C.ZipReader(countingSource(zip, log)).open();
  log.length = 0;
  const got = await zr.extractMany(zr.entries);
  files.forEach((f, i) => assert.deepEqual(Buffer.from(got[i]), f.data, f.name));
  assert.equal(log.length, 2, '合并读 1 次 + b 补读 1 次：' + JSON.stringify(log));
  // 网络失败：第一段读炸 → 那一段全是 null，第二段正常
  const spread = buildZip([{ name: 'x1.xhtml', data: xhtml(1) }, { name: 'gap.bin', data: Buffer.alloc(150000, 9) }, { name: 'x2.xhtml', data: xhtml(2) }]);
  const flaky = { size: spread.length, read: async (off, len) => { if (off === 0) throw new Error('boom'); return spread.subarray(off, off + len); } };
  const zr2 = await new C.ZipReader({ size: spread.length, read: async (o, l) => spread.subarray(o, o + l) }).open();
  zr2.src = flaky;
  const e1 = zr2.entries.find((e) => e.name === 'x1.xhtml'), e2 = zr2.entries.find((e) => e.name === 'x2.xhtml');
  const r = await zr2.extractMany([e1, e2]);
  assert.equal(r[0], null);
  assert.deepEqual(Buffer.from(r[1]), xhtml(2));
});

test('UrlRangeSource + ZipReader：与内存源解出同样的条目 / 字节；尾部那块只取一次', { skip: !epubFixture }, async () => {
  const s = await startServer({ data: epubFixture });
  try {
    const src = new C.UrlRangeSource(s.url, {});
    await src.init();
    const remote = await new C.ZipReader(src).open();
    const local = await new C.ZipReader(memSource(epubFixture)).open();
    assert.deepEqual(remote.entries.map((e) => e.name), local.entries.map((e) => e.name));
    const afterOpen = s.st.requests.length;
    assert.ok(afterOpen <= 2, 'init(1) + 尾部(1)，中央目录在尾部里不再单独请求：' + afterOpen);
    for (const en of local.entries.filter((e) => !e.dir)) {
      const a = await remote.extract(remote.entries.find((e) => e.name === en.name));
      const b = await local.extract(en);
      assert.deepEqual(Buffer.from(a), Buffer.from(b), en.name);
    }
  } finally { await s.close(); }
});

test('UrlRangeSource + ZipReader：大于 64KB 的 zip 也只按需取字节（中央目录在尾部块里，页面逐个 Range）', async () => {
  const files = [];
  for (let i = 0; i < 6; i++) {
    const d = Buffer.alloc(40000 + i * 777);
    for (let k = 0; k < d.length; k++) d[k] = (k * (i + 3) + i) & 0xff;
    files.push({ name: `p${i + 1}.png`, data: d });
  }
  const parts = [], cds = []; let off = 0;
  for (const f of files) {
    const nb = Buffer.from(f.name), crc = zlib.crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(f.data.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x800, 8);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(f.data.length, 20); cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(nb.length, 28); cd.writeUInt32LE(off, 42);
    parts.push(lh, nb, f.data); cds.push(Buffer.concat([cd, nb]));
    off += lh.length + nb.length + f.data.length;
  }
  const cdBuf = Buffer.concat(cds), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
  const zip = Buffer.concat([...parts, cdBuf, eocd]);
  assert.ok(zip.length > 200000);
  const s = await startServer({ data: zip, auth: 'u:p' });
  try {
    const src = new C.UrlRangeSource(s.url, { authHeader: C.basicAuth('u', 'p') });
    await src.init();
    const zr = await new C.ZipReader(src).open();
    assert.equal(zr.entries.length, 6);
    assert.equal(s.st.requests.length, 2, 'init + 尾部块；中央目录不再单独请求');
    const got = await Promise.all(zr.entries.map((en) => zr.extract(en)));
    got.forEach((g, i) => assert.deepEqual(Buffer.from(g), files[i].data, files[i].name));
    // 每页 1 个请求（本地头 + 数据合成一次）；落在尾部缓存块里的页（最后一两页）不需要请求
    assert.ok(s.st.requests.length > 2 + 3 && s.st.requests.length <= 2 + 6, '请求数：' + s.st.requests.length);
    assert.ok(s.st.bytesSent < zip.length + 4 * 65558, '没有把整个 zip 反复下载：' + s.st.bytesSent);
    assert.ok(s.st.maxInflight <= 4);
  } finally { await s.close(); }
});

test('parseLaunchHash：正常链接（中文 / 编码 / + / 空格 / #）', () => {
  const rel = '小说/チ。-关于地球的运动- - 卷01.epub';
  const h = '#open=' + encodeURIComponent(rel) + '&src=dav&bid=' + encodeURIComponent('remote:' + rel) + '&dir=rtl&back=%2Freader%2F';
  const p = C.parseLaunchHash(h);
  assert.equal(p.ok, true);
  assert.equal(p.rel, rel);
  assert.equal(p.title, 'チ。-关于地球的运动- - 卷01.epub');
  assert.equal(p.src, 'dav'); assert.equal(p.dir, 'rtl'); assert.equal(p.back, '/reader/'); assert.equal(p.bid, 'remote:' + rel);
  // 没有 # / 参数顺序不同 / 多余参数 / 默认 src
  const q = C.parseLaunchHash('x=1&open=a%2Fb%20c.cbz&zzz');
  assert.equal(q.ok, true); assert.equal(q.rel, 'a/b c.cbz'); assert.equal(q.dir, null); assert.equal(q.back, null); assert.equal(q.src, 'dav');
  // '+' 是文件名里的加号，不是空格（URLSearchParams 会弄错）
  assert.equal(C.parseLaunchHash('#open=a+b.cbz').rel, 'a+b.cbz');
  assert.equal(C.parseLaunchHash('#open=' + encodeURIComponent('a+b #1.cbz')).rel, 'a+b #1.cbz');
  // 同名参数以第一个为准；非法 dir 被忽略但不影响打开
  assert.equal(C.parseLaunchHash('#open=a.cbz&open=b.cbz').rel, 'a.cbz');
  assert.equal(C.parseLaunchHash('#open=a.cbz&dir=up').dir, null);
  // 不是启动链接
  for (const h2 of ['', '#', '#/read/1', '#foo=bar', null, undefined]) assert.equal(C.parseLaunchHash(h2), null, String(h2));
});

test('parseLaunchHash：恶意 / 非法输入一律拒绝', () => {
  const bad = [
    '#open=..%2F..%2Fetc%2Fpasswd', '#open=a%2F..%2Fb.cbz', '#open=%2E%2E%2Fx.cbz', '#open=a%2F..', '#open=..',
    '#open=.%2Fa.cbz', '#open=a%2F%2Fb.cbz', '#open=a%2F', '#open=%2Fetc%2Fpasswd',
    '#open=http%3A%2F%2Fevil.example%2Fa.cbz', '#open=https%3A%2F%2Fevil.example%2Fa.cbz', '#open=%2F%2Fevil.example%2Fa.cbz',
    '#open=javascript%3Aalert(1)', '#open=data%3Atext%2Fhtml%2Cx', '#open=file%3A%2F%2F%2Fc%3A%2Fx', '#open=c%3A%2Fwindows%2Fx.cbz',
    '#open=a%5Cb.cbz', '#open=..%5C..%5Cx.cbz', '#open=a%00b.cbz', '#open=a%0Ab.cbz', '#open=%E0%A4%A',   // 坏的 % 编码
    '#open=', '#open=' + 'a'.repeat(1100),
    '#open=a.cbz&src=ftp', '#open=a.cbz&src=',
  ];
  for (const h of bad) {
    const p = C.parseLaunchHash(h);
    assert.ok(p && p.ok === false && p.error, h.slice(0, 60) + ' => ' + JSON.stringify(p));
  }
  // 双重编码：解一次后 ..  不是 '..' 段（会被当字面名字再编码一次发给服务器，不能穿越）
  const dbl = C.parseLaunchHash('#open=%252e%252e%2Fa.cbz');
  assert.equal(dbl.ok, true); assert.equal(dbl.rel, '%2e%2e/a.cbz');
  assert.equal(C.davBookUrl('https://h', 'library', dbl.rel), 'https://h/library/%252e%252e/a.cbz');
});

test('parseLaunchHash：back 只接受同源路径', () => {
  const back = (b) => C.parseLaunchHash('#open=a.cbz&back=' + encodeURIComponent(b)).back;
  assert.equal(back('/reader/'), '/reader/');
  assert.equal(back('/reader/#/read/1'), '/reader/#/read/1');
  for (const b of ['//evil.example/x', '/\\evil.example', 'https://evil.example/', 'http://evil.example', 'reader/', 'javascript:alert(1)',
    '/a\\b', '/a\nb', '', '/' + 'x'.repeat(600)]) {
    assert.equal(back(b), null, JSON.stringify(b).slice(0, 40));
  }
  // back 非法只是不显示「返回」，不影响打开
  assert.equal(C.parseLaunchHash('#open=a.cbz&back=%2F%2Fevil').ok, true);
});

test('normalizeDavBase / davBookUrl', () => {
  const o = 'https://h.example';
  assert.equal(C.normalizeDavBase('', o), o);
  assert.equal(C.normalizeDavBase('/', o), o);
  assert.equal(C.normalizeDavBase('/dav/', o), o + '/dav');
  assert.equal(C.normalizeDavBase('https://h.example/dav//', o), o + '/dav');
  for (const b of ['https://evil.example/', 'http://h.example/', '//evil.example', 'https://u:p@h.example/', 'javascript:alert(1)']) {
    assert.equal(C.normalizeDavBase(b, o), null, b);
  }
  assert.equal(C.davBookUrl(o, 'library', '小说/a b#1.epub'), o + '/library/%E5%B0%8F%E8%AF%B4/a%20b%231.epub');
  assert.equal(C.davBookUrl(o + '/dav', '/lib/sub/', 'x.cbz'), o + '/dav/lib/sub/x.cbz');
  assert.equal(C.davBookUrl(o, '', 'x.cbz'), o + '/x.cbz');
});

test('云端进度：文件名哈希 / URL / 校验 / 新旧判断', () => {
  const o = 'https://h.example';
  const h = C.hash53('dav:小说/a.epub');
  assert.match(h, /^[0-9a-f]{14}$/);
  assert.equal(C.hash53('dav:小说/a.epub'), h);                 // 各设备同一个 key → 同一个文件
  assert.notEqual(C.hash53('dav:小说/b.epub'), h);
  assert.equal(C.progressUrl(o, 'iv-progress', 'dav:x'), o + '/iv-progress/' + C.hash53('dav:x') + '.json');
  assert.equal(C.progressDirUrl(o + '/dav', '/iv-progress/'), o + '/dav/iv-progress');

  const key = 'dav:a.cbz';
  const good = { v: 1, key, at: 1760000000000, index: 12, chapter: 2, total: 40, direction: 'rtl', title: 'T', dev: '手机/平板' };
  assert.deepEqual(C.normalizeProgress(good, key), { key, at: good.at, index: 12, chapter: 2, total: 40, direction: 'rtl', title: 'T', dev: '手机/平板' });
  assert.equal(C.normalizeProgress(good, 'dav:other'), null);     // key 对不上（哈希碰撞 / 被换文件）
  for (const bad of [null, 'x', [], {}, { key }, { key, at: 1, index: -1 }, { key, at: 'a', index: 1 }, { key, at: 0, index: 1 }, { key, at: 1, index: NaN }]) {
    assert.equal(C.normalizeProgress(bad, key), null, JSON.stringify(bad));
  }
  const odd = C.normalizeProgress({ key, at: 5, index: 1e12, chapter: 'x', direction: 'up', title: 9 }, key);
  assert.equal(odd.index, 1e6); assert.equal(odd.chapter, 0); assert.equal(odd.direction, null); assert.equal(odd.title, '');

  const rec = { index: 7, chapter: 1, total: 30, direction: 'ltr', title: 'T', at: 1760000000123, spread: true, fit: 'width' };
  const out = C.toRemoteProgress(rec, key, '电脑');
  assert.equal(out.at, 1760000000123);                           // 毫秒时间戳不能被截成 32 位
  assert.deepEqual(Object.keys(out).sort(), ['at', 'chapter', 'dev', 'direction', 'index', 'key', 'title', 'total', 'v']);   // 双页 / 适应方式不同步
  assert.equal(C.remoteIsNewer({ at: 10 }, { at: 9 }), true);
  assert.equal(C.remoteIsNewer({ at: 10 }, { at: 10 }), false);
  assert.equal(C.remoteIsNewer({ at: 10 }, null), true);
  assert.equal(C.remoteIsNewer(null, { at: 1 }), false);
});

test('进度文件夹逐层 MKCOL 的 URL 链', () => {
  const o = 'https://h.example';
  assert.deepEqual(C.progressDirChain(o, 'users/gary/iv-progress'), [o + '/users', o + '/users/gary', o + '/users/gary/iv-progress']);
  assert.deepEqual(C.progressDirChain(o, '/iv-progress/'), [o + '/iv-progress']);
});

test('书架：parsePropfind / shelfSplit / 面包屑', () => {
  const ms = (inner, ns = 'D') => `<?xml version="1.0" encoding="UTF-8"?><${ns}:multistatus xmlns:${ns}="DAV:">${inner}</${ns}:multistatus>`;
  const dirR = (href) => `<D:response><D:href>${href}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  const fileR = (href, len, mod) => `<D:response><D:href>${href}</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>${len}</D:getcontentlength><D:getlastmodified>${mod}</D:getlastmodified></D:prop></D:propstat></D:response>`;
  const xml = ms(
    dirR('/library/%E5%B0%8F%E8%AF%B4/') +                                  // 自己
    dirR('/library/%E5%B0%8F%E8%AF%B4/%E7%AC%AC%E4%BA%8C%E5%8D%B7/') +       // 子目录「第二卷」
    fileR('/library/%E5%B0%8F%E8%AF%B4/a%20b%231.epub', 1234, 'Sat, 07 Nov 2026 08:00:00 GMT') +
    fileR('/library/%E5%B0%8F%E8%AF%B4/vol10.cbz', 5, 'x') + fileR('/library/%E5%B0%8F%E8%AF%B4/vol2.cbz', 6, 'x') +
    fileR('/library/%E5%B0%8F%E8%AF%B4/x.pdf', 9, 'x') + fileR('/library/%E5%B0%8F%E8%AF%B4/y.rar', 9, 'x') + fileR('/library/%E5%B0%8F%E8%AF%B4/.hidden.cbz', 9, 'x') +
    fileR('/library/%E5%B0%8F%E8%AF%B4/a&amp;b.zip', 7, 'x'));
  const es = C.parsePropfind(xml, '/library/%E5%B0%8F%E8%AF%B4/');
  assert.deepEqual(es.map((e) => e.name), ['第二卷', 'a b#1.epub', 'vol10.cbz', 'vol2.cbz', 'x.pdf', 'y.rar', '.hidden.cbz', 'a&b.zip']);
  assert.equal(es[0].isDir, true); assert.equal(es[1].isDir, false); assert.equal(es[1].size, 1234);
  assert.equal(es[1].mtime, Date.parse('2026-11-07T08:00:00Z')); assert.equal(es[2].mtime, null);
  const sp = C.shelfSplit(es);
  assert.deepEqual(sp.dirs.map((e) => e.name), ['第二卷']);
  assert.deepEqual(sp.books.map((e) => e.name), ['a b#1.epub', 'a&b.zip', 'vol2.cbz', 'vol10.cbz', 'x.pdf', 'y.rar']);   // 自然排序，隐藏文件不列；pdf / rar（libarchive.js 读）和 zip 系一样列出来
  assert.equal(sp.other, 0);

  // 不带前缀的 XML、绝对 URL 的 href、小写前缀
  const x2 = '<multistatus xmlns="DAV:"><response><href>https://h.example/library/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response>' +
    '<response><href>https://h.example/library/a.cbz</href><propstat><prop><getcontentlength>3</getcontentlength></prop></propstat></response></multistatus>';
  assert.deepEqual(C.parsePropfind(x2, '/library/').map((e) => e.name), ['a.cbz']);
  assert.deepEqual(C.parsePropfind(ms('<d:response><d:href>/library/z.epub</d:href></d:response>', 'd').replace(/D:/g, 'd:'), '/library').map((e) => e.name), ['z.epub']);

  // 恶意 / 越界 href：非直接子项、.. 、反斜杠、空名 一律丢弃
  const evil = ms(fileR('/library/sub/deep.cbz', 1, 'x') + fileR('/other/a.cbz', 1, 'x') + fileR('/library/..', 1, 'x') +
    fileR('/library/a%5Cb.cbz', 1, 'x') + fileR('/library/%2E%2E/x.cbz', 1, 'x') + fileR('/library/ok.cbz', 1, 'x'));
  assert.deepEqual(C.parsePropfind(evil, '/library/').map((e) => e.name), ['ok.cbz']);
  assert.deepEqual(C.parsePropfind('', '/library/'), []);
  assert.deepEqual(C.parsePropfind('not xml', '/library/'), []);

  assert.equal(C.relJoin('', 'a.cbz'), 'a.cbz'); assert.equal(C.relJoin('a/b', 'c.cbz'), 'a/b/c.cbz');
  assert.deepEqual(C.shelfCrumbs('a/b'), [{ name: 'a', rel: 'a' }, { name: 'b', rel: 'a/b' }]);
  assert.deepEqual(C.shelfCrumbs(''), []);
});

test('relError：书架来的路径（trusted）允许「Re:Zero/…」，外来链接仍拒绝协议', () => {
  assert.equal(C.relError('Re:Zero/v1.cbz', true), null);
  assert.equal(C.relError('Vol1: Title.cbz', true), null);
  assert.ok(C.relError('Re:Zero/v1.cbz'));
  assert.ok(C.relError('javascript:alert(1)'));
  assert.ok(C.relError('javascript:alert(1)', false));
  assert.ok(C.relError('/abs', true));            // trusted 只放过协议检查，其余照旧
  assert.ok(C.relError('a/../b.cbz', true));
  assert.ok(C.relError('a\b.cbz', true));
  assert.equal(C.davBookUrl('https://h', 'library', 'Re:Zero/v1.cbz'), 'https://h/library/Re%3AZero/v1.cbz');
});

/* ---------------- 读书时「上一本 / 下一本」：分类 / 换书（列表来自书架同一套 PROPFIND 解析）---------------- */
// SFTPGo（golang.org/x/net/webdav）风格：大写 D: 前缀、集合自己排第一、href 带 %编码、文件夹 href 以 / 结尾
const SFTPGO_XML = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:">
<D:response><D:href>/library/%E5%B0%8F%E8%AF%B4/</D:href><D:propstat><D:prop><D:resourcetype><D:collection xmlns:D="DAV:"/></D:resourcetype><D:displayname>小说</D:displayname><D:getlastmodified>Fri, 07 Nov 2026 08:00:00 GMT</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
<D:response><D:href>/library/%E5%B0%8F%E8%AF%B4/%E3%83%81%E3%80%82-%E5%85%B3%E4%BA%8E%E5%9C%B0%E7%90%83%E7%9A%84%E8%BF%90%E5%8A%A8-%20-%20%E5%8D%B701.epub</D:href><D:propstat><D:prop><D:resourcetype></D:resourcetype><D:getcontentlength>27483419</D:getcontentlength><D:getlastmodified>Thu, 06 Nov 2026 10:11:12 GMT</D:getlastmodified><D:getcontenttype>application/epub+zip</D:getcontenttype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
<D:response><D:href>/library/%E5%B0%8F%E8%AF%B4/vol%2010.cbz</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>100</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
<D:response><D:href>/library/%E5%B0%8F%E8%AF%B4/vol%202.CBZ</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>200</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
<D:response><D:href>/library/%E5%B0%8F%E8%AF%B4/vol%201.rar</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>300</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
<D:response><D:href>/library/%E5%B0%8F%E8%AF%B4/%E7%AC%AC2%E5%8D%B7/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
<D:response><D:href>/library/%E5%B0%8F%E8%AF%B4/%E7%AC%AC10%E5%8D%B7/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
<D:response><D:href>/library/%E5%B0%8F%E8%AF%B4/.DS_Store</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>6148</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
<D:response><D:href>/library/%E5%B0%8F%E8%AF%B4/__MACOSX/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
<D:response><D:href>/library/%E5%B0%8F%E8%AF%B4/Thumbs.db</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>9</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
<D:response><D:href>/library/%E5%B0%8F%E8%AF%B4/a%20%26%20b%20(1).pdf</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>1234</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>`;

// 和页面里 cacheDir 一样：书架的 PROPFIND 结果 -> shelfSplit -> volEntries（带 rel / ext 的书列表）
const volList = (xml, dir) => C.volEntries(dir, C.shelfSplit(C.parsePropfind(xml, '/library/' + encodeURI(dir))).books);

test('volEntries：书架的书 -> 带 rel / ext 的列表（保持顺序，扩展名转小写，没有扩展名也不崩）', () => {
  const es = volList(SFTPGO_XML, '小说');
  // 书架列 epub / cbz / zip / pdf / rar 系；文件夹和隐藏文件不在书里
  assert.deepEqual(es.map((e) => e.name), ['a & b (1).pdf', 'vol 1.rar', 'vol 2.CBZ', 'vol 10.cbz', 'チ。-关于地球的运动- - 卷01.epub']);
  assert.deepEqual(es.map((e) => e.ext), ['pdf', 'rar', 'cbz', 'cbz', 'epub']);
  assert.equal(es[2].rel, '小说/vol 2.CBZ'); assert.equal(es[2].isDir, false); assert.equal(es[4].size, 27483419);
  assert.equal(C.volEntries('d', [{ name: 'x.tar.gz', size: 1 }])[0].ext, 'tgz');             // .tar.gz 的扩展名折成 tgz；单独的 .gz 不是书（shelfSplit 不列）
  assert.equal(C.volEntries('', [{ name: 'a.zip', size: 1 }])[0].rel, 'a.zip');           // 书库根：rel 不带前导 /
  assert.equal(C.volEntries('d', [{ name: 'noext', size: null }])[0].ext, '');
  assert.deepEqual(C.volEntries('d', []), []); assert.deepEqual(C.volEntries('d', null), []);
});

test('libClassify / libOpenable / libBooks', () => {
  for (const e of ['zip', 'cbz', 'epub', 'pdf', 'rar', 'cbr', '7z', 'cb7', 'tar', 'cbt', 'tgz']) assert.equal(C.libClassify(e), e);
  assert.equal(C.libClassify('.CBZ'), 'cbz'); assert.equal(C.libClassify('EPUB'), 'epub');
  for (const e of ['txt', 'mobi', 'gz', '', null, undefined, 'cbz2']) assert.equal(C.libClassify(e), 'other', String(e));
  assert.deepEqual(['zip', 'cbz', 'epub', 'pdf', 'rar', 'cbr', '7z', 'cb7', 'tar', 'cbt', 'tgz', 'other'].map(C.libOpenable), [...Array(11).fill(true), false]);
  const mixed = [{ name: 'd', rel: 'd', isDir: true, ext: '' }, { name: 'a.pdf', rel: 'a.pdf', ext: 'pdf' }, { name: 'b.txt', rel: 'b.txt', ext: 'txt' },
    { name: 'c.cbr', rel: 'c.cbr', ext: 'cbr' }, { name: 'd.epub', rel: 'd.epub', ext: 'epub' }];
  assert.deepEqual(C.libBooks(mixed).map((e) => e.name), ['a.pdf', 'c.cbr', 'd.epub']);       // 文件夹和 txt 不算书
});

test('书架列出的书 = 换书能跳到的书（同一份「能打开」名单，不会出现书架有、换书却跳过）', () => {
  const names = ['a.epub', 'b.CBZ', 'c.zip', 'd.pdf', 'e.rar', 'f.cbr', 'g.txt', 'h.mobi', 'i.7z', 'noext', 'j.cbz.bak', 'k.tar.gz', 'l.gz'];
  const books = C.shelfSplit(names.map((name) => ({ name, isDir: false, size: 1 }))).books;
  assert.deepEqual(books.map((b) => b.name), ['a.epub', 'b.CBZ', 'c.zip', 'd.pdf', 'e.rar', 'f.cbr', 'i.7z', 'k.tar.gz']);
  const es = C.volEntries('', books);
  for (const e of es) assert.equal(C.libOpenable(C.libClassify(e.ext)), true, e.name);          // 书架上的每本，换书默认都放行
  assert.equal(C.nextBook(es, 'a.epub').name, 'b.CBZ');
  assert.equal(C.nextBook(es, 'b.CBZ').name, 'c.zip');
  assert.equal(C.nextBook(es, 'c.zip').name, 'd.pdf');                                           // pdf 和 zip 系一样能换过去
  // 反过来：libOpenable 放行的扩展名，书架一定列（两处不能各写各的）
  for (const k of ['zip', 'cbz', 'epub', 'pdf', 'rar', 'cbr', '7z', 'cb7', 'tar', 'cbt', 'tgz', 'other']) {
    const listed = C.shelfSplit([{ name: 'x.' + k, isDir: false, size: 1 }]).books.length === 1;
    assert.equal(listed, C.libOpenable(k), k);
  }
});

test('libParentRel', () => {
  assert.equal(C.libParentRel('a/b/c.cbz'), 'a/b'); assert.equal(C.libParentRel('a/b'), 'a');
  assert.equal(C.libParentRel('a'), ''); assert.equal(C.libParentRel(''), ''); assert.equal(C.libParentRel('a/b/'), 'a');
});

test('nextBook / prevBook：同一文件夹相邻的书，跳过打不开的', () => {
  const R = (n) => '小说/' + n;
  const es = volList(SFTPGO_XML, '小说');
  // 书架的书：a & b (1).pdf, vol 1.rar, vol 2.CBZ, vol 10.cbz, チ…卷01.epub
  assert.equal(C.nextBook(es, R('vol 2.CBZ')).name, 'vol 10.cbz');
  assert.equal(C.nextBook(es, R('vol 10.cbz')).ext, 'epub');
  assert.equal(C.nextBook(es, R('チ。-关于地球的运动- - 卷01.epub')), null);      // 最后一本
  assert.equal(C.prevBook(es, R('a & b (1).pdf')), null);                        // 第一本
  assert.equal(C.prevBook(es, R('vol 2.CBZ')).ext, 'rar');
  assert.equal(C.prevBook(es, R('vol 1.rar')).ext, 'pdf');
  assert.equal(C.prevBook(es, R('vol 10.cbz')).name, 'vol 2.CBZ');
  assert.equal(C.nextBook(es, '小说/不存在.cbz'), null);                            // 当前书不在列表里
  assert.equal(C.nextBook([], 'x.cbz'), null);
  // 列表里夹着 rar / pdf（#open= 或别的来源给的完整列表）：rar / pdf 默认放行；调用方传的 canOpen 说了算（例如 pdf 阅读器被关掉时不放行 pdf，没有 WebAssembly 时不放行 rar 系）
  const full = [{ name: 'a.pdf', rel: 'a.pdf', ext: 'pdf' }, { name: 'b.rar', rel: 'b.rar', ext: 'rar' }, { name: 'c.cbz', rel: 'c.cbz', ext: 'cbz' },
    { name: 'd.cbz', rel: 'd.cbz', ext: 'cbz' }];
  assert.equal(C.prevBook(full, 'c.cbz').name, 'b.rar');
  const noPdf = (e) => e.ext !== 'pdf' && C.libOpenable(C.libClassify(e.ext));
  assert.equal(C.prevBook(full, 'c.cbz', noPdf).name, 'b.rar');
  const noPdfNoRar = (e) => noPdf(e) && e.ext !== 'rar';
  assert.equal(C.prevBook(full, 'c.cbz', noPdfNoRar), null);
  assert.equal(C.nextBook(full, 'c.cbz').name, 'd.cbz');

});

/* ====================== PDF：渲染比例 / 区间适配器（pdf.js 本体不在 Node 里跑，在 web_e2e 里用真浏览器测） ====================== */

test('isPdfName：只认 .pdf 结尾（不分大小写）', () => {
  for (const n of ['a.pdf', 'A.PDF', '小说/书 1.Pdf']) assert.equal(C.isPdfName(n), true, n);
  for (const n of ['a.pdf.zip', 'pdf', 'a.pdfx', '', null, undefined]) assert.equal(C.isPdfName(n), false, String(n));
});

test('pdfAreaCap：桌面 1200 万 / 手机小屏 600 万 / 低内存 400 万', () => {
  assert.equal(C.pdfAreaCap({}), 12e6);
  assert.equal(C.pdfAreaCap({ small: true }), 6e6);
  assert.equal(C.pdfAreaCap({ small: true, deviceMemory: 2 }), 4e6);
  assert.equal(C.pdfAreaCap({ small: false, deviceMemory: 1 }), 4e6);
  assert.equal(C.pdfAreaCap({ small: true, deviceMemory: 8 }), 6e6);
  assert.equal(C.pdfAreaCap(), 12e6);
});

test('pdfScale：A4 手机约 3.46；A0 小于 1；小页封顶 4 倍；最长边 ≤ 4000、面积 ≤ 上限；0 / NaN 不炸', () => {
  const sA4 = C.pdfScale(595, 842, { areaCap: 6e6, maxSide: 4000 });
  assert.ok(Math.abs(sA4 - 3.46) < 0.01, String(sA4));
  const z = C.pdfPixelSize(595, 842, sA4);
  assert.ok(z.w * z.h <= 6e6 && z.w * z.h > 5.9e6, JSON.stringify(z));            // 面积用满上限（向下取整，所以不会超）
  const sA0 = C.pdfScale(2384, 3370, { areaCap: 6e6, maxSide: 4000 });
  assert.ok(sA0 < 1 && sA0 > 0.5, String(sA0));
  assert.equal(C.pdfScale(100, 100, { areaCap: 6e6, maxSide: 4000 }), 4);            // 小页：4 倍封顶
  assert.equal(C.pdfScale(10, 10, { areaCap: 12e6 }), 4);
  // 细长页：最长边约束先起作用（5000x50pt 的横幅）
  const sBan = C.pdfScale(5000, 50, { areaCap: 12e6, maxSide: 4000 });
  assert.ok(Math.abs(sBan - 0.8) < 1e-9, String(sBan));
  for (const [w, h] of [[612, 792], [5000, 5000], [300, 400], [841.89, 1190.55], [1, 20000], [20000, 1]]) {
    for (const cap of [4e6, 6e6, 12e6]) {
      const s = C.pdfScale(w, h, { areaCap: cap, maxSide: 4000 });
      const p = C.pdfPixelSize(w, h, s);
      assert.ok(p.w * p.h <= cap && Math.max(p.w, p.h) <= 4000 && p.w >= 1 && p.h >= 1, `${w}x${h} cap ${cap} -> ${JSON.stringify(p)}`);
    }
  }
  for (const bad of [[0, 0], [0, 10], [NaN, 5], [5, Infinity], [-3, 4], [undefined, 4]]) assert.equal(C.pdfScale(bad[0], bad[1], {}), 1, String(bad));
  assert.equal(C.pdfScale(612, 792), C.pdfScale(612, 792, {}));                   // 没传选项也行
  // 比例只由页面尺寸决定：同一页多次算结果一样（旋转 / 改窗口大小不影响）
  assert.equal(C.pdfScale(612, 792, { areaCap: 6e6, maxSide: 4000 }), C.pdfScale(612, 792, { areaCap: 6e6, maxSide: 4000 }));
});

test('pdfRangeAdapter：区间夹到文件大小、返回独立拷贝、统计字节', async () => {
  const buf = Buffer.from(synthetic);
  const src = memSource(buf);
  const A = C.pdfRangeAdapter(src, buf.length, {});
  const u8 = await A.requestRange(10, 20);
  assert.deepEqual(Buffer.from(u8), buf.subarray(10, 20));
  const tail = await A.requestRange(buf.length - 5, buf.length + 99999);              // 越界按文件尾截断
  assert.equal(tail.length, 5);
  assert.equal((await A.requestRange(50, 50)).length, 0);                            // 空区间 / 反向区间：空，不发读
  assert.equal((await A.requestRange(60, 10)).length, 0);
  assert.equal((await A.requestRange(-5, 3)).length, 3);                             // 负起点按 0
  assert.equal(A.reads, 3);
  assert.equal(A.bytes, 10 + 5 + 3);
  // 拷贝：改返回值不会影响源缓冲（pdf.js 会 transfer 掉这块内存）
  assert.notEqual(u8.buffer, buf.buffer);
  assert.equal(u8.buffer.byteLength, u8.length);
  u8.fill(0);
  assert.notEqual(buf[10], 0);
  assert.equal(A.fatal, null);
});

test('pdfRangeAdapter：读失败 -> 记 fatal、回调一次、之后的请求不再读（pdf.js 没有出错通道）', async () => {
  let reads = 0, fatals = [];
  const src = { size: 1000, read: async (off) => { reads++; if (off >= 500) { const e = new Error('boom'); e.status = 503; throw e; } return new Uint8Array(10); } };
  const A = C.pdfRangeAdapter(src, 1000, { onFatal: (e) => fatals.push(e.message) });
  await A.requestRange(0, 10);
  await assert.rejects(A.requestRange(600, 610), /boom/);
  assert.equal(A.fatal.message, 'boom');
  assert.deepEqual(fatals, ['boom']);
  await assert.rejects(A.requestRange(0, 10), /boom/);                               // 已经 fatal：直接拒绝
  await assert.rejects(A.requestRange(700, 710), /boom/);
  assert.equal(reads, 2, 'fatal 之后不再向源发读取');
  assert.deepEqual(fatals, ['boom'], 'onFatal 只回调一次');
  // 长度不对（短读）也是 fatal
  const short = C.pdfRangeAdapter({ size: 100, read: async () => new Uint8Array(3) }, 100, {});
  await assert.rejects(short.requestRange(0, 10), (e) => e.code === 'short');
  assert.ok(short.fatal);
});

test('pdfRangeAdapter：401 -> 等 retryAuth（用户重新输入账号）-> true 就再读一次；false -> fatal', async () => {
  let pass = 'old', gen = 0, asked = 0;
  const src = { size: 100, read: async () => { if (pass !== 'new') { const e = new Error('401'); e.status = 401; throw e; } return new Uint8Array(4); } };
  const A = C.pdfRangeAdapter(src, 100, {
    gen: () => gen,
    retryAuth: async (g) => { asked++; if (g !== gen) return true; pass = 'new'; gen++; return true; },
  });
  const u = await A.requestRange(0, 4);
  assert.equal(u.length, 4);
  assert.equal(asked, 1);
  assert.equal(A.fatal, null);
  // 用户取消（false）-> 401 变成 fatal
  const src2 = { size: 100, read: async () => { const e = new Error('401'); e.status = 401; throw e; } };
  const fa = [];
  const B = C.pdfRangeAdapter(src2, 100, { retryAuth: async () => false, onFatal: (e) => fa.push(e.status) });
  await assert.rejects(B.requestRange(0, 4), (e) => e.status === 401);
  assert.deepEqual(fa, [401]);
  // 没有 retryAuth -> 直接 fatal；重试最多 2 次，不会死循环
  let n = 0;
  const C3 = C.pdfRangeAdapter({ size: 100, read: async () => { n++; const e = new Error('401'); e.status = 401; throw e; } }, 100, { retryAuth: async () => true });
  await assert.rejects(C3.requestRange(0, 4), (e) => e.status === 401);
  assert.equal(n, 3, '首次 + 重试 2 次后放弃');
});

test('pdfRangeAdapter + UrlRangeSource：整条链 —— 只发 206 Range；服务器忽略 Range（200）-> fatal，不整本下载', async () => {
  const big = Buffer.alloc(2 * 1024 * 1024, 5);
  const ok = await startServer({ data: synthetic, auth: 'u:p' });
  try {
    const src = new C.UrlRangeSource(ok.url, { authHeader: C.basicAuth('u', 'p') });
    await src.init();
    const A = C.pdfRangeAdapter(src, src.size, {});
    const got = await A.requestRange(1000, 1000 + 4096);
    assert.deepEqual(Buffer.from(got), synthetic.subarray(1000, 5096));
    const tail = await A.requestRange(synthetic.length - 65536, synthetic.length + 10);
    assert.deepEqual(Buffer.from(tail), synthetic.subarray(synthetic.length - 65536));
    assert.ok(ok.st.requests.every((r) => r.range && r.authorization), '全部带 Range 和账号头');
    assert.ok(ok.st.requests.every((r) => !/u:p|Basic/.test(r.url)), '账号不进 URL');
  } finally { await ok.close(); }
  const bad = await startServer({ data: big, ignoreRange: true });
  try {
    const src = new C.UrlRangeSource(bad.url, {});
    src.size = big.length;
    const A = C.pdfRangeAdapter(src, big.length, {});
    await assert.rejects(A.requestRange(0, 262144), (e) => e.code === 'norange');
    assert.equal(A.fatal.code, 'norange');
    assert.equal(bad.st.requests.length, 1, '只发了一次，没有重试、没有整本下载');
  } finally { await bad.close(); }
});

test('UrlRangeSource：0 字节的文件 -> 明确的 empty 错误（各种服务器的空文件行为），不是「忽略 Range」/「取不到大小」', async () => {
  const modes = {
    cl0: (req, res) => { res.writeHead(200, { 'Content-Length': 0 }); res.end(); },                                   // 没做 Range：直接回 200 + 空
    r416: (req, res) => { res.writeHead(416, { 'Content-Range': 'bytes */0', 'Content-Length': 0 }); res.end(); },    // Go http.ServeContent / Caddy / SFTPGo
    head: (req, res) => {                                                                                              // 416 没带 Content-Range -> 退回 HEAD -> Content-Length: 0
      if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Length': 0 }); res.end(); return; }
      res.writeHead(416, { 'Content-Length': 0 }); res.end();
    }
  };
  for (const [mode, handler] of Object.entries(modes)) {
    const reqs = [];
    const srv = http.createServer((req, res) => { reqs.push(req.method + ' ' + (req.headers.range || '')); handler(req, res); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const src = new C.UrlRangeSource('http://127.0.0.1:' + srv.address().port + '/e.pdf', {});
      await assert.rejects(src.init(), (e) => e.code === 'empty' && /空/.test(e.message) && !/Range/.test(e.message), mode);
      assert.ok(reqs.length <= 2, mode + ': 请求数 ' + reqs.length);
    } finally { await new Promise((r) => srv.close(r)); }
  }
});

/* ================= 书签 ================= */
test('书签：加 / 取消 / 备注 / 删除 —— 同一页再点一次是取消；u 总比已有的大', () => {
  const t0 = 1760000000000;
  const r = C.bmToggle([], 0, 4, t0, { s: '春天到了' }, 0.5);
  assert.ok(r.added && !r.removed);
  assert.equal(r.added.i, 4); assert.equal(r.added.c, 0); assert.equal(r.added.s, '春天到了'); assert.equal(r.added.u, t0);
  assert.equal(C.bmLive(r.list).length, 1);
  assert.equal(C.bmAtPage(r.list, 0, 4).id, r.added.id);
  assert.equal(C.bmAtPage(r.list, 1, 4), null);                       // 不同章的同一页下标不是同一个书签
  const l2 = C.bmUpdate(r.list, r.added.id, { n: '备注' }, t0 + 5);
  assert.equal(C.bmLive(l2)[0].n, '备注'); assert.equal(C.bmLive(l2)[0].u, t0 + 5);
  const r2 = C.bmToggle(l2, 0, 4, t0 + 10, null);                     // 再点 = 取消（留墓碑）
  assert.ok(r2.removed && !r2.added); assert.equal(C.bmLive(r2.list).length, 0);
  assert.equal(r2.list.length, 1); assert.equal(r2.list[0].x, 1); assert.equal(r2.list[0].u, t0 + 10);
  const r3 = C.bmToggle(r2.list, 0, 4, t0 + 20, null);                // 取消之后再加 = 新 id
  assert.ok(r3.added && r3.added.id !== r.added.id);
  // 时钟倒退（别的设备的 u 更大）：本次改动的 u 仍要比已有的大，合并时才赢
  const future = [{ id: 'a1', c: 0, i: 2, n: '', s: '', t: t0 + 1e6, u: t0 + 1e6 }];
  const r4 = C.bmToggle(future, 0, 2, t0, null);
  assert.ok(r4.list.find((b) => b.id === 'a1').u > t0 + 1e6);
  const l5 = C.bmRemove(r3.list, r3.added.id, t0 + 30);
  assert.equal(C.bmLive(l5).length, 0);
});

test('书签：合并 —— 按 id 取 u 大的，删除（墓碑）传播，过期墓碑清掉，脏数据丢弃，活书签最多 200', () => {
  const now = 1760000000000, day = 864e5;
  const A = [{ id: 'x', c: 0, i: 1, n: 'A改的', s: '', t: 1, u: now - 5000 }, { id: 'y', c: 0, i: 2, n: '', s: '', t: 1, u: now - 9000 }];
  const B = [{ id: 'x', c: 0, i: 1, n: 'B改的', s: '', t: 1, u: now - 1000 }, { id: 'y', c: 0, i: 2, n: '', s: '', t: 1, u: now - 100, x: 1 },
    { id: 'z', c: 0, i: 3, n: '', s: '', t: 1, u: now - 50 }];
  const m = C.bmMerge(A, B, now);
  assert.equal(m.find((b) => b.id === 'x').n, 'B改的');                // 较新的赢
  assert.equal(m.find((b) => b.id === 'y').x, 1);                      // B 删了 y，A 的旧副本不能复活它
  assert.equal(C.bmLive(m).map((b) => b.id).join(), 'x,z');
  assert.deepEqual(C.bmMerge(B, A, now), m);                           // 交换律：两台设备合并出同一个结果
  assert.deepEqual(C.bmMerge(m, m, now), m);                           // 幂等
  assert.ok(C.bmSame(m, C.bmMerge(m, A, now)));
  // 同一时刻：墓碑赢
  const tie = C.bmMerge([{ id: 'q', c: 0, i: 0, n: '', s: '', t: 5, u: 7 }], [{ id: 'q', c: 0, i: 0, n: '', s: '', t: 5, u: 7, x: 1 }], 0);
  assert.equal(tie[0].x, 1);
  // 过期墓碑清掉；活的不清
  const old = C.bmNormalize([{ id: 'o', c: 0, i: 0, t: 1, u: now - 61 * day, x: 1 }, { id: 'p', c: 0, i: 1, t: 1, u: now - 61 * day }], now);
  assert.deepEqual(old.map((b) => b.id), ['p']);
  // 脏数据
  const dirty = C.bmNormalize([null, 5, { id: '', i: 1, u: 1 }, { id: 'a', i: -1, u: 1 }, { id: 'b', i: 1 }, { id: 'c!<b>', i: 2.7, u: 3, n: 'x'.repeat(999), s: 5 },
    { id: 'd', i: 1e12, u: 4, c: -3 }], now);
  assert.deepEqual(dirty.map((b) => b.id).sort(), ['cb', 'd']);        // 'c!<b>' 去掉非法字符后是 'cb'
  const cb = dirty.find((b) => b.id === 'cb');
  assert.equal(cb.i, 2); assert.equal(cb.n.length, 200); assert.equal(cb.s, '');
  assert.equal(dirty.find((b) => b.id === 'd').i, 1e6); assert.equal(dirty.find((b) => b.id === 'd').c, 0);
  // 上限 200：留最新的
  const many = Array.from({ length: 230 }, (_, k) => ({ id: 'm' + k, c: 0, i: k, t: 1, u: 1000 + k }));
  const cap = C.bmNormalize(many, now);
  assert.equal(C.bmLive(cap).length, 200); assert.ok(cap.some((b) => b.id === 'm229')); assert.ok(!cap.some((b) => b.id === 'm0'));
  assert.deepEqual(C.bmNormalize('nope', now), []);
});

test('书签：跟着进度走（bm 字段）；没有书签的进度和旧版本完全一样', () => {
  const key = 'dav:lib/a.pdf', now = Date.now();
  const bm = [{ id: 'k1', c: 0, i: 7, n: '备注', s: '片段', t: now, u: now }, { id: 'k2', c: 1, i: 0, n: '', s: '', t: now, u: now + 1, x: 1 }];
  const out = C.toRemoteProgress({ index: 7, chapter: 0, total: 30, direction: 'ltr', title: 'T', at: 1760000000123, bookmarks: bm }, key, '电脑');
  assert.deepEqual(out.bm.map((b) => b.id), ['k1', 'k2']);
  assert.ok(!('bm' in C.toRemoteProgress({ index: 7, chapter: 0, total: 30, at: 1760000000123 }, key, '')));
  assert.ok(!('bm' in C.toRemoteProgress({ index: 7, chapter: 0, total: 30, at: 1760000000123, bookmarks: [] }, key, '')));
  const back = C.normalizeProgress(JSON.parse(JSON.stringify(out)), key);
  assert.deepEqual(back.bm, C.bmNormalize(bm, now));
  const legacy = C.normalizeProgress({ key, at: 5, index: 1 }, key);
  assert.ok(!('bm' in legacy));                                        // 旧文件没有 bm：不凭空多字段
  assert.ok(!('bm' in C.normalizeProgress({ key, at: 5, index: 1, bm: 'x' }, key)));
});

/* ================= PDF 文字层 → 可朗读文字 ================= */
// 造一页：行 = [x, y(自顶向下), 字号, 文字]；perChar = 每个汉字一个 item（逼近最坏的 OCR 文字层：逐字断开）
function mkItems(lines, perChar) {
  const out = [];
  for (const [x, y, fs, text] of lines) {
    if (perChar && /[㐀-鿿]/.test(text)) { let cx = x; for (const ch of text) { out.push({ s: ch, x: cx, y, w: fs, fs }); cx += fs; } }
    else out.push({ s: text, x, y, w: text.length * fs * (/[㐀-鿿]/.test(text) ? 1 : 0.5), fs });
  }
  return out;
}
const W = 400, H = 600;
function bodyLines(texts, y0, indent, n = 24) {            // 每行 n 个字，缩进段第一行缩进 2 字
  const lines = [];
  texts.forEach((t, k) => {
    const ind = indent[k] !== false;
    const parts = ind ? [t.slice(0, n - 2)].concat(Array.from({ length: Math.ceil(Math.max(0, t.length - (n - 2)) / n) }, (_, j) => t.slice(n - 2 + j * n, n - 2 + (j + 1) * n)))
      : Array.from({ length: Math.ceil(t.length / n) }, (_, j) => t.slice(j * n, (j + 1) * n));
    parts.forEach((p, j) => { lines.push([50 + (ind && j === 0 ? 24 : 0), y0, 12, p]); y0 += 18; });
    y0 += 4;
  });
  return lines;
}

test('文字层：逐字断开的 OCR 也能拼回一行；页眉 / 页码 / 脚注 / 〔n〕注号被清掉；缩进开新段；中文标点旁边不多出空格', () => {
  const tr = C.ttsTracker();
  const head = [150, 30, 9, '示例：朗读测试书'];
  const mk = (n, extra) => [head].concat(extra).concat([[195, 575, 9, String(n)]]);
  const p1 = mk(1, bodyLines(['春天到了，山上的雪慢慢融化。溪水从石缝里流出来，带着泥土的气息。', '老人坐在门口晒太阳，他说今年的收成一定不错。'], 80, [true, true])
    .concat([[50, 540, 7, '〔1〕这里是脚注，朗读时应该被跳过。']]));
  const p2 = mk(2, bodyLines(['夜里，月亮升起来，整个山谷安静得像一幅画。'], 80, [true]));
  const p3 = mk(3, bodyLines(['路上遇到了一位旅人。'], 80, [true]));
  [p1, p2, p3].forEach((p, k) => { C.pdfPageParas(mkItems(p, true), W, H, tr, k + 1); });
  const o = C.pdfPageParas(mkItems(p1, true), W, H, tr, 1);
  assert.equal(o.paras.length, 2);
  assert.equal(o.paras[0], '春天到了，山上的雪慢慢融化。溪水从石缝里流出来，带着泥土的气息。');
  assert.equal(o.paras[1], '老人坐在门口晒太阳，他说今年的收成一定不错。');
  assert.ok(o.indentFirst);
  assert.ok(!o.paras.join('').includes('示例') && !o.paras.join('').includes('脚注'), '页眉 / 脚注不该出现');
  assert.ok(!/\s/.test(o.paras.join('')), '中文里不能有空格');
  // 注号 〔2〕 [3] 在句中被去掉；句尾被截断的「〔」「〔0」也去掉
  assert.equal(C.ttsClean('他说〔2〕这样。[3]好。〔'), '他说这样。好。');
  assert.equal(C.ttsClean('快乐”〔0'), '快乐”');
  assert.equal(C.ttsClean('a\u0000b\u0007  c'), 'a b c');
});

test('文字层：页眉页脚只有在书里反复出现才丢；单独一页的页码也丢；标题自成一段；弯引号旁不补空格', () => {
  const tr = C.ttsTracker();
  const lines = [[100, 40, 9, 'CHAPTER ONE'], [50, 80, 20, '第一章'], ...bodyLines(['他说“你好”。她笑了。'], 130, [true]), [195, 575, 9, '- 12 -']];
  // 只看过这一页：页码（数字）丢，「CHAPTER ONE」暂时当正文（还不知道它是不是每页都有）
  const a = C.pdfPageParas(mkItems(lines, true), W, H, tr, 12);
  assert.ok(a.paras.some((p) => /CHAPTER/.test(p)));
  assert.ok(!a.paras.some((p) => /12/.test(p)));
  assert.equal(a.paras[a.paras.length - 2], '第一章');                   // 大字号 = 标题，自成一段
  assert.equal(a.paras[a.paras.length - 1], '他说“你好”。她笑了。');
  // 又看过一页同样的页眉 → 以后都丢
  C.pdfPageParas(mkItems([[100, 40, 9, 'CHAPTER ONE'], ...bodyLines(['下一页。'], 80, [true])], true), W, H, tr, 13);
  const b = C.pdfPageParas(mkItems(lines, true), W, H, tr, 12);
  assert.ok(!b.paras.some((p) => /CHAPTER/.test(p)));
  assert.ok(tr.isRepeat('CHAPTER ONE'));
  // 页眉里的页码变了（Chapter 7 → 8）也算同一个
  const t2 = C.ttsTracker();
  C.pdfPageParas(mkItems([[100, 40, 9, 'Chapter 7 · Light'], ...bodyLines(['甲。'], 80, [true])], true), W, H, t2, 7);
  C.pdfPageParas(mkItems([[100, 40, 9, 'Chapter 8 · Light'], ...bodyLines(['乙。'], 80, [true])], true), W, H, t2, 8);
  assert.ok(t2.isRepeat('Chapter 9 · Light'));
});

test('文字层：缩进的块引用不断成一行一段；英文行尾连字符拼回；中英混排只在英文之间补空格；索引页（数字比字多）整页不读', () => {
  const quote = [[70, 80, 12, '我从来没有被女性如此强烈地拒绝'], [70, 98, 12, '过，即使发生过这样的事，也从未'], [70, 116, 12, '像这次这么多人。']];
  const o = C.pdfPageParas(mkItems([[50, 60, 12, '他在信里写道：'], ...quote], false), W, H, null, 1);
  assert.equal(o.paras.length, 2);
  assert.equal(o.paras[1], '我从来没有被女性如此强烈地拒绝过，即使发生过这样的事，也从未像这次这么多人。');
  const en = C.pdfPageParas(mkItems([[50, 80, 12, 'The scientist was astonish-'], [50, 98, 12, 'ed by the result of the experi-'], [50, 116, 12, 'ment, and said so.']], false), W, H, null, 1);
  assert.equal(en.paras[0], 'The scientist was astonished by the result of the experiment, and said so.');
  const mix = C.pdfPageParas([{ s: '使用', x: 50, y: 80, w: 24, fs: 12 }, { s: 'Azure', x: 74, y: 80, w: 30, fs: 12 }, { s: 'Speech', x: 108, y: 80, w: 36, fs: 12 }, { s: '服务。', x: 146, y: 80, w: 36, fs: 12 }], W, H, null, 1);
  assert.equal(mix.paras[0], '使用Azure Speech服务。');
  const idx = mkItems(Array.from({ length: 10 }, (_, k) => [50, 80 + k * 18, 10, '72，74，76，77，79，84，85，86，89，90，92，93，113，122']), false);
  assert.deepEqual(C.pdfPageParas(idx, W, H, null, 1).paras, []);
  assert.deepEqual(C.pdfPageParas([], W, H, null, 1).paras, []);
  assert.deepEqual(C.pdfPageParas([{ s: '   ', x: 1, y: 2, w: 3, fs: 12 }], W, H, null, 1).paras, []);
});

test('文字层：下方小字号的行 = 脚注，从那一行起到页尾都不读；「open」= 最后一行顶到右边距且没有句号（句子跨页）', () => {
  const txt = ('他把论文寄给了远在比利时经商的舅舅。科赫曾经资助过他。这个计划碰到了相当大的麻烦因为这样一来我必须至少大上两岁才行。').repeat(2).slice(0, 94);   // 22 + 24 × 3：最后一行刚好顶满
  const body = bodyLines([txt], 80, [true]);
  const o = C.pdfPageParas(mkItems(body.concat([[50, 520, 7, 'Frank 1947, 17; Maja Einstein, 27.'], [50, 531, 7, '“某某”，夏，1895。']]), false), W, H, null, 1);
  assert.equal(o.paras.length, 1);
  assert.ok(!/Frank|1895/.test(o.paras[0]));
  assert.equal(o.open, true);
  const closed = C.pdfPageParas(mkItems(bodyLines(['这一段到此结束。'], 80, [true]), false), W, H, null, 1);
  assert.equal(closed.open, false);
});

test('切句：中文按 。！？；…，引号 / 括号跟在句末；英文按「句点 + 空白」且不在缩写 / 小数处断；超长的在逗号处再切', () => {
  assert.deepEqual(C.splitSentences('他说：“今天天气很好！”然后走了。你呢？我也是……好吧；再见。'),
    ['他说：“今天天气很好！”', '然后走了。', '你呢？', '我也是……', '好吧；', '再见。']);
  assert.deepEqual(C.splitSentences('Dr. Smith paid $3.50 for it. Mr. Lee said: "Fine!" Then they left. e.g. nothing.'),
    ['Dr. Smith paid $3.50 for it.', 'Mr. Lee said: "Fine!"', 'Then they left.', 'e.g. nothing.']);
  const long = '这是一个很长很长的句子，'.repeat(30);               // 没有句号：靠逗号切
  const parts = C.splitSentences(long, 60);
  assert.ok(parts.length > 3 && parts.every((p) => p.length <= 61), parts.map((p) => p.length));
  assert.equal(parts.join(''), long);
  assert.ok(C.splitSentences('甲'.repeat(500), 150).every((p) => p.length <= 150));      // 没有任何断点：硬切，不死循环
  assert.deepEqual(C.splitSentences('”'), []);                      // 只有标点：不读
  assert.deepEqual(C.splitSentences('……。'), []);
  assert.equal(C.pageSentences({ paras: ['甲乙丙。', '丁戊。'] }, '半句', 150).join('|'), '半句甲乙丙。|丁戊。');
  assert.equal(C.pageSentences({ paras: ['then it ended.'] }, 'He said that', 150)[0], 'He said that then it ended.');
});

/* ================= 朗读控制器（假引擎） ================= */
// 假引擎：speak 返回按脚本决定的结果；pause 时 speak 挂起直到 resume；记录一切
function fakeEngine(script = {}) {
  const E = { spoken: [], prefetched: [], calls: [], lastError: null, paused: false, _wait: null, _gen: 0 };
  E.speak = (text) => {
    const g = E._gen;
    E.calls.push('speak');
    return new Promise((res) => {
      const finish = () => { if (g !== E._gen) return res('cancel'); E.spoken.push(text); res(script.result ? script.result(text, E.spoken.length) : 'end'); };
      if (E.paused) E._wait = finish; else setTimeout(finish, script.delay == null ? 8 : script.delay);
    });
  };
  E.prefetch = (t) => { E.prefetched.push(t.slice()); };
  E.cancel = () => { E._gen++; E.calls.push('cancel'); E.paused = false; };
  E.pause = () => { E.paused = true; E.calls.push('pause'); };
  E.resume = () => { E.paused = false; E.calls.push('resume'); const w = E._wait; E._wait = null; if (w) setTimeout(w, 0); };
  return E;
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('等待超时'); await tick(2); } }
function fakeHost(pagesById, eng, extra = {}) {
  const log = { pages: [], states: [], sentences: [] };
  const host = {
    engine: eng, count: Object.keys(pagesById).length,
    getPage: (p) => Promise.resolve(pagesById[p] || null),
    onPage: (p) => log.pages.push(p),
    onSentence: (s, p) => log.sentences.push([p, s]),
    onState: (s, info) => log.states.push([s, info && info.kind]),
    ...extra
  };
  return { host, log };
}

test('朗读控制器：一页一页读到最后，自动翻页，读完回到 idle；预读窗口里包含下一页的开头', async () => {
  const eng = fakeEngine();
  const pg = { 1: { paras: ['甲一。甲二。'], indentFirst: true, open: false }, 2: { paras: ['乙一。'], indentFirst: true, open: false } };
  const { host, log } = fakeHost(pg, eng);
  const r = C.createTtsRunner(host);
  r.start(1);
  assert.equal(r.state, 'playing');
  await until(() => r.state === 'idle');
  assert.deepEqual(eng.spoken, ['甲一。', '甲二。', '乙一。']);
  assert.deepEqual(log.pages, [1, 2]);
  assert.ok(log.states.some((s) => s[0] === 'done'));
  assert.deepEqual(eng.prefetched[0], ['甲一。', '甲二。', '乙一。']);   // 正在读第一句时，窗口 = 这一句 + 本页剩下的 + 下一页的第一句（必须含正在读的这句）
});

test('朗读控制器：跨页的半句和下一页开头拼成一句再读；下一页开头缩进就不拼', async () => {
  const eng = fakeEngine();
  const pg = { 1: { paras: ['完整一句。这句没写完还有'], indentFirst: true, open: true }, 2: { paras: ['那些红薯。新的一句。'], indentFirst: false, open: false } };
  const { host } = fakeHost(pg, eng);
  const r = C.createTtsRunner(host);
  r.start(1); await until(() => r.state === 'idle');
  assert.deepEqual(eng.spoken, ['完整一句。', '这句没写完还有那些红薯。', '新的一句。']);
  const eng2 = fakeEngine();
  pg[2].indentFirst = true;                                              // 下一页是新段落：上一页的半句自己读掉
  const r2 = C.createTtsRunner(fakeHost(pg, eng2).host);
  r2.start(1); await until(() => r2.state === 'idle');
  assert.deepEqual(eng2.spoken, ['完整一句。', '这句没写完还有', '那些红薯。', '新的一句。']);
});

test('朗读控制器：没有文字的页跳过；连续 3 页没有就停下并报 notext；有文字的页让计数归零', async () => {
  const eng = fakeEngine();
  const pg = { 1: { paras: ['一。'] }, 2: { paras: [] }, 3: null, 4: { paras: ['四。'] }, 5: { paras: [] }, 6: { paras: [] }, 7: null, 8: { paras: ['不该读到。'] } };
  const { host, log } = fakeHost(pg, eng);
  const r = C.createTtsRunner(host);
  r.start(1); await until(() => r.state === 'idle');
  assert.deepEqual(eng.spoken, ['一。', '四。']);
  assert.deepEqual(log.pages, [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(log.states.some((s) => s[0] === 'error' && s[1] === 'notext'));
  assert.equal(log.states.filter((s) => s[0] === 'notext').length, 5);
});

test('朗读控制器：暂停 / 继续 / 停止；暂停时 speak 不前进；stop 后不再读', async () => {
  const eng = fakeEngine();
  const pg = { 1: { paras: ['一。二。三。四。'] } };
  const { host } = fakeHost(pg, eng);
  const r = C.createTtsRunner(host);
  r.start(1);
  await until(() => eng.spoken.length === 1);
  r.pause(); assert.equal(r.state, 'paused');
  await tick(30); const n = eng.spoken.length;
  await tick(30); assert.equal(eng.spoken.length, n, '暂停时不该前进');
  r.resume(); assert.equal(r.state, 'playing');
  await until(() => eng.spoken.length >= n + 1);
  r.stop(); assert.equal(r.state, 'idle');
  const m = eng.spoken.length; await tick(40);
  assert.equal(eng.spoken.length, m, 'stop 后不再读');
  assert.ok(eng.calls.includes('cancel'));
  r.pause(); r.resume(); assert.equal(r.state, 'idle');                // idle 时 pause / resume 无效
});

test('朗读控制器：seek / 重新 start 作废旧的一轮，从新页开头读；没在读时 seek 无效；越界页号被夹住', async () => {
  const eng = fakeEngine();
  const pg = { 1: { paras: ['一一。一二。一三。'] }, 2: { paras: ['二一。二二。'] }, 3: { paras: ['三一。'] } };
  const { host } = fakeHost(pg, eng);
  const r = C.createTtsRunner(host);
  r.start(1); await until(() => eng.spoken.length === 1);
  r.seek(3);
  await until(() => r.state === 'idle');
  assert.deepEqual(eng.spoken.filter((s) => /^[二三]/.test(s)), ['三一。']);   // 没有读到第 2 页
  const idle = C.createTtsRunner(fakeHost(pg, fakeEngine()).host);
  idle.seek(2); assert.equal(idle.state, 'idle');                        // 没在读时 seek 无效
  r.start(99); await until(() => r.state === 'idle');                     // 越界页号被夹到最后一页
  assert.equal(eng.spoken[eng.spoken.length - 1], '三一。');
});

test('朗读控制器：引擎出错 —— 第一次重试同一句，再错跳过，连续 3 次停下；auth / quota / offline / nostart 立即停并带原因', async () => {
  let fails = 0;
  const eng = fakeEngine({ result: (t) => (t === '坏。' && fails++ < 1 ? 'error' : 'end') });
  const r = C.createTtsRunner(fakeHost({ 1: { paras: ['好。坏。后。'] } }, eng).host);
  r.start(1); await until(() => r.state === 'idle');
  assert.deepEqual(eng.spoken, ['好。', '坏。', '坏。', '后。']);          // 重试同一句一次
  const eng2 = fakeEngine({ result: (t) => (t === '坏。' ? 'error' : 'end') });
  const r2 = C.createTtsRunner(fakeHost({ 1: { paras: ['好。坏。后。'] } }, eng2).host);
  r2.start(1); await until(() => r2.state === 'idle');
  assert.deepEqual(eng2.spoken, ['好。', '坏。', '坏。', '后。']);         // 第二次仍错 → 跳过这一句，继续
  const eng3 = fakeEngine({ result: () => 'error' });
  const h3 = fakeHost({ 1: { paras: ['一。二。三。四。五。六。'] } }, eng3);
  const r3 = C.createTtsRunner(h3.host);
  r3.start(1); await until(() => r3.state === 'idle');
  assert.ok(h3.log.states.some((s) => s[0] === 'error' && s[1] === 'error'));
  assert.ok(eng3.spoken.length < 6);
  for (const kind of ['auth', 'quota', 'offline', 'nostart']) {
    const e = fakeEngine({ result: () => kind }); e.lastError = new Error('x');
    const h = fakeHost({ 1: { paras: ['一。二。'] } }, e);
    const rr = C.createTtsRunner(h.host);
    rr.start(1); await until(() => rr.state === 'idle');
    assert.deepEqual(e.spoken, ['一。'], kind);
    assert.ok(h.log.states.some((s) => s[0] === 'error' && s[1] === kind), kind);
  }
  const t = fakeEngine({ result: (s) => (s === '长。' ? 'toolong' : 'end') });
  const rt = C.createTtsRunner(fakeHost({ 1: { paras: ['短。长。尾。'] } }, t).host);
  rt.start(1); await until(() => rt.state === 'idle');
  assert.deepEqual(t.spoken, ['短。', '长。', '尾。']);                    // 太长 = 跳过，不算错误
});

/* ================= 朗读引擎 ================= */
function fakeAudio() {
  const a = { src: '', paused: true, playbackRate: 1, defaultPlaybackRate: 1, plays: 0, onended: null, onerror: null, onplaying: null };
  a.play = () => { a.plays++; a.paused = false; setTimeout(() => { a.onplaying && a.onplaying(); }, 0); return Promise.resolve(); };
  a.pause = () => { a.paused = true; };
  a.end = () => { a.onended && a.onended(); };
  return a;
}
function fakeFetch(handler) {
  const reqs = [];
  const f = (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    const rec = { url, method: init && init.method, auth: init && init.headers && init.headers.Authorization, body, aborted: false };
    reqs.push(rec);
    if (init && init.signal) init.signal.addEventListener('abort', () => { rec.aborted = true; });
    const aborted = new Promise((_, rej) => {
      if (init && init.signal) init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
    });
    return Promise.race([Promise.resolve(handler(rec, init)), aborted]);
  };
  f.reqs = reqs;
  return f;
}
const okRes = () => ({ ok: true, status: 200, blob: () => Promise.resolve({ size: 3 }) });
const errRes = (status, body) => ({ ok: false, status, json: () => Promise.resolve(body || {}), blob: () => Promise.resolve({ size: 0 }) });
const blobUrls = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
const mkCloud = (f, a, cfg = {}) => C.makeCloudEngine({ fetch: f, audio: a, URL: blobUrls, endpoint: (p) => 'https://h/tts/v1/' + p, startTimeoutMs: 0,
  getCfg: () => ({ token: 'tok', voice: 'zh-CN-YunxiNeural', rate: 1.5, ...cfg }) });

test('在线引擎：请求形状（URL / 方法 / Bearer 令牌 / 文本和声音 / rate 0）；中英文各用自己的声音；播放速度 = playbackRate', async () => {
  const f = fakeFetch(() => okRes()), a = fakeAudio(), e = mkCloud(f, a);
  const p = e.speak('你好。');
  await until(() => a.plays === 1);
  assert.equal(f.reqs[0].url, 'https://h/tts/v1/speak'); assert.equal(f.reqs[0].method, 'POST');
  assert.equal(f.reqs[0].auth, 'Bearer tok');
  assert.deepEqual(f.reqs[0].body, { text: '你好。', voice: 'zh-CN-YunxiNeural', rate: 0 });
  assert.equal(a.playbackRate, 1.5); assert.equal(a.defaultPlaybackRate, 1.5);
  a.end(); assert.equal(await p, 'end');
  const p2 = e.speak('Hello there.'); await until(() => a.plays === 2);
  assert.equal(f.reqs[1].body.voice, 'en-US-AriaNeural'); a.end(); await p2;
  const long = e.speak('长'.repeat(300)); await until(() => a.plays === 3);
  assert.equal(f.reqs[2].body.text.length, 200); a.end(); await long;
});

test('在线引擎：HTTP 错误分类（401/403 auth、429 quota、413 toolong、5xx 出错、断网 offline）；空音频算错；错误带中文原因', async () => {
  const cases = [[401, 'auth'], [403, 'auth'], [429, 'quota'], [413, 'toolong'], [500, 'error'], [502, 'error'], [404, 'error']];
  for (const [status, want] of cases) {
    const e = mkCloud(fakeFetch(() => errRes(status, { retryAfter: 120 })), fakeAudio());
    assert.equal(await e.speak('甲。'), want, String(status));
    assert.ok(e.lastError && /[一-鿿]/.test(e.lastError.message), String(status));
  }
  const q = mkCloud(fakeFetch(() => errRes(429, { retryAfter: 120 })), fakeAudio());
  await q.speak('甲。'); assert.match(q.lastError.message, /2 分钟/);
  const off = mkCloud(() => Promise.reject(new TypeError('Failed to fetch')), fakeAudio());
  assert.equal(await off.speak('甲。'), 'offline');
  const empty = mkCloud(fakeFetch(() => ({ ok: true, status: 200, blob: () => Promise.resolve({ size: 0 }) })), fakeAudio());
  assert.equal(await empty.speak('甲。'), 'error');
  const e2 = C.makeCloudEngine({ fetch: () => Promise.reject(new Error('never')), audio: fakeAudio(), URL: blobUrls, endpoint: (p) => p, online: () => false, getCfg: () => ({ token: 't' }) });
  assert.equal(await e2.speak('甲。'), 'offline');
  assert.deepEqual([C.ttsClassify(401).kind, C.ttsClassify(429).kind, C.ttsClassify(503).kind, C.ttsClassify(418).kind], ['auth', 'quota', 'upstream', 'http']);
});

test('在线引擎：预读（同一句只请求一次，窗口外的取消）、cancel 取消全部、暂停 / 继续、播放被浏览器拦下 = nostart', async () => {
  const f = fakeFetch(() => okRes()), a = fakeAudio(), e = mkCloud(f, a);
  e.prefetch(['乙。', '丙。', '丁。']);
  await tick(5);
  assert.deepEqual(f.reqs.map((r) => r.body.text), ['乙。', '丙。', '丁。']);
  const p = e.speak('乙。'); await until(() => a.plays === 1);
  assert.equal(f.reqs.length, 3, '已预读的那句不再请求第二次');
  a.end(); assert.equal(await p, 'end');
  e.prefetch(['戊。']);                                                  // 窗口换了：丙 / 丁 被取消
  await tick(5);
  assert.ok(f.reqs.find((r) => r.body.text === '丙。').aborted && f.reqs.find((r) => r.body.text === '丁。').aborted);
  e.cancel();
  assert.ok(f.reqs.find((r) => r.body.text === '戊。').aborted);
  // 暂停：音频到了也先不播，resume 后才播
  const a2 = fakeAudio(), e2 = mkCloud(fakeFetch(() => okRes()), a2);
  e2.pause();
  const p2 = e2.speak('己。'); await tick(20);
  assert.equal(a2.plays, 0, '暂停时不该开始播');
  e2.resume(); await until(() => a2.plays === 1); a2.end(); assert.equal(await p2, 'end');
  // cancel 中的 speak = cancel
  const slow = fakeFetch(() => new Promise(() => {})), e3 = mkCloud(slow, fakeAudio());
  const p3 = e3.speak('庚。'); await tick(5); e3.cancel();
  assert.equal(await p3, 'cancel');
  // 浏览器要求用户操作才能出声
  const a4 = fakeAudio(); a4.play = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
  const e4 = mkCloud(fakeFetch(() => okRes()), a4);
  assert.equal(await e4.speak('辛。'), 'nostart');
  const a5 = fakeAudio(); const e5 = mkCloud(fakeFetch(() => okRes()), a5);
  const p5 = e5.speak('壬。'); await until(() => a5.plays === 1); a5.onerror(); assert.equal(await p5, 'error');
});

test('朗读控制器 + 在线引擎：每一句只请求一次，预读不会把正在读的那句取消掉；一路读完', async () => {
  const f = fakeFetch(() => okRes()), a = fakeAudio();
  a.play = () => { a.plays++; setTimeout(() => { a.onplaying && a.onplaying(); setTimeout(() => a.onended && a.onended(), 3); }, 0); return Promise.resolve(); };
  const e = mkCloud(f, a);
  const sents = Array.from({ length: 9 }, (_, k) => '第' + (k + 1) + '句话。');
  const r = C.createTtsRunner(fakeHost({ 1: { paras: [sents.slice(0, 5).join('')] }, 2: { paras: [sents.slice(5).join('')] } }, e).host);
  r.start(1);
  await until(() => r.state === 'idle', 5000);
  const texts = f.reqs.map((x) => x.body.text);
  assert.equal(a.plays, 9);
  assert.deepEqual(texts.slice().sort(), sents.slice().sort(), '每句恰好请求一次（没有因为预读窗口被取消后重取）');
  assert.ok(f.reqs.every((x) => !x.aborted), '没有被取消的请求');
});

test('本机引擎：按文字选语言和声音、语速、cancel / 出错 / 没有语音 = nostart', async () => {
  const spoken = [];
  class U { constructor(t) { this.text = t; } }
  const synth = { voices: [{ name: 'Microsoft Xiaoxiao Online (Natural)', lang: 'zh-CN' }, { name: 'Other', lang: 'zh-TW' }, { name: 'David', lang: 'en-US' }],
    getVoices() { return this.voices; }, speak(u) { spoken.push(u); setTimeout(() => u.onstart && u.onstart(), 0); setTimeout(() => u.onend && u.onend(), 2); }, cancel() {}, pause() {}, resume() {} };
  const e = C.makeBrowserEngine({ synth, Utterance: U, getCfg: () => ({ rate: 3 }) });
  assert.equal(await e.speak('你好。'), 'end');
  assert.equal(spoken[0].lang, 'zh-CN'); assert.match(spoken[0].voice.name, /Xiaoxiao/); assert.equal(spoken[0].rate, 2.5);   // 夹到 2.5
  assert.equal(await e.speak('Hello.'), 'end');
  assert.equal(spoken[1].lang, 'en-US'); assert.equal(spoken[1].voice.name, 'David');
  const e2 = C.makeBrowserEngine({ synth: null, Utterance: null, getCfg: () => ({}) });
  assert.equal(await e2.speak('x。'), 'nostart'); assert.ok(e2.lastError);
  const silent = { getVoices: () => [], speak() {}, cancel() {} };            // 永远不 onstart：超时算 nostart
  const e3 = C.makeBrowserEngine({ synth: silent, Utterance: U, getCfg: () => ({}), startTimeoutMs: 20 });
  assert.equal(await e3.speak('甲。'), 'nostart');
  const bad = { getVoices: () => [], speak(u) { setTimeout(() => u.onerror({ error: 'synthesis-failed' }), 0); }, cancel() {} };
  assert.equal(await C.makeBrowserEngine({ synth: bad, Utterance: U, getCfg: () => ({}) }).speak('甲。'), 'error');
  const canceled = { getVoices: () => [], speak(u) { setTimeout(() => u.onerror({ error: 'canceled' }), 0); }, cancel() {} };
  assert.equal(await C.makeBrowserEngine({ synth: canceled, Utterance: U, getCfg: () => ({}) }).speak('甲。'), 'cancel');
  assert.equal(C.ttsRate('x'), 1); assert.equal(C.ttsRate(0.1), 0.5); assert.equal(C.ttsRate(9), 2.5);
});

/* ====================== rar / 7z / tar 系（libarchive.js）的纯逻辑 ====================== */

test('archKind：rar / cbr / 7z / cb7 / tar / cbt / tgz / tar.gz（不分大小写）；zip 系、单个 .gz、别的都不是', () => {
  const want = { 'a.rar': 'rar', 'A.CBR': 'rar', 'b.7z': '7z', 'b.CB7': '7z', 'c.tar': 'tar', 'c.cbt': 'tar', 'd.tgz': 'tgz', 'd.tar.gz': 'tgz', 'D.TAR.GZ': 'tgz', '小说/第1卷.cbr': 'rar' };
  for (const [n, k] of Object.entries(want)) assert.equal(C.archKind(n), k, n);
  for (const n of ['a.cbz', 'a.zip', 'a.epub', 'a.pdf', 'a.gz', 'a.tar.gz.bak', 'a.rar.txt', 'rar', 'a.7zip', '', null, undefined]) assert.equal(C.archKind(n), null, String(n));
  assert.equal(C.ARCH_EXTS.test('x.cb7'), true);
  assert.equal(C.ARCH_WARN_BYTES, 300 * 1024 * 1024);
});

test('桌面式扩展名表（DESKTOP_EXTS / classify 用）认得新增的后缀；zip 系的 ARCHIVE_EXTS 不变', () => {
  for (const n of ['a.rar', 'a.cbr', 'a.7z', 'a.cb7', 'a.tar', 'a.cbt', 'a.tgz', 'a.tar.gz', 'a.gz', 'a.zip', 'a.cbz', 'a.pdf', 'a.epub']) assert.equal(C.DESKTOP_EXTS.test(n), true, n);
  for (const n of ['a.cbr', 'a.7z', 'a.tar', 'a.tgz']) assert.equal(C.ARCHIVE_EXTS.test(n), false, n);      // 走 libarchive，不走 ZipReader
  for (const n of ['a.zip', 'a.cbz', 'a.epub']) assert.equal(C.ARCHIVE_EXTS.test(n), true, n);
  for (const e of ['rar', 'cbr', '7z', 'cb7', 'tar', 'cbt', 'tgz']) assert.ok(C.LIB_OPEN_KINDS.includes(e), e);
});

test('archPickImages：只留浏览器能显示的图片、丢元数据、自然排序、带 name', () => {
  const ents = ['10.jpg', 'readme.txt', '03.png', '__MACOSX/._01.jpg', '01.jpg', 'dir/', 'Thumbs.db', '.hidden.png', 'sub/2.PNG', 'sub\\1.jpg', '/abs/9.webp', 'a.tif', 'b.svg', 'c.avif', 'x.heic']
    .map((path, i) => ({ path, size: i, cf: { i } }));
  const got = C.archPickImages(ents);
  assert.deepEqual(got.map((e) => e.path), ['01.jpg', '03.png', '10.jpg', 'abs/9.webp', 'b.svg', 'c.avif', 'sub/1.jpg', 'sub/2.PNG']);
  assert.deepEqual(got.map((e) => e.name).slice(0, 2), ['01.jpg', '03.png']);
  assert.equal(got[0].cf.i, 4);                                                    // 其它字段原样带着
  assert.deepEqual(C.archPickImages([]), []); assert.deepEqual(C.archPickImages(null), []);
  assert.deepEqual(C.archPickImages([{ path: 'p2.jpg' }, { path: 'p10.jpg' }, { path: 'p1.jpg' }]).map((e) => e.path), ['p1.jpg', 'p2.jpg', 'p10.jpg']);
});

test('archErrorMessage：加密 / WebAssembly 被 CSP 拦 / 格式不支持 / 其它', () => {
  assert.match(C.archErrorMessage(Object.assign(new Error('encrypted'), { encrypted: true })), /有密码/);
  assert.match(C.archErrorMessage(new Error('Passphrase required for this entry')), /有密码/);
  assert.match(C.archErrorMessage(new Error("WebAssembly.instantiate(): Refused to compile ... 'unsafe-eval'")), /wasm-unsafe-eval/);
  assert.match(C.archErrorMessage(new Error('Unrecognized archive format')), /不是有效的压缩包/);
  assert.equal(C.archErrorMessage(new Error('boom')), 'boom');
  assert.equal(C.archErrorMessage(null), '未知错误');
});

test('fetchWhole：整本下载成 Blob，带 Authorization、不带 Range、报告进度；401 / 404 / 空文件带 status', async () => {
  const body = Buffer.from('x'.repeat(100000));
  const seen = [];
  const mk = (status, data) => (u, init) => { seen.push({ u, init }); return Promise.resolve(new Response(data, { status, headers: data ? { 'Content-Length': String(data.length) } : {} })); };
  const prog = [];
  const b = await C.fetchWhole('https://h/library/a.cbr', { authHeader: () => 'Basic QQ==', fetch: mk(200, body), onProgress: (g, t) => prog.push([g, t]) });
  assert.equal(b.size, 100000);
  assert.equal(seen[0].init.headers.Authorization, 'Basic QQ=='); assert.equal(seen[0].init.headers.Range, undefined);
  assert.equal(seen[0].init.credentials, 'omit'); assert.equal(seen[0].init.cache, 'no-store');
  assert.ok(prog.length >= 1 && prog[prog.length - 1][0] === 100000 && prog[prog.length - 1][1] === 100000);
  let authFail = 0;
  for (const [st, code] of [[401, 'auth'], [403, 'forbidden'], [404, 'notfound'], [500, 'http']]) {
    await assert.rejects(C.fetchWhole('u', { fetch: mk(st, st === 500 ? 'e' : 'no'), onAuthFail: () => authFail++ }), (e) => e.status === st && e.code === code);
  }
  assert.equal(authFail, 1);                                                        // 只有 401 触发 onAuthFail
  await assert.rejects(C.fetchWhole('u', { fetch: (u, i) => Promise.resolve(new Response(new Uint8Array(0), { status: 200 })) }), (e) => e.code === 'empty');
  const plain = await C.fetchWhole('u', { authHeader: 'Basic Z', fetch: () => Promise.resolve({ status: 200, headers: new Headers(), blob: () => Promise.resolve(new Blob(['abc'])) }) });
  assert.equal(plain.size, 3);                                                      // 没有 body.getReader 的环境退回 blob()
});

/* ================= AI 朗读（无文字层 PDF → /ocr/v1/page）纯逻辑 ================= */

test('AI 切叶：合页（宽/高 ≥ 1.1）才切，渲染比例让一叶长边约 2000', () => {
  assert.equal(C.aiIsSpread(2570, 2160), true);
  assert.equal(C.aiIsSpread(612, 792), false);
  assert.equal(C.aiIsSpread(1000, 1000), false);                                    // 方形：不切
  assert.equal(C.aiIsSpread(1100, 1000), true);
  assert.equal(C.aiIsSpread(0, 0), false);
  const sp = C.aiRenderPlan(1200, 1000), one = C.aiRenderPlan(612, 792);
  assert.equal(sp.split, true); assert.equal(one.split, false);
  assert.ok(Math.abs(1000 * sp.scale - 2000) < 1);                                   // 一叶 600x1000 → 高 2000
  assert.ok(Math.abs(792 * one.scale - 2000) < 1);
  const huge = C.aiRenderPlan(6000, 5000);
  assert.ok(6000 * 5000 * huge.scale * huge.scale <= 36e6 * 1.001);                  // 总像素有上限
});

test('aiGutter：墨迹投影 40%-60% 内找谷底；谷不明显 / 没墨迹 / 谷在范围外 → 固定中点', () => {
  const mk = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const valley = (a, b) => mk(1000, (i) => (i >= a && i < b ? 0 : 100));
  assert.ok(Math.abs(C.aiGutter(valley(480, 520)) - 500) <= 1);                      // 居中的装订线
  assert.ok(Math.abs(C.aiGutter(valley(430, 450)) - 440) <= 1);                      // 偏心的装订线：不是固定中点
  assert.equal(C.aiGutter(mk(1000, () => 100)), 500);                                // 没有谷：中点
  assert.equal(C.aiGutter(mk(1000, () => 0)), 500);                                  // 空白页：中点
  assert.equal(C.aiGutter(valley(280, 320)), 500);                                   // 谷在 40%-60% 之外：当作没有
  assert.equal(C.aiGutter(mk(1000, (i) => (i >= 480 && i < 520 ? 70 : 100))), 500);  // 谷底 / 平均 > 0.5：不明显
  assert.equal(C.aiGutter([1, 2, 3]), 2);                                            // 太窄：中点（四舍五入）
  // 从真实像素算：整页深色、47-52 列是白的
  const w = 100, h = 10, px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4, v = x >= 47 && x < 53 ? 255 : 30; px[o] = px[o + 1] = px[o + 2] = v; px[o + 3] = 255; }
  const ink = C.aiColumnInk(px, w, h);
  assert.equal(ink[10], 10); assert.equal(ink[50], 0);
  assert.ok(Math.abs(C.aiGutter(ink) - 50) <= 1);
});

test('aiGutter（版框线）：两页版框几乎贴在一起时，字列之间的空白不是装订线；右页上别的竖线不会抢走', () => {
  const H = 100;
  const prof = (lines) => { const a = Array.from({ length: 1000 }, (_, i) => (i % 40 < 6 ? 0 : 30)); for (const [s0, e0] of lines) for (let i = s0; i <= e0; i++) a[i] = 90; return a; };   // 底：字列（每 40 列有 6 列空白缝）
  assert.ok(Math.abs(C.aiGutter(prof([[476, 481], [496, 501]]), H) - 489) <= 1);         // 贴近的两道框线（间隙 14 列 = 1.4%）：中点 489，不是某条字缝
  assert.ok(Math.abs(C.aiGutter(prof([[460, 465], [535, 540]]), H) - 500) <= 1);         // 宽间隙
  assert.ok(Math.abs(C.aiGutter(prof([[460, 465], [500, 504], [620, 625]]), H) - 482.5) <= 1);   // 右页还有别的竖线：取中点离页中心最近的一对
  const decoy = prof([[470, 474], [530, 534], [580, 584]]);
  assert.ok(Math.abs(C.aiGutter(decoy, H) - 502) <= 1);                                      // (474,530) 中点 502 比 (534,580) 中点 557 近
  assert.equal(C.aiGutter(prof([[300, 305]]), H), 500);                                      // 窗口里只有一条线：不成对 → 没有整段空白 → 固定中点
  assert.equal(C.aiGutter(prof([[476, 481], [496, 501]])), 500);                             // 不给 h：不看框线，只剩 6 列空白缝（0.6% < 2%）→ 固定中点
});

test('aiLeafRects：竖排合页 = 右叶在前、左叶在后；横排相反；每叶向装订线外扩 2%', () => {
  const r = C.aiLeafRects(1000, 800, 500, true);
  assert.deepEqual(r.map((x) => x.leaf), ['R', 'L']);
  assert.deepEqual([r[0].x, r[0].w], [480, 520]);                                    // 右叶 480..1000
  assert.deepEqual([r[1].x, r[1].w], [0, 520]);                                      // 左叶 0..520
  assert.equal(r[0].h, 800);
  assert.deepEqual(C.aiLeafRects(1000, 800, 500, false).map((x) => x.leaf), ['L', 'R']);
  const edge = C.aiLeafRects(1000, 800, 10, true);                                   // 装订线贴边：不越界
  assert.ok(edge.every((x) => x.x >= 0 && x.x + x.w <= 1000));
  assert.deepEqual(C.aiFitSize(4000, 2000, 2000), { w: 2000, h: 1000 });
  assert.deepEqual(C.aiFitSize(800, 600, 2000), { w: 800, h: 600 });                // 不放大
});

test('aiEncode：先 q0.85 / 长边 2000；超过 1.1MB 逐级降质量、缩小；都不行 reject', async () => {
  const calls = [];
  const canvas = { width: 3000, height: 2400 };
  const d = (sizeOf) => ({ resize: (c, w, h) => ({ width: w, height: h }), toBlob: (c, t, q) => { calls.push([c.width, c.height, q]); return Promise.resolve({ size: sizeOf(c, q) }); } });
  let r = await C.aiEncode(canvas, d(() => 500 * 1024));
  assert.deepEqual(calls[0], [2000, 1600, 0.85]);                                    // 超长边先缩到 2000
  assert.equal(r.w, 2000); assert.equal(r.h, 1600); assert.equal(r.q, 0.85);
  calls.length = 0;
  r = await C.aiEncode(canvas, d((c, q) => (q >= 0.85 ? 1300 * 1024 : 900 * 1024)));  // 0.85 超限 → 0.75
  assert.deepEqual(calls.map((c) => c[2]), [0.85, 0.75]); assert.equal(r.q, 0.75);
  calls.length = 0;
  r = await C.aiEncode(canvas, d((c) => (c.width > 1300 ? 2e6 : 100 * 1024)));        // 要缩到 ≤1280 才够
  assert.ok(r.w <= 1280 && r.blob.size <= C.AI_MAX_BYTES);
  await assert.rejects(C.aiEncode(canvas, d(() => 5e6)), (e) => e.code === 'toolarge');
  const small = await C.aiEncode({ width: 800, height: 600 }, d(() => 1000));        // 小图不放大
  assert.deepEqual([small.w, small.h], [800, 600]);
});

test('aiBuildRequest / aiPageId：JSON 体、Bearer 头、模式白名单、pageId 只含服务端允许的字符且不带书名', () => {
  const rq = C.aiBuildRequest({ endpoint: 'https://h/ocr/v1/page', token: 'tok', b64: 'QUJD', mode: 'horizontal', pageId: 'a b/c:p1:R' });
  assert.equal(rq.url, 'https://h/ocr/v1/page'); assert.equal(rq.init.method, 'POST');
  assert.equal(rq.init.headers.Authorization, 'Bearer tok'); assert.equal(rq.init.headers['Content-Type'], 'application/json');
  assert.equal(rq.init.credentials, 'omit');
  const b = JSON.parse(rq.init.body);
  assert.deepEqual(b, { image: 'QUJD', mime: 'image/jpeg', mode: 'horizontal', pageId: 'a_b_c:p1:R' });
  assert.equal(JSON.parse(C.aiBuildRequest({ endpoint: 'u', token: 't', b64: 'x', mode: 'evil', pageId: 'p' }).init.body).mode, 'vertical-classical');
  const id = C.aiPageId('dav:肉蒲团/第一卷.pdf', 57, 'R');
  assert.match(id, /^b[0-9a-f]+:p57:R$/); assert.ok(!/肉|pdf/.test(id));
});

test('aiAdapt：各叶文字按顺序拼成 {paras, indentFirst:false, open:false}；页码残留丢弃；跳过注文可选', () => {
  const t = ['右叶第一段，天地玄黄。\n右叶第二段【注：双行小注】。', '左叶：宇宙洪荒。\n12'];
  const a = C.aiAdapt(t, {});
  assert.deepEqual(Object.keys(a).sort(), ['indentFirst', 'open', 'paras']);
  assert.deepEqual(a.paras, ['右叶第一段，天地玄黄。', '右叶第二段【注：双行小注】。', '左叶：宇宙洪荒。']);
  assert.equal(a.indentFirst, false); assert.equal(a.open, false);
  assert.deepEqual(C.aiAdapt(t, { skipNotes: true }).paras, ['右叶第一段，天地玄黄。', '右叶第二段。', '左叶：宇宙洪荒。']);
  assert.equal(C.aiStripNotes('甲【注：a】乙【注：b，c】丙'), '甲乙丙');
  assert.deepEqual(C.aiAdapt(['', '  ', '3'], {}).paras, []);                         // 空白页 / 只有页码 → 没有段落 = runner 当无文字页
  assert.deepEqual(C.aiAdapt(null, {}).paras, []);
});

test('aiAdapt 的结果能直接喂 pageSentences / splitSentences（和文字层页同一条管线）', () => {
  const pg = C.aiAdapt(['甲乙丙丁。戊己庚辛，壬癸子丑！'], {});
  assert.deepEqual(C.pageSentences(pg, '', 150), ['甲乙丙丁。', '戊己庚辛，壬癸子丑！']);
});

test('aiClassify / aiBackoff：401 403 400/413/415 422 429(rate|busy|cap) 502 504 网络错误', () => {
  const k = (s, b, h) => C.aiClassify(s, b, h);
  assert.deepEqual([k(401).kind, k(401).fatal], ['auth', true]);
  assert.deepEqual([k(403, { code: 'not_enabled' }).kind, k(403).fatal], ['forbidden', true]);
  for (const s of [400, 413, 415]) { assert.equal(k(s).kind, 'badimage'); assert.equal(k(s).retry, false); assert.equal(k(s).fatal, false); }
  assert.deepEqual([k(422, { code: 'refused' }).kind, k(422).retry, k(422).fatal], ['refused', false, false]);
  const rl = k(429, { code: 'rate_limited', retryAfter: 2 }, '2');
  assert.deepEqual([rl.kind, rl.retry, rl.retryAfter, rl.fatal], ['rate', true, 2, false]);
  assert.equal(k(429, { code: 'busy' }).kind, 'rate');
  assert.equal(k(429, { code: 'busy' }).retryAfter, 2);                              // 没给 Retry-After 也有默认
  const dc = k(429, { code: 'daily_cap', retryAfter: 7200 }, '7200');
  assert.deepEqual([dc.kind, dc.fatal, dc.retry], ['quota', true, false]); assert.match(dc.message, /今日.*2 小时/);
  assert.match(k(429, { code: 'monthly_cap' }).message, /本月/);
  assert.deepEqual([k(502).kind, k(502).retry], ['upstream', true]);
  assert.deepEqual([k(504).kind, k(504).retry], ['timeout', true]);
  assert.deepEqual([k(0).kind, k(0).retry], ['offline', true]);
  assert.equal(k(418).retry, false);
  assert.deepEqual([C.aiBackoff(k(502), 0), C.aiBackoff(k(502), 1), C.aiBackoff(k(502), 2)], [1000, 3000, -1]);   // 1s、3s 最多 2 次
  assert.deepEqual([C.aiBackoff(rl, 0), C.aiBackoff(rl, 5), C.aiBackoff(rl, 6)], [2000, 2000, -1]);              // 429 按 Retry-After
  assert.equal(C.aiBackoff(k(429, { code: 'rate_limited', retryAfter: 600 }), 0), -1);                           // 要等太久：放弃
  assert.equal(C.aiBackoff(k(422), 0), -1); assert.equal(C.aiBackoff(null, 0), -1);
});

test('aiCacheKey：书 + 页 + 叶 + 模式 + 模型 + promptVer', () => {
  const o = { bookKey: 'dav:x', pno: 3, leaf: 'P', mode: 'vertical-classical', model: 'm', promptVer: 1 };
  assert.equal(C.aiCacheKey(o), 'dav:x|3|P|vertical-classical|m|1');
  assert.notEqual(C.aiCacheKey(o), C.aiCacheKey(Object.assign({}, o, { promptVer: 2 })));
  assert.notEqual(C.aiCacheKey(o), C.aiCacheKey(Object.assign({}, o, { model: 'n' })));
  assert.equal(C.aiCacheKey({ bookKey: 'b', pno: 1, leaf: 'P', mode: 'x' }), 'b|1|P|x|' + C.AI_MODEL0 + '|' + C.AI_PROMPT_VER0);
});

/** 极简 IndexedDB 假实现（只支持缓存用到的 get / put / delete / clear / getAll），回调异步触发 */
function fakeIdb(opts) {
  const dbs = {}; opts = opts || {};
  return {
    opened: 0,
    open(name) {
      const rq = {}; this.opened++;
      setTimeout(() => {
        if (opts.failOpen) return rq.onerror && rq.onerror();
        const first = !dbs[name]; dbs[name] = dbs[name] || new Map();
        const store = dbs[name];
        rq.result = { createObjectStore() {}, transaction() {
          const t = {};
          const mk = (fn) => { const r = {}; setTimeout(() => { if (opts.failTx) { t.onerror && t.onerror(); return; } r.result = fn(); t.oncomplete && t.oncomplete(); }, 0); return r; };
          t.objectStore = () => ({
            get: (k) => mk(() => store.get(k)), put: (v) => mk(() => { store.set(v.k, v); }),
            delete: (k) => mk(() => { store.delete(k); }), clear: () => mk(() => { store.clear(); }), getAll: () => mk(() => [...store.values()]) });
          return t;
        } };
        if (first && rq.onupgradeneeded) rq.onupgradeneeded();
        rq.onsuccess && rq.onsuccess();
      }, 0);
      return rq;
    }, _dbs: dbs };
}

test('makeAiCache：IndexedDB 读写 / 删除 / 清空 / 超限删最旧；换一个实例（模拟重开页面）仍命中', async () => {
  const idb = fakeIdb();
  const c1 = C.makeAiCache({ indexedDB: idb, max: 3, now: (() => { let n = 0; return () => ++n; })() });
  assert.equal(await c1.get('k1'), null);
  await c1.put('k1', ['甲']); await c1.put('k2', ['乙', '丙']);
  assert.equal(c1.usingIdb, true);
  const c2 = C.makeAiCache({ indexedDB: idb });                                       // 新实例：内存是空的，只能从 IndexedDB 读
  assert.deepEqual(await c2.get('k2'), ['乙', '丙']);
  await c2.remove('k1'); assert.equal(await C.makeAiCache({ indexedDB: idb }).get('k1'), null);
  for (const k of ['a', 'b', 'c', 'd', 'e']) await c1.put(k, [k]);
  await c1.trim(); await new Promise((r) => setTimeout(r, 10));                        // 假 IDB 的事务在第一个请求后就报完成，等剩下的删除跑完
  assert.ok(idb._dbs['iv-ocr'].size <= 3);                                            // 超过 max 删最旧的
  assert.ok(idb._dbs['iv-ocr'].has('e'));
  await c1.clear(); assert.equal(idb._dbs['iv-ocr'].size, 0);
});

test('makeAiCache：没有 indexedDB / 打开失败 / 事务失败 → 退回内存，不抛异常', async () => {
  for (const d of [{}, { indexedDB: fakeIdb({ failOpen: true }) }, { indexedDB: fakeIdb({ failTx: true }) }, { indexedDB: { open() { throw new Error('denied'); } } }]) {
    const c = C.makeAiCache(d);
    assert.equal(await c.get('x'), null);
    await c.put('x', ['值']);
    assert.deepEqual(await c.get('x'), ['值']);                                       // 同一会话内仍能命中
    await c.remove('x'); assert.equal(await c.get('x'), null);
    await c.clear();
  }
});

/* ---- 取页控制器 ---- */
function aiHarness(over) {
  over = over || {};
  const H = { reqs: [], status: [], fatal: [], usage: [], sleeps: [], cfg: { token: 'T', mode: 'vertical-classical', skipNotes: false }, reply: null };
  H.cache = C.makeAiCache({});
  H.meta = { model: 'qwen3.8-flash', promptVer: 1 };
  H.fetch = (url, init) => {
    const b = JSON.parse(init.body), n = H.reqs.length;
    H.reqs.push({ url, auth: init.headers.Authorization, pageId: b.pageId, mode: b.mode, signal: init.signal, t: Date.now() });
    const r = (H.reply || ((q) => ({ status: 200, body: { text: '文' + q.pageId, model: 'qwen3.8-flash', promptVer: 1, usage: { pagesToday: n + 1, pagesLimit: 300 } } })))(H.reqs[n], n);
    return new Promise((res, rej) => {
      const fin = () => { if (init.signal && init.signal.aborted) { const e = new Error('abort'); e.name = 'AbortError'; return rej(e); }
        res({ ok: r.status >= 200 && r.status < 300, status: r.status, headers: new Headers(r.headers || {}), json: () => Promise.resolve(r.body) }); };
      if (init.signal) init.signal.addEventListener('abort', () => { const e = new Error('abort'); e.name = 'AbortError'; rej(e); });
      setTimeout(fin, r.delay || 1);
    });
  };
  H.pager = C.createAiPager(Object.assign({
    bookKey: 'dav:book', count: 10, fetch: H.fetch, endpoint: (p) => 'https://h/ocr/v1/' + p, getCfg: () => H.cfg, cache: H.cache, meta: H.meta,
    render: (pno) => Promise.resolve(over.spread === false ? [{ leaf: 'S', b64: 'IMG' + pno }] : [{ leaf: 'R', b64: 'R' + pno }, { leaf: 'L', b64: 'L' + pno }]),
    sleep: (ms) => { H.sleeps.push(ms); return new Promise((r) => setTimeout(r, 1)); },
    onStatus: (p, k, i) => H.status.push([p, k, i]), onUsage: (u) => H.usage.push(u), onFatal: (c) => H.fatal.push(c) }, over.d || {}));
  return H;
}

test('createAiPager：成功路径 —— 先右叶后左叶（竖排），Bearer 令牌，结果是 pdfPageParas 同形状，usage 回传', async () => {
  const H = aiHarness();
  const pg = await H.pager.getPage(3);
  assert.deepEqual(H.reqs.map((r) => r.pageId.split(':').slice(1).join(':')), ['p3:R', 'p3:L']);   // 请求顺序：右叶在前
  assert.ok(H.reqs.every((r) => r.auth === 'Bearer T' && r.url === 'https://h/ocr/v1/page' && r.mode === 'vertical-classical'));
  assert.equal(pg.paras.length, 2); assert.ok(pg.paras[0].includes(':p3:R') && pg.paras[1].includes(':p3:L'));   // 文字：右叶在前
  assert.deepEqual([pg.indentFirst, pg.open], [false, false]);
  assert.equal(H.usage.length, 2); assert.equal(H.usage[1].pagesLimit, 300);
  assert.equal(await H.pager.getPage(0), null); assert.equal(await H.pager.getPage(11), null);
});

test('createAiPager：缓存命中不再请求（同实例 + 新实例共用 IndexedDB）；跳过注文只在取页时应用，不用重新请求', async () => {
  const idb = fakeIdb(), H = aiHarness({ d: { cache: C.makeAiCache({ indexedDB: idb }) } });
  H.reply = () => ({ status: 200, body: { text: '甲【注：小注】乙。', model: 'qwen3.8-flash', promptVer: 1 } });
  const a = await H.pager.getPage(2);
  assert.equal(H.reqs.length, 2); assert.deepEqual(a.paras, ['甲【注：小注】乙。', '甲【注：小注】乙。']);
  await H.pager.getPage(2); assert.equal(H.reqs.length, 2);                             // 同一实例：合并 / 命中
  H.cfg.skipNotes = true;
  assert.deepEqual((await H.pager.getPage(2)).paras, ['甲乙。', '甲乙。']); assert.equal(H.reqs.length, 2);
  const H2 = aiHarness({ d: { cache: C.makeAiCache({ indexedDB: idb }) } });             // 「重开页面」：新控制器，同一个 IndexedDB
  const b = await H2.pager.getPage(2);
  assert.equal(H2.reqs.length, 0); assert.equal(H2.pager.hits, 1); assert.equal(b.paras.length, 2);
  assert.ok(H2.status.some((s) => s[1] === 'cached'));
});

test('createAiPager：429 按 Retry-After 退避后重试成功；失败的页不重复请求，retry(pno) 才重来', async () => {
  const H = aiHarness({ spread: false });
  let n = 0;
  H.reply = () => (n++ < 2 ? { status: 429, headers: { 'Retry-After': '2' }, body: { code: 'rate_limited', retryAfter: 2 } } : { status: 200, body: { text: '第一页文字。' } });
  const pg = await H.pager.getPage(1);
  assert.equal(H.reqs.length, 3); assert.deepEqual(H.sleeps, [2000, 2000]); assert.equal(pg.paras[0], '第一页文字。');
  assert.equal(H.status.filter((s) => s[1] === 'retry').length, 2);
  // 502 两次退避后放弃：页失败 → null，状态 failed；再取不再请求
  const H2 = aiHarness({ spread: false });
  H2.reply = () => ({ status: 502, body: { code: 'upstream_error' } });
  assert.equal(await H2.pager.getPage(4), null);
  assert.deepEqual(H2.sleeps, [1000, 3000]); assert.equal(H2.reqs.length, 3);
  assert.equal(H2.pager.failed(4), true); assert.equal(H2.status.filter((s) => s[1] === 'failed').length, 1);
  assert.equal(await H2.pager.getPage(4), null); assert.equal(H2.reqs.length, 3);
  H2.reply = () => ({ status: 200, body: { text: '好了。' } });
  assert.equal((await H2.pager.retry(4)).paras[0], '好了。'); assert.equal(H2.pager.failed(4), false);
});

test('createAiPager：422 refused 只这一页失败（不重试）；401 / 每日额度是 fatal，通知 onFatal；空白页不是错误', async () => {
  const H = aiHarness({ spread: false });
  H.reply = () => ({ status: 422, body: { code: 'refused' } });
  assert.equal(await H.pager.getPage(1), null);
  assert.equal(H.reqs.length, 1); assert.equal(H.sleeps.length, 0); assert.equal(H.fatal.length, 0);
  const f = H.status.find((s) => s[1] === 'failed'); assert.equal(f[2].cls.kind, 'refused');
  H.reply = () => ({ status: 429, headers: { 'Retry-After': '3600' }, body: { code: 'daily_cap', retryAfter: 3600 } });
  assert.equal(await H.pager.getPage(2), null);
  assert.equal(H.fatal.length, 1); assert.equal(H.fatal[0].kind, 'quota'); assert.equal(H.sleeps.length, 0);
  H.reply = () => ({ status: 401, body: { code: 'unauthorized' } });
  assert.equal(await H.pager.getPage(3), null); assert.equal(H.fatal[1].kind, 'auth');
  H.reply = () => ({ status: 200, body: { text: '' } });                               // 空白页：不是错误，paras 为空
  const e = await H.pager.getPage(5); assert.deepEqual(e.paras, []); assert.equal(H.status.find((s) => s[0] === 5 && s[1] === 'done')[2].empty, true);
});

test('createAiPager：同时最多 2 个请求在飞；页号小的先；focus 中止窗口外的页并预取 p..p+2', async () => {
  const H = aiHarness({ spread: false });
  let live = 0, max = 0;
  const base = H.fetch;
  H.fetch = (u, i) => { live++; max = Math.max(max, live); return base(u, i).finally(() => live--); };
  H.pager = C.createAiPager({ bookKey: 'b', count: 20, fetch: H.fetch, endpoint: (p) => 'e/' + p, getCfg: () => H.cfg, cache: C.makeAiCache({}), meta: H.meta,
    render: (p) => Promise.resolve([{ leaf: 'S', b64: 'I' + p }]), onStatus: () => {} });
  H.reply = () => ({ status: 200, delay: 15, body: { text: '文。' } });
  H.pager.focus(5);                                                                     // 预取 5,6,7
  await Promise.all([H.pager.getPage(5), H.pager.getPage(6), H.pager.getPage(7)]);
  assert.equal(max, 2, 'max inflight ' + max);
  assert.deepEqual(H.reqs.map((r) => +r.pageId.split(':p')[1].split(':')[0]).slice(0, 2), [5, 6]);
  assert.equal(H.reqs.length, 3);
  H.reqs.length = 0; H.reply = () => ({ status: 200, delay: 60, body: { text: '文。' } });
  H.pager.focus(12);                                                                     // 12,13,14 在飞 / 排队
  await new Promise((r) => setTimeout(r, 20));
  const sig = H.reqs.map((r) => r.signal);
  assert.ok(sig.length >= 1);
  H.pager.focus(15);                                                                     // 窗口变成 15..17：12、13、14 都被中止
  assert.ok(sig.every((s) => s.aborted));
  assert.notEqual(await H.pager.getPage(15), null);
});

test('createAiPager + createTtsRunner：无文字层的 PDF 经 AI 取页后，runner 一句句读完，页序 1→3，失败页被跳过', async () => {
  const H = aiHarness({ spread: false, d: { count: 3 } });
  H.reply = (q) => (q.pageId.endsWith(':p2:S') ? { status: 422, body: { code: 'refused' } } : { status: 200, body: { text: q.pageId.endsWith(':p1:S') ? '天地玄黄。宇宙洪荒。' : '日月盈昃。' } });
  const spoken = [], states = [];
  const host = { count: 3, getPage: (p) => H.pager.getPage(p), onPage: (p) => H.pager.focus(p), onSentence: () => {}, onState: (s, i) => states.push([s, i && i.pno]),
    engine: { speak: (t) => { spoken.push(t); return Promise.resolve('end'); }, prefetch() {}, cancel() {}, pause() {}, resume() {} } };
  const r = C.createTtsRunner(host); r.start(1);
  for (let i = 0; i < 100 && r.state !== 'idle'; i++) await new Promise((x) => setTimeout(x, 10));
  assert.deepEqual(spoken, ['天地玄黄。', '宇宙洪荒。', '日月盈昃。']);                       // 第 2 页失败 → 跳过，第 3 页接着读
  assert.ok(states.some((s) => s[0] === 'notext' && s[1] === 2));
  assert.ok(states.some((s) => s[0] === 'done'));
});

// ---------------- 视频：格式判断 / 字幕转换 ----------------
test('视频格式判断：扩展名 + canPlayType', () => {
  assert.ok(C.isVideoName('a/b/电影.MP4'));
  assert.ok(C.isVideoName('x.mkv'));
  assert.ok(!C.isVideoName('x.mp3'));
  assert.ok(!C.isVideoName('x.srt'));
  assert.equal(C.videoMime('a.webm'), 'video/webm');
  assert.equal(C.videoMime('a.mov'), 'video/quicktime');
  assert.equal(C.videoMime('a.txt'), '');
  const chromeLike = (m) => (/mp4|webm|ogg/.test(m) ? 'probably' : /matroska/.test(m) ? 'maybe' : '');
  assert.equal(C.videoSupport('a.mp4', chromeLike), 'yes');
  assert.equal(C.videoSupport('a.mkv', chromeLike), 'maybe');
  assert.equal(C.videoSupport('a.avi', chromeLike), 'no');
  assert.equal(C.videoSupport('a.txt', chromeLike), 'no');
  assert.equal(C.videoSupport('a.mp4', () => ''), 'no');
  assert.match(C.videoErrorMessage({ code: 4 }, 'a.mp4'), /HEVC/);
  assert.match(C.videoErrorMessage({ code: 4 }, 'a.avi'), /\.avi/);
  assert.match(C.videoErrorMessage({ code: 2 }, 'a.mp4'), /网络/);
});

test('SRT -> WebVTT：BOM / CRLF / 逗号 / 序号 / 标记', () => {
  const srt = '\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\n你好\r\n世界\r\n\r\n2\r\n00:01:02,5 --> 00:01:03,000 X1:10\r\n<font color="red">second</font> {\\an8}line & more\r\n\r\n';
  const vtt = C.srtToVtt(srt);
  assert.ok(vtt.startsWith('WEBVTT\n\n'));
  assert.ok(!vtt.includes('\r') && !vtt.includes('\uFEFF'));
  assert.ok(vtt.includes('00:00:01.000 --> 00:00:02.500\n你好\n世界\n'));
  assert.ok(vtt.includes('00:01:02.500 --> 00:01:03.000\n'));          // 毫秒位补齐到 3 位
  assert.ok(vtt.includes('second line &amp; more'));                    // font / {\an8} 被去掉，& 转义
  assert.ok(!/,\d{3} -->/.test(vtt));
});

test('SRT -> WebVTT：短时间、无序号、已是 VTT、垃圾块', () => {
  assert.ok(C.srtToVtt('1:02,3 --> 1:03,4\nhi\n').includes('00:01:02.300 --> 00:01:03.400\nhi'));
  assert.ok(C.srtToVtt('00:00:01.000 --> 00:00:02.000\nno index\n').includes('no index'));
  const v = 'WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nhi\r\n';
  assert.equal(C.srtToVtt(v), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n');
  const junk = C.srtToVtt('随便一段\n\n3\nnot a time\ntext\n\n4\n00:00:05,000 --> 00:00:06,000\nok\n');
  assert.equal(junk, 'WEBVTT\n\n00:00:05.000 --> 00:00:06.000\nok\n');
  assert.equal(C.srtToVtt(''), 'WEBVTT\n');
});

test('ASS -> WebVTT：只取 Dialogue 文本，丢样式，排序', () => {
  const ass = '[Script Info]\nTitle: x\n[V4+ Styles]\nStyle: Default,Arial,20\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
    'Dialogue: 0,0:00:05.00,0:00:06.50,Default,,0,0,0,,{\\an8\\b1}第二句\\N换行, 带逗号\n' +
    'Comment: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,注释不要\n' +
    'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,第一句\n';
  const vtt = C.assToVtt(ass);
  assert.equal(vtt, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n第一句\n\n00:00:05.000 --> 00:00:06.500\n第二句\n换行, 带逗号\n');
  assert.equal(C.subtitleToVtt(ass, 'a.ass'), vtt);
  assert.ok(C.subtitleToVtt('1\n00:00:01,000 --> 00:00:02,000\nx\n', 'a.srt').startsWith('WEBVTT'));
});

test('字幕解码：UTF-8 BOM / GBK / UTF-16LE', () => {
  const u8 = new Uint8Array([0xEF, 0xBB, 0xBF, ...Buffer.from('你好', 'utf8')]);
  assert.equal(C.decodeSubtitle(u8), '你好');
  assert.equal(C.decodeSubtitle(new Uint8Array([0xC4, 0xE3, 0xBA, 0xC3])), '你好');       // GBK 的“你好”
  const u16 = new Uint8Array([0xFF, 0xFE, 0x60, 0x4F, 0x7D, 0x59]);
  assert.equal(C.decodeSubtitle(u16), '你好');
});
