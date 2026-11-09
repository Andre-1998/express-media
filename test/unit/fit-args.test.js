import test from 'node:test';
import assert from 'node:assert/strict';
import {
  capLongSide, stepDown, resolutionLadder, fpsCap, rotationFilter, buildFilter, encodeArgs, estimateBytes,
  suggestAlternatives, estimateRange, trimArgs,
} from '../../src/fit.js';
import { KINDS } from '../../src/classify.js';

const audio = { present: true, kbps: 96, channels: 2, estimatedBytes: 72000 };
const noAudio = { present: false, kbps: 0, channels: 2, estimatedBytes: 0 };

test('capLongSide 只缩不放，而且结果一定是偶数', () => {
  assert.deepEqual(capLongSide(1920, 1080, 1920), { w: 1920, h: 1080 });
  assert.deepEqual(capLongSide(3840, 2160, 1920), { w: 1920, h: 1080 });
  assert.deepEqual(capLongSide(1921, 1081, 1920), { w: 1920, h: 1080 });
  // 小于上限时原样返回（且修正奇数）
  assert.deepEqual(capLongSide(1281, 721, 1920), { w: 1282, h: 722 });
  for (const [w, h, cap] of [[3840, 2160, 1280], [1080, 1920, 1920], [1440, 1441, 1920]]) {
    const r = capLongSide(w, h, cap);
    assert.equal(r.w % 2, 0);
    assert.equal(r.h % 2, 0);
  }
});

test('stepDown 降一档，比例接近 0.75 且保持长宽比', () => {
  const s = stepDown({ w: 1920, h: 1080 });
  assert.equal(s.w, 1440);
  assert.equal(s.h, 810);
  assert.ok(Math.abs(s.w / s.h - 16 / 9) < 0.02, '长宽比不能被压变形');
});

test('分辨率阶梯：单调下降、到地板就停', () => {
  const ladder = resolutionLadder(1920, 1080, 'balanced');
  assert.deepEqual(ladder[0], { w: 1920, h: 1080 });
  for (let i = 1; i < ladder.length; i += 1) {
    assert.ok(Math.max(ladder[i].w, ladder[i].h) < Math.max(ladder[i - 1].w, ladder[i - 1].h), '每一档都要更小');
  }
  const last = ladder[ladder.length - 1];
  assert.ok(Math.max(last.w, last.h) >= 360, '最后一档不能小到没人看得见');
  // 4K 在 balanced 下第一档就该降到 1920
  assert.deepEqual(resolutionLadder(3840, 2160, 'balanced')[0], { w: 1920, h: 1080 });
  // keep 档不该动分辨率
  assert.deepEqual(resolutionLadder(3840, 2160, 'keep')[0], { w: 3840, h: 2160 });
  // small 档压到 1280
  assert.deepEqual(resolutionLadder(3840, 2160, 'small')[0], { w: 1280, h: 720 });
});

test('fpsCap：本来就 <=30 的不往上拉，60 的按档位压', () => {
  assert.equal(fpsCap(24, 'balanced'), 24, '24fps 保持原样，拉到 30 只会浪费体积');
  assert.equal(fpsCap(30, 'balanced'), 30);
  assert.equal(fpsCap(60, 'balanced'), 30);
  assert.equal(fpsCap(60, 'keep'), 60);
  assert.equal(fpsCap(29.97, 'balanced'), 29.97);
  assert.equal(fpsCap(null, 'balanced'), null);
});

test('rotationFilter 覆盖四种角度，其余一律不处理', () => {
  assert.equal(rotationFilter(0), null);
  assert.equal(rotationFilter(90), 'transpose=1');
  assert.equal(rotationFilter(180), 'hflip,vflip');
  assert.equal(rotationFilter(270), 'transpose=2');
  assert.equal(rotationFilter(360), null);
  assert.equal(rotationFilter(-90), 'transpose=2', '负角度要归一化');
  assert.equal(rotationFilter(undefined), null);
});

test('buildFilter 的顺序是「先转正、再缩放」，且 setsar 归一', () => {
  const f = buildFilter({ width: 1080, height: 1920, rotation: 90 });
  const parts = f.split(',');
  assert.ok(parts.indexOf('transpose=1') < parts.findIndex((p) => p.startsWith('scale=')), '必须先转再缩');
  assert.ok(f.includes('scale=1080:1920'));
  assert.ok(f.includes('setsar=1'));
  assert.equal(buildFilter({ width: null, height: null, rotation: 0 }), null, '不缩不转时不该有多余滤镜');
});

test('buildFilter 即使传了 trim 也不做裁剪（裁剪归 -ss/-t 管）', () => {
  // 这条测试原本断言的是「先 trim 再 setpts」——也就是那个 bug 本身。
  // bug 和它的测试被一起固化，测试全绿而功能是错的。改成断言正确行为。
  const f = buildFilter({ width: 640, height: 360, rotation: 0, trim: { start: 1, end: 3 } });
  assert.ok(!f.includes('trim='), `不该出现 trim 滤镜：${f}`);
  assert.ok(!f.includes('setpts'), `不该出现 setpts：${f}`);
  assert.ok(f.includes('scale=640:360'), '缩放照常');
});

test('encodeArgs：CRF 模式、音频、faststart、旋转归零，一个都不能少', () => {
  const args = encodeArgs({ input: 'in.mp4', output: 'out.mp4', width: 1280, height: 720, fps: 30, crf: 28, audio, rotation: 90, speed: 'medium' });
  const s = args.join(' ');
  assert.ok(args.includes('-noautorotate'), '必须自己处理旋转，否则会叠加');
  assert.ok(s.includes('libx264'));
  assert.ok(s.includes('-crf 28'));
  assert.ok(!s.includes('-b:v'), 'CRF 模式不该同时给码率');
  assert.ok(s.includes('yuv420p'), 'yuv420p 是兼容性底线');
  assert.ok(s.includes('+faststart'), 'moov 放前面才能边下边播');
  assert.ok(s.includes('-metadata:s:v:0 rotate=0'), '方向要烤进像素，元数据清零');
  assert.ok(s.includes('-b:a 96k'));
  assert.equal(args.at(-1), 'out.mp4', '输出文件必须是最后一个参数');
});

test('encodeArgs：码率模式用 -b:v 而不是 -crf', () => {
  const args = encodeArgs({ input: 'in.mp4', output: 'out.mp4', width: 640, height: 360, fps: 30, crf: 30, bitrateBps: 800000, audio, rotation: 0 });
  const s = args.join(' ');
  assert.ok(s.includes('-b:v 800000'));
  assert.ok(s.includes('-maxrate 1000000'));
  assert.ok(!s.includes('-crf'));
});

test('encodeArgs：源没有音频时用 -an，不能凭空造一条音轨', () => {
  const args = encodeArgs({ input: 'in.mp4', output: 'out.mp4', width: 640, height: 360, fps: 30, crf: 26, audio: noAudio, rotation: 0 });
  assert.ok(args.includes('-an'));
  assert.ok(!args.join(' ').includes('-c:a'));
});

test('estimateBytes：CRF 越高估得越小，分辨率越高估得越大', () => {
  const base = { width: 1280, height: 720, fps: 30, kind: 'camera', durationSec: 10 };
  const lo = estimateBytes({ ...base, crf: 20 });
  const hi = estimateBytes({ ...base, crf: 30 });
  const big = estimateBytes({ ...base, crf: 30, width: 1920, height: 1080 });
  assert.ok(lo > hi, `CRF 高应该更小：${lo} vs ${hi}`);
  assert.ok(big > hi, '分辨率高应该更大');
  assert.ok(estimateBytes({ ...base, crf: 30 }) > hi - 1);
});

test('buildFilter：链里不该出现 trim 滤镜（ffmpeg 9 上它不裁剪）', () => {
  // 实测：`-vf trim=0:12.5` 在 ffmpeg 9.0.2 上产出仍是完整的 25 秒。
  // 所以裁剪必须走输出选项 -ss / -t，不能走滤镜。
  const f = buildFilter({ width: 1080, height: 1920, rotation: 90, trim: { start: 0, end: 12.5 } });
  assert.ok(!f.includes('trim='), `滤镜链里不该有 trim：${f}`);
  assert.ok(!f.includes('setpts'), `不该再有 setpts：${f}`);
  assert.ok(f.includes('transpose=1') || f.includes('hflip'), '方向处理要保留');
  assert.ok(f.includes('sidedata=mode=delete'), '显示矩阵清理要保留');
});

test('trimArgs：start>0 用 -ss 定位，-t 取「定位之后」的秒数', () => {
  // 段 1：0~12.5
  const a = trimArgs({ start: 0, end: 12.5 });
  assert.equal(a.seek, null, '从 0 开始不需要 -ss');
  assert.equal(a.take, 12.5);
  // 段 2：12.5~25 → -ss 12.5 之后取 12.5 秒
  const b = trimArgs({ start: 12.5, end: 25 });
  assert.equal(b.seek, 12.5);
  assert.equal(b.take, 12.5, '-t 是定位之后的时长，不是结束时间');
  // 显式给 duration 时优先用它
  assert.equal(trimArgs({ start: 5, end: 100, duration: 8 }).take, 8);
  // 不裁剪时两个都不给
  const none = trimArgs({});
  assert.equal(none.seek, null);
  assert.equal(none.take, null);
});

test('encodeArgs：裁剪必须落在 -ss / -t 上，不能退化成滤镜', () => {
  const audio = { present: true, kbps: 96, channels: 2, estimatedBytes: 0 };
  const args = encodeArgs({
    input: 'in.mp4', output: 'out.mp4', width: 1920, height: 1080, fps: 30, crf: 25,
    audio, rotation: 0, speed: 'veryfast', trim: { start: 12.5, end: 25 },
  });
  const s = args.join(' ');
  assert.ok(args.includes('-ss'), '要快速定位');
  assert.equal(args[args.indexOf('-ss') + 1], '12.5');
  assert.ok(args.includes('-t'), '要限制时长，否则会输出到片尾');
  assert.equal(args[args.indexOf('-t') + 1], '12.5');
  assert.ok(args.indexOf('-ss') < args.indexOf('-i'), '-ss 必须在 -i 之前');
  assert.ok(args.indexOf('-t') > args.indexOf('-i'), '-t 是输出选项');
  assert.ok(!s.includes('trim='), '不能有 trim 滤镜');
  // 从 0 开始时不要多此一举加 -ss 0
  const fromZero = encodeArgs({
    input: 'in.mp4', output: 'o.mp4', width: 1920, height: 1080, fps: 30, crf: 25,
    audio, rotation: 0, trim: { start: 0, end: 8 },
  });
  assert.ok(!fromZero.includes('-ss'), 'start=0 时不需要 -ss');
  assert.equal(fromZero[fromZero.indexOf('-t') + 1], '8');
  // 不给 trim 时不该有 -t
  const plain = encodeArgs({ input: 'in.mp4', output: 'o.mp4', width: 1920, height: 1080, fps: 30, crf: 25, audio, rotation: 0 });
  assert.ok(!plain.includes('-t') && !plain.includes('-ss'));
});

test('estimateRange：给区间而不是一个看着精确的数字', () => {
  // 实测教训：单点估算对同一份内容能偏乐观 35%，而跨内容类型的偏差能到几倍。
  // 所以用户看到的应该是区间，并且 mid 落在区间内。
  const base = { width: 1920, height: 1080, fps: 30, crf: 25, kind: 'camera', durationSec: 25 };
  const r = estimateRange(base);
  const mid = estimateBytes(base);
  assert.ok(r.low < mid && mid < r.high, `中值 ${mid} 应落在区间 ${r.low}~${r.high} 内`);
  assert.ok(r.high / r.low >= 2, '区间要真的覆盖得住不确定性');
  assert.ok(r.low > 0 && r.high > r.low);
  // 区间随 CRF 单调收窄
  const higher = estimateRange({ ...base, crf: 30 });
  assert.ok(higher.high < r.high, 'CRF 高了区间应该整体下移');
});

test('estimateBytes 对高运动内容给同样的 CRF 估得更大', () => {
  const base = { width: 1280, height: 720, fps: 30, crf: 26, durationSec: 10 };
  const screen = estimateBytes({ ...base, kind: 'screen' });
  const motion = estimateBytes({ ...base, kind: 'motion' });
  assert.ok(motion > screen, `高运动应该估得更大：${motion} vs ${screen}`);
});

// —— 「压不进去」时给的替代方案：算术必须站得住 ——

function fakeO({ durationSec, displayW, displayH, fps, kind, aimBytes, sizeBytes, hardBytes }) {
  return {
    inputInfo: { durationSec, sizeBytes, video: { displayWidth: displayW, displayHeight: displayH, fps } },
    content: { kind },
    target: { aimBytes, hardBytes },
  };
}

test('替代方案：裁到多少秒能压进去，是按那一档的实测密度算的', () => {
  // 10 分钟、1080p，压到 5MB —— 显然得裁
  const alts = suggestAlternatives(fakeO({
    durationSec: 600, displayW: 1920, displayH: 1080, fps: 30, kind: 'camera',
    aimBytes: 5 * 1024 * 1024, sizeBytes: 500 * 1024 * 1024, hardBytes: 5.2 * 1024 * 1024,
  }));
  const trim = alts.find((a) => a.kind === 'trim');
  assert.ok(trim, '长视频压不进去必须给出裁剪建议');
  assert.ok(trim.seconds > 0 && trim.seconds < 600, `秒数要在 0~600 之间，实得 ${trim.seconds}`);
  // 反推校验：按这个秒数，在最低档参数下应当真的装得下
  const perSec = estimateBytes({
    width: Math.max(360, Math.round(1920 * 0.25)), height: Math.max(360, Math.round(1080 * 0.25)),
    fps: 30, crf: KINDS.camera.maxCrf, kind: 'camera', durationSec: 1,
  });
  assert.ok(trim.seconds * perSec <= 5 * 1024 * 1024, `按建议秒数算仍超限：${trim.seconds * perSec}`);
  assert.ok(alts.some((a) => a.kind === 'split'));
  assert.ok(alts.some((a) => a.kind === 'link'));
});

test('替代方案：裁不掉两成就别提，那是噪音', () => {
  // 5 秒的片子压到 100KB：算出来「裁到 4 秒」，但只省了两成，等于没裁
  const alts = suggestAlternatives(fakeO({
    durationSec: 5, displayW: 1280, displayH: 720, fps: 30, kind: 'motion',
    aimBytes: 100 * 1024, sizeBytes: 2 * 1024 * 1024, hardBytes: 105 * 1024,
  }));
  assert.equal(alts.find((a) => a.kind === 'trim'), undefined, '裁掉不到两成不该给建议');
  assert.ok(alts.length >= 2, '但仍然要给别的路');
});

test('替代方案：分段数要跟着真实体积走', () => {
  const alts = suggestAlternatives(fakeO({
    durationSec: 30, displayW: 640, displayH: 480, fps: 30, kind: 'motion',
    aimBytes: 50 * 1024, sizeBytes: 150 * 1024 * 1024, hardBytes: 1 * 1024 * 1024,
  }));
  const split = alts.find((a) => a.kind === 'split');
  assert.ok(split, '必须给分段建议');
  assert.match(split.text, /段/, '要说清是分几段');
});
