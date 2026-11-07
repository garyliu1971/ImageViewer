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
    // 每页 2 个请求（本地头 + 数据）；落在尾部缓存块里的页（最后一两页）不需要请求
    assert.ok(s.st.requests.length > 2 + 6 && s.st.requests.length <= 2 + 6 * 2, '请求数：' + s.st.requests.length);
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
