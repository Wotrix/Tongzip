// TongZip 引擎端到端自检(仅开发用):esbuild 打包 engine.ts 后在 node 运行
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectEngine, listArchive, runCompress, runExtract, runTest, inferFormat,
  totalSize, previewEntry, pauseTask, cancelTask,
} from '../electron/engine';
import type { CompressJob } from '../shared/types';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('ok  :', msg);
}

(async () => {
  const engine = await detectEngine(null);
  console.log('engine', engine);
  assert(/7-?zip/i.test(engine.version) || engine.version !== '未知', '引擎版本可读');

  // 准备源
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tz-selftest-'));
  const src = path.join(root, 'data');
  fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(src, 'a.txt'), 'hello tongzip '.repeat(100));
  fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'nested content');

  // 压缩 7z
  const out7z = path.join(root, 'pack.7z');
  let done = false; let hadErr = '';
  const job: CompressJob = {
    sources: [src], output: out7z, format: '7z', level: 5,
    dict: '16m', solid: 'auto', multiThread: true,
  };
  const { taskId } = await runCompress(job, (ev) => {
    if (ev.status === 'done') done = true;
    if (ev.status === 'error') hadErr = ev.message ?? '';
  });
  void taskId;
  for (let i = 0; i < 100 && !done && !hadErr; i++) await new Promise((r) => setTimeout(r, 50));
  assert(done && fs.existsSync(out7z), `7z 压缩生成文件 (${hadErr})`);

  // 列目录
  const info = await listArchive(out7z);
  assert(info.type.toLowerCase().includes('7z'), `类型识别=${info.type}`);
  assert(info.entries.length >= 2, `条目数=${info.entries.length}`);
  const aTxt = info.entries.find((e) => e.path.endsWith('a.txt'));
  assert(!!aTxt && aTxt!.size === 1400, `a.txt 大小解析=${aTxt?.size}`);
  assert(info.entries.some((e) => e.isDir), '目录条目识别');

  // 解压
  const dest = path.join(root, 'out');
  let edone = false; let eerr = '';
  await runExtract({ archive: out7z, dest, overwrite: 'overwrite' }, (ev) => {
    if (ev.status === 'done') edone = true;
    if (ev.status === 'error') eerr = ev.message ?? '';
  });
  for (let i = 0; i < 100 && !edone && !eerr; i++) await new Promise((r) => setTimeout(r, 50));
  assert(edone && fs.existsSync(path.join(dest, 'data', 'a.txt')), `解压还原 (${eerr})`);

  // 测试完整性
  let tdone = false;
  await runTest(out7z, undefined, (ev) => { if (ev.status === 'done') tdone = true; });
  for (let i = 0; i < 100 && !tdone; i++) await new Promise((r) => setTimeout(r, 50));
  assert(tdone, '压缩包测试通过');

  // 复合格式 tar.gz 推断
  assert(inferFormat('x.tar.gz') === 'tar.gz', 'inferFormat tar.gz');
  assert(inferFormat('y.zip') === 'zip', 'inferFormat zip');

  let gdone = false; let gerr = '';
  const outGz = path.join(root, 'pack.tar.gz');
  await runCompress(
    { sources: [src], output: outGz, format: 'tar.gz', level: 5, dict: '16m', solid: 'auto', multiThread: true },
    (ev) => { if (ev.status === 'done') gdone = true; if (ev.status === 'error') gerr = ev.message ?? ''; },
  );
  for (let i = 0; i < 160 && !gdone && !gerr; i++) await new Promise((r) => setTimeout(r, 50));
  assert(gdone && fs.existsSync(outGz), `tar.gz 复合压缩 (${gerr})`);

  // 新增能力:总体积/预览/暂停-恢复-取消链路
  const sum = totalSize([src]);
  assert(sum === 1414, `totalSize 递归求和=${sum} (期望 1414)`);

  const pv = await previewEntry(out7z, 'data/a.txt');
  assert(pv.kind === 'text' && pv.text!.includes('hello tongzip'), `previewEntry 文本预览 kind=${pv.kind}`);

  const big = path.join(root, 'big.bin');
  fs.writeFileSync(big, Buffer.alloc(640 * 1024 * 1024, 7)); // 高冗余大文件,mx9 下单线程可持续数秒
  let bdone = false; let bcancel = false;
  const bJob = await runCompress(
    { sources: [big], output: path.join(root, 'big.7z'), format: '7z', level: 9, dict: '16m', solid: 'auto', multiThread: false },
    (ev) => { if (ev.status === 'done') bdone = true; if (ev.status === 'cancelled') bcancel = true; },
  );
  // 7za 管道模式进度按 \r 缓冲末尾才刷出,不可按百分比门控;只验证挂起/恢复/挂起态取消接线
  await new Promise((r) => setTimeout(r, 150));
  const p1 = await pauseTask(bJob.taskId);
  assert(p1 === true, `pauseTask 运行中→挂起 (bdone=${bdone})`);
  await new Promise((r) => setTimeout(r, 600));
  assert(!bdone, '挂起期间任务未意外结束');
  const p2 = await pauseTask(bJob.taskId);
  assert(p2 === false, 'pauseTask 再次调用→恢复');
  await new Promise((r) => setTimeout(r, 150));
  assert(cancelTask(bJob.taskId) === true, 'cancelTask 取消成功');
  for (let i = 0; i < 160 && !bcancel && !bdone; i++) await new Promise((r) => setTimeout(r, 50));
  assert(bcancel && !bdone, `取消后收到 cancelled 终态事件 (bdone=${bdone})`);

  fs.rmSync(root, { recursive: true, force: true });
  console.log('\nALL PASSED');
})().catch((e) => { console.error('EXCEPTION', e); process.exit(1); });
