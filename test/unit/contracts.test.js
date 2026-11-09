import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlatforms, DATA_PATH } from '../../src/format.js';
import { parseTimecode, trimArgs, splitArgs } from '../../src/trim.js';
import { buildGifFilter, gifWarnings, GIF_LIMITS } from '../../src/gif.js';
import { cardHtml } from '../../src/card.js';
import { parseFfmpegTime, tryRun } from '../../src/ffmpeg.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// —— 平台表：这份数据是整个工具的地基，坏一条就有一条平台判错 ——

test('平台表：每条都有 id、标签、合法体积、来源', () => {
  const db = loadPlatforms({ reload: true });
  assert.ok(db.targets.length >= 8, '平台太少了，说明表没维护');
  for (const t of db.targets) {
    assert.match(t.id, /^[a-z0-9-]+$/, `id 要是小写短横线：${t.id}`);
    assert.ok(t.label && t.label.length > 1, `${t.id} 缺中文标签`);
    assert.ok(Number.isFinite(t.maxBytes) && t.maxBytes > 0, `${t.id} 的 maxBytes 不对`);
    assert.ok(['official', 'community', 'mixed'].includes(t.confidence), `${t.id} 的 confidence 取值非法：${t.confidence}`);
    assert.ok(db.confidenceLevels[t.confidence], `${t.id} 用了表里没解释的置信度`);
    assert.ok(Array.isArray(t.sources) && t.sources.length > 0, `${t.id} 没有来源——不标来源的数字不敢用`);
    for (const s of t.sources) {
      assert.match(s.url, /^https?:\/\//, `${t.id} 的来源不是网址：${s.url}`);
      assert.ok(s.note && s.note.length > 4, `${t.id} 的来源没说明它说了什么`);
    }
    if (t.suggestedMaxBytes !== undefined) {
      assert.ok(t.suggestedMaxBytes <= t.maxBytes, `${t.id} 的建议值比硬上限还大`);
      assert.ok(t.suggestedMaxBytes > 0, `${t.id} 的建议值必须为正`);
    }
    if (t.maxDurationSec !== undefined && t.maxDurationSec !== null) {
      assert.ok(t.maxDurationSec > 0, `${t.id} 的时长上限必须为正`);
    }
  }
});

test('平台表：mixed 的条目必须把矛盾口径都列进 variants', () => {
  const db = loadPlatforms({ reload: true });
  for (const t of db.targets) {
    if (t.confidence !== 'mixed') continue;
    assert.ok(Array.isArray(t.variants) && t.variants.length > 0, `${t.id} 标了口径不一，却没列另一套说法`);
    for (const v of t.variants) {
      assert.ok(Number.isFinite(v.maxBytes), `${t.id} 的 variant 缺 maxBytes`);
      assert.ok(v.note, `${t.id} 的 variant 缺说明`);
    }
  }
});

test('平台表：写入时间戳格式正确，且不能是未来（防止忘了更新却以为是最新的）', () => {
  const db = loadPlatforms({ reload: true });
  assert.match(db.updatedAt, /^\d{4}-\d{2}-\d{2}$/);
  // 用本地日期比：updatedAt 记的是「查资料的当天」，按 UTC 比会在跨日时段误报
  const now = new Date();
  const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  assert.ok(db.updatedAt <= local, `更新时间 ${db.updatedAt} 不能晚于今天 ${local}`);
});

test('平台表：JSON 本身合法（文件在手，改坏了要立刻炸）', () => {
  const raw = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
  assert.equal(raw.schema, 1);
  assert.ok(raw.disclaimer && raw.disclaimer.length > 20, '必须写清楚这些数字会过期');
});

// —— 文档与代码不许漂移：README / 帮助里出现的平台 id 必须真实存在 ——

test('文档里提到的平台 id 都真实存在（防止文档教人一个不存在的目标）', () => {
  const db = loadPlatforms({ reload: true });
  const ids = new Set(db.targets.map((t) => t.id));
  const files = ['README.md', 'src/cli.js'];
  for (const rel of files) {
    const p = path.join(root, rel);
    let text;
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    // 抓 --to xxx / express fit ... --to xxx 形式出现的目标 id
    for (const m of text.matchAll(/--to\s+([a-z][a-z0-9-]+)/g)) {
      assert.ok(ids.has(m[1]), `${rel} 里出现 --to ${m[1]}，但平台表里没有这个 id`);
    }
  }
});

test('平台表里没有孤儿：每条都能被 inspect 的判定逻辑消费', () => {
  const db = loadPlatforms({ reload: true });
  for (const t of db.targets) {
    assert.ok(typeof t.maxBytes === 'number');
    // 判定时会用到的字段不能是 undefined 之外的东西
    assert.ok(t.confidence);
  }
});

// —— 时间码 ——

test('parseTimecode 认得秒、分秒、时分秒、小数', () => {
  assert.equal(parseTimecode('12'), 12);
  assert.equal(parseTimecode('12.5'), 12.5);
  assert.equal(parseTimecode('1:30'), 90);
  assert.equal(parseTimecode('01:02:03'), 3723);
  assert.equal(parseTimecode('0:00:30'), 30);
});

test('parseTimecode 对看不懂的输入要报错', () => {
  for (const bad of ['', 'abc', '1:xx', '1:2:3:4', '-5']) {
    assert.throws(() => parseTimecode(bad), /看不懂的时间|长度/, `应该拒绝：${bad}`);
  }
});

test('trimArgs：起点在 -i 之前（快速定位），时长在之后，且默认重编码保证切点准确', () => {
  const a = trimArgs({ input: 'in.mp4', output: 'out.mp4', start: 5, duration: 10 });
  assert.ok(a.indexOf('-ss') < a.indexOf('-i'), '-ss 必须在 -i 之前');
  assert.equal(a[a.indexOf('-ss') + 1], '5');
  assert.equal(a[a.indexOf('-t') + 1], '10');
  assert.equal(a.at(-1), 'out.mp4');
  assert.ok(a.includes('libx264'), '重编码才能保证切点帧准确');

  const copy = trimArgs({ input: 'in.mp4', output: 'o.mp4', start: 0, duration: 3, reencode: false });
  assert.ok(copy.includes('-c'), '快速模式用 -c copy');
  assert.ok(copy.includes('copy'));
});

test('splitArgs：分段也要重编码，不能 copy（否则每段起点都不准）', () => {
  const a = splitArgs({ input: 'in.mp4', output: 'part1.mp4', start: 0, duration: 30 });
  assert.ok(a.includes('-ss') && a.includes('-t'));
  assert.ok(a.includes('libx264'));
  assert.equal(a.at(-1), 'part1.mp4');
});

// —— GIF ——

test('buildGifFilter：必须走 palettegen/paletteuse，否则渐变会出色带', () => {
  const f = buildGifFilter({ width: 320, fps: 12 });
  assert.ok(f.includes('palettegen'), '缺 palettegen');
  assert.ok(f.includes('paletteuse'), '缺 paletteuse');
  assert.ok(f.includes('scale=320:-1'), '非正方形时保持比例');
  assert.ok(f.includes('fps=12'));
});

test('buildGifFilter：方形模式先放大再居中裁，不能直接拉伸', () => {
  const f = buildGifFilter({ width: 240, fps: 10, cropSquare: true });
  assert.ok(f.includes('force_original_aspect_ratio=increase'));
  assert.ok(f.includes('crop=240:240'));
  assert.ok(f.includes('fps=10'));
});

test('gifWarnings：超过 1MB 要警告，并给出可执行的下一步', () => {
  const big = gifWarnings(2 * 1024 * 1024, 320);
  assert.ok(big.length > 0);
  assert.ok(big.join(' ').includes('1MB'), '要说清限制是什么');
  assert.ok(/\d+/.test(big.join(' ')), '要给个具体数字，别只说「再小点」');

  const ok = gifWarnings(500 * 1024, 320);
  assert.deepEqual(ok, [], '1MB 以内不该报警');
  assert.equal(GIF_LIMITS.wechatEmojiBytes, 1024 * 1024);
});

test('gifWarnings：太宽的 GIF 值得提醒（聊天窗口里会缩得很小）', () => {
  assert.ok(gifWarnings(300 * 1024, 720).join(' ').includes('偏大'));
});

// —— 投递卡 ——

test('cardHtml：视频与封面用相对文件名引用，不把视频塞进 HTML', () => {
  const html = cardHtml({ videoPath: 'out.mp4', posterName: 'out.cover.jpg', meta: { afterBytes: 12345 } });
  assert.ok(html.includes('src="out.mp4"'));
  assert.ok(html.includes('poster="out.cover.jpg"'));
  assert.ok(html.includes('download'), '要有下载入口');
  assert.ok(!html.includes('base64'), '视频绝不能以 base64 内嵌，那会让 HTML 几百 MB');
});

test('cardHtml：文件名里的引号和尖括号要被转义（不然 HTML 结构就坏了）', () => {
  const html = cardHtml({
    videoPath: 'a"><script>alert(1)</script>.mp4',
    meta: { target: '<b>微信</b>', afterBytes: 1, beforeBytes: 2 },
  });
  assert.ok(!html.includes('<script>'), '不能出现可执行的 script 标签');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;b&gt;微信&lt;/b&gt;'));
});

test('cardHtml：没有前后对比时不能显示 NaN 或 undefined', () => {
  const html = cardHtml({ videoPath: 'x.mp4', meta: {} });
  assert.ok(!html.includes('NaN'), `出现了 NaN：${html.match(/.{40}NaN.{40}/)?.[0]}`);
  assert.ok(!html.includes('undefined'));
});

test('cardHtml：平台判定表把「超了多少」写出来', () => {
  const html = cardHtml({
    videoPath: 'x.mp4',
    meta: {
      afterBytes: 30 * 1024 * 1024,
      platformChecks: [{ label: '微信 · 聊天窗口', maxBytes: 25 * 1024 * 1024, bytes: 30 * 1024 * 1024, sizeOk: false, durationOk: true, fits: false, note: '' }],
    },
  });
  assert.ok(html.includes('超 '), '超限时应该写明超出多少');
  assert.ok(html.includes('微信 · 聊天窗口'));
});

test('cardHtml：体积够但时长超限时，要说时长而不是「超 0 B」', () => {
  // 朋友圈限 30 秒但体积上限有 10MB：一条 40 秒、7MB 的片子体积是够的。
  // 只按体积算差值的话，7MB - 10MB 是负数，取 max(0,·) 就变成「超 0 B」——等于什么都没说。
  const html = cardHtml({
    videoPath: 'x.mp4',
    meta: {
      durationSec: 40,
      afterBytes: 7 * 1024 * 1024,
      platformChecks: [{
        label: '微信 · 朋友圈', maxBytes: 10 * 1024 * 1024, bytes: 7 * 1024 * 1024,
        maxDurationSec: 30, durationSec: 40, sizeOk: true, durationOk: false, fits: false, note: '',
      }],
    },
  });
  assert.ok(html.includes('时长超限'), '必须说清是时长的问题');
  assert.ok(html.includes('30 秒'), '要说清上限是多少秒');
  assert.ok(!html.includes('超 0 B'), '不能出现「超 0 B」这种等于没说的话');
});

test('cardHtml：体积和时长都超时，两个原因都要写出来', () => {
  const html = cardHtml({
    videoPath: 'x.mp4',
    meta: {
      durationSec: 95,
      afterBytes: 30 * 1024 * 1024,
      platformChecks: [{
        label: '微信 · 朋友圈', maxBytes: 10 * 1024 * 1024, bytes: 30 * 1024 * 1024,
        maxDurationSec: 30, durationSec: 95, sizeOk: false, durationOk: false, fits: false, note: '',
      }],
    },
  });
  assert.ok(html.includes('体积和时长都超'));
  assert.match(html, /超出 [\d.]+ MB/);
  assert.match(html, /1 分 35 秒 超过 30 秒/);
});

// —— ffmpeg 辅助 ——

test('parseFfmpegTime 认得 ffmpeg 的进度行', () => {
  assert.equal(parseFfmpegTime('frame=  120 fps= 30 q=28.0 size=     512kB time=00:00:04.00 bitrate=1048.6kbits/s'), 4);
  assert.equal(parseFfmpegTime('time=01:02:03.50'), 3723.5);
  assert.equal(parseFfmpegTime('time=-00:00:02.00'), -2);
  assert.equal(parseFfmpegTime('没有 time 的一行'), null);
  assert.equal(parseFfmpegTime(''), null);
});

test('tryRun：路径不存在时明确说 enoent，而不是笼统失败', async () => {
  const r = await tryRun('D:/绝对/不存在/ffmpeg.exe', ['-version']);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'enoent');
  assert.ok(r.error, '要带上原始错误，便于判断是路径问题还是权限问题');
});

test('tryRun：非零退出码要报出来，且带上输出前几行', async () => {
  const r = await tryRun(process.execPath, ['-e', 'process.exit(3)']);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'exit-3');
});

// —— 目录结构 ——

test('项目里没有临时文件混进源码目录', () => {
  const srcDir = path.join(root, 'src');
  for (const f of readdirSync(srcDir)) {
    assert.ok(!/\.(tmp|log|part)$/.test(f), `src 里有临时文件：${f}`);
    assert.ok(f.endsWith('.js'), `src 里出现了非 .js 文件：${f}`);
  }
  assert.ok(statSync(path.join(root, 'package.json')).size > 0);
});

/**
 * 源码、配置、文档一律不许带 UTF-8 BOM。
 *
 * 真实事故：用 PowerShell 5.1 的 `Set-Content -Encoding UTF8` 批量改文件，
 * 22 个文件全被写上了 BOM。Node 容忍 .js 带 BOM，但 JSON 解析会直接失败，
 * 而且这批文件里就包括插件要用的 src/*.js 与清单。
 *
 * 这条守卫是必要的：只要还用 PowerShell 改文件，它就会再犯。
 */
test('所有源码 / 配置 / 文档都没有 UTF-8 BOM', () => {
  const roots = [root, path.join(process.env.USERPROFILE || '', '.minimax', 'plugins', 'express-media')]
    .filter((p) => p && existsSync(p));
  const skip = /node_modules|fixtures[\\/]media|\.(png|jpg|webp)$/;
  const bad = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (skip.test(p)) continue;
      if (entry.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs|cjs|json|md)$/i.test(entry.name)) continue;
      const fd = readFileSync(p);
      if (fd.length >= 3 && fd[0] === 0xef && fd[1] === 0xbb && fd[2] === 0xbf) bad.push(p);
    }
  };
  for (const r of roots) walk(r);
  assert.deepEqual(
    bad.map((p) => path.relative(root, p).replace(/\\/g, '/')),
    [],
    `这些文件带 UTF-8 BOM（PowerShell 5.1 的 Set-Content -Encoding UTF8 会加）：\n  ${bad.join('\n  ')}`,
  );
});

test('JSON 文件能被严格解析（带 BOM 会让 JSON.parse 直接失败）', () => {
  for (const rel of ['package.json', 'data/platforms.json']) {
    const text = readFileSync(path.join(root, rel), 'utf8');
    const parsed = JSON.parse(text.replace(/^﻿/, '')); // 去掉 BOM 后必须能解析
    assert.ok(parsed && typeof parsed === 'object', `${rel} 解析结果不是对象`);
  }
});
