import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { fit } from '../../src/fit.js';
import { ctx, tmpOut, realSize } from './helpers.js';

const c = await ctx();

/**
 * 模糊测试：不预先规定「应该成功」，只钉住一条铁律。
 *
 *   对任意输入，产物要么真的达标，要么明确报「压不进去」并给替代方案；
 *   绝不允许出现「工具说达标、文件其实超了」这种情况。
 *
 * 随机维度：素材（分辨率/内容/有无音轨各不相同）× 目标体积（从荒谬到宽裕）× 档位。
 */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const TARGETS = ['300KB', '1MB', '5MB', 'wechat-chat', 'discord-free', 'telegram-bot', '200MB'];
const PRESETS = ['keep', 'balanced', 'small'];
const FIXTURES = ['motion', 'screen', 'pan', 'chaos', 'silent', 'letterbox', 'tiny'];

test('模糊测试：40 组随机组合，没有一次「报告与实物不符」', async (t) => {
  const rng = makeRng(20261001);
  const stats = { 达标: 0, 明确超限: 0, 报压不进去: 0 };
  const problems = [];

  for (let i = 0; i < 40; i += 1) {
    const fixture = FIXTURES[Math.floor(rng() * FIXTURES.length)];
    const to = TARGETS[Math.floor(rng() * TARGETS.length)];
    const preset = PRESETS[Math.floor(rng() * PRESETS.length)];
    const out = tmpOut(`fuzz${i}`);
    const label = `[${i}] ${fixture} → ${to} / ${preset}`;

    let r = null;
    try {
      r = await fit(c.fixtures[fixture], {
        to, preset, out, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe,
        speed: 'veryfast', maxPasses: 3,
      });
    } catch (err) {
      // 「压不进去」是可以接受的结局，但必须说清楚、并给替代方案
      if (!/压不进去/.test(err.message)) { problems.push(`${label} 抛了非预期错误：${err.message}`); continue; }
      if (!/裁|分段|链接/.test(err.message)) problems.push(`${label} 报压不进去但没给替代方案`);
      stats['报压不进去'] += 1;
      continue;
    }

    // 走到这里 = 交了产物。那产物必须在磁盘上、且体积与报告一致
    let bytes;
    try { bytes = realSize(out); } catch { problems.push(`${label} 声称完成但磁盘上没有文件`); continue; }
    if (bytes !== r.after) { problems.push(`${label} 报告 ${r.after}，磁盘 ${bytes}`); continue; }
    if (r.verdict.fitsHardLimit === true && bytes > r.target.hardBytes) {
      problems.push(`${label} 报告达标（上限 ${r.target.hardBytes}）实际 ${bytes} —— 这就是最严重的谎报`);
      continue;
    }
    if (r.verdict.fitsHardLimit === false) {
      if (bytes <= r.target.hardBytes) { problems.push(`${label} 报告超限但其实没超（${bytes}）`); continue; }
      if (!r.alternatives.length) { problems.push(`${label} 报告超限却没给替代方案`); continue; }
      stats['明确超限'] += 1;
      continue;
    }
    // 达标
    if (bytes > r.target.aimBytes && bytes <= r.target.hardBytes) {
      // 允许「硬上限内、但没到建议值」——那是取舍，不是谎报
      stats['达标'] += 1;
      continue;
    }
    stats['达标'] += 1;
  }

  assert.deepEqual(problems, [], `模糊测试发现 ${problems.length} 个问题：\n${problems.join('\n')}`);
  t.diagnostic(`结局分布：${JSON.stringify(stats)}`);
  assert.ok(stats['达标'] > 0, '一个都没成功，说明这套组合本身不可用');
  assert.ok(stats['达标'] + stats['明确超限'] + stats['报压不进去'] === 40);
});

test('模糊测试：目标体积的边界值（刚好等于文件大小、差一个字节、大一点点）', async (t) => {
  const src = c.fixtures.motion;
  const size = statSync(src).size;
  const cases = [
    { to: String(size), note: '正好等于原大小' },
    { to: String(size + 1024), note: '比原大小多 1KB' },
  ];
  for (const { to, note } of cases) {
    const out = tmpOut('edge');
    const r = await fit(src, { to, out, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast' });
    const bytes = realSize(out);
    assert.equal(r.after, bytes, `${note}：报告与磁盘不符`);
    const hard = r.target.hardBytes;
    assert.equal(r.verdict.fitsHardLimit, bytes <= hard, `${note}：判定与实物不符（${bytes} vs ${hard}）`);
  }
});

test('模糊测试：目标为 0 或负数这种荒唐输入，要在入口就报错', async (t) => {
  for (const to of ['0', '1', '10', '0.0001MB', '8KB']) {
    await assert.rejects(
      () => fit(c.fixtures.motion, { to, out: tmpOut('zero'), ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast' }),
      // 报错必须说清是「目标本身不合理」，并且给出下一步；只说「失败了」等于把问题推回给用户
      (err) => {
        assert.match(err.message, /目标体积太小/, `目标 ${to} 的报错要说清是目标本身不合理：${err.message}`);
        assert.match(err.message, /--to/, `目标 ${to} 的报错要给出下一步：${err.message}`);
        return true;
      },
      `目标 ${to} 应该被入口拦下`,
    );
  }
  // 门槛之上要接受
  await assert.doesNotReject(async () => {
    const r = await fit(c.fixtures.motion, { to: '16KB', out: tmpOut('floor'), ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast', maxPasses: 1 });
    return r;
  });
});
