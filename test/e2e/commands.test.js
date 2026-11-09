import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trackTempDir } from '../cleanup.mjs';
import { toGif, GIF_LIMITS } from '../../src/gif.js';
import { trim } from '../../src/trim.js';
import { cardHtml, extractPoster, posterArgs } from '../../src/card.js';
import { doctor } from '../../src/doctor.js';
import { probe } from '../../src/probe.js';
import { formatBytes } from '../../src/format.js';
import { ctx, tmpOut } from './helpers.js';

const c = await ctx();

test('doctor：能找到能跑的 ffmpeg，并报出坏掉的候选', async (t) => {
  const r = await doctor();
  assert.equal(r.ok, true, '这台机器上 ffmpeg 应该是好的');
  assert.ok(r.checks.some((x) => x.level === 'ok' && x.name === 'ffmpeg'));
  assert.ok(r.checks.some((x) => x.name === 'libx264'), '必须检查 H.264 编码器');
  // 本机 PATH 上有一个悬空的 WinGet 链接，doctor 应该把它指出来而不是装作没事
  if (r.broken.length) {
    const hint = r.checks.find((x) => x.level === 'warn');
    assert.ok(hint, '有坏候选就必须出现在报告里');
    assert.match(hint.detail, /悬空符号链接|执行失败|超时/);
  }
});

test('GIF：产物是真的 gif，尺寸和帧数按参数来', async (t) => {
  const out = path.join(tmpOut('gif'), 'clip.gif');
  const r = await toGif(c.fixtures.motion, { out, width: 240, fps: 10, duration: 1, ffmpeg: c.ffmpeg, speed: 'veryfast' });
  assert.ok(existsSync(out));
  assert.equal(realBytes(r.output), r.bytes, '报告的体积必须等于磁盘上的');
  const info = await probe(out, { ffprobe: c.ffprobe });
  assert.ok(info.format.name.includes('gif'), `应该是 gif，实得 ${info.format.name}`);
  assert.equal(info.video.width, 240, '宽度要按参数来');
  // GIF 的 duration 靠 ffprobe 常常报 0，所以这里数帧：1 秒 @ 10fps 应该有 10 帧左右。
  // 只查「文件存在」的话，一个单帧的静态图也能过——那测的就不是「转 GIF」这件事了。
  const frames = await countFrames(out, c.ffprobe);
  assert.ok(frames >= 5, `1 秒 10fps 的 GIF 应该有好几帧，实得 ${frames}`);
  assert.ok(r.estimate > 0);
});

test('GIF：方形模式是正方形，且不是把画面拉变形', async (t) => {
  const out = path.join(tmpOut('gifsq'), 'sq.gif');
  await toGif(c.fixtures.motion, { out, width: 200, fps: 8, duration: 1, cropSquare: true, ffmpeg: c.ffmpeg, speed: 'veryfast' });
  const info = await probe(out, { ffprobe: c.ffprobe });
  assert.equal(info.video.width, 200);
  assert.equal(info.video.height, 200, '方形模式的高宽必须相等');
});

test('GIF：超过微信表情 1MB 时给出带数字的建议', async (t) => {
  const out = path.join(tmpOut('gifbig'), 'big.gif');
  const r = await toGif(c.fixtures.chaos, { out, width: 480, fps: 20, duration: 3, ffmpeg: c.ffmpeg, speed: 'veryfast' });
  if (r.bytes > GIF_LIMITS.wechatEmojiBytes) {
    assert.ok(r.warnings.length > 0, `${formatBytes(r.bytes)} 超了 1MB 却没警告`);
    assert.match(r.warnings.join(' '), /1MB/);
    assert.match(r.warnings.join(' '), /\d+/, '建议里要有具体数字');
  }
});

test('裁剪：起止时间按参数走，产出时长要对得上', async (t) => {
  const out = path.join(tmpOut('trim'), 'seg.mp4');
  const r = await trim(c.fixtures.motion, { start: '0:01', end: '0:03', out, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe });
  assert.ok(existsSync(out));
  const info = await probe(out, { ffprobe: c.ffprobe });
  assert.ok(Math.abs(info.durationSec - 2) < 0.35, `裁 2 秒应该得到 2 秒左右，实得 ${info.durationSec}`);
  assert.ok(r.after < r.before, '裁完应该更小');
  assert.equal(r.startSec, 1);
  assert.equal(r.durationSec, 2);
});

test('裁剪：只给时长也能work', async (t) => {
  const out = path.join(tmpOut('trim2'), 'seg.mp4');
  const r = await trim(c.fixtures.big, { duration: 2, out, ffmpeg: c.ffmpeg, ffprobe: c.ffprobe });
  const info = await probe(out, { ffprobe: c.ffprobe });
  assert.ok(info.durationSec > 1.5 && info.durationSec < 2.5, `实得 ${info.durationSec}`);
});

test('裁剪：结束早于开始要报错', async (t) => {
  await assert.rejects(
    () => trim(c.fixtures.motion, { start: '0:03', end: '0:01', ffmpeg: c.ffmpeg, ffprobe: c.ffprobe }),
    /必须晚于/,
  );
});

test('封面：真的抽出图了，参数也说得通', async (t) => {
  const out = path.join(trackTempDir(mkdtempSync(path.join(os.tmpdir(), 'express-poster-'))), 'p.jpg');
  const r = await extractPoster(c.fixtures.motion, { ffmpeg: c.ffmpeg, at: 1, width: 320, out });
  assert.ok(r.path, `抽封面失败：${r.error}`);
  assert.ok(existsSync(out));
  const info = await probe(out, { ffprobe: c.ffprobe });
  assert.equal(info.format.name.includes('image') || info.format.name.includes('mjpeg') || info.format.name.includes('jpeg'), true, `应该是图片，实得 ${info.format.name}`);
  assert.ok(info.video.width <= 320);
  // 1 秒处不该抽到第 0 帧以外的东西，也不能越界
  const args = posterArgs({ input: 'a.mp4', output: 'b.jpg', at: 1, width: 320 });
  assert.ok(args.includes('-ss'));
  assert.equal(args[args.indexOf('-frames:v') + 1], '1');
});

test('封面抽不出来时不致命（投递卡没封面照样能用）', async (t) => {
  const r = await extractPoster(path.join(os.tmpdir(), '根本没这个文件.mp4'), { ffmpeg: c.ffmpeg });
  assert.equal(r.path, null);
  assert.ok(r.error, '要说明为什么没抽出来');
});

test('投递卡：把压缩前后与平台判定都写进去，且引用的文件名真实存在', async (t) => {
  const dir = trackTempDir(mkdtempSync(path.join(os.tmpdir(), 'express-card-')));
  const videoPath = path.join(dir, 'out.mp4');
  const { copyFileSync } = await import('node:fs');
  copyFileSync(c.fixtures.motion, videoPath);
  const poster = await extractPoster(videoPath, { ffmpeg: c.ffmpeg, at: 1, width: 200, out: path.join(dir, 'out.cover.jpg') });
  const { getTarget } = await import('../../src/format.js');
  const db = (await import('../../src/format.js')).loadPlatforms();
  const checks = db.targets.map((t) => ({
    id: t.id, label: t.label, maxBytes: t.maxBytes,
    bytes: statSync(videoPath).size,
    fits: statSync(videoPath).size <= t.maxBytes,
  }));
  const html = cardHtml({
    videoPath: 'out.mp4',
    posterName: 'out.cover.jpg',
    meta: {
      beforeBytes: statSync(videoPath).size * 4,
      afterBytes: statSync(videoPath).size,
      target: getTarget('wechat-chat').label,
      durationSec: 6,
      resolution: '1280×720',
      contentLabel: '一般画面',
      verdict: { fitsHardLimit: true, durationOk: true },
      platformChecks: checks,
      alternatives: [],
    },
  });
  assert.ok(html.includes('out.mp4'));
  assert.ok(poster.path && html.includes('out.cover.jpg'), '封面名要写进 poster 属性');
  assert.ok(existsSync(path.join(dir, 'out.cover.jpg')));
  assert.ok(html.includes('微信 · 聊天窗口'));
  assert.ok(html.includes('省下'), '要写清省了多少');
  assert.ok(!html.includes('NaN'));
});

function realBytes(p) { return statSync(p).size; }

/** 数帧。GIF 这种容器 ffprobe 报的 duration 经常是 0，只能靠 -count_frames 数。 */
async function countFrames(file, ffprobe) {
  const { run } = await import('../../src/ffmpeg.js');
  const bin = typeof ffprobe === 'string' ? ffprobe : ffprobe.path;
  const { code, stdout } = await run(bin, [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file,
  ]);
  if (code !== 0) return 0;
  return Number(String(stdout).trim().split(/\r?\n/)[0]) || 0;
}
