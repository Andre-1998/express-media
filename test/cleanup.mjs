// 测试临时目录的登记与清理。
//
// 单独成文件是因为 unit 和 e2e 都要用：e2e 走 helpers.tmpOut()，
// 而 unit 里的测试有自己的临时目录需求。放在 helpers.js 里的话，
// unit 测试为了清个目录得把整套 e2e 依赖（ffmpeg、素材校验）都拖进来。
import { after } from 'node:test';
import { rmSync } from 'node:fs';

const created = [];
const failed = [];

export function sweep() {
  while (created.length) {
    const dir = created.pop();
    try {
      // retry 必须给够：刚被 ffmpeg 写完的视频在 Windows 上会短暂锁住文件。
      // 重试次数不够就只会「删不掉」，而静默 catch 掉的话，
      // 「测试跑完不留垃圾」这件事就永远没人验证了——它当初就是这样失效的，
      // 代价是 353MB 的临时目录。
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 });
    } catch (e) {
      failed.push(`${dir}（${e.code || e.message}）`);
    }
  }
  if (failed.length) {
    process.emitWarning(
      `有 ${failed.length} 个临时目录没删掉：\n  ${failed.join('\n  ')}`,
      'express-temp-cleanup',
    );
    failed.length = 0;
  }
}

let hooked = false;

/** 登记一个临时目录，测试跑完后清掉。返回原值方便链式用。 */
export function trackTempDir(dir) {
  if (!hooked) {
    hooked = true;
    // after() 在所有用例跑完、进程退出之前触发，那时文件锁已释放。
    // 挂 exit 事件会撞上 Windows 的文件锁，所以它是兜底不是主力。
    after(sweep);
    process.on('exit', sweep);
  }
  created.push(dir);
  return dir;
}
