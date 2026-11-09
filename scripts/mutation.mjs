// 变异测试：故意把产品改坏，确认「检查」真的会红。
//
// 一条永远为真的断言比没有断言更糟——它会让人以为这一层已经验过了。
// 所以这里对每个关键判定做一次「定向破坏」，然后要求对应的检查必须失败。
//
// ⚠ 极性是这个脚本最容易搞错的地方：
//   caught = true 表示「不变量被违反」= 变异生效了 = 对应的检查会红。
//   写成「行为是否仍然正确」的话，每个真正被改坏的变异都会报成「没抓到」，
//   而每条变异的实得值其实都在说「它确实坏了」——脚本在自欺。
//   所以每个 check 写完都要自己问一句：把「行为正确」代入，caught 是不是 false。
//
// 另外三种结局必须分清：被抓住 / 没抓住（检查是摆设） / 检查自己没跑起来。
// 把第三种算成「抓住了」同样是自欺，所以 harness 错误一律让本轮结果作数。
//
// 用法：node scripts/mutation.mjs [--only 关键词]
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const { ensureFixtures } = await import('../test/fixtures/make-fixtures.mjs');
const { resolveBinaries } = await import('../src/ffmpeg.js');
const { run } = await import('../src/ffmpeg.js');

// 每个变异 = 一个真实缺陷的最小复现
const MUTANTS = [
  {
    id: 'fit-trim-ignored',
    title: '裁剪参数被忽略（每段都输出完整原片，第 2 段起内容重复）',
    file: 'src/fit.js',
    module: 'fit.js',
    // 这是真踩过的 bug：曾经用 `trim` 滤镜做裁剪，而 ffmpeg 9 上那个滤镜根本不裁剪，
    // 产出每段都是完整原片。当时测试全绿——因为它只验了「时间范围元数据首尾相接」，
    // 而那组元数据即使内容没被裁剪也照样自洽。
    find: "  if (duration !== null && duration !== undefined && duration > 0) args.take = duration;\n  else if (end !== null && end !== undefined && end > start) args.take = end - start;",
    replace: "  if (false) args.take = duration;\n  else if (false) args.take = end - start;",
    e2e: true,
    async check(m, api) {
      const out = path.join(api.dir, 'mutant-trim.mp4');
      await m.fit(api.fixture, {
        to: '5MB', out, ffmpeg: api.bins.ffmpeg, ffprobe: api.bins.ffprobe, speed: 'veryfast',
        trim: { start: 2, end: 4 },
      });
      const { probe } = await import(pathToFileURL(path.join(api.src, 'probe.js')).href);
      const info = await probe(out, { ffprobe: api.bins.ffprobe });
      // 要的是 2 秒的片段；裁剪被忽略时会拿到完整 6 秒
      const wrong = info.durationSec > 3;
      return { caught: wrong, actual: `声称裁 2~4 秒，产出 ${info.durationSec.toFixed(1)} 秒` };
    },
  },
  {
    id: 'fit-trim-filter-instead-of-t',
    title: '裁剪退回 trim 滤镜（ffmpeg 9 上不裁剪，输出完整原片）',
    file: 'src/fit.js',
    module: 'fit.js',
    find: "    ...(t.take !== null ? ['-t', String(t.take)] : []),\n    ...audioArgs(audio),\n    '-metadata:s:v:0', 'rotate=0', '-movflags', '+faststart', output,",
    replace: "    ...audioArgs(audio),\n    '-metadata:s:v:0', 'rotate=0', '-movflags', '+faststart', output,",
    e2e: true,
    async check(m, api) {
      const args = m.encodeArgs({
        input: 'in.mp4', output: 'o.mp4', width: 1920, height: 1080, fps: 30, crf: 25,
        audio: { present: true, kbps: 96, channels: 2, estimatedBytes: 0 }, rotation: 0,
        trim: { start: 0, end: 2 },
      });
      const lostT = !args.includes('-t');
      return { caught: lostT, actual: lostT ? '裁剪时长限制丢了' : '-t 还在' };
    },
  },
  {
    id: 'CONTROL-noop-comment-only',
    title: '反向对照：只改注释，行为完全不变（这条必须报「没抓到」）',
    control: true,
    file: 'src/format.js',
    module: 'format.js',
    find: 'export const MIN_TARGET_BYTES = 16 * 1024;',
    replace: 'export const MIN_TARGET_BYTES = 16 * 1024; // 反向对照：只加一行注释，行为不变',
    async check(m) {
      let threw = false;
      try { m.resolveTarget('0'); } catch { threw = true; }
      return { caught: !threw, actual: threw ? '0 字节的目标被拦下了（行为没变，说明这条变异无效）' : '0 字节的目标被放行了' };
    },
  },
  {
    id: 'probe-rotation-ignore-side-data',
    title: '旋转只从老式 tags 读，漏掉新版 side_data_list',
    file: 'src/probe.js',
    module: 'probe.js',
    find: "    if (typeof sd.rotation === 'number') return normalizeAngle(sd.rotation);",
    replace: "    if (typeof sd.never === 'number') return normalizeAngle(sd.never);",
    async check(m) {
      const got = m.extractRotation({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] });
      return { caught: got !== 270, actual: `rotation=${got}（应为 270）` };
    },
  },
  {
    id: 'format-safe-aim-no-headroom',
    title: '压缩目标不预留余量（贴着上限压，必然踩线）',
    file: 'src/format.js',
    module: 'format.js',
    find: '  const headroom = Math.min(want, Math.round(hardBytes * 0.1));',
    replace: '  const headroom = 0;',
    async check(m) {
      const hard = 25 * 1024 * 1024;
      const aim = m.safeAim(hard);
      return { caught: !(aim < hard && hard - aim >= 512 * 1024), actual: `aim=${aim}，余量 ${hard - aim} 字节` };
    },
  },
  {
    id: 'classify-threshold-inverted',
    title: '内容判定阈值写反（录屏被当高运动，实拍被当录屏）',
    file: 'src/classify.js',
    module: 'classify.js',
    find: "  if (motion < THRESHOLDS.screenMotion) return 'screen';",
    replace: "  if (motion > THRESHOLDS.screenMotion) return 'screen';",
    async check(m) {
      const got = m.classifyByMetrics({ motion: 0.0002 });
      return { caught: got !== 'screen', actual: `录屏被判成 ${got}` };
    },
  },
  {
    id: 'fit-ladder-not-decreasing',
    title: '分辨率阶梯不下降（压不动时只会反复重试同一档）',
    file: 'src/fit.js',
    module: 'fit.js',
    find: '    const next = stepDown(cur);',
    replace: '    const next = cur;',
    async check(m) {
      const ladder = m.resolutionLadder(1920, 1080, 'balanced');
      const decreasing = ladder.every((s, i) => i === 0 || Math.max(s.w, s.h) < Math.max(ladder[i - 1].w, ladder[i - 1].h));
      return { caught: !decreasing || ladder.length < 3, actual: `阶梯 ${ladder.length} 档，递减=${decreasing}` };
    },
  },
  {
    id: 'fit-rotation-ignored',
    title: '旋转元数据照抄不处理（竖屏视频发出去是躺着的）',
    file: 'src/fit.js',
    module: 'fit.js',
    find: "    case 90: return 'transpose=1';",
    replace: "    case 90: return null;",
    async check(m) {
      const got = m.rotationFilter(90);
      return { caught: got !== 'transpose=1', actual: `rotationFilter(90) = ${String(got)}` };
    },
  },
  {
    id: 'fit-no-sidedata-cleanup',
    title: '像素转正了却不删显示矩阵（播放器会再转一次，竖屏躺着发出去）',
    file: 'src/fit.js',
    module: 'fit.js',
    find: "  if (hadRotation) parts.push('sidedata=mode=delete:type=DISPLAYMATRIX');",
    replace: '  if (hadRotation) parts.push(\'noop\');',
    async check(m) {
      const f = m.buildFilter({ width: 1080, height: 1920, rotation: 90 });
      return { caught: !f.includes('sidedata=mode=delete'), actual: f };
    },
  },
  {
    id: 'gif-broken-dither-arg',
    title: 'GIF 的 dither 选项写成畸形形态（多一个 =，ffmpeg 直接拒绝）',
    file: 'src/gif.js',
    module: 'gif.js',
    find: "const ditherArg = dither === 'none' ? '' : `=dither=${dither}:bayer_scale=3`;",
    replace: "const ditherArg = dither === 'none' ? '' : `=dither=${dither}:bayer_scale=3:extra=1=2`;",
    async check(m) {
      const f = m.buildGifFilter({ width: 320, fps: 12 });
      // 精确比对正确形态：只查「有没有 dither」太弱，写成 `=dither=none:extra=1=2` 也能蒙混过关
      const ok = f === '[0:v]fps=12,scale=320:-1:flags=lanczos,split[s0][s1];'
        + '[s0]palettegen=max_colors=256:stats_mode=diff[p];'
        + '[s1][p]paletteuse=dither=bayer:bayer_scale=3';
      return { caught: !ok, actual: f.slice(-56) };
    },
  },
  {
    id: 'gif-filter-colon-instead-of-equals',
    title: '带输入标签的滤镜用 : 代替 =（ffmpeg 会把 :dither 当成下一个滤镜）',
    file: 'src/gif.js',
    module: 'gif.js',
    find: "const ditherArg = dither === 'none' ? '' : `=dither=${dither}:bayer_scale=3`;",
    replace: "const ditherArg = dither === 'none' ? '' : `:dither=${dither}:bayer_scale=3`;",
    async check(m) {
      const f = m.buildGifFilter({ width: 320, fps: 12 });
      // 带显式输入标签的滤镜，选项前必须是 "="
      return { caught: /paletteuse:/.test(f) || !/\[s1\]\[p\]paletteuse=/.test(f), actual: f.slice(-56) };
    },
  },
  {
    id: 'card-no-escape',
    title: '投递卡不转义文件名（文件名带尖括号就能破坏页面结构）',
    file: 'src/card.js',
    module: 'card.js',
    find: "function esc(s) {\n  return String(s ?? '').replace(/[&<>\"']/g,",
    replace: "function esc(s) {\n  return String(s ?? '').replace(/ZZZ-NEVER-MATCHES/g,",
    async check(m) {
      const html = m.cardHtml({ videoPath: 'a"><script>alert(1)</script>.mp4', meta: {} });
      return { caught: html.includes('<script>'), actual: html.includes('<script>') ? '页面里出现了裸 script 标签' : '已转义' };
    },
  },
  {
    id: 'card-size-verdict-for-duration',
    title: '平台判定只看体积（时长超限的平台会被显示成「超 0 B」）',
    file: 'src/card.js',
    module: 'card.js',
    find: '    } else if (durOver) {\n      cls = \'bad\';\n      label = \'时长超限\';',
    replace: '    } else if (durOver) {\n      cls = \'bad\';\n      label = `超 ${formatBytes(overBytes)}`;',
    async check(m) {
      const html = m.cardHtml({
        videoPath: 'x.mp4',
        meta: {
          durationSec: 40,
          platformChecks: [{
            label: '微信 · 朋友圈', maxBytes: 10 * 1024 * 1024, bytes: 7 * 1024 * 1024,
            maxDurationSec: 30, durationSec: 40, sizeOk: true, durationOk: false, fits: false, note: '',
          }],
        },
      });
      return { caught: !html.includes('时长超限') || html.includes('超 0 B'), actual: html.includes('超 0 B') ? '出现了「超 0 B」' : '没出现时长超限' };
    },
  },
  {
    id: 'trim-seek-after-input',
    title: '裁剪的 -ss 放在 -i 之后（慢十几倍，长视频直接不可用）',
    file: 'src/trim.js',
    module: 'trim.js',
    find: "  const args = ['-nostdin', '-v', 'error', '-y'];\n  if (start > 0) args.push('-ss', String(start));\n  args.push('-i', input);",
    replace: "  const args = ['-nostdin', '-v', 'error', '-y', '-i', input];\n  if (start > 0) args.push('-ss', String(start));",
    async check(m) {
      const a = m.trimArgs({ input: 'in.mp4', output: 'o.mp4', start: 5, duration: 10 });
      return { caught: a.indexOf('-ss') > a.indexOf('-i'), actual: a.join(' ') };
    },
  },
  {
    id: 'format-accept-absurd-target',
    title: '荒唐目标体积不在入口拦下（白压三档再报超限）',
    file: 'src/format.js',
    module: 'format.js',
    find: '    if (bytes < MIN_TARGET_BYTES) {',
    replace: '    if (false) {',
    async check(m) {
      let threw = false;
      try { m.resolveTarget('0'); } catch { threw = true; }
      return { caught: !threw, actual: threw ? '已拦下' : '0 字节的目标被放行了' };
    },
  },
  {
    id: 'platforms-drop-sources',
    title: '平台表去掉来源（数字还在，但没人知道它从哪来、还可不可信）',
    file: 'data/platforms.json',
    module: 'format.js',
    find: '"sources": [\n        { "url": "https://core.telegram.org/bots/faq", "note": "官方 FAQ：Bots can currently send files of any type of up to 50 MB in size" }\n      ]',
    replace: '"sources": []',
    async check(m) {
      const bad = m.loadPlatforms({ reload: true }).targets.filter((x) => !x.sources || x.sources.length === 0);
      return { caught: bad.length > 0, actual: bad.length ? `${bad.length} 条没有来源（${bad.map((b) => b.id).join(',')}）` : '所有条目都还有来源' };
    },
  },
  {
    id: 'fit-report-half-the-real-size',
    title: '报告的产出体积不等于磁盘真实体积（谎报超标的最典型写法）',
    file: 'src/fit.js',
    module: 'fit.js',
    find: '  const after = statSync(outPath).size;\n  return finish({\n    ...base, action: \'encode\', output: outPath, before: info.sizeBytes, after,',
    replace: '  const after = Math.round(statSync(outPath).size * 0.5);\n  return finish({\n    ...base, action: \'encode\', output: outPath, before: info.sizeBytes, after,',
    e2e: true,
    async check(m, api) {
      // 必须用「一定会重编码」的组合：素材本来就装得下的话走的是 copy 路径，
      // 变异挂在 encode 路径上，压根不会被执行到 —— 那种「没抓到」是变异自己没用，不是检查没用。
      const out = path.join(api.dir, 'mutant-half.mp4');
      const r = await m.fit(api.fixture, {
        to: '1MB', out, ffmpeg: api.bins.ffmpeg, ffprobe: api.bins.ffprobe,
        speed: 'veryfast', maxPasses: 2,
      });
      const real = statSync(out).size;
      return { caught: r.after !== real, actual: `报告 ${r.after} / 实际 ${real}（动作 ${r.action}）` };
    },
  },
  {
    id: 'fit-no-rotation-bake',
    title: '不把旋转烤进像素（竖屏素材压完方向还是错的）',
    file: 'src/fit.js',
    module: 'fit.js',
    find: "  const tf = rotationFilter(rotation);\n  const hadRotation = Boolean(tf);\n  if (tf) parts.push(tf);",
    replace: '  const tf = null;\n  const hadRotation = false;\n  if (tf) parts.push(tf);',
    e2e: true,
    async check(m, api) {
      const out = path.join(api.dir, 'mutant-rot.mp4');
      await m.fit(api.fixturePortrait, {
        to: '1.5MB', out, ffmpeg: api.bins.ffmpeg, ffprobe: api.bins.ffprobe, speed: 'veryfast',
      });
      const { probe } = await import(pathToFileURL(path.join(api.src, 'probe.js')).href);
      const info = await probe(out, { ffprobe: api.bins.ffprobe });
      const ok = info.video.rotation === 0 && info.video.height > info.video.width;
      return { caught: !ok, actual: `rotation=${info.video.rotation} 容器 ${info.video.width}×${info.video.height}` };
    },
  },
  {
    id: 'fit-copy-ignores-rotation-warning',
    title: '体积达标直接复制，却不提醒旋转元数据的事（收到横屏视频都不知道为什么）',
    file: 'src/fit.js',
    module: 'fit.js',
    find: "      if (info.video.rotation !== 0) {",
    replace: '      if (false) {',
    e2e: true,
    async check(m, api) {
      const out = path.join(api.dir, 'mutant-nowarn.mp4');
      const r = await m.fit(api.fixturePortrait, {
        to: '8MB', out, ffmpeg: api.bins.ffmpeg, ffprobe: api.bins.ffprobe, speed: 'veryfast',
      });
      const warned = (r.warnings || []).some((w) => /旋转/.test(w));
      return { caught: !warned, actual: warned ? '有提醒' : '没有任何提醒就交付了带旋转元数据的文件' };
    },
  },
  {
    id: 'dry-run-writes-file',
    title: '--dry-run 真的落文件（说好不动的命令动了用户的磁盘）',
    file: 'src/fit.js',
    module: 'fit.js',
    find: '      if (dryRun) {\n        return finish({ ...base, action: \'copy\', output: outPath, before: info.sizeBytes, after: info.sizeBytes, passes: [], afterInfo: info, dryRun: true });\n      }\n',
    replace: '',
    e2e: true,
    async check(m, api) {
      // 用 tiny：它走 copy 路径，所以变异挂在 copy 的 dry-run 早退上才会被触发
      const out = path.join(api.dir, 'mutant-dry.mp4');
      const r = await m.fit(api.fixtureTiny, {
        to: '8MB', out, ffmpeg: api.bins.ffmpeg, ffprobe: api.bins.ffprobe, speed: 'veryfast', dryRun: true,
      });
      const { existsSync: ex } = await import('node:fs');
      const left = ex(out);
      return { caught: left, actual: left ? `dry-run 留下了文件（dryRun=${r.dryRun}）` : '没有留文件' };
    },
  },
];

function stageMutant(mutant, dir) {
  const srcDir = path.join(dir, 'src');
  cpSync(path.join(ROOT, 'src'), srcDir, { recursive: true });
  cpSync(path.join(ROOT, 'data'), path.join(dir, 'data'), { recursive: true });
  const target = path.join(dir, mutant.file);
  if (!existsSync(target)) {
    const err = new Error(`变异目标不存在：${mutant.file}`);
    err.harness = true;
    throw err;
  }
  const before = readFileSync(target, 'utf8');
  if (!before.includes(mutant.find)) {
    const err = new Error(`变异「${mutant.id}」的锚点没匹配上源码——代码已经变了，这条变异必须重新设计，不能当成「通过」`);
    err.harness = true;
    throw err;
  }
  writeFileSync(target, before.replace(mutant.find, mutant.replace), 'utf8');
  // 必须保留扩展名：去掉 .js 后 import 会失败，于是「模块加载不了」会被误当成「检查抓到了变异」
  return path.join(srcDir, mutant.module);
}

async function main() {
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
  const list = only ? MUTANTS.filter((m) => m.id.includes(only)) : MUTANTS;
  if (!list.length) { console.error(`没有 id 含「${only}」的变异`); process.exitCode = 1; return; }

  const bins = await resolveBinaries();
  const fixtures = await ensureFixtures({ ff: bins.ffmpeg.path, ffprobe: bins.ffprobe.path });
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'express-mut-'));
  const api = {
    bins,
    dir: workDir,
    src: path.join(ROOT, 'src'),
    fixture: fixtures.motion,
    fixturePortrait: fixtures.portrait,
    fixtureTiny: fixtures.tiny,
  };

  const rows = [];
  const leftover = [];
  for (const m of list) {
    const dir = mkdtempSync(path.join(os.tmpdir(), `express-mut-${m.id}-`));
    const t0 = Date.now();
    let result = { caught: false, actual: '（检查没跑）' };
    let error = null;
    let harness = false;
    try {
      const modPath = stageMutant(m, dir);
      const mod = await import(pathToFileURL(modPath).href);
      result = await m.check(mod, api);
    } catch (err) {
      error = err;
      harness = Boolean(err.harness) || /Cannot find module|ERR_MODULE/.test(String(err.message));
    }
    const ms = Math.round(Date.now() - t0);
    rows.push({ ...m, ...result, error, harness, ms, e2e: Boolean(m.e2e) });
    // 重试要给够：里面可能有刚被 ffmpeg 写完的视频，Windows 上会短暂锁住文件。
    // 之前这里 catch 掉了，于是「没删掉」和「删掉了」看起来一模一样。
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 }); }
    catch { leftover.push(dir); }
  }

  // 主工作目录同样要清——之前只清了每个变异自己的目录，主目录一直在 temp 里堆着
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 }); }
  catch { leftover.push(workDir); }

  console.log('');
  console.log('变异测试：故意把产品改坏，看对应的检查会不会红');
  console.log('（caught = 不变量被违反 = 那个检查会红）');
  console.log('='.repeat(78));
  let gaps = 0;
  let broken = 0;
  let controlOk = 0;
  let controlTotal = 0;
  for (const r of rows) {
    const verdict = r.harness ? '✘ 检查自己没跑起来' : r.caught ? '红 ✔ 被抓住' : '绿 ✘ 没抓到！';
    if (r.harness) broken += 1;
    else if (!r.caught) gaps += 1;
    // 反向对照是「预期没被抓住」：它被抓到反而说明校验器坏了
    if (r.control) {
      controlTotal += 1;
      if (!r.harness && !r.caught) controlOk += 1;
    }
    console.log(`\n${r.e2e ? '[端到端]' : '[单点]  '} ${r.id}${r.control ? '（反向对照）' : ''}`);
    console.log(`  破坏：${r.title}`);
    console.log(`  结果：${verdict}${r.error ? `（${String(r.error.message).slice(0, 120)}）` : ''}  用时 ${r.ms}ms`);
    if (typeof r.actual === 'string' && !r.harness) console.log(`  实得：${r.actual}`);
  }
  console.log('');
  console.log('='.repeat(78));
  // 反向对照的失败要从 gaps 里扣掉：它本来就该「没抓到」
  gaps -= controlOk;
  const realMutants = rows.filter((r) => !r.control).length;
  if (broken) {
    console.log(`有 ${broken} 个变异的检查自己没跑起来——这一轮结果不作数，先修变异脚本。`);
    process.exitCode = 1;
  } else if (controlOk !== controlTotal) {
    console.log(`反向对照没通过（${controlOk}/${controlTotal}）：无效变异被误判成「抓住了」，校验器本身有问题。`);
    process.exitCode = 1;
  } else if (gaps > 0) {
    console.log(`有 ${gaps} 个变异没被抓住，那些检查形同虚设。`);
    process.exitCode = 1;
  } else {
    console.log(`全部 ${realMutants} 个变异都被抓住了，${controlTotal} 条反向对照也验证了校验器本身没在自欺。`);
  }
}

await main();
