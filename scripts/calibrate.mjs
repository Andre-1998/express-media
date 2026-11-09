// 阈值标定脚本：把每个素材的原始指标都打出来，用数据定阈值，而不是拍脑袋。
// 改 classify.js 的采样分辨率、度量方式或阈值之后，跑一遍这个看分布有没有被拆开。
import { ensureFixtures, FF_BIN } from '../test/fixtures/make-fixtures.mjs';
import { analyzeContent, THRESHOLDS } from '../src/classify.js';
import { probe } from '../src/probe.js';
import { resolveBinaries } from '../src/ffmpeg.js';

const bins = await resolveBinaries();
const f = await ensureFixtures();

console.log('阈值：', JSON.stringify(THRESHOLDS));
console.log('');
console.log(
  '素材'.padEnd(11), '判定'.padEnd(8), 'motion'.padStart(8), 'detail'.padStart(8), 'sharp'.padStart(8),
  'bright'.padStart(7), '采样'.padEnd(10), '黑边',
);
const rows = [];
for (const [k, p] of Object.entries(f)) {
  const info = await probe(p, { ffprobe: bins.ffprobe });
  const c = await analyzeContent(p, {
    ff: FF_BIN || bins.ffmpeg.path,
    durationSec: info.durationSec,
    width: info.video.displayWidth,
    height: info.video.displayHeight,
  });
  rows.push({ k, c });
  console.log(
    k.padEnd(11), c.kind.padEnd(8),
    String(c.metrics.motion).padStart(8), String(c.metrics.detail).padStart(8), String(c.metrics.sharp).padStart(8),
    String(c.metrics.brightness).padStart(7), String(c.metrics.sample).padEnd(10),
    c.bars ? c.bars.by.join(',') : '—',
  );
}

// 素材的「本意」是什么，工具判成什么。不一致就分两种情况看：
//   判偏保守（往 motion 靠）= 画质更保险、文件略大，可以接受；
//   判偏激进（往 screen 靠）= 可能糊，必须调阈值。
const EXPECT = {
  screen: 'screen',   // 录屏：应该走「静止/文字」这一档
  pan: 'motion',      // 快速摇摄：动得厉害，判高运动才对
  chaos: 'motion',    // 生命游戏：高频混沌
  motion: 'camera',   // testsrc2：中等运动
  portrait: 'camera',
  letterbox: 'camera',
  silent: 'camera',
  tiny: 'motion',     // 已知偏保守：320p 的 testsrc2 在小画面里运动物占比更大
  big: 'camera',
  hevc: 'camera',
};
console.log('');
const wrong = rows.filter((r) => EXPECT[r.k] && EXPECT[r.k] !== r.c.kind);
if (wrong.length) {
  console.log('与预期不一致：');
  for (const w of wrong) console.log(`  ${w.k}：期望 ${EXPECT[w.k]}，实得 ${w.c.kind}（motion=${w.c.metrics.motion}）`);
} else {
  console.log('全部与预期一致。');
}
