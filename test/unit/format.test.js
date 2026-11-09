import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSize, safeAim, resolveTarget, formatBytes, formatDuration, formatBitrate, loadPlatforms, getTarget, ensureExtension, displayWidth, padDisplay, containerLabel } from '../../src/format.js';

test('parseSize 认得各种写法', () => {
  assert.equal(parseSize('25MB'), 25 * 1024 * 1024);
  assert.equal(parseSize('25mb'), 25 * 1024 * 1024);
  assert.equal(parseSize('500k'), 500 * 1024);
  assert.equal(parseSize('1.5g'), Math.floor(1.5 * 1024 ** 3));
  assert.equal(parseSize(2048), 2048);
  assert.equal(parseSize('1024'), 1024);
});

test('parseSize 对看不懂的东西要报错，而不是默默当 0', () => {
  for (const bad of ['', 'abc', '25 MB extra', 'MB', '-5MB']) {
    assert.throws(() => parseSize(bad), /看不懂的大小/, `应该拒绝：${bad}`);
  }
});

test('safeAim 一定比硬上限小，而且留的余量不是零', () => {
  const hard = 25 * 1024 * 1024;
  const aim = safeAim(hard);
  assert.ok(aim < hard, '目标必须低于硬上限');
  assert.ok(hard - aim >= 512 * 1024, '至少留 512KB 余量');
});

test('safeAim 对小目标按比例留余量（固定 512KB 会把它吃光）', () => {
  // 这一条是踩过的坑：400KB 的目标减去固定 512KB 余量后只剩 1KB，
  // 于是「裁到多少秒能压进去」这类建议永远算不出来。
  for (const hard of [100, 1024, 10 * 1024, 60 * 1024, 64 * 1024, 100 * 1024, 400 * 1024]) {
    const aim = safeAim(hard);
    assert.ok(aim > 0, `${hard}B 的目标体积被吃成了 ${aim}`);
    assert.ok(aim < hard, `${hard}B 的目标反而比上限还大：${aim}`);
    assert.ok(hard - aim <= hard * 0.5, `${hard}B 的目标留了超过一半余量，没法用`);
  }
  // 退化输入（1 字节）不能崩，容许它等于上限
  assert.ok(safeAim(1) >= 1);
  assert.ok(safeAim(0) >= 1, '0 也不能返回 0，否则后面会除零');
  // 大目标仍然按固定余量 + 2% 留
  assert.ok(25 * 1024 * 1024 - safeAim(25 * 1024 * 1024) >= 512 * 1024);
});

test('resolveTarget 认平台 id，也认自定义大小', () => {
  const p = resolveTarget('telegram-bot');
  assert.equal(p.kind, 'platform');
  assert.equal(p.hardBytes, 50 * 1024 * 1024);
  assert.ok(p.aimBytes < p.hardBytes);
  assert.equal(p.confidence, 'official');

  const c = resolveTarget('30MB');
  assert.equal(c.kind, 'custom');
  assert.equal(c.hardBytes, 30 * 1024 * 1024);
  assert.equal(c.platform, null);
});

test('resolveTarget 对不存在的平台要报错，并把可用的列出来', () => {
  assert.throws(() => resolveTarget('不存在的平台'), /没这个目标/);
  assert.throws(() => resolveTarget('不存在的平台'), /telegram-bot/);
});

test('resolveTarget 拦下荒唐的目标体积（多半是少打了个 0）', () => {
  for (const bad of ['0', '1', '10', '0.0001MB', '8KB']) {
    assert.throws(() => resolveTarget(bad), /目标体积太小/, `应该拒绝：${bad}`);
  }
  // 报错要教人怎么改，而不是只说「错了」
  try { resolveTarget('0'); } catch (e) { assert.match(e.message, /--to/); }
  // 刚好在门槛之上要接受
  assert.doesNotThrow(() => resolveTarget('16KB'));
  assert.doesNotThrow(() => resolveTarget('25MB'));
});

test('自定义目标小于 2MB 时，音频预算要跟着缩', () => {
  const small = resolveTarget('1MB');
  const big = resolveTarget('100MB');
  assert.ok(small.aimBytes < 2 * 1024 * 1024);
  assert.ok(big.aimBytes > 2 * 1024 * 1024);
});

test('ensureExtension：没有扩展名就补上，扩展名不对也不覆盖用户写的名字', () => {
  // ffmpeg 靠扩展名判断输出格式，路径没有扩展名时会报一句用户看不懂的错
  assert.equal(ensureExtension('myclip', 'gif'), 'myclip.gif');
  assert.equal(ensureExtension('D:\\a\\b\\myclip', 'mp4'), 'D:\\a\\b\\myclip.mp4');
  // 已经有正确扩展名：原样返回
  assert.equal(ensureExtension('myclip.gif', 'gif'), 'myclip.gif');
  assert.equal(ensureExtension('myclip.MP4', 'mp4'), 'myclip.MP4');
  // 扩展名不对：不覆盖用户写的名字（那太意外），而是在后面补一个正确的
  assert.equal(ensureExtension('myclip.mp4', 'gif'), 'myclip.mp4.gif');
  assert.equal(ensureExtension('a.b.mp4', 'gif'), 'a.b.mp4.gif');
});

test('displayWidth：中文按两列算（终端表格对不齐比没有表格更难读）', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('微信'), 4);
  // 微信(4) + 空格(1) + ·(1) + 空格(1) + 聊天窗口(8) = 15 列，但只有 9 个字符
  assert.equal('微信 · 聊天窗口'.length, 9);
  assert.equal(displayWidth('微信 · 聊天窗口'), 15);
  assert.equal(displayWidth(''), 0);
  // 同一宽度目标下，中文串补的空格必须比等长英文串少
  assert.ok(padDisplay('微信', 10).length < padDisplay('abcd', 10).length);
  assert.equal(displayWidth(padDisplay('微信', 10)), 10);
  assert.equal(displayWidth(padDisplay('abcd', 10)), 10);
  // 已经超宽时不截断，只是补 0 个空格
  assert.equal(displayWidth(padDisplay('很长很长的中文标签', 4)), 18);
});

test('containerLabel：把 ffmpeg 的候选容器清单收敛成一个名字', () => {
  assert.equal(containerLabel('mov,mp4,m4a,3gp,3g2,mj2'), 'mp4');
  assert.equal(containerLabel('matroska,webm'), 'mkv');
  assert.equal(containerLabel('matroska,webm'), 'mkv', 'mkv 比 matroska 更符合用户叫法');
  assert.equal(containerLabel('avi'), 'avi');
  assert.equal(containerLabel('gif'), 'gif');
  assert.equal(containerLabel(''), '—');
  assert.equal(containerLabel(null), '—');
  assert.equal(containerLabel('某个没听过的容器'), '某个没听过的容器', '不认识的就原样显示，不要瞎猜');
});

test('formatBytes 读起来像人话', () => {  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.00 KB');
  assert.equal(formatBytes(1536), '1.50 KB');
  assert.equal(formatBytes(25 * 1024 * 1024), '25.0 MB');
  assert.equal(formatBytes(null), '—');
});

test('formatDuration 分秒时对得上', () => {
  assert.equal(formatDuration(9.4), '9.4 秒');
  assert.equal(formatDuration(59.6), '60 秒');
  assert.equal(formatDuration(61), '1 分 1 秒');
  assert.equal(formatDuration(3600), '1 小时 0 分');
  assert.equal(formatDuration(null), '—');
});

test('formatBitrate 单位跟着量级走', () => {
  assert.equal(formatBitrate(4_000_000), '4.0 Mbps');
  assert.equal(formatBitrate(96_000), '96 kbps');
  assert.equal(formatBitrate(null), '—');
});

test('平台表里的每条都能被 getTarget 拿到', () => {
  const db = loadPlatforms();
  for (const t of db.targets) {
    assert.equal(getTarget(t.id), t);
  }
});
