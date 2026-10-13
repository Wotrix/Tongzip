// TongZip 引擎端到端自检(仅开发用):esbuild 打包 engine.ts 后在 node 运行
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectEngine, listArchive, runCompress, runExtract, runTest, inferFormat,
  totalSize, previewEntry, pauseTask, cancelTask, extractConflicts,
  runDelete, configureTxnJournal, stageForModify, verifyArchiveArtifact, abortTxn,
  recoverStaleTransactions, checkFreeSpace,
  configureGuard, guardStats, extractSingleToTemp,
} from '../electron/engine';
import {
  applyRestoreRules, clearTaskHistory, configureTaskHistory, flushTaskHistory, getTaskHistory,
  loadTaskHistory, observeTaskEvent, parseHistoryText,
} from '../electron/history';
import type { CompressJob, ExtractJob, PersistedTask, ProgressEvent } from '../shared/types';
import { ERR } from '../shared/types';

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
  const txnJournal = path.join(root, 'txn-journal.json');
  configureTxnJournal(txnJournal); // 事务 journal 落测试目录,不污染默认位置
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

  // ── 安全回归:S2 zip-slip — 恶意 renames 键(../../x)不得让重命名逃出解压目标目录 ──
  const slipVictim = path.join(root, 'slip-victim.txt');
  fs.writeFileSync(slipVictim, 'must-not-touch');
  const out2 = path.join(root, 'out2');
  let sdone = false; let serr = '';
  await runExtract({
    archive: out7z, dest: out2, overwrite: 'overwrite',
    renames: { '../slip-victim.txt': 'hacked.txt', 'data/../../slip-victim.txt': 'hacked2.txt', 'data/a.txt': 'z.txt' },
  }, (ev) => { if (ev.status === 'done') sdone = true; if (ev.status === 'error') serr = ev.message ?? ''; });
  for (let i = 0; i < 100 && !sdone && !serr; i++) await new Promise((r) => setTimeout(r, 50));
  assert(sdone, `带恶意 renames 键的解压任务正常完成不中断 (${serr})`);
  assert(fs.existsSync(slipVictim) && fs.readFileSync(slipVictim, 'utf8') === 'must-not-touch', 'zip-slip: 目录外文件未被逃逸重命名');
  assert(!fs.existsSync(path.join(root, 'hacked.txt')) && !fs.existsSync(path.join(root, 'hacked2.txt')), 'zip-slip: 逃逸目标名未落在目录外');
  assert(fs.existsSync(path.join(out2, 'data', 'z.txt')), '合法 renames 仍正常生效');

  // ── 功能回归:U1 ask 预检 — 目标已有同名文件时必须报冲突而非静默覆盖 ──
  const conflicts = await extractConflicts({ archive: out7z, dest: out2, entries: [], overwrite: 'ask' });
  assert(conflicts.length > 0 && conflicts.some((c) => c.endsWith('z.txt') || c.endsWith('b.txt')), `extractConflicts 命中已存在文件 count=${conflicts.length}`);
  const fresh = await extractConflicts({ archive: out7z, dest: path.join(root, 'never-exists'), entries: [], overwrite: 'ask' });
  assert(fresh.length === 0, 'extractConflicts 空目标目录无冲突');

  // ── 回归:Q1 机读错误码 — 加密包无密码解压,终态事件须带 ERR.NEED_PASSWORD(不依赖文案) ──
  const outEnc = path.join(root, 'enc.7z');
  let encDone = false; let encErr = '';
  await runCompress(
    { sources: [src], output: outEnc, format: '7z', level: 1, dict: '16m', solid: 'auto', multiThread: false, password: 'tz-pw-42' },
    (ev) => { if (ev.status === 'done') encDone = true; if (ev.status === 'error') encErr = ev.message ?? ''; },
  );
  for (let i = 0; i < 100 && !encDone && !encErr; i++) await new Promise((r) => setTimeout(r, 50));
  assert(encDone && fs.existsSync(outEnc), `加密 7z 压缩成功 (${encErr})`);
  let xCode = ''; let xMsg = '';
  await runExtract({ archive: outEnc, dest: path.join(root, 'outEnc'), overwrite: 'overwrite' }, (ev) => {
    if (ev.status === 'error') { xCode = ev.code ?? ''; xMsg = ev.message ?? ''; }
  });
  for (let i = 0; i < 100 && !xCode && !xMsg; i++) await new Promise((r) => setTimeout(r, 50));
  assert(xCode === ERR.NEED_PASSWORD, `无密码解压加密包→code=NEED_PASSWORD (code=${xCode} msg=${xMsg})`);
  assert(xMsg !== 'NEED_PASSWORD', '错误事件 message 为人可读文案而非裸码');

  // ── 阶段 3.1 归档修改事务回归 ──
  // T1 删除条目事务成功:条目更新、无 .tztmp/.tzbak 残留、journal 清零
  let dlDone = false; let dlErr = '';
  await runDelete(out7z, ['data/sub/b.txt'], (ev) => {
    if (ev.status === 'done') dlDone = true;
    if (ev.status === 'error') dlErr = ev.message ?? '';
  });
  for (let i = 0; i < 200 && !dlDone && !dlErr; i++) await new Promise((r) => setTimeout(r, 50));
  assert(dlDone && !dlErr, `T1 事务化删除成功 (${dlErr})`);
  const infoAfterDel = await listArchive(out7z);
  assert(
    !infoAfterDel.entries.some((e) => e.path.endsWith('b.txt')) && infoAfterDel.entries.some((e) => e.path.endsWith('a.txt')),
    'T1 删除生效且其余条目完好',
  );
  assert(!fs.readdirSync(root).some((f) => f.endsWith('.tztmp') || f.endsWith('.tzbak')), 'T1 成功后无事务残留');
  assert(JSON.parse(fs.readFileSync(txnJournal, 'utf8')).records.length === 0, 'T1 成功后 journal 清零');

  // T2 校验失败防线:暂存副本被写坏 → verify 拒绝,原包完好,副本丢弃
  const txnA = path.join(root, 'txnA.7z');
  let taDone = false; let taErr = '';
  await runCompress({ sources: [src], output: txnA, format: '7z', level: 1, dict: '16m', solid: 'auto', multiThread: false },
    (ev) => { if (ev.status === 'done') taDone = true; if (ev.status === 'error') taErr = ev.message ?? ''; });
  for (let i = 0; i < 100 && !taDone && !taErr; i++) await new Promise((r) => setTimeout(r, 50));
  assert(taDone, `T2 前置:txnA.7z 创建成功 (${taErr})`);
  const { tmp: stg } = stageForModify(txnA, 'tztest01');
  fs.writeFileSync(stg, 'garbage-not-an-archive');
  let vFailed = false; let vCode = '';
  try { await verifyArchiveArtifact(stg); } catch (e) { vFailed = true; vCode = (e as { code?: string }).code ?? ''; }
  assert(vFailed && vCode === ERR.VERIFY_FAILED, `T2 校验拒绝损坏副本 (code=${vCode})`);
  abortTxn('tztest01', stg);
  const infoA = await listArchive(txnA);
  assert(infoA.entries.length > 0 && !fs.existsSync(stg), 'T2 校验失败后原包完好、损坏副本已丢弃');

  // T3 崩溃半替换恢复:模拟 swap 中途进程终止(原包已改名 .tzbak)→ 启动恢复还原
  const victim = path.join(root, 'victim.7z');
  fs.copyFileSync(txnA, victim);
  const vBak = path.join(root, `victim.7z.tzcrash01.tzbak`);
  fs.renameSync(victim, vBak);
  fs.writeFileSync(txnJournal, JSON.stringify({
    v: 1, records: [{ id: 'tzcrash01', archive: victim, tmp: path.join(root, 'ghost.tztmp'), backup: vBak, stage: 'swapping', at: Date.now() }],
  }));
  const rec = recoverStaleTransactions();
  assert(rec.restored.includes(victim) && fs.existsSync(victim) && !fs.existsSync(vBak),
    `T3 启动恢复还原半替换归档 (restored=${rec.restored.length})`);
  const infoV = await listArchive(victim);
  assert(infoV.entries.length > 0, 'T3 还原后的归档内容可用');

  // T4 磁盘空间预检:天文需求必拒,正常需求放行
  assert(checkFreeSpace(root, Number.MAX_SAFE_INTEGER ** 2) === false, 'T4 checkFreeSpace 拒绝超量空间需求');
  assert(checkFreeSpace(root, 1024) === true, 'T4 checkFreeSpace 正常需求放行');

  // T5 追加文件事务:appendTo 既有归档走副本+替换,原路径同名称生效且无残留
  const cTxt = path.join(root, 'c.txt');
  fs.writeFileSync(cTxt, 'append me for txn');
  let apDone = false; let apErr = '';
  await runCompress({ sources: [cTxt], output: txnA, format: '7z', level: 1, dict: '16m', solid: 'auto', multiThread: false },
    (ev) => { if (ev.status === 'done') apDone = true; if (ev.status === 'error') apErr = ev.message ?? ''; });
  for (let i = 0; i < 200 && !apDone && !apErr; i++) await new Promise((r) => setTimeout(r, 50));
  assert(apDone && !apErr, `T5 追加到既有归档成功 (${apErr})`);
  const infoAp = await listArchive(txnA);
  assert(infoAp.entries.some((e) => e.name === 'c.txt') && infoAp.entries.some((e) => e.path.endsWith('a.txt')),
    'T5 追加后新旧条目共存');
  assert(!fs.readdirSync(root).some((f) => f.endsWith('.tztmp') || f.endsWith('.tzbak')), 'T5 追加后无事务残留');

  // ══════════════════ 阶段 3.2 资源防护回归(G 系列) ══════════════════
  const stageLeft = () => fs.readdirSync(root).filter((f) => f.includes('tzstage'));
  /** 起一个解压任务并等终态;返回可断言的结果快照(events=全部原始进度事件,供泄露面断言) */
  async function extractTo(archive: string, dest: string, extra: Partial<ExtractJob> = {}) {
    let done = false; let code = ''; let msg = '';
    const events: { message?: string; log?: string; file?: string }[] = [];
    await runExtract({ archive, dest, overwrite: 'overwrite', ...extra }, (ev) => {
      events.push(ev);
      if (ev.status === 'done') done = true;
      if (ev.status === 'error') { code = ev.code ?? ''; msg = ev.message ?? ''; }
    });
    for (let i = 0; i < 600 && !done && !code && !msg; i++) await new Promise((r) => setTimeout(r, 50));
    return { done, code, msg, events };
  }
  /* 手工构造 tar:恶意条目名/链接样本 7za 自身拒绝打包,只能按 POSIX ustar 规范直写字节
     (实测 21.07 校验和必须 6位八进制+NUL+空格,声明 size 与数据块必须对齐) */
  function tarHeader(o: { name: string; size: number; typeflag?: string; linkname?: string }): Buffer {
    const b = Buffer.alloc(512);
    b.write(o.name.slice(0, 99), 0, 'latin1');
    b.write('0000644 ', 100); b.write('0000000 ', 108); b.write('0000000 ', 116);
    b.write(o.size.toString(8).padStart(11, '0') + ' ', 124);
    b.write('00000000000 ', 136); b.write('        ', 148);
    b.write(o.typeflag ?? '0', 156);
    if (o.linkname) b.write(o.linkname.slice(0, 99), 157, 'latin1');
    b.write('ustar\x0000', 257);
    let sum = 0; for (const c of b) sum += c;
    b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return b;
  }
  function makeTar(items: Array<{ name: string; data?: string; typeflag?: string; linkname?: string }>): Buffer {
    const blocks: Buffer[] = [];
    for (const it of items) {
      const data = it.data ? Buffer.from(it.data, 'utf8') : Buffer.alloc(0);
      blocks.push(tarHeader({ name: it.name, size: data.length, typeflag: it.typeflag, linkname: it.linkname }));
      if (data.length) {
        const pad = Buffer.alloc(Math.ceil(data.length / 512) * 512);
        data.copy(pad); blocks.push(pad);
      }
    }
    blocks.push(Buffer.alloc(1024));
    return Buffer.concat(blocks);
  }

  // G1 恶意路径包(穿越/盘符/绝对/保留名混装):预检硬拒,目录内外一字不写
  const g1Tar = path.join(root, 'evil-path.tar');
  fs.writeFileSync(g1Tar, makeTar([
    { name: '../escape_g1.txt', data: 'ESCAPED' },
    { name: 'C:/evil_abs.txt', data: 'ABS' },
    { name: '/abs/evil_g1.txt', data: 'ROOTABS' },
    { name: 'sub/../../escape_g1b.txt', data: 'E2' },
    { name: 'CON.dat', data: 'RESERVED' },
    { name: 'legit.txt', data: 'fine' },
  ]));
  const g1Dest = path.join(root, 'g1out');
  const r1 = await extractTo(g1Tar, g1Dest);
  assert(!r1.done && r1.code === ERR.UNSAFE_PATH, `G1 恶意路径包预检拒绝 (code=${r1.code})`);
  assert(!fs.existsSync(g1Dest) && !fs.existsSync(path.join(root, 'escape_g1.txt'))
    && !fs.existsSync(path.join(root, 'escape_g1b.txt')) && !fs.existsSync(path.join(root, 'evil_abs.txt')),
    'G1 恶意条目未在任何位置落地');
  assert(stageLeft().length === 0, 'G1 拒绝后无暂存残留');

  // G2 符号链接包(条目名本身无害):链接可指向目录外,默认策略拒绝
  const g2Tar = path.join(root, 'evil-link.tar');
  fs.writeFileSync(g2Tar, makeTar([
    { name: 'normal.txt', data: 'ok' },
    { name: 'sneaky_link', typeflag: '2', linkname: '../../../Windows/win.ini' },
  ]));
  const r2 = await extractTo(g2Tar, path.join(root, 'g2out'));
  assert(!r2.done && r2.code === ERR.UNSAFE_PATH, `G2 含链接条目的包被拦截 (code=${r2.code})`);
  assert(!fs.existsSync(path.join(root, 'g2out')), 'G2 拦截后目标目录未创建');

  // G3 重复落点包(dup.txt 与 ./dup.txt 塌缩同一文件 → 后写静默覆盖先写)
  const g3Tar = path.join(root, 'evil-dup.tar');
  fs.writeFileSync(g3Tar, makeTar([
    { name: 'dup_g3.txt', data: 'A' },
    { name: './dup_g3.txt', data: 'B' },
  ]));
  const r3 = await extractTo(g3Tar, path.join(root, 'g3out'));
  assert(!r3.done && r3.code === ERR.UNSAFE_PATH, `G3 重复落点条目被拦截 (code=${r3.code})`);

  // G4 条目数上限(声明量预检):阈值取实际条目数-1,不猜 7za 对复合容器的列表口径
  const g4Count = infoAfterDel.entries.length;
  configureGuard({ maxEntries: g4Count - 1 });
  const r4 = await extractTo(out7z, path.join(root, 'g4out'));
  configureGuard(null);
  assert(!r4.done && r4.code === ERR.GUARD_LIMIT, `G4 条目数超限熔断 (entries=${g4Count} code=${r4.code} msg=${r4.msg.slice(0, 60)})`);

  // G5 声明总量/磁盘水位预检 + 伪造声明的归档不产生成功假象
  configureGuard({ maxTotalBytes: 1024 });
  const r5a = await extractTo(outGz, path.join(root, 'g5a'));
  configureGuard(null);
  assert(!r5a.done && r5a.code === ERR.GUARD_LIMIT, `G5a 声明总体积超限熔断 (code=${r5a.code})`);
  configureGuard({ minFreeBytes: Number.MAX_SAFE_INTEGER });
  const r5c = await extractTo(outGz, path.join(root, 'g5c'));
  configureGuard(null);
  assert(!r5c.done && r5c.code === ERR.SPACE_LOW, `G5c 磁盘水位不足拒绝启动 (code=${r5c.code})`);
  // 伪造超大声明 size 但无数据块的畸形 tar:无论预检/引擎在哪层拦下,都不许报成功、不许留残骸
  const g5bTar = path.join(root, 'fake-size.tar');
  fs.writeFileSync(g5bTar, Buffer.concat([
    tarHeader({ name: 'fakelarge.bin', size: 3 * 1024 ** 3 }),
    Buffer.alloc(1024),
  ]));
  const r5b = await extractTo(g5bTar, path.join(root, 'g5b'));
  assert(!r5b.done && !fs.existsSync(path.join(root, 'g5b')) && stageLeft().length === 0,
    `G5b 伪造声明的包失败但不留半成品 (code=${r5b.code})`);

  // G6 压缩比信号:默认策略不误伤正常高压缩比文件,收紧后才熔断
  const z40 = path.join(root, 'z40.bin');
  fs.writeFileSync(z40, Buffer.alloc(40 * 1024 * 1024));
  let z40Done = false;
  await runCompress({ sources: [z40], output: path.join(root, 'z40.zip'), format: 'zip', level: 1, dict: '16m', solid: 'auto', multiThread: false },
    (ev) => { if (ev.status === 'done') z40Done = true; });
  for (let i = 0; i < 200 && !z40Done; i++) await new Promise((r) => setTimeout(r, 50));
  assert(z40Done, 'G6 前置:40MB 零数据 zip 生成');
  const r6pass = await extractTo(path.join(root, 'z40.zip'), path.join(root, 'g6out'));
  assert(r6pass.done, `G6 默认策略不误伤高压缩比正常文件 (${r6pass.msg})`);
  configureGuard({ ratioMinDeclared: 1024 * 1024, maxRatio: 500 });
  const r6block = await extractTo(path.join(root, 'z40.zip'), path.join(root, 'g6out2'));
  configureGuard(null);
  assert(!r6block.done && r6block.code === ERR.GUARD_LIMIT, `G6 收紧比例阈值后熔断 (${r6block.code})`);

  // G7 看门狗超时熔断:执行中 kill + 暂存整体丢弃,dest 连目录都不出现
  const big3 = path.join(root, 'big3.bin');
  fs.writeFileSync(big3, Buffer.alloc(300 * 1024 * 1024));
  let b3Done = false;
  await runCompress({ sources: [big3], output: path.join(root, 'big3.7z'), format: '7z', level: 0, dict: '16m', solid: 'auto', multiThread: false },
    (ev) => { if (ev.status === 'done') b3Done = true; });
  for (let i = 0; i < 400 && !b3Done; i++) await new Promise((r) => setTimeout(r, 50));
  assert(b3Done, 'G7 前置:300MB store 归档生成');
  // 阈值取 50ms:远小于解压总时长(数百 ms),第一个采样点(100ms)必命中;缓存再快也快不过进程启动
  configureGuard({ maxRunMs: 50, watchIntervalMs: 100 });
  const r7 = await extractTo(path.join(root, 'big3.7z'), path.join(root, 'g7out'));
  configureGuard(null);
  assert(!r7.done && r7.code === ERR.GUARD_LIMIT && r7.msg.includes('时长'), `G7 运行超时看门狗熔断 (done=${r7.done} code=${r7.code} msg=${r7.msg.slice(0, 60)})`);
  assert(!fs.existsSync(path.join(root, 'g7out')) && stageLeft().length === 0, 'G7 熔断后半成品已清理、dest 未出现');

  // G8 单文件提取逃逸(P0 修复):恶意 entry 不得借预览链路逃出临时根/触发目录外递归删除
  const g8Victim = path.join(os.tmpdir(), 'TongZip', 'tz-g8-victim.txt');
  fs.mkdirSync(path.dirname(g8Victim), { recursive: true });
  fs.writeFileSync(g8Victim, 'untouchable');
  let g8code = '';
  try { await extractSingleToTemp(out7z, '../tz-g8-victim.txt'); }
  catch (e) { g8code = (e as { code?: string }).code ?? ''; }
  assert(g8code === ERR.UNSAFE_PATH, `G8 预览链逃逸条目名被拒绝 (code=${g8code})`);
  assert(fs.existsSync(g8Victim) && fs.readFileSync(g8Victim, 'utf8') === 'untouchable', 'G8 目录外受害者完好');
  fs.rmSync(g8Victim, { force: true });

  // G9 嵌套深度上限
  configureGuard({ maxNestDepth: 1 });
  const r9 = await extractTo(outGz, path.join(root, 'g9out'), { nestDepth: 5 });
  configureGuard(null);
  assert(!r9.done && r9.code === ERR.GUARD_LIMIT, `G9 嵌套深度超限熔断 (code=${r9.code})`);

  // G10 并发闸:maxHeavyTasks=1 时第二任务排队等待而非并行绕过,且不被饿死
  configureGuard({ maxHeavyTasks: 1 });
  let a10Done = false; let b10Done = false;
  void runExtract({ archive: path.join(root, 'big3.7z'), dest: path.join(root, 'g10a'), overwrite: 'overwrite' },
    (ev) => { if (ev.status === 'done' || ev.status === 'error') a10Done = true; });
  await new Promise((r) => setTimeout(r, 30));
  const g10DestB = path.join(root, 'g10b');
  void runExtract({ archive: outGz, dest: g10DestB, overwrite: 'overwrite' },
    (ev) => { if (ev.status === 'done') b10Done = true; });
  await new Promise((r) => setTimeout(r, 30));
  const st = guardStats();
  assert(st.active === 1 && st.waiting === 1, `G10 第二任务被并发闸排队 (active=${st.active} waiting=${st.waiting})`);
  // 无竞态断言:只要 A 还没结束,B(排队中)就绝不允许完成或落地;A 释放槽位后 B 才可能被放行
  let violated = false;
  for (let i = 0; i < 800 && (!a10Done || !b10Done); i++) {
    await new Promise((r) => setTimeout(r, 25));
    if (!a10Done && (b10Done || fs.existsSync(g10DestB))) violated = true;
  }
  configureGuard(null);
  assert(!violated, 'G10 排队期间未提前落地(A 占用槽位期间 B 零输出)');
  assert(a10Done && b10Done && fs.existsSync(g10DestB), `G10 排队任务最终获准完成 (a=${a10Done} b=${b10Done})`);

  // ══════════════════ 阶段 3.3 密码安全回归(PW 系列) ══════════════════
  const PW = 'Tz#Pw 安全%_probe7'; // 含空格/特殊字符/中文,顺带验证 argv 传参完整性
  const pwSrc = path.join(root, 'pwsrc.txt');
  fs.writeFileSync(pwSrc, 'password-safe-roundtrip');

  // PW1 加密压缩成功且事件流零密码回显
  const encPw = path.join(root, 'enc_pw.7z');
  let pwCDone = false; let pwCErr = '';
  const pwEvents: { message?: string; log?: string; file?: string }[] = [];
  await runCompress({ sources: [pwSrc], output: encPw, format: '7z', level: 1, dict: '16m', solid: 'auto', multiThread: false, password: PW },
    (ev) => { pwEvents.push(ev); if (ev.status === 'done') pwCDone = true; if (ev.status === 'error') pwCErr = ev.message ?? ''; });
  for (let i = 0; i < 200 && !pwCDone && !pwCErr; i++) await new Promise((r) => setTimeout(r, 50));
  assert(pwCDone && !pwCErr, `PW1 带密码压缩成功 (${pwCErr})`);

  // PW1b 正确密码 roundtrip:内容逐字节还原
  const rPwOk = await extractTo(encPw, path.join(root, 'pwout'), { password: PW });
  assert(rPwOk.done && fs.readFileSync(path.join(root, 'pwout', 'pwsrc.txt'), 'utf8') === 'password-safe-roundtrip',
    `PW1b 正确密码解压 roundtrip (${rPwOk.code} ${rPwOk.msg.slice(0, 40)})`);

  // PW2 错误密码:拒绝任务;全部事件(message/log/file)不含任何密码明文——实测 7za 不回显 argv
  const BADPW = 'DefinitelyWrong-42';
  const rPwBad = await extractTo(encPw, path.join(root, 'pwbad'), { password: BADPW });
  assert(!rPwBad.done && rPwBad.code === ERR.NEED_PASSWORD, `PW2 错误密码被拒绝 (code=${rPwBad.code})`);
  const leaked = [...pwEvents, ...rPwOk.events, ...rPwBad.events]
    .some((e) => { const s = `${e.message ?? ''}\n${e.log ?? ''}\n${e.file ?? ''}`; return s.includes(PW) || s.includes(BADPW); });
  assert(!leaked, 'PW2 事件流零密码明文(压缩/成功解压/错密码解压全程)');

  // PW3 加密文件头包:无密码列表 → NEED_PASSWORD;有密码 → 条目可读
  const mhePw = path.join(root, 'enc_mhe.7z');
  let mDone = false;
  await runCompress({ sources: [pwSrc], output: mhePw, format: '7z', level: 1, dict: '16m', solid: 'auto', multiThread: false, password: PW, encryptHeaders: true },
    (ev) => { if (ev.status === 'done') mDone = true; });
  for (let i = 0; i < 200 && !mDone; i++) await new Promise((r) => setTimeout(r, 50));
  assert(mDone, 'PW3 前置:加密文件头包生成');
  let mheNoCode = ''; let mheNoCount = -1;
  try { mheNoCount = (await listArchive(mhePw)).entries.length; } catch (e) { mheNoCode = (e as { code?: string }).code ?? ''; }
  const mheYes = await listArchive(mhePw, PW);
  assert(mheNoCount < 0 && mheNoCode === ERR.NEED_PASSWORD && mheYes.entries.some((en) => en.name === 'pwsrc.txt'),
    `PW3 加密头包无密码拒绝/有密码可读 (no=${mheNoCode} with=${mheYes.entries.length})`);

  // PW4 带密码事务删除:成功;journal 全文无密码明文且记录归零
  let pwDDone = false; let pwDErr = '';
  await runDelete(encPw, ['pwsrc.txt'], (ev) => {
    if (ev.status === 'done') pwDDone = true;
    if (ev.status === 'error') pwDErr = ev.message ?? '';
  }, PW);
  for (let i = 0; i < 200 && !pwDDone && !pwDErr; i++) await new Promise((r) => setTimeout(r, 50));
  assert(pwDDone && !pwDErr, `PW4 加密包内删除事务成功 (${pwDErr})`);
  const journalTxt = fs.readFileSync(txnJournal, 'utf8');
  assert(!journalTxt.includes(PW) && JSON.parse(journalTxt).records.length === 0, 'PW4 事务 journal 无密码明文');

  // PW5 加密包单文件提取(预览/拖拽链路)带密码可用
  const local5 = await extractSingleToTemp(mhePw, 'pwsrc.txt', PW);
  assert(fs.readFileSync(local5, 'utf8') === 'password-safe-roundtrip', 'PW5 加密包单文件提取成功');

  /* ============ 阶段 3.4:任务历史持久化与重启恢复(T 系列) ============ */
  const histFile = path.join(root, 'tongzip-history.json');
  configureTaskHistory(histFile);
  clearTaskHistory(); flushTaskHistory();
  const ev = (o: Partial<ProgressEvent>): ProgressEvent => ({ taskId: 'x', kind: 'compress', percent: 0, file: '', status: 'running', ...o });

  // T1 全链落盘:running→done 事件流驱动历史记录,文件带 version=1 与完整字段
  const tOut = path.join(root, 'hist-out.7z');
  observeTaskEvent(ev({ taskId: 't-a', status: 'running', percent: 12 }), { output: tOut });
  observeTaskEvent(ev({ taskId: 't-a', status: 'done', percent: 100 }), { output: tOut });
  flushTaskHistory();
  const histData = JSON.parse(fs.readFileSync(histFile, 'utf8'));
  const tA = (histData.tasks as PersistedTask[]).find((t) => t.id === 't-a');
  assert(histData.version === 1 && tA?.status === 'done' && tA.out === tOut && typeof tA.finishedAt === 'number' && tA.percent === 100,
    'T1 任务历史 version 化落盘,终态/时间/路径齐备');

  // T2 脱敏红线:错误事件的 message/log(可含密码与命令行)永不入库,只留机读码
  observeTaskEvent(ev({ taskId: 't-b', kind: 'extract', status: 'running', percent: 5, log: `7za x -p${PW} …` }), { archive: encPw });
  observeTaskEvent(ev({ taskId: 't-b', kind: 'extract', status: 'error', percent: 30, message: `密码错误 ${PW}`, code: ERR.NEED_PASSWORD, log: `-p${PW}` }), { archive: encPw });
  flushTaskHistory();
  const histTxt = fs.readFileSync(histFile, 'utf8');
  assert(!histTxt.includes(PW) && !histTxt.includes('7za'), 'T2 历史文件零密码/零引擎日志');
  const tB = getTaskHistory().find((t) => t.id === 't-b');
  assert(tB?.status === 'error' && tB.errCode === ERR.NEED_PASSWORD && !('message' in (tB ?? {})), 'T2 失败记录只存机读码不存文案');

  // T3 损坏隔离:JSON 乱码与未知 version → 原件改名隔离,从空历史恢复(留证据不猜测)
  fs.writeFileSync(histFile, '{ 乱码~~~ not json', 'utf8');
  const h3a = loadTaskHistory();
  assert(h3a.quarantined !== null && h3a.tasks.length === 0 && fs.existsSync(h3a.quarantined!), 'T3 乱码历史被隔离且可读回原件');
  fs.writeFileSync(histFile, JSON.stringify({ version: 99, tasks: [] }), 'utf8');
  const h3b = loadTaskHistory();
  assert(h3b.quarantined !== null, 'T3 未知 version 历史同样隔离');

  // T4 记录级抢救:JSON 合法但混入坏记录 → 好记录保留、坏记录丢弃,整文件不隔离
  const good: PersistedTask = { id: 'g1', kind: 'test', label: 'ok.7z', status: 'done', createdAt: 1, finishedAt: 2 };
  fs.writeFileSync(histFile, JSON.stringify({ version: 1, tasks: [good, null, { id: 42 }, { id: 'x', kind: 'wat', status: 'done', createdAt: 1 }] }), 'utf8');
  const h4 = loadTaskHistory();
  assert(h4.quarantined === null && h4.tasks.length === 1 && h4.tasks[0].id === 'g1', 'T4 坏记录过滤,好记录抢救');

  // T5 恢复状态机 + 幂等:running→interrupted(事务命中带标记),queued 重验输入,终态原样;二次映射零变更
  const srcJ = path.join(root, 'journal-hit.7z'); const srcE = path.join(root, 'exists.7z');
  fs.writeFileSync(srcE, 'x');
  const rules: PersistedTask[] = [
    { id: 'r1', kind: 'delete', label: '', status: 'running', createdAt: 1, src: srcJ },
    { id: 'r2', kind: 'delete', label: '', status: 'running', createdAt: 1, src: path.join(root, 'no-journal.7z') },
    { id: 'q1', kind: 'compress', label: '', status: 'queued', createdAt: 1, src: srcE },
    { id: 'q2', kind: 'compress', label: '', status: 'queued', createdAt: 1, src: path.join(root, 'vanished.7z') },
    { id: 'd1', kind: 'extract', label: '', status: 'done', createdAt: 1 },
    { id: 'e1', kind: 'extract', label: '', status: 'error', createdAt: 1, errCode: ERR.GUARD_LIMIT },
    { id: 'c1', kind: 'test', label: '', status: 'cancelled', createdAt: 1 },
  ];
  const p5 = applyRestoreRules(rules, new Set([srcJ]), (p) => p === srcE);
  const s5 = Object.fromEntries(p5.map((t) => [t.id, t]));
  assert(s5.r1.status === 'interrupted' && s5.r1.txnRolledBack === true, 'T5 执行中断→标记中断;事务恢复命中标记 txnRolledBack');
  assert(s5.r2.status === 'interrupted' && s5.r2.txnRolledBack === undefined, 'T5 执行中断不误标事务回滚');
  assert(s5.q1.status === 'retryable' && s5.q2.status === 'interrupted', 'T5 排队任务重验输入:存在=可重试,缺失=中断');
  assert(s5.d1.status === 'done' && s5.e1.status === 'error' && s5.c1.status === 'cancelled', 'T5 终态保留原始终态,不重放不改判');
  assert(JSON.stringify(applyRestoreRules(p5, new Set([srcJ]), (p) => p === srcE)) === JSON.stringify(p5), 'T5 恢复流程幂等:重复执行零变更');

  // T6 崩溃模拟:带 running 记录的文件经 load 落盘为 interrupted,再次启动 load 结果不变(不会复活瞬态)
  fs.writeFileSync(histFile, JSON.stringify({ version: 1, tasks: [{ id: 'crash1', kind: 'extract', label: 'c.7z', status: 'running', createdAt: 1, src: encPw }] }), 'utf8');
  const r6a = loadTaskHistory();
  const r6b = loadTaskHistory();
  assert(r6a.tasks[0].status === 'interrupted' && JSON.stringify(r6b.tasks) === JSON.stringify(r6a.tasks)
    && JSON.parse(fs.readFileSync(histFile, 'utf8')).tasks[0].status === 'interrupted', 'T6 崩溃遗留 running 定格 interrupted,重复启动恢复稳定');

  // T7 写盘失败不破坏状态(磁盘满/路径非法的降级形态):内存历史保留,调用不抛
  configureTaskHistory(root); // 目标是目录 → writeFileSync 必失败(EISDIR)
  observeTaskEvent(ev({ taskId: 't-c', status: 'done', percent: 100 }), { output: tOut });
  flushTaskHistory();
  assert(getTaskHistory().some((t) => t.id === 't-c'), 'T7 落盘失败静默降级,内存状态不丢');
  configureTaskHistory(histFile);

  // G11 全链结束后 journal 归零(暂存登记不泄漏)
  assert(JSON.parse(fs.readFileSync(txnJournal, 'utf8')).records.length === 0, 'G11 防护任务结束后 journal 清零');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('\nALL PASSED');
})().catch((e) => { console.error('EXCEPTION', e); process.exit(1); });
