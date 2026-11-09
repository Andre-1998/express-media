import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { split, planSplit } from '../../src/split.js';
import { probe } from '../../src/probe.js';
import { formatBytes } from '../../src/format.js';
import { ctx, tmpOut } from './helpers.js';

const c = await ctx();

test('分段数按「体积 / 目标」算出来，并给每一段算出时间范围', () => {
  // 100MB 压到 10MB → 需要 10 段
  const p = planSplit({ sizeBytes: 100 * 1024 * 1024, aimBytes: 10 * 1024 * 1024, durationSec: 100 });
  assert.equal(p.need, 10);
  assert.equal(p.parts, 10);
  assert.ok(Math.abs(p.segSeconds - 10) < 0.001, `每段应该是 10 秒，实得 ${p.segSeconds}`);
});

test('本来装得下的情况下，不该拆成一片片（至少两段）', () => {
  const p = planSplit({ sizeBytes: 5 * 1024 * 1024, aimBytes: 10 * 1024 * 1024, durationSec: 60 });
  assert.equal(p.need, 2, '拆成一段没有意义');
  assert.equal(p.parts, 2);
});

test('显式指定段数时要尊重，而且少于 2 段会被抬到 2', () => {
  const base = { sizeBytes: 100 * 1024 * 1024, aimBytes: 10 * 1024 * 1024, durationSec: 100 };
  assert.equal(planSplit(base).parts, 10, '不给段数就按体积算');
  assert.equal(planSplit({ ...base, parts: 0 }).parts, 10, '0 视为没给');
  assert.equal(planSplit({ ...base, parts: null }).parts, 10);
  assert.equal(planSplit({ ...base, parts: 4 }).parts, 4, '给了就尊重');
  assert.equal(planSplit({ ...base, parts: 25 }).parts, 25, '给多了也尊重');
  assert.equal(planSplit({ ...base, parts: 1 }).parts, 2, '分成一段等于没分');
});

test('本来发得出去的文件：直接告诉你不用分，不产出任何目录', async (t) => {
  const r = await split(c.fixtures.motion, {
    to: 'telegram-bot', outDir: tmpOut('split-noop'),
    ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast',
  });
  assert.equal(r.action, 'noop');
  assert.match(r.reason, /装得下/);
  assert.equal(existsSync(r.dir), false, '不用分的时候不该建目录');
});

test('分段：每一段都真的在上限内，时间首尾相接覆盖全片', async (t) => {
  const outDir = tmpOut('split');
  const src = await probe(c.fixtures.big, { ffprobe: c.ffprobe });
  const r = await split(c.fixtures.big, {
    to: '25MB', outDir, parts: 3,
    ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast', maxPasses: 2,
  });
  assert.equal(r.action, 'split');
  assert.equal(r.segments.length, 3);
  for (const s of r.segments) {
    assert.ok(existsSync(s.path), `第 ${s.index} 段没产出`);
    const bytes = statSync(s.path).size;
    assert.equal(bytes, s.bytes, `第 ${s.index} 段报告与磁盘不符`);
    assert.ok(bytes <= r.target.hardBytes, `第 ${s.index} 段 ${formatBytes(bytes)} 超过 ${formatBytes(r.target.hardBytes)}`);
    assert.equal(s.fits, true);
  }
  assert.equal(r.allFit, true);
  // 时间范围必须首尾相接、覆盖全片，中间不能有缝
  assert.equal(r.segments[0].start, 0);
  for (let i = 1; i < r.segments.length; i += 1) {
    assert.ok(Math.abs(r.segments[i].start - r.segments[i - 1].end) < 0.01, `第 ${i} 段起点和上一段终点对不上`);
  }
  assert.ok(Math.abs(r.segments[r.segments.length - 1].end - src.durationSec) < 0.01, '最后一段要一直到片尾');

  // 每一段都要是真能播的视频，不是 0 字节或者解不开的
  for (const s of r.segments) {
    const info = await probe(s.path, { ffprobe: c.ffprobe });
    assert.equal(info.video.present, true, `第 ${s.index} 段没有视频轨`);
    assert.ok(info.durationSec > 0.5, `第 ${s.index} 段时长 ${info.durationSec}，太短了`);
    assert.equal(info.video.rotation, 0);
  }
});

test('分段：每段的实际时长必须等于它声称的时间范围（元数据会骗人）', async (t) => {
  // 这条是补一个真实漏洞：曾经 trim 参数走的是 `trim` 滤镜，而 ffmpeg 9 上那个滤镜
  // 根本不裁剪——第 1 段输出了完整的 25 秒，第 2 段又是后 12.5 秒，内容重复。
  // 当时测试全绿，因为它只验了「段与段的时间范围元数据首尾相接」，
  // 而那组元数据即使内容没被裁剪也照样自洽。**元数据自洽 ≠ 内容正确。**
  const outDir = tmpOut('split-len');
  const r = await split(c.fixtures.big, {
    to: '10MB', outDir, parts: 4,
    ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast', maxPasses: 2,
  });
  assert.equal(r.action, 'split');
  let totalActual = 0;
  for (const s of r.segments) {
    const info = await probe(s.path, { ffprobe: c.ffprobe });
    const want = s.end - s.start;
    totalActual += info.durationSec;
    assert.ok(
      Math.abs(info.durationSec - want) < 0.6,
      `第 ${s.index} 段声称是 ${s.start}~${s.end} 秒（${want.toFixed(1)}s），实际产出 ${info.durationSec.toFixed(1)}s`,
    );
  }
  // 所有段的时长加起来必须接近全片（多或少都说明切错了）
  const srcLen = (await probe(c.fixtures.big, { ffprobe: c.ffprobe })).durationSec;
  assert.ok(
    Math.abs(totalActual - srcLen) < 1.0,
    `${r.segments.length} 段加起来 ${totalActual.toFixed(1)}s，原片 ${srcLen.toFixed(1)}s，差太多了`,
  );
  t.diagnostic(`原片 ${srcLen.toFixed(1)}s → ${r.segments.length} 段合计 ${totalActual.toFixed(1)}s`);
});

test('分段：段数不够时要说清哪几段超限，并给出可执行的建议', async (t) => {
  const outDir = tmpOut('split-loose');
  // 只分 2 段但目标很小 —— 靠每段自己压，压不下去就该明说
  const r = await split(c.fixtures.big, {
    to: '2MB', outDir, parts: 2,
    ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast', maxPasses: 2,
  });
  if (r.allFit) {
    for (const s of r.segments) assert.ok(s.bytes <= r.target.hardBytes);
  } else {
    assert.ok(r.overSegments.length > 0, '报了不合格就要指出是哪几段');
    for (const i of r.overSegments) {
      const s = r.segments.find((x) => x.index === i);
      assert.ok(s.bytes > r.target.hardBytes, `第 ${i} 段被标成超限，但实际 ${formatBytes(s.bytes)} 在上限内`);
    }
  }
});

test('分段：不留下中间临时文件', async (t) => {
  const outDir = tmpOut('split-clean');
  const r = await split(c.fixtures.motion, {
    to: '1MB', outDir, parts: 2,
    ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast', maxPasses: 2,
  });
  assert.equal(r.action, 'split');
  const files = readdirSync(outDir);
  assert.equal(files.length, r.segments.length, `目录里应该只有 ${r.segments.length} 个分片，实际：${files.join(', ')}`);
  for (const f of files) assert.ok(!/\.tmp\.mp4$/.test(f), `留下了临时文件：${f}`);
});

test('分段：竖屏素材切完之后每段仍然是竖着的', async (t) => {
  const outDir = tmpOut('split-rot');
  const r = await split(c.fixtures.portrait, {
    to: '1.2MB', outDir, parts: 2,
    ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast', maxPasses: 2,
  });
  assert.equal(r.action, 'split');
  for (const s of r.segments) {
    const info = await probe(s.path, { ffprobe: c.ffprobe });
    assert.equal(info.video.rotation, 0, `第 ${s.index} 段还带着旋转元数据`);
    assert.ok(info.video.height > info.video.width, `第 ${s.index} 段不是竖屏：${info.video.width}×${info.video.height}`);
  }
});
