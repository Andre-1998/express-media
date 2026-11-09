import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProbe, parseRational, extractRotation, isHdr } from '../../src/probe.js';

const base = (over = {}) => ({
  format: { format_name: 'mov,mp4,m4a', duration: '10.000000', size: '1000000', bit_rate: '800000', nb_streams: '2' },
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1', r_frame_rate: '30/1', bit_rate: '700000', pix_fmt: 'yuv420p' },
    { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: '2', bit_rate: '96000' },
  ],
  ...over,
});

test('parseRational 处理分数、整数和垃圾输入', () => {
  assert.equal(parseRational('30/1'), 30);
  assert.equal(parseRational('30000/1001'), 30000 / 1001);
  assert.equal(parseRational('25'), 25);
  assert.equal(parseRational('0/0'), null);
  assert.equal(parseRational(''), null);
  assert.equal(parseRational(null), null);
  assert.equal(parseRational('abc'), null);
});

test('解析出一个能拿来判断的 MediaInfo', () => {
  const info = parseProbe(JSON.stringify(base()), { file: 'a.mp4', sizeBytes: 1000000 });
  assert.equal(info.durationSec, 10);
  assert.equal(info.sizeBytes, 1000000);
  assert.equal(info.bitrateBps, 800000);
  assert.equal(info.video.codec, 'h264');
  assert.equal(info.video.displayWidth, 1920);
  assert.equal(info.video.displayHeight, 1080);
  assert.equal(info.video.fps, 30);
  assert.equal(info.video.megapixels, 2.07);
  assert.equal(info.video.rotation, 0);
  assert.equal(info.video.hdr, false);
  assert.equal(info.audio.channels, 2);
});

test('旋转：新版 side_data_list 也要认（只认 tags.rotate 是常见缺陷）', () => {
  const v = base();
  v.streams[0].side_data_list = [{ side_data_type: 'Display Matrix', rotation: -90 }];
  const info = parseProbe(v);
  assert.equal(info.video.rotation, 270, '-90 度应该归一化成 270');
  // 90/270 时，观看者看到的宽高是互换的
  assert.equal(info.video.displayWidth, 1080);
  assert.equal(info.video.displayHeight, 1920);
});

test('旋转：旧版 tags.rotate 也要认', () => {
  const v = base();
  v.streams[0].tags = { rotate: '90' };
  const info = parseProbe(v);
  assert.equal(info.video.rotation, 90);
  assert.equal(info.video.displayWidth, 1080);
});

test('extractRotation 归一化负数与越界角度', () => {
  assert.equal(extractRotation({ side_data_list: [{ rotation: -90 }] }), 270);
  assert.equal(extractRotation({ side_data_list: [{ rotation: 450 }] }), 90);
  assert.equal(extractRotation({ side_data_list: [{ rotation: 0 }] }), 0);
  assert.equal(extractRotation({}), 0);
  assert.equal(extractRotation({ side_data_list: [{ rotation: 'abc' }] }), 0);
  // tags 和 side_data 都给时，side_data_list 优先（那是容器里真正的矩阵）
  assert.equal(extractRotation({ side_data_list: [{ rotation: 180 }], tags: { rotate: '90' } }), 180);
});

test('HDR 认得两种传递函数', () => {
  assert.equal(isHdr({ color_transfer: 'smpte2084' }), true);
  assert.equal(isHdr({ color_transfer: 'arib-std-b67' }), true);
  assert.equal(isHdr({ color_transfer: 'bt709' }), false);
  assert.equal(isHdr({}), false);
});

test('没有视频轨 / 没有音频轨都不能炸', () => {
  const v = { format: { duration: '5', size: '100' }, streams: [{ codec_type: 'audio', codec_name: 'aac' }] };
  const info = parseProbe(v);
  assert.equal(info.video.present, false);
  assert.equal(info.video.displayWidth, null);
  assert.equal(info.audio.present, true);

  const v2 = { format: { duration: '5', size: '100' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 640, height: 480 }] };
  const info2 = parseProbe(v2);
  assert.equal(info2.audio.present, false);
  assert.equal(info2.audio.channels, null);
});

test('没有 duration 时回退到流的 duration', () => {
  const v = { format: {}, streams: [{ codec_type: 'video', codec_name: 'h264', width: 320, height: 240, duration: '3.5' }] };
  assert.equal(parseProbe(v).durationSec, 3.5);
});

test('ffprobe 输出是坏 JSON 时要说人话', () => {
  assert.throws(() => parseProbe('not json'), /无法解析 ffprobe 输出/);
});

test('sizeBytes 优先用调用方给的（stat 比 format.size 可靠）', () => {
  const info = parseProbe(base(), { file: 'a.mp4', sizeBytes: 999 });
  assert.equal(info.sizeBytes, 999);
});
