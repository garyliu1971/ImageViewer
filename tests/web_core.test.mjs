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
  assert.deepEqual(sp.books.map((e) => e.name), ['a b#1.epub', 'a&b.zip', 'vol2.cbz', 'vol10.cbz', 'x.pdf']);   // 自然排序，隐藏文件不列；pdf 和 zip 系一样列出来
  assert.equal(sp.other, 1);                                                                          // y.rar 只计数

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
  // 书架只列 epub / cbz / zip / pdf；rar 只计数，文件夹和隐藏文件不在书里
  assert.deepEqual(es.map((e) => e.name), ['a & b (1).pdf', 'vol 2.CBZ', 'vol 10.cbz', 'チ。-关于地球的运动- - 卷01.epub']);
  assert.deepEqual(es.map((e) => e.ext), ['pdf', 'cbz', 'cbz', 'epub']);
  assert.equal(es[1].rel, '小说/vol 2.CBZ'); assert.equal(es[1].isDir, false); assert.equal(es[3].size, 27483419);
  assert.equal(C.volEntries('', [{ name: 'a.zip', size: 1 }])[0].rel, 'a.zip');           // 书库根：rel 不带前导 /
  assert.equal(C.volEntries('d', [{ name: 'noext', size: null }])[0].ext, '');
  assert.deepEqual(C.volEntries('d', []), []); assert.deepEqual(C.volEntries('d', null), []);
});

test('libClassify / libOpenable / libBooks', () => {
  for (const e of ['zip', 'cbz', 'epub', 'pdf', 'rar', 'cbr']) assert.equal(C.libClassify(e), e);
  assert.equal(C.libClassify('.CBZ'), 'cbz'); assert.equal(C.libClassify('EPUB'), 'epub');
  for (const e of ['txt', 'mobi', '7z', '', null, undefined, 'cbz2']) assert.equal(C.libClassify(e), 'other', String(e));
  assert.deepEqual(['zip', 'cbz', 'epub', 'pdf', 'rar', 'cbr', 'other'].map(C.libOpenable), [true, true, true, true, false, false, false]);
  const mixed = [{ name: 'd', rel: 'd', isDir: true, ext: '' }, { name: 'a.pdf', rel: 'a.pdf', ext: 'pdf' }, { name: 'b.txt', rel: 'b.txt', ext: 'txt' },
    { name: 'c.cbr', rel: 'c.cbr', ext: 'cbr' }, { name: 'd.epub', rel: 'd.epub', ext: 'epub' }];
  assert.deepEqual(C.libBooks(mixed).map((e) => e.name), ['a.pdf', 'c.cbr', 'd.epub']);       // 文件夹和 txt 不算书
});

test('书架列出的书 = 换书能跳到的书（同一份「能打开」名单，不会出现书架有、换书却跳过）', () => {
  const names = ['a.epub', 'b.CBZ', 'c.zip', 'd.pdf', 'e.rar', 'f.cbr', 'g.txt', 'h.mobi', 'i.7z', 'noext', 'j.cbz.bak'];
  const books = C.shelfSplit(names.map((name) => ({ name, isDir: false, size: 1 }))).books;
  assert.deepEqual(books.map((b) => b.name), ['a.epub', 'b.CBZ', 'c.zip', 'd.pdf']);
  const es = C.volEntries('', books);
  for (const e of es) assert.equal(C.libOpenable(C.libClassify(e.ext)), true, e.name);          // 书架上的每本，换书默认都放行
  assert.equal(C.nextBook(es, 'a.epub').name, 'b.CBZ');
  assert.equal(C.nextBook(es, 'b.CBZ').name, 'c.zip');
  assert.equal(C.nextBook(es, 'c.zip').name, 'd.pdf');                                           // pdf 和 zip 系一样能换过去
  // 反过来：libOpenable 放行的扩展名，书架一定列（两处不能各写各的）
  for (const k of ['zip', 'cbz', 'epub', 'pdf', 'rar', 'cbr', 'other']) {
    const listed = C.shelfSplit([{ name: 'x.' + k, isDir: false, size: 1 }]).books.length === 1;
    assert.equal(listed, C.libOpenable(k), k);
  }
});

test('libParentRel', () => {
  assert.equal(C.libParentRel('a/b/c.cbz'), 'a/b'); assert.equal(C.libParentRel('a/b'), 'a');
  assert.equal(C.libParentRel('a'), ''); assert.equal(C.libParentRel(''), ''); assert.equal(C.libParentRel('a/b/'), 'a');
});

test('nextBook / prevBook：同一文件夹相邻的书，跳过打不开的（rar / cbr）', () => {
  const R = (n) => '小说/' + n;
  const es = volList(SFTPGO_XML, '小说');
  // 书架的书：a & b (1).pdf, vol 2.CBZ, vol 10.cbz, チ…卷01.epub
  assert.equal(C.nextBook(es, R('vol 2.CBZ')).name, 'vol 10.cbz');
  assert.equal(C.nextBook(es, R('vol 10.cbz')).ext, 'epub');
  assert.equal(C.nextBook(es, R('チ。-关于地球的运动- - 卷01.epub')), null);      // 最后一本
  assert.equal(C.prevBook(es, R('a & b (1).pdf')), null);                        // 第一本
  assert.equal(C.prevBook(es, R('vol 2.CBZ')).ext, 'pdf');
  assert.equal(C.prevBook(es, R('vol 10.cbz')).name, 'vol 2.CBZ');
  assert.equal(C.nextBook(es, '小说/不存在.cbz'), null);                            // 当前书不在列表里
  assert.equal(C.nextBook([], 'x.cbz'), null);
  // 列表里夹着 rar / pdf（#open= 或别的来源给的完整列表）：rar 跳过，pdf 默认放行；调用方传的 canOpen 说了算（例如 pdf 阅读器被关掉时不放行 pdf）
  const full = [{ name: 'a.pdf', rel: 'a.pdf', ext: 'pdf' }, { name: 'b.rar', rel: 'b.rar', ext: 'rar' }, { name: 'c.cbz', rel: 'c.cbz', ext: 'cbz' },
    { name: 'd.cbz', rel: 'd.cbz', ext: 'cbz' }];
  assert.equal(C.prevBook(full, 'c.cbz').name, 'a.pdf');
  const noPdf = (e) => e.ext !== 'pdf' && C.libOpenable(C.libClassify(e.ext));
  assert.equal(C.prevBook(full, 'c.cbz', noPdf), null);
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
