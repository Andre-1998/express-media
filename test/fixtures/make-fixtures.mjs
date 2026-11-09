// 合成测试素材。
//
// 为什么要自己合成：真实视频不能进仓库，而「屏幕录制 / 实拍 / 高运动 / 竖屏旋转 / 黑边」
// 这几类的压缩行为完全不同，必须有可控样本。阈值要对着这些样本标定，而不是拍脑袋定。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../src/ffmpeg.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MEDIA_DIR = path.join(here, 'media');
const STAMP_VERSION = '3';

export const FF_BIN = 'C:\\Users\\UglyPo\\.minimax\\tools\\ffmpeg\\ffmpeg-9.0.2-essentials_build\\bin\\ffmpeg.exe';
export const PROBE_BIN = 'C:\\Users\\UglyPo\\.minimax\\tools\\ffmpeg\\ffmpeg-9.0.2-essentials_build\\bin\\ffprobe.exe';

function pickFont() {
  for (const f of ['C:\\Windows\\Fonts\\msyh.ttc', 'C:\\Windows\\Fonts\\consola.ttf', 'C:\\Windows\\Fonts\\arial.ttf']) {
    if (existsSync(f)) return f;
  }
  return null;
}

/** 滤镜里的 Windows 路径必须加单引号、且把冒号转义，否则 ffmpeg 会在 C: 处把选项切断 */
function escPath(p) {
  return `'${p.replace(/\\/g, '/').replace(/:/g, '\\:')}'`;
}

async function enc(ff, args, label) {
  const { code, stderr } = await run(ff, ['-nostdin', '-v', 'error', '-y', ...args]);
  if (code !== 0) throw new Error(`合成素材失败（${label}）：${(stderr || '').trim() || '退出码 ' + code}`);
}

const out = (name) => path.join(MEDIA_DIR, name);
const SINE = ['-f', 'lavfi', '-i', 'sine=frequency=320:sample_rate=48000'];
const H264 = (extra = []) => ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', ...extra];

/** 素材文件名的唯一来源。配方和路径函数都从这里取，避免同一个东西有两个名字。 */
export const FIXTURE_FILES = {
  screen: 'screen.mp4',
  pan: 'pan.mp4',
  motion: 'motion.mp4',
  chaos: 'chaos.mp4',
  portrait: 'portrait-rotated.mp4',
  letterbox: 'letterbox.mp4',
  silent: 'silent.mp4',
  tiny: 'tiny.mp4',
  big: 'big.mp4',
  hevc: 'unfriendly.mkv',
};
const fileFor = (name) => out(FIXTURE_FILES[name]);

export const RECIPES = {
  // 屏幕录制：画面几乎不动，但到处是文字边缘
  screen: async (ff) => {
    const font = pickFont();
    const F = font ? escPath(font) : null;
    const lines = [
      // 注意：文本里不能出现 ASCII 冒号，否则 ffmpeg 的滤镜解析会在那里把整个表达式切断
      ['$ ls -la', 40, 200, '0xd7e0ea'],
      ['drwxr-xr-x  12 uglypo  staff   384 Oct 01  workspace', 28, 270, '0x9fb0c3'],
      ['-rw-r--r--   1 uglypo  staff  48213 Jan 14  report.pdf', 28, 330, '0x9fb0c3'],
      ['急件 · 媒体投递站   v0.1.0', 42, 450, '0x7c9cff'],
      ['目标：微信聊天窗口 25MB', 34, 520, '0xe6edf3'],
      ['实测 78.4MB → 21.2MB   3.7x', 34, 590, '0x4ade80'],
      ['content kind = screen / motion 0.008', 28, 700, '0xfbbf24'],
    ];
    const draw = F
      ? lines.map(([t, size, y, color]) =>
          `drawtext=fontfile=${F}:text='${t}':x=140:y=${y}:fontsize=${size}:fontcolor=${color}:expansion=none`).join(',')
      : "drawbox=x=140:y=200:w=900:h=520:color=0x2a3038@1:t=fill";
    const vf = [
      'drawbox=x=80:y=80:w=1760:h=920:color=0x1b1f27@1:t=fill',
      draw,
      // 光标每 0.5 秒闪一次：让 motion 落在「很小但不为 0」的区间
      "drawbox=x=140:y=620:w=18:h=32:color=0x7c9cff@1:t=fill:enable='lt(mod(t\\,1)\\,0.5)'",
      "drawbox=x=140:y=880:w='120+680*mod(t\\,4)/4':h=10:color=0x4ade80@1:t=fill",
    ].join(',');
    await enc(ff, [
      '-f', 'lavfi', '-i', 'color=c=0x101418:s=1920x1080:r=30:d=6', ...SINE,
      '-vf', vf, ...H264(['-crf', '20']),
      '-c:a', 'aac', '-b:a', '96k', '-t', '6', '-movflags', '+faststart',
      fileFor('screen'),
    ], 'screen');
  },

  // 快速摇摄：杂乱场景 + 持续平移，细节多、运动量大。
  // 用「杂乱小方块场景 + 缓慢摇摄」来模拟手持镜头：
  // 既有大量真实边缘（细节密度接近实拍），又是连续平移（运动量落在中间档）。
  // 不用 mandelbrot——它每帧要迭代大量像素，合成一段 6 秒就要几分钟。
  pan: async (ff) => {
    let seed = 20261001;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const boxes = [];
    for (let i = 0; i < 90; i += 1) {
      const x = Math.round(rnd() * 1900);
      const y = Math.round(rnd() * 1000);
      const w = 40 + Math.round(rnd() * 220);
      const h = 30 + Math.round(rnd() * 160);
      const g = 40 + Math.round(rnd() * 180);
      const c = `0x${g.toString(16).padStart(2, '0')}${Math.round(60 + rnd() * 120).toString(16).padStart(2, '0')}${Math.round(60 + rnd() * 120).toString(16).padStart(2, '0')}`;
      boxes.push(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${c}@0.85:t=fill`);
    }
    const vf = [
      ...boxes,
      // 「主体」——一个横向移动的大色块，模拟画面里走动的人
      "drawbox=x='300+900*mod(t\\,2)/2':y=380:w=260:h=420:color=0xd9a066@0.95:t=fill",
      // 摇摄：从大画面里裁一块平移，缩到 1280×720
      "crop=w=1600:h=900:x='160+80*sin(t*0.7)':y='90+60*cos(t*0.5)'",
      'scale=1280:720:flags=lanczos',
    ].join(',');
    await enc(ff, [
      '-f', 'lavfi', '-i', 'color=c=0x1d2530:s=1920x1080:r=30:d=6', ...SINE,
      '-vf', vf, ...H264(['-crf', '20']),
      '-c:a', 'aac', '-b:a', '96k', '-t', '6', '-movflags', '+faststart',
      fileFor('pan'),
    ], 'pan');
  },

  // 高运动：testsrc2 满屏滚动 + 移动图案 + 噪声
  motion: async (ff) => {
    await enc(ff, [
      '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=6', ...SINE,
      ...H264(['-crf', '20']),
      '-c:a', 'aac', '-b:a', '96k', '-t', '6', '-movflags', '+faststart',
      fileFor('motion'),
    ], 'motion');
  },

  // 竖屏：容器里存 1920×1080 + 显示矩阵 rotation=90，实际显示 1080×1920。
  // 「发过去 sideways」那个 bug 的真实来源。
  // 注意必须用 -display_rotation（输入选项）来写矩阵：老写法 -metadata:s:v:0 rotate=90
  // 在 ffmpeg 9 上根本不生效，会造出一个「看起来有旋转、其实没旋转」的假夹具。
  portrait: async (ff) => {
    const base = out('_portrait-base.mp4');
    await enc(ff, [
      '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=4',
      ...H264(['-crf', '22']), '-t', '4', '-movflags', '+faststart', base,
    ], 'portrait-base');
    await enc(ff, ['-display_rotation', '90', '-i', base, '-c', 'copy', fileFor('portrait')], 'portrait');
    try { unlinkSync(base); } catch { /* 留着也无妨 */ }
  },

  // 只有左右黑边（pillarbox）：内容拉到满高并水平居中，上下不留黑。
  // 故意不做「上下也有黑边」——那样就分不清检测器是真的在量，还是什么都报。
  letterbox: async (ff) => {
    await enc(ff, [
      '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=4',
      '-vf', 'scale=1440:1080,pad=1920:1080:240:0:black',
      ...H264(['-crf', '22']), '-t', '4', '-movflags', '+faststart',
      fileFor('letterbox'),
    ], 'letterbox');
  },

  // 无音频
  silent: async (ff) => {
    await enc(ff, [
      '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3',
      '-an', ...H264(['-crf', '24']), '-t', '3', fileFor('silent'),
    ], 'silent');
  },

  // 已经很小、明显发得出去
  tiny: async (ff) => {
    await enc(ff, [
      '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=15:d=2',
      ...H264(['-crf', '30']), '-t', '2', fileFor('tiny'),
    ], 'tiny');
  },

  // 体积远大于 25MB：微信聊天 / Discord 那档的真实压力测试
  big: async (ff) => {
    await enc(ff, [
      '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=25', ...SINE,
      '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '40M', '-maxrate', '40M', '-bufsize', '80M',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-t', '25', '-movflags', '+faststart',
      fileFor('big'),
    ], 'big');
  },

  // 真正的高运动：life（生命游戏）本身就是高频混沌，缩放用 neighbor 保留颗粒感
  chaos: async (ff) => {
    await enc(ff, [
      '-f', 'lavfi', '-i', 'life=s=320x240:r=30:mold=10:ratio=0.12:death_color=0x1a1a1a:life_color=0xd8d8d8',
      ...SINE,
      '-vf', 'scale=1280:720:flags=neighbor', ...H264(['-crf', '20']),
      '-c:a', 'aac', '-b:a', '96k', '-t', '6', '-movflags', '+faststart',
      fileFor('chaos'),
    ], 'chaos');
  },

  // 体积不大但格式不吃香：HEVC + mkv（体积达标也该重编码成 h264）
  hevc: async (ff) => {
    await enc(ff, [
      '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '32', '-pix_fmt', 'yuv420p',
      '-an', '-t', '3', fileFor('hevc'),
    ], 'hevc');
  },
};

export const FIXTURE_NAMES = Object.keys(RECIPES);
export const fixturePaths = () => Object.fromEntries(FIXTURE_NAMES.map((n) => [n, fileFor(n)]));

/**
 * 每个素材「必须具备什么」。
 *
 * 这张表存在的理由：一个假夹具不会让测试失败，它只会让测试**变得没有意义**。
 * 比如 rotate=90 那次，老写法在 ffmpeg 9 上不生效，素材看着正常但根本没有旋转，
 * 于是「竖屏方向有没有被烤进像素」这条断言永远是绿的——它测的是一个不存在的场景。
 * 所以夹具必须自证，不符就当场报错。
 */
export const FIXTURE_EXPECT = {
  screen: { kind: 'screen', width: 1920, height: 1080, audio: true },
  pan: { kind: 'motion', audio: true },
  chaos: { kind: 'motion' },
  motion: { kind: 'camera' },
  portrait: { rotation: 90, storedWidth: 1920, storedHeight: 1080, displayWidth: 1080, displayHeight: 1920 },
  letterbox: { width: 1920, height: 1080, bars: ['left', 'right'] },
  silent: { audio: false, kind: 'camera' },
  tiny: { maxBytes: 200 * 1024, kind: 'motion' },
  big: { minBytes: 60 * 1024 * 1024, audio: true },
  hevc: { videoCodec: 'hevc' },
};

/** 逐条核对夹具的真实属性，返回 { name, problems[] }。problems 非空 = 夹具不可信。 */
export async function verifyFixtures({ ffprobe = PROBE_BIN, ff = FF_BIN } = {}) {
  const { probe } = await import('../../src/probe.js');
  const { analyzeContent } = await import('../../src/classify.js');
  const paths = fixturePaths();
  const results = [];

  // 素材目录是**输入**。任何跑到这里的产物（抽出来的封面、中间文件、压坏的输出）
  // 都是污染：它既不属于任何配方，也可能被后续某个「遍历目录」的检查当成夹具用。
  // 真实事故：验证投递卡时忘了给封面指定路径，抽到了 motion.mp4 旁边。
  const expected = new Set([...FIXTURE_NAMES.map((n) => FIXTURE_FILES[n]), '.stamp.v3']);
  const strays = readdirSync(MEDIA_DIR)
    .filter((f) => !expected.has(f) && !f.startsWith('.'))
    .filter((f) => !f.endsWith('.bad-') && !f.endsWith('.old-'));
  for (const f of strays) {
    results.push({ name: f, problems: ['素材目录里出现了非配方产物——请删掉并查清是谁写的（多半是某个测试忘了给输出指定临时路径）'] });
  }

  for (const name of FIXTURE_NAMES) {
    const want = FIXTURE_EXPECT[name] || {};
    const problems = [];
    const p = paths[name];
    if (!existsSync(p)) { results.push({ name, problems: ['文件不存在'] }); continue; }
    let info;
    try { info = await probe(p, { ffprobe }); } catch (err) { results.push({ name, problems: [`解不开：${err.message}`] }); continue; }
    const bytes = statSync(p).size;
    if (want.minBytes && bytes < want.minBytes) problems.push(`只有 ${(bytes / 1024 / 1024).toFixed(1)}MB，要求至少 ${(want.minBytes / 1024 / 1024).toFixed(0)}MB`);
    if (want.maxBytes && bytes > want.maxBytes) problems.push(`有 ${(bytes / 1024).toFixed(0)}KB，要求不超过 ${(want.maxBytes / 1024).toFixed(0)}KB`);
    if (want.width && info.video.width !== want.width) problems.push(`宽度 ${info.video.width}，要求 ${want.width}`);
    if (want.height && info.video.height !== want.height) problems.push(`高度 ${info.video.height}，要求 ${want.height}`);
    if (want.storedWidth && info.video.width !== want.storedWidth) problems.push(`容器内宽度 ${info.video.width}，要求 ${want.storedWidth}`);
    if (want.storedHeight && info.video.height !== want.storedHeight) problems.push(`容器内高度 ${info.video.height}，要求 ${want.storedHeight}`);
    if (want.displayWidth && info.video.displayWidth !== want.displayWidth) problems.push(`显示宽度 ${info.video.displayWidth}，要求 ${want.displayWidth}`);
    if (want.displayHeight && info.video.displayHeight !== want.displayHeight) problems.push(`显示高度 ${info.video.displayHeight}，要求 ${want.displayHeight}`);
    if (want.rotation !== undefined && info.video.rotation !== want.rotation) problems.push(`旋转 ${info.video.rotation}°，要求 ${want.rotation}°`);
    if (want.videoCodec && info.video.codec !== want.videoCodec) problems.push(`视频编码 ${info.video.codec}，要求 ${want.videoCodec}`);
    if (want.audio === true && !info.audio.present) problems.push('要求有音频轨，但没有');
    if (want.audio === false && info.audio.present) problems.push('要求没有音频轨，但有');
    if (want.kind || want.bars) {
      const c = await analyzeContent(p, { ff, durationSec: info.durationSec, width: info.video.displayWidth, height: info.video.displayHeight });
      if (want.kind && c.kind !== want.kind) problems.push(`内容判定 ${c.kind}，要求 ${want.kind}（motion=${c.metrics.motion}）`);
      if (want.bars) {
        const got = (c.bars && c.bars.by) || [];
        for (const side of want.bars) if (!got.includes(side)) problems.push(`没检出${side === 'left' ? '左' : side === 'right' ? '右' : side === 'top' ? '上' : '下'}黑边（实得 ${got.join(',') || '无'}）`);
        for (const side of got) if (!want.bars.includes(side)) problems.push(`多报了${side}黑边（只该有 ${want.bars.join(',')}）`);
      }
    }
    results.push({ name, problems, bytes, kind: info.video.codec, size: bytes });
  }
  return results;
}

/**
 * 光看「文件在不在」是不够的：被中断的 ffmpeg 会留下一个几 MB 大小、却缺 moov atom 的
 * 截断 mp4（文件存在、能通过 stat、但根本解不开）。所以必须真的让 ffprobe 解一次。
 */
export async function isValidMedia(file, ffprobe = PROBE_BIN) {
  if (!existsSync(file)) return false;
  if (statSync(file).size === 0) return false;
  try {
    const { code, stdout } = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', file]);
    if (code !== 0) return false;
    const j = JSON.parse(stdout);
    return Array.isArray(j.streams) && j.streams.some((s) => s.codec_type === 'video');
  } catch {
    return false;
  }
}

export async function ensureFixtures({ ff = FF_BIN, force = false, only = null } = {}) {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const names = only && only.length ? only : FIXTURE_NAMES;
  // --force 只重建「被选中的」那几个，不要连整个素材目录一起清掉——
  // 否则「只想重做 portrait」会把另外九段素材也删掉，白等一轮合成。
  if (force) {
    for (const n of names) {
      const target = fixturePaths()[n];
      if (existsSync(target)) {
        renameSync(target, `${target}.old-${Date.now()}`);
      }
    }
  }
  const stampPath = out(`.stamp.v${STAMP_VERSION}`);
  const want = names.join(',');
  const stampOk = existsSync(stampPath) && readFileSync(stampPath, 'utf8') === want;
  if (stampOk && !force) {
    const allValid = (await Promise.all(names.map((n) => isValidMedia(fixturePaths()[n])))).every(Boolean);
    if (allValid) return fixturePaths();
  }

  for (const n of names) {
    const target = fixturePaths()[n];
    if (!force && await isValidMedia(target)) continue;
    if (existsSync(target)) {
      // 上一次留下的坏文件会挡着，重新合成前先把它移开
      renameSync(target, `${target}.bad-${Date.now()}`);
    }
    await RECIPES[n](ff);
    if (!(await isValidMedia(target))) {
      throw new Error(`合成的素材解不开：${target}（可能是合成过程被中断，或者 ffmpeg 参数有问题）`);
    }
  }
  writeFileSync(stampPath, want, 'utf8');
  return fixturePaths();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const only = process.argv.slice(2).filter((a) => RECIPES[a]);
  const t0 = Date.now();
  const paths = await ensureFixtures({ force: process.argv.includes('--force'), only });
  console.log(`素材就绪（${((Date.now() - t0) / 1000).toFixed(1)}s）：`);
  for (const [k, v] of Object.entries(paths)) {
    if (only.length && !only.includes(k)) continue;
    console.log(`  ${k.padEnd(10)} ${(statSync(v).size / 1024 / 1024).toFixed(2)} MB  ${v}`);
  }
  // 夹具必须自证：属性对不上就当场失败，别让假夹具把测试变成空转
  const verify = await verifyFixtures();
  const bad = verify.filter((r) => r.problems.length);
  if (bad.length) {
    console.error('\n夹具核对不通过：');
    for (const b of bad) console.error(`  ${b.name}：${b.problems.join('；')}`);
    process.exitCode = 1;
  } else {
    console.log(`夹具核对通过（${verify.length} 条全部符合预期）。`);
  }
}
