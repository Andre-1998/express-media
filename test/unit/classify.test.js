import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyByMetrics, detectBars, motionRatio, detailScore, sampleDims,
  THRESHOLDS, KINDS, MAX_SAMPLE_W, SAMPLE_STRIDE,
} from '../../src/classify.js';

// 造一帧：背景亮度 + 上下左右黑边宽度
function makeFrame(w, h, { base = 180, bars = {} } = {}) {
  const f = Buffer.alloc(w * h, base);
  const paint = (y0, y1) => { for (let y = y0; y < y1; y += 1) for (let x = 0; x < w; x += 1) f[y * w + x] = 0; };
  const paintX = (x0, x1) => { for (let y = 0; y < h; y += 1) for (let x = x0; x < x1; x += 1) f[y * w + x] = 0; };
  if (bars.top) paint(0, bars.top);
  if (bars.bottom) paint(h - bars.bottom, h);
  if (bars.left) paintX(0, bars.left);
  if (bars.right) paintX(w - bars.right, w);
  return f;
}

test('detectBars：没有黑边就返回 null（不能什么都报）', () => {
  const f = makeFrame(64, 36, { base: 180 });
  assert.equal(detectBars(f, 64), null);
});

test('detectBars：左右黑边只报左右', () => {
  const f = makeFrame(64, 36, { base: 180, bars: { left: 10, right: 10 } });
  const b = detectBars(f, 64);
  assert.ok(b, '应该检出黑边');
  assert.deepEqual(b.by.sort(), ['left', 'right']);
  assert.ok(Math.abs(b.left - 10 / 64) < 0.02);
  assert.ok(Math.abs(b.right - 10 / 64) < 0.02);
});

test('detectBars：上下黑边只报上下', () => {
  const f = makeFrame(64, 36, { base: 180, bars: { top: 6, bottom: 6 } });
  const b = detectBars(f, 64);
  assert.deepEqual(b.by.sort(), ['bottom', 'top']);
  assert.ok(Math.abs(b.top - 6 / 36) < 0.03);
});

test('detectBars：四边都有就四个都报', () => {
  const f = makeFrame(64, 36, { base: 200, bars: { top: 4, bottom: 4, left: 8, right: 8 } });
  assert.equal(detectBars(f, 64).by.length, 4);
});

test('detectBars：整帧很暗时不下结论（那是黑屏，不是黑边）', () => {
  const dark = makeFrame(64, 36, { base: 6 });
  assert.equal(detectBars(dark, 64), null);
});

test('detectBars：细如 1 像素的暗边不算黑边（噪声）', () => {
  const f = makeFrame(64, 36, { base: 180, bars: { top: 1 } });
  assert.equal(detectBars(f, 64), null);
});

test('detectBars：宽度不够的帧直接返回 null，不许越界', () => {
  assert.equal(detectBars(Buffer.alloc(0), 64), null);
  assert.equal(detectBars(Buffer.alloc(64 * 36, 200), 0), null);
});

test('classifyByMetrics：阈值两侧都验，且落在实测空档里', () => {
  // 实测分布：0.0002（录屏）｜ 0.034~0.117（一般）｜ 0.19~0.31（高运动）
  assert.equal(classifyByMetrics({ motion: 0.0002 }), 'screen');
  assert.equal(classifyByMetrics({ motion: 0.0199 }), 'screen');
  assert.equal(classifyByMetrics({ motion: THRESHOLDS.screenMotion }), 'camera');
  assert.equal(classifyByMetrics({ motion: 0.0636 }), 'camera');
  assert.equal(classifyByMetrics({ motion: 0.117 }), 'camera');
  assert.equal(classifyByMetrics({ motion: 0.1896 }), 'motion');
  assert.equal(classifyByMetrics({ motion: 0.31 }), 'motion');
});

test('classifyByMetrics：测不出来时走保守的一档', () => {
  assert.equal(classifyByMetrics({ motion: null }), 'camera');
  assert.equal(classifyByMetrics({}), 'camera');
});

test('motionRatio：完全相同的帧是 0；变化越多量到越大；全变则接近 1', () => {
  const w = 64;
  const a = makeFrame(w, 36, { base: 100 });
  assert.equal(motionRatio([a, Buffer.from(a)], w), 0, '完全相同必须是 0');

  // 采样步长是 4，打散式改动里有一部分正好落在采样点上，所以这里只验「单调」和「量级」，
  // 不去断言精确比例——那个精确值测的是步长网格，不是这个函数
  const scatter = (frac) => {
    const b = Buffer.from(a);
    const step = Math.max(1, Math.round(1 / frac));
    for (let i = 0; i < b.length; i += step) b[i] = b[i] === 100 ? 200 : 100;
    return motionRatio([a, b], w);
  };
  const few = scatter(0.01);
  const some = scatter(0.2);
  const most = scatter(0.9);
  assert.ok(few < some, `改动少要量得小：${few} vs ${some}`);
  assert.ok(some < most, `改动多要量得大：${some} vs ${most}`);
  assert.ok(few >= 0 && most <= 1, '结果必须落在 0~1');
  assert.ok(few < 0.2, `1% 的改动不该量成 20%：${few}`);
  assert.ok(most > 0.5, `90% 的改动应该过半：${most}`);
});

test('motionRatio：帧数不足时给 null，不是 0（0 会被当成「完全静止」）', () => {
  assert.equal(motionRatio([makeFrame(64, 36)], 64), null);
  assert.equal(motionRatio([], 64), null);
  assert.equal(motionRatio([makeFrame(64, 36), makeFrame(64, 36)], 0), null);
});

test('detailScore：纯色没有细节，高频图案细节高', () => {
  const flat = makeFrame(64, 36, { base: 128 });
  const d1 = detailScore([flat], 64);
  assert.equal(d1.detail, 0);
  assert.equal(d1.sharp, 0);

  const striped = Buffer.alloc(64 * 36);
  for (let y = 0; y < 36; y += 1) for (let x = 0; x < 64; x += 1) striped[y * 64 + x] = x % 2 ? 255 : 0;
  const d2 = detailScore([striped], 64);
  assert.ok(d2.detail > 0.3, `高频条纹细节应该很高，实得 ${d2.detail}`);
  assert.ok(d2.sharp > 0.9, `高频条纹 sharp 应该接近 1，实得 ${d2.sharp}`);
});

test('sampleDims：不放大、不超上限、保持比例、宽高都是偶数', () => {
  assert.deepEqual(sampleDims(1920, 1080), { w: 1920, h: 1080 });
  assert.deepEqual(sampleDims(320, 180), { w: 320, h: 180 });
  const d = sampleDims(7680, 4320);
  assert.equal(d.w, MAX_SAMPLE_W);
  assert.equal(d.h, 1440);
  for (const [w, h] of [[1921, 1081], [1000, 563], [333, 777]]) {
    const r = sampleDims(w, h);
    assert.equal(r.w % 2, 0, `宽要偶数：${w}x${h}`);
    assert.equal(r.h % 2, 0, `高要偶数：${w}x${h}`);
    assert.ok(Math.abs(r.w / r.h - w / h) < 0.02, `长宽比不能变：${w}x${h}`);
  }
  // 没给尺寸时要有兜底，不能算出 NaN
  assert.deepEqual(sampleDims(null, undefined), { w: 1280, h: 720 });
});

test('KINDS 的参数是递减的：画面越难压，允许的 CRF 越低', () => {
  const s = KINDS.screen, c = KINDS.camera, m = KINDS.motion;
  assert.ok(s.crfStart > c.crfStart && c.crfStart > m.crfStart, '起始 CRF 要递减');
  assert.ok(s.maxCrf > c.maxCrf && c.maxCrf > m.maxCrf, '上限 CRF 要递减');
  assert.ok(s.minBpp < c.minBpp && c.minBpp < m.minBpp, '每像素比特下限要递增');
  for (const [k, v] of Object.entries(KINDS)) assert.ok(v.label, `${k} 必须有中文标签`);
});

test('采样步长是常数且为正（除零会让所有指标变成 NaN）', () => {
  assert.ok(SAMPLE_STRIDE > 0 && Number.isInteger(SAMPLE_STRIDE));
  assert.ok(Object.values(THRESHOLDS).every((v) => Number.isFinite(v) && v > 0));
});
