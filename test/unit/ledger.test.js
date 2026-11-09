import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trackTempDir } from '../cleanup.mjs';
import { appendEntry, readEntries, summarize, toEntry, reportHtml, writeReport, ledgerPath } from '../../src/ledger.js';

// 也登记到统一清理里。之前这个文件自己 mkdtemp 完就不管了，
// 于是每次跑单测都往系统 temp 里丢 4 个 express-ledger-* 目录。
function tempHome() {
  return trackTempDir(mkdtempSync(path.join(os.tmpdir(), 'express-ledger-')));
}

test('台账：写进去再读出来，一条不能少', () => {
  const env = { EXPRESS_HOME: tempHome() };
  appendEntry({ action: 'encode', input: 'a.mp4', output: 'a.out.mp4', beforeBytes: 1000, afterBytes: 250, targetLabel: '微信' }, { env });
  appendEntry({ action: 'copy', input: 'b.mp4', output: 'b.mp4', beforeBytes: 500, afterBytes: 500, targetLabel: 'Telegram' }, { env });
  const entries = readEntries({ env });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].input, 'a.mp4');
  assert.ok(entries[0].ts, '每条都要有时间戳');
});

test('台账：文件里有一行坏 JSON 时，只丢那一行', () => {
  const env = { EXPRESS_HOME: tempHome() };
  appendEntry({ beforeBytes: 10, afterBytes: 5, input: 'ok1' }, { env });
  writeFileSync(ledgerPath(env), '{"broken":\n' + JSON.stringify({ beforeBytes: 20, afterBytes: 10, input: 'ok2' }) + '\n', 'utf8');
  const entries = readEntries({ env });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].input, 'ok2');
});

test('台账：还没有台账时读出来是空数组，不是崩', () => {
  const env = { EXPRESS_HOME: path.join(tempHome(), 'nested', 'not-created-yet') };
  assert.deepEqual(readEntries({ env }), []);
  assert.deepEqual(summarize(readEntries({ env })), {
    count: 0, beforeBytes: 0, afterBytes: 0, savedBytes: 0, savedRatio: null, encodeSeconds: 0, byTarget: [],
  });
});

test('汇总：累计省下的体积算得对，按目标分组也分得对', () => {
  const entries = [
    { beforeBytes: 1000, afterBytes: 100, targetLabel: '微信', encodeSeconds: 3 },
    { beforeBytes: 500, afterBytes: 250, targetLabel: '微信', encodeSeconds: 1 },
    { beforeBytes: 2000, afterBytes: 1000, targetLabel: 'Telegram', encodeSeconds: 5 },
  ];
  const s = summarize(entries);
  assert.equal(s.count, 3);
  assert.equal(s.beforeBytes, 3500);
  assert.equal(s.afterBytes, 1350);
  assert.equal(s.savedBytes, 2150);
  assert.equal(s.encodeSeconds, 9);
  assert.equal(s.byTarget.length, 2);
  assert.equal(s.byTarget[0].target, '微信', '省得多的排前面');
  assert.equal(s.byTarget[0].savedBytes, 1150);
});

test('汇总：缺字段的条目要被排除，不能变成 NaN 污染总数', () => {
  const s = summarize([
    { beforeBytes: 100, afterBytes: 10 },
    { beforeBytes: undefined, afterBytes: 5 },
    { input: 'no numbers' },
  ]);
  assert.equal(s.count, 1);
  assert.equal(s.beforeBytes, 100);
  assert.ok(Number.isFinite(s.savedBytes));
});

test('汇总：全部压大了的情况，省下的是 0 而不是负数', () => {
  const s = summarize([{ beforeBytes: 100, afterBytes: 300 }]);
  assert.equal(s.savedBytes, 0, '「省下」不能是负的，那会让报告出现负数');
});

test('toEntry：把 fit 的结果压成台账需要的那几个字段', () => {
  const entry = toEntry({
    action: 'encode',
    input: 'in.mp4',
    output: 'out.mp4',
    target: { kind: 'platform', platform: { id: 'wechat-chat' }, label: '微信 · 聊天窗口' },
    before: 1000,
    after: 200,
    inputInfo: { durationSec: 12 },
    content: { kind: 'screen' },
    passes: [{ crf: 28 }, { crf: 30 }],
    verdict: { fitsHardLimit: true },
  }, { encodeSeconds: 4.5 });
  assert.equal(entry.targetId, 'wechat-chat');
  assert.equal(entry.beforeBytes, 1000);
  assert.equal(entry.afterBytes, 200);
  assert.equal(entry.durationSec, 12);
  assert.equal(entry.contentKind, 'screen');
  assert.equal(entry.passCount, 2);
  assert.equal(entry.encodeSeconds, 4.5);
  assert.equal(entry.fitsHardLimit, true);
});

test('toEntry：自定义目标没有 platform.id 时不能崩', () => {
  const entry = toEntry({
    action: 'encode', input: 'a', output: 'b',
    target: { kind: 'custom', platform: null, label: '自定义 25 MB' },
    before: 1, after: 1, inputInfo: {}, content: {}, passes: [], verdict: {},
  });
  assert.equal(entry.targetId, 'custom');
  assert.equal(entry.targetLabel, '自定义 25 MB');
});

test('报告 HTML：空台账也能出图，且不出现 NaN', () => {
  const html = reportHtml(summarize([]), []);
  assert.ok(html.includes('<!doctype html>'));
  assert.ok(html.includes('台账还是空的'));
  assert.ok(!html.includes('NaN'));
  assert.ok(!html.includes('undefined'));
});

test('报告 HTML：明细行里的文件名要转义，别把 HTML 撑破', () => {
  const s = summarize([{ beforeBytes: 100, afterBytes: 10, targetLabel: 'x' }]);
  const html = reportHtml(s, [{ ts: '2026-10-01T00:00:00.000Z', input: 'C:\\vids\\a&b<c>.mp4', beforeBytes: 100, afterBytes: 10, targetLabel: '微信', fitsHardLimit: true }]);
  assert.ok(html.includes('a&amp;b&lt;c&gt;.mp4'));
  assert.ok(html.includes('省下'));
  assert.ok(!html.includes('NaN'));
});

test('报告写到指定路径，目录不存在时自动建', () => {
  const dir = tempHome();
  const p = path.join(dir, 'deep', 'nested', 'report.html');
  const s = summarize([{ beforeBytes: 100, afterBytes: 10, targetLabel: 'x' }]);
  writeReport(p, s, []);
  assert.ok(existsSync(p));
  assert.ok(readFileSync(p, 'utf8').includes('<!doctype html>'));
});
