import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trackTempDir } from '../cleanup.mjs';
import { resolveBinaries } from '../../src/ffmpeg.js';
import { ensureFixtures, verifyFixtures } from '../fixtures/make-fixtures.mjs';

let cached = null;

// 临时目录的登记与清理由 ../cleanup.mjs 统一负责（unit 测试也要用），
// 这里只提供 e2e 需要的包装。

/** 供 cli.test.js 复用：登记一个已存在的目录，测试跑完后清掉 */
export function registerTempDir(dir) {
  return trackTempDir(dir);
}

/** 端到端测试的公共前提：ffmpeg 能跑、素材齐全且属性可信。 */
export async function ctx() {
  if (cached) return cached;
  const bins = await resolveBinaries();
  if (!bins.ffmpeg || !bins.ffprobe) throw new Error('这台机器上没有可用的 ffmpeg，端到端测试跑不了（先跑 express doctor）');
  const fixtures = await ensureFixtures({ ff: bins.ffmpeg.path, ffprobe: bins.ffprobe.path });
  const verify = await verifyFixtures({ ff: bins.ffmpeg.path, ffprobe: bins.ffprobe.path });
  const bad = verify.filter((v) => v.problems.length);
  if (bad.length) {
    const detail = bad.map((b) => `${b.name}：${b.problems.join('；')}`).join(' | ');
    throw new Error(`夹具不可信，端到端测试会变成空转，先修素材：${detail}`);
  }
  cached = { ...bins, fixtures, verify };
  return cached;
}

/**
 * 造一个**尚不存在**的输出路径。
 *
 * 「不存在」是有意为之：它模拟用户真实会犯的错（`--out` 指到一个还没建好的地方），
 * 工具必须自己把目录建出来。改成返回已存在的目录会把这层覆盖悄悄弄掉——
 * 而当初正是这个场景暴露了「中间临时文件写在目录创建之前」那个 bug。
 * 所以这里只登记父目录用于退出时清理，返回值语义一个字都不动。
 */
export function tmpOut(tag = 'x') {
  const parent = registerTempDir(mkdtempSync(path.join(os.tmpdir(), `express-${tag}-`)));
  return path.join(parent, 'out');
}

/** 文件在磁盘上的真实体积。判定必须以它为准，不是以工具自己报的数为准。 */
export function realSize(p) {
  return statSync(p).size;
}

/** 一条铁律：工具说「达标」，磁盘上的文件就必须真的达标。 */
export function assertVerdictHonest(t, result) {
  const bytes = realSize(result.output);
  assertBytesMatch(t, bytes, result.after, '报告的产出体积');
  if (result.verdict.fitsHardLimit === true) {
    t.assert.ok(
      bytes <= result.target.hardBytes,
      `报告说达标（${bytes} <= ${result.target.hardBytes}），但磁盘上是 ${bytes}`,
    );
  }
  if (result.verdict.fitsHardLimit === false) {
    t.assert.ok(bytes > result.target.hardBytes, `报告说超限（${result.target.hardBytes}），但磁盘上只有 ${bytes}`);
    t.assert.ok(result.alternatives.length > 0, '报了超限就必须给替代方案，不能只说一句「失败了」');
  }
  t.assert.equal(bytes, result.after, 'result.after 必须等于磁盘上的真实体积');
  return bytes;
}

function assertBytesMatch(t, a, b, what) {
  t.assert.equal(a, b, `${what}对不上：磁盘 ${a} vs 报告 ${b}`);
}
