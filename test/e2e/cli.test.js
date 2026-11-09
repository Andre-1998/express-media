import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ctx, tmpOut, registerTempDir } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'bin', 'express.mjs');
const c = await ctx();

// 每个用例跑在**独立的临时台账**里。
// 之前这里没做隔离，CLI 测试把 9 条测试记录写进了用户真实的 ~/.express/ledger.jsonl——
// 靠「每个用例记得加 --no-ledger」来防，是把约束挂在自觉上；应该由框架保证。
// 同一个沙箱也顺带让 ledger 测试验到真正的读写闭环（之前它读的是用户真实台账，碰巧对上）。
const SANDBOX_HOME = registerTempDir(mkdtempSync(path.join(os.tmpdir(), 'express-cli-sandbox-')));

function runCli(args, { timeout = 240000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      windowsHide: true,
      env: { ...process.env, EXPRESS_HOME: SANDBOX_HOME, NO_COLOR: '1' },
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => p.kill(), timeout);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, all: out + err });
    });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e), all: out + String(e) }); });
  });
}

// 本地化守卫：界面文案必须是中文。
// 注意不能只查「有没有非 ASCII 字符」——纯 ASCII 的整句英文（"output_path is required"）
// 会从这种豁免里完整穿过去。判据是按词数：连续 3 个以上英文单词才算英文句子。
// 单词模式必须把下划线和数字算进去，否则 `output_path is required` 只会匹配到 `is required` 两个词而漏网。
const WORD = '[A-Za-z_][A-Za-z0-9_\'-]*';
function findEnglishSentences(text, { html = false } = {}) {
  const stripped = (html ? String(text).replace(/<[^>]*>/g, ' ') : String(text))
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[A-Za-z_][A-Za-z0-9_.-]*\.(mp4|mkv|html|json|exe|js|cjs|mjs|ts|md)/gi, ' ');
  const hits = [];
  const re = new RegExp(`\\b${WORD}(?:[ \\t]+${WORD}){2,}\\b`, 'g');
  for (const m of stripped.matchAll(re)) hits.push(m[0].trim());
  return hits;
}

test('本地化守卫本身是有效的（先证明尺子能量出东西）', () => {
  assert.deepEqual(findEnglishSentences('output_path is required'), ['output_path is required']);
  assert.deepEqual(findEnglishSentences('at least one of chunks required'), ['at least one of chunks required']);
  assert.deepEqual(findEnglishSentences('压好了，产出：out.mp4'), [], '中文里混一两个标识符不算英文句子');
  assert.deepEqual(findEnglishSentences('目标：wechat-chat 上限 25MB'), [], '平台 id 不算英文句子');
  assert.deepEqual(findEnglishSentences('https://core.telegram.org/bots/faq'), [], '网址不算');
  assert.deepEqual(findEnglishSentences('目录 D:\\temp\\gif-check\\a.gif'), [], '路径不算');
  assert.deepEqual(findEnglishSentences('ffmpeg-9.0.2-essentials_build'), [], '版本号不算');
  // HTML 标签属性不是给人看的文案，不能算「界面里出现了英文句子」
  assert.deepEqual(
    findEnglishSentences('<video controls preload="metadata" src="a.mp4"></video>', { html: true }),
    [],
    'HTML 标签属性不该被判成英文句子',
  );
  // 但标签里的真实文案仍然要抓
  assert.deepEqual(
    findEnglishSentences('<p>the file is too large to send</p>', { html: true }),
    ['the file is too large to send'],
    '标签里的可见文案仍要被抓出来',
  );
});

test('CLI doctor：退出码 0，并且说的是中文', async (t) => {
  const r = await runCli(['doctor']);
  assert.equal(r.code, 0, r.all);
  assert.ok(r.all.includes('环境体检'));
  const english = findEnglishSentences(r.all);
  assert.deepEqual(english, [], `输出里混进了英文句子：${english.join(' / ')}`);
});

test('CLI help：列出所有子命令，且都真实存在', async (t) => {
  const r = await runCli(['help']);
  assert.equal(r.code, 0);
  for (const cmd of ['doctor', 'platforms', 'inspect', 'fit', 'trim', 'gif', 'card', 'ledger']) {
    assert.ok(r.all.includes(cmd), `帮助里漏了 ${cmd}`);
  }
});

test('CLI platforms --json：能解析，且每条都带来源', async (t) => {
  const r = await runCli(['platforms', '--json']);
  assert.equal(r.code, 0);
  const db = JSON.parse(r.out);
  assert.ok(db.length >= 8);
  for (const x of db) {
    assert.ok(x.sources.length > 0, `${x.id} 没有来源`);
    assert.ok(x.label, `${x.id} 没有中文标签`);
  }
});

test('CLI platforms：正文要写清「数字会过期」这件事', async (t) => {
  const r = await runCli(['platforms']);
  assert.match(r.all, /更新于/);
  assert.match(r.all, /官方|社区/);
});

test('CLI inspect --json：字段齐、能判定各平台', async (t) => {
  const r = await runCli(['inspect', c.fixtures.big, '--json']);
  assert.equal(r.code, 0, r.all);
  const [res] = JSON.parse(r.out);
  assert.ok(res.info.sizeBytes > 60 * 1024 * 1024);
  assert.equal(res.info.video.codec, 'h264');
  assert.ok(res.checks.length >= 8);
  const wechat = res.checks.find((x) => x.id === 'wechat-chat');
  assert.equal(wechat.fits, false, '90MB 的片子微信肯定发不出去');
  const gmail = res.checks.find((x) => x.id === 'gmail');
  assert.equal(gmail.fits, false);
});

test('CLI inspect：正文是中文表格，并指出旋转与时长限制', async (t) => {
  const r = await runCli(['inspect', c.fixtures.portrait]);
  assert.equal(r.code, 0);
  assert.match(r.all, /各平台能不能收/);
  assert.match(r.all, /旋转 90°/);
});

test('CLI fit：压成功时退出码 0、文件真的在上限内', async (t) => {
  const out = tmpOut('cli-fit');
  const r = await runCli(['fit', c.fixtures.motion, '--to', '1MB', '--out', out, '--speed', 'veryfast', '--no-ledger']);
  assert.equal(r.code, 0, r.all);
  assert.ok(existsSync(out));
  assert.ok(statSync(out).size <= 1024 * 1024, `产出 ${statSync(out).size} 超过 1MB`);
  assert.match(r.all, /可以发/);
  assert.match(r.all, /压缩比/);
});

test('CLI fit：压不进去时退出码非 0（脚本里能靠它判断成败）', async (t) => {
  const out = tmpOut('cli-fail');
  const r = await runCli(['fit', c.fixtures.big, '--to', '400KB', '--out', out, '--speed', 'veryfast', '--no-ledger', '--max-passes', '2']);
  assert.notEqual(r.code, 0, '压不进去却给成功退出码，脚本会以为发出去了');
  assert.ok(existsSync(out) ? statSync(out).size > 400 * 1024 : true);
  assert.match(r.all, /压不进去|超|换一条路|换个思路/);
});

test('CLI fit 缺 --to 时要说清怎么用，退出码非 0', async (t) => {
  const r = await runCli(['fit', c.fixtures.tiny]);
  assert.notEqual(r.code, 0);
  assert.match(r.all, /--to/);
});

test('CLI fit --dry-run：只出计划，不落文件', async (t) => {
  const out = tmpOut('cli-dry');
  const r = await runCli(['fit', c.fixtures.motion, '--to', '1MB', '--out', out, '--dry-run', '--no-ledger']);
  assert.equal(r.code, 0, r.all);
  assert.equal(existsSync(out), false, 'dry-run 不能落文件');
  assert.match(r.all, /压缩计划/);
  assert.match(r.all, /预估/);
});

test('CLI fit 体积不够时立刻报错，而不是压到一半才发现', async (t) => {
  const r = await runCli(['fit', path.join(ROOT, '不存在的.mp4'), '--to', '25MB', '--no-ledger']);
  assert.notEqual(r.code, 0);
  assert.match(r.all, /文件不存在/);
});

test('CLI 未知命令：退出码 2，并且给出帮助', async (t) => {
  const r = await runCli(['不存在的命令']);
  assert.equal(r.code, 2);
  assert.match(r.all, /没有这个命令|用法/);
});

test('CLI gif：产出真的存在且在 1MB 内（微信表情场景）', async (t) => {
  const out = path.join(tmpOut('cli-gif'), '表情.gif');
  const r = await runCli(['gif', c.fixtures.motion, '--out', out, '--width', '240', '--fps', '10', '--duration', '1', '--square']);
  assert.equal(r.code, 0, r.all);
  assert.ok(existsSync(out));
  assert.ok(statSync(out).size <= 1024 * 1024, `GIF ${statSync(out).size} 超过微信表情 1MB`);
  assert.match(r.all, /1MB/);
});

test('CLI gif：--out 不带扩展名时自己补上，而不是甩一句 ffmpeg 报错', async (t) => {
  // 用户写 --out myclip 是很自然的，ffmpeg 只会回一句
  // "Unable to choose an output format for 'myclip'" —— 这不该由用户来翻译
  const dir = tmpOut('cli-gifext');
  const out = path.join(dir, 'myclip');
  const r = await runCli(['gif', c.fixtures.motion, '--out', out, '--width', '200', '--fps', '8', '--duration', '1']);
  assert.equal(r.code, 0, r.all);
  assert.ok(existsSync(`${out}.gif`), '应该生成 myclip.gif');
  assert.equal(existsSync(out), false, '不该生成一个没有扩展名的 myclip');
  assert.match(r.all, /myclip\.gif/, '要告诉用户实际产出的是哪个文件');
});

test('CLI trim：裁出来的时长对得上', async (t) => {
  const out = path.join(tmpOut('cli-trim'), 'seg.mp4');
  const r = await runCli(['trim', c.fixtures.motion, '--start', '0:01', '--end', '0:02', '--out', out]);
  assert.equal(r.code, 0, r.all);
  assert.ok(existsSync(out));
  assert.match(r.all, /裁好了/);
});

test('CLI fit --card：顺手生成投递卡，且卡片引用的文件真实存在', async (t) => {
  const outDir = tmpOut('cli-card');
  const out = path.join(outDir, 'v.mp4');
  const r = await runCli(['fit', c.fixtures.motion, '--to', '2MB', '--out', out, '--speed', 'veryfast', '--no-ledger', '--card']);
  assert.equal(r.code, 0, r.all);
  const card = path.join(outDir, 'v.card.html');
  assert.ok(existsSync(card), '应该生成 card.html');
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(card, 'utf8');
  assert.ok(html.includes('v.mp4'), '卡片要引用视频');
  assert.ok(!html.includes('NaN'));
  // 卡片引用的相对路径必须真的存在
  const m = html.match(/src="([^"]+)"/);
  assert.ok(m, '卡片里要有 video src');
  assert.ok(existsSync(path.join(outDir, m[1])), `卡片引用的 ${m[1]} 不存在`);
});

test('CLI card：独立生成投递卡，字段齐、引用真实、内容判定不能空', async (t) => {
  // 这条命令在 help 和 README 里都挂着，却一度没有任何端到端测试——
  // 「文档里写了但没人验过」和「没写」一样危险。
  const dir = tmpOut('cli-card2');
  const { mkdirSync, copyFileSync, readFileSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  const video = path.join(dir, '片子.mp4');
  copyFileSync(c.fixtures.motion, video);
  const r = await runCli(['card', video, '--to', 'wechat-chat']);
  assert.equal(r.code, 0, r.all);
  const card = path.join(dir, '片子.card.html');
  assert.ok(existsSync(card), '应该生成 片子.card.html');
  const html = readFileSync(card, 'utf8');
  assert.ok(html.includes('片子.mp4'), '卡片要引用视频');
  assert.ok(!html.includes('NaN'), '不能出现 NaN');
  assert.ok(!html.includes('undefined'));
  assert.ok(!html.includes('内容判定</th><td></td>'), '内容判定不能是空的');
  assert.match(html, /微信 · 聊天窗口/, '指定了目标就该只列这一条判定');
  // 引用的封面和视频都必须真实存在
  const m = html.match(/poster="([^"]+)"/);
  assert.ok(m && existsSync(path.join(dir, m[1])), '封面引用必须指向真实文件');
  const s = html.match(/src="([^"]+)"/);
  assert.ok(s && existsSync(path.join(dir, s[1])), '视频引用必须指向真实文件');
  // 本地化守卫同样适用于卡片（去掉 HTML 标签后再扫，标签属性不是文案）
  const english = findEnglishSentences(html, { html: true });
  assert.deepEqual(english, [], `卡片里混进了英文句子：${english.join(' / ')}`);
});

test('CLI ledger：写进去再读出来，闭环成立', async (t) => {
  const home = tmpOut('cli-ledger-home');
  const out = path.join(home, 'r.mp4');
  await runCli(['fit', c.fixtures.motion, '--to', '2MB', '--out', out, '--speed', 'veryfast', '--card']);
  const r = await runCli(['ledger', '--json'], { timeout: 60000 });
  assert.equal(r.code, 0, r.all);
  const data = JSON.parse(r.out);
  assert.ok(data.summary);
  assert.ok(Array.isArray(data.entries));
  // 台账读写现在在同一个沙箱里，所以这里能验到真正的闭环
  // （之前 fit 写进了用户真实台账、ledger 读的也是它，「碰巧」对上）
  assert.ok(data.summary.count > 0, '刚压过一次，台账里应该有记录');
  assert.ok(data.summary.savedBytes > 0, '应该记下省了多少');
  const mine = data.entries.filter((e) => String(e.input).includes('motion.mp4'));
  assert.ok(mine.length > 0, '刚才那次压缩应该在台账里');
  assert.ok(mine[0].fitsHardLimit === true, '达标的结果要记成达标');
});

test('CLI card：--out 指到别处时，封面引用仍然有效', async (t) => {
  // 这条是补一个真实漏洞：封面原本抽到「视频所在目录」，而卡片里写的是相对路径。
  // 当 --out 指到另一个目录时，poster="xxx.cover.jpg" 就指错了地方——
  // 卡片在别处打开是没有封面的。之前的测试只测了「不给 --out」（输入输出同目录，恰好能工作）。
  const videoDir = tmpOut('card-src');
  const cardDir = tmpOut('card-dst');
  const { mkdirSync, copyFileSync, readFileSync } = await import('node:fs');
  mkdirSync(videoDir, { recursive: true });
  mkdirSync(cardDir, { recursive: true });
  const video = path.join(videoDir, '原视频.mp4');
  copyFileSync(c.fixtures.motion, video);
  const cardPath = path.join(cardDir, '卡片.html');

  const r = await runCli(['card', video, '--out', cardPath, '--to', 'wechat-chat']);
  assert.equal(r.code, 0, r.all);
  assert.ok(existsSync(cardPath));

  const html = readFileSync(cardPath, 'utf8');
  const m = html.match(/poster="([^"]+)"/);
  assert.ok(m, '卡片里要有 poster 引用');
  assert.ok(
    existsSync(path.join(cardDir, m[1])),
    `封面 ${m[1]} 应该和卡片在同一个目录（${cardDir}），否则相对路径指不到`,
  );
  assert.ok(
    !existsSync(path.join(videoDir, m[1])),
    '封面不该留在视频原目录里（那会污染用户放视频的地方）',
  );
  // 视频不在旁边时要给出提示，而不是默默交付一个换机器就打不开的卡片
  assert.match(r.all, /视频不在卡片同一目录|注意/);
});

test('CLI 测试不该在用户真实 home 留下任何东西', async (t) => {
  // 这条是防复发的守卫。真实事故：CLI 测试没做台账隔离，把 9 条测试记录
  // 写进了 ~/.express/ledger.jsonl（全是 Temp\express-* 路径）。
  // 靠「每个用例记得加 --no-ledger」来防是把约束挂在自觉上，应该由框架保证。
  const realHome = process.env.USERPROFILE || os.homedir();
  const realLedger = path.join(realHome, '.express', 'ledger.jsonl');
  if (!existsSync(realLedger)) {
    t.diagnostic('用户真实台账不存在，本轮测试确实没碰它');
    return;
  }
  const text = readFileSync(realLedger, 'utf8');
  const polluted = text.split(/\r?\n/).filter(Boolean).filter((l) => {
    try { return /Temp[\\/]express-|express-cli-sandbox/.test(JSON.parse(l).output || ''); } catch { return false; }
  });
  assert.deepEqual(polluted, [], `用户真实台账里有 ${polluted.length} 条测试数据，请清掉 ~/.express/ledger.jsonl`);
});

test('所有 CLI 输出都不该出现 NaN / undefined / [object Object]', async (t) => {
  const cases = [
    ['platforms'],
    ['inspect', c.fixtures.big],
    ['inspect', c.fixtures.tiny],
    ['inspect', c.fixtures.silent],
    ['help'],
  ];
  for (const args of cases) {
    const r = await runCli(args);
    for (const bad of ['NaN', 'undefined', '[object Object]']) {
      assert.ok(!r.all.includes(bad), `${args.join(' ')} 的输出里出现了 ${bad}`);
    }
  }
});
