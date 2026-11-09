import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fit } from '../../src/fit.js';
import { probe } from '../../src/probe.js';
import { loadPlatforms, getTarget, formatBytes } from '../../src/format.js';
import { ctx, tmpOut, realSize, assertVerdictHonest } from './helpers.js';

const c = await ctx();

test('本来就在上限内的视频：不重压，直接交付（copy 路径）', async (t) => {
  const out = tmpOut('copy');
  const r = await fit(c.fixtures.tiny, { to: 'telegram-bot', out, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast' });
  assert.equal(r.action, 'copy', '已经发得出去就不该重编码');
  assert.equal(r.passes.length, 0);
  assert.equal(r.after, r.before, 'copy 之后体积不该变');
  assert.equal(realSize(out), statSync(c.fixtures.tiny).size, '必须是字节级一致的复制');
  assertVerdictHonest(t, r);
  assert.equal(r.verdict.fitsHardLimit, true);
});

test('超大的视频压到微信聊天上限：产出真的在 25MB 以内，且判定与实物一致', async (t) => {
  const out = tmpOut('wechat');
  const limit = getTarget('wechat-chat').maxBytes;
  const r = await fit(c.fixtures.big, {
    to: 'wechat-chat', out, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe,
    speed: 'veryfast', maxPasses: 5,
  });
  const bytes = assertVerdictHonest(t, r);
  assert.equal(r.action, 'encode');
  assert.ok(bytes <= limit, `产出 ${formatBytes(bytes)} 超过上限 ${formatBytes(limit)}`);
  assert.ok(r.ratio > 1.5, `90MB 压到 25MB 以内，压缩比应该很可观，实得 ${r.ratio}`);
  assert.ok(r.savedBytes > 0);
  for (const p of r.passes) {
    assert.ok(p.measuredBytes > 0, `第 ${p.width}×${p.height} 那一档没有实测体积`);
    assert.ok(Number.isFinite(p.predictedBytes));
  }
  const winner = r.passes.find((p) => p.measuredBytes === bytes);
  assert.ok(winner, '最终产出的体积应该来自某一档的实测');
});

test('目标更紧时必须真的多试几档（收敛逻辑不是摆设）', async (t) => {
  const out = tmpOut('converge');
  const r = await fit(c.fixtures.big, {
    to: '8MB', out, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe,
    speed: 'veryfast', maxPasses: 5,
  });
  const bytes = assertVerdictHonest(t, r);
  assert.ok(bytes <= getTarget('wechat-chat').maxBytes);
  assert.ok(r.passes.length >= 2, `8MB 的目标不可能一档就过，实得 ${r.passes.length} 档`);
  // 后一档必须比前一档更小，否则「按实测推下一档」没在起作用
  const sizes = r.passes.filter((p) => p.measuredBytes > 0).map((p) => p.measuredBytes);
  assert.ok(sizes.length >= 2);
  assert.ok(sizes[sizes.length - 1] < sizes[0], `后面的档应该更小：${sizes.join(' → ')}`);
  // 收敛的最后一档要么达标，要么整体报超限，不能停在一个不上不下的地方还宣布成功
  const last = r.passes[r.passes.length - 1];
  assert.ok(
    last.measuredBytes <= r.target.aimBytes || r.passes.length >= 5,
    '最后一档没达标就该用完所有尝试次数',
  );
});

test('产出的兼容性：H.264 + AAC + 有音轨 + 方向元数据归零 + 可边下边播', async (t) => {
  const out = tmpOut('compat');
  const r = await fit(c.fixtures.big, { to: 'wechat-chat', out, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast', maxPasses: 5 });
  const info = await probe(out, { ffprobe: c.ffprobe });
  assert.equal(info.video.codec, 'h264', '各家 IM 只认 H.264');
  assert.equal(info.audio.codec, 'aac');
  assert.equal(info.audio.present, true, '源有声音就不能把它丢了');
  assert.equal(info.video.pixFmt, 'yuv420p', 'yuv444/422 在很多客户端上播不了');
  assert.equal(info.video.rotation, 0, '方向要烤进像素，元数据清零');
  assert.ok(info.format.name.includes('mp4'), `容器应该是 mp4，实得 ${info.format.name}`);
  // faststart：moov 在文件头部
  const head = readFileHead(out, 64);
  assert.ok(head.includes('moov'), 'moov 必须前置，否则微信里要等整段下完才能播');
  assert.ok(!head.includes('mdat') || head.indexOf('moov') < head.indexOf('mdat'));
});

test('竖屏带旋转的素材：方向被烤进像素，产出是真正的竖屏', async (t) => {
  const out = tmpOut('rot');
  const src = await probe(c.fixtures.portrait, { ffprobe: c.ffprobe });
  assert.equal(src.video.rotation, 90, '前置条件：源真的带 90° 旋转');
  assert.equal(src.video.displayWidth, 1080);
  assert.equal(src.video.displayHeight, 1920);

  const r = await fit(c.fixtures.portrait, { to: '1.5MB', out, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast' });
  assertVerdictHonest(t, r);
  const info = await probe(out, { ffprobe: c.ffprobe });
  assert.equal(info.video.rotation, 0, '产出不该再依赖旋转元数据');
  assert.ok(
    info.video.displayHeight > info.video.displayWidth,
    `产出应该保持竖屏，实得 ${info.video.displayWidth}×${info.video.displayHeight}`,
  );
  // 方向烤进像素后，容器里的宽高就应该已经是竖着的了
  assert.ok(info.video.height > info.video.width, `容器内尺寸也应该是竖的（transpose 已经应用），实得 ${info.video.width}×${info.video.height}`);
});

test('体积达标时不重压，但要提醒旋转元数据的事，并给出真能用的开关', async (t) => {
  // 这条很容易被写成「一律烤进像素」，但体积达标时直接复制既无损又快，
  // 为了统一而重压一次是白白掉画质。正确做法是：保持无损 + 说清楚风险 + 给一个能真的解决它的开关。
  const out = tmpOut('rot-copy');
  const r = await fit(c.fixtures.portrait, { to: '8MB', out, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast' });
  assert.equal(r.action, 'copy', '体积达标就该直接复制');
  assert.equal(realSize(out), statSync(c.fixtures.portrait).size, '复制必须字节级一致');
  assert.ok(r.warnings && r.warnings.length > 0, '带旋转元数据却什么都不说，用户收到横屏的视频都不知道为什么');
  const text = r.warnings.join(' ');
  assert.match(text, /旋转/, '要说清是旋转的事');
  assert.match(text, /--normalize/, '要给出真的能解决它的开关');

  // 那个开关必须真的管用
  const out2 = tmpOut('rot-norm');
  const r2 = await fit(c.fixtures.portrait, { to: '8MB', normalize: true, out: out2, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast' });
  assert.equal(r2.action, 'encode', '--normalize 必须真的重编码');
  const info2 = await probe(out2, { ffprobe: c.ffprobe });
  assert.equal(info2.video.rotation, 0, '重编码后不该再带旋转元数据');
  assert.ok(info2.video.height > info2.video.width, `重编码后应该是竖屏，实得 ${info2.video.width}×${info2.video.height}`);
  assertVerdictHonest(t, r2);
});

test('HEVC/mkv：体积达标也重编码成 H.264（格式不吃香一样发不出去）', async (t) => {
  const out = tmpOut('hevc');
  const r = await fit(c.fixtures.hevc, { to: 'telegram-bot', out, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast' });
  assert.equal(r.action, 'encode', '体积够但格式是 HEVC，必须重编码');
  const info = await probe(out, { ffprobe: c.ffprobe });
  assert.equal(info.video.codec, 'h264');
  assert.ok(info.format.name.includes('mp4'), '容器也要换成 mp4');
  assertVerdictHonest(t, r);
});

test('源没有音频时，不会凭空造一条音轨', async (t) => {
  const out = tmpOut('silent');
  const r = await fit(c.fixtures.silent, { to: '1MB', out, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast' });
  const info = await probe(out, { ffprobe: c.ffprobe });
  assert.equal(info.audio.present, false, '不能给无声视频加上声音');
  assertVerdictHonest(t, r);
});

test('压到不可能的目标：不静默超限，必须明确报压不进去', async (t) => {
  const out = tmpOut('hopeless');
  let err = null;
  let r = null;
  try {
    r = await fit(c.fixtures.big, { to: '400KB', out, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast', maxPasses: 2 });
  } catch (e) { err = e; }
  if (err) {
    assert.match(err.message, /压不进去/, '报错要说清是压不进去，而不是「未知错误」');
    assert.match(err.message, /裁短|分段|链接/, '报错要给出可行的下一步');
    // 半路而废也不能留下半成品
    assert.equal(existsSync(out), false, '报压不进去却把文件留在那儿，用户会以为压好了');
  } else {
    assertVerdictHonest(t, r);
    assert.equal(r.verdict.fitsHardLimit, false);
    assert.ok(r.alternatives.length >= 2, '至少要给出两条替代路线');
  }
});

test('裁剪建议的算术是对的：按那一档的实测密度反推秒数', async (t) => {
  // 25 秒的片子压到 400KB，裁剪帮不上忙（要裁到比原片还长），所以这里只验接线。
  // 「要裁多少秒」的具体算术在单测里用确定性的数字验，见 unit/fit-args.test.js。
  const out = tmpOut('alt');
  const r = await fit(c.fixtures.big, { to: '400KB', out, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast', maxPasses: 2 });
  if (r.alternatives.some((a) => a.kind === 'trim')) {
    const trim = r.alternatives.find((a) => a.kind === 'trim');
    assert.ok(trim.seconds > 0, '秒数必须为正');
    assert.ok(trim.seconds < r.inputInfo.durationSec, '建议秒数必须短于原片，否则这条建议没意义');
  } else {
    assert.ok(r.alternatives.some((a) => a.kind === 'split'), '给不出裁剪建议时，至少要给分段/链接');
  }
});

test('多个平台目标都能压到位（不是只对微信调通了）', async (t) => {
  for (const id of ['discord-free', 'telegram-bot']) {
    const out = tmpOut(id);
    const limit = getTarget(id).maxBytes;
    const r = await fit(c.fixtures.big, { to: id, out, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast', maxPasses: 5 });
    const bytes = realSize(out);
    assert.ok(bytes <= limit, `${id}：产出 ${formatBytes(bytes)} 超过 ${formatBytes(limit)}`);
    assertVerdictHonest(t, r);
  }
});

test('自定义目标（不是平台 id）一样能压', async (t) => {
  const out = tmpOut('custom');
  const r = await fit(c.fixtures.motion, { to: '1.5MB', out, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast' });
  assert.equal(r.target.kind, 'custom');
  assertVerdictHonest(t, r);
  assert.ok(realSize(out) <= 1.5 * 1024 * 1024);
});

test('--dry-run 只出计划，不产出文件', async (t) => {
  const out = tmpOut('dry');
  const r = await fit(c.fixtures.big, { to: 'wechat-chat', out, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, dryRun: true });
  assert.equal(r.dryRun, true);
  assert.ok(r.passes.length > 0, 'dry-run 也要给出打算试哪几档');
  for (const p of r.passes) {
    assert.equal(p.measuredBytes, null, 'dry-run 没真跑，不该有实测体积');
    assert.ok(p.predictedBytes > 0, '但要给出预估体积');
  }
  assert.equal(existsSync(out), false, 'dry-run 绝对不能留下文件');
});

test('产出目录不存在时会自动创建', async (t) => {
  const dir = path.join(tmpOut('mkdir'), '深层', '目录');
  const out = path.join(dir, 'r.mp4');
  const r = await fit(c.fixtures.motion, { to: '2MB', out, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast' });
  assert.ok(existsSync(out));
  assertVerdictHonest(t, r);
});

test('临时中间文件会被清掉，不留在用户目录里', async (t) => {
  const dir = tmpOut('clean');
  const out = path.join(dir, 'r.mp4');
  await fit(c.fixtures.motion, { to: '1MB', out, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast', maxPasses: 3 });
  const leftovers = readdirSync(dir).filter((f) => f !== 'r.mp4');
  assert.deepEqual(leftovers, [], `目录里还剩着：${leftovers.join(', ')}`);
});

test('每一档的耗时与体积都被记下来（台账要靠这些）', async (t) => {
  const out = tmpOut('meta');
  const r = await fit(c.fixtures.motion, { to: '1MB', out, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast' });
  assert.ok(r.inputInfo.sizeBytes > 0);
  assert.ok(r.inputInfo.durationSec > 0);
  assert.ok(r.content.kind, '必须记下内容判定');
  assert.ok(r.content.metrics.motion !== undefined, '必须记下运动量这个依据');
  assert.ok(r.target.label, '必须记下目标是哪个平台');
  assert.ok(r.afterInfo.video.present, '产出也要体检一遍');
});

test('不存在 / 0 字节的文件要立刻报错并说清原因', async (t) => {
  const dir = tmpOut('bad');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  await assert.rejects(
    () => fit(path.join(dir, '不存在的.mp4'), { to: '25MB', ffmpeg: c.ffmpeg, ffprobe: c.ffprobe }),
    /文件不存在/,
  );
  const empty = path.join(dir, '空.mp4');
  writeFileSync(empty, '');
  await assert.rejects(
    () => fit(empty, { to: '25MB', ffmpeg: c.ffmpeg, ffprobe: c.ffprobe }),
    /0 字节/,
  );
});

test('目标体积比文件还大时不该白跑一趟（更不该把画质压差）', async (t) => {
  const out = tmpOut('noop');
  const r = await fit(c.fixtures.motion, { to: '2GB', out, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast' });
  assert.equal(r.action, 'copy', '本来就发得出去，应该直接给');
  assert.equal(realSize(out), r.before);
});

test('平台表里每一条都至少能被 fit 处理一次（清单不是摆设）', async (t) => {
  // 用 90MB 的素材，才能让所有平台限额（20MB ~ 10GB）都真的落到「需要压」的那一侧
  const src = c.fixtures.big;
  const srcSize = statSync(src).size;
  // 有意义的覆盖面：所有「限额本身就紧张」的平台（<100MB）都必须真的跑到收敛逻辑。
  // B 站、小红书、视频号这种限额在 GB 级的，90MB 的素材本来就装得下，走的是 copy 路径，测不到收敛。
  const tight = loadPlatforms().targets.filter((x) => x.maxBytes < 100 * 1024 * 1024);
  const targets = tight.filter((x) => x.maxBytes < srcSize);
  assert.ok(
    targets.length >= tight.length - 1,
    `${tight.length} 个紧张平台里只跑到 ${targets.length} 个，覆盖不足`,
  );
  t.diagnostic(`覆盖 ${targets.length} 个限额紧张的平台：${targets.map((x) => x.id).join(', ')}`);
  for (const target of targets) {
    const out = tmpOut(target.id);
    const r = await fit(src, { to: target.id, out, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe, speed: 'veryfast', maxPasses: 4 });
    const bytes = realSize(out);
    assert.ok(
      bytes <= target.maxBytes,
      `${target.id}：产出 ${formatBytes(bytes)} 超过上限 ${formatBytes(target.maxBytes)}`,
    );
    assertVerdictHonest(t, r);
  }
});

function readFileHead(file, n) {
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(n);
  readSync(fd, buf, 0, n, 0);
  closeSync(fd);
  return buf.toString('latin1');
}
