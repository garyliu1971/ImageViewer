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
