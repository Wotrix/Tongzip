/**
 * 阶段 3.4/3.5 — 真实进程崩溃演练(Windows)
 * 从实际打包产物 release/win-unpacked/TongZip.exe 启动应用,经 CDP 向渲染页下发真实任务
 * (走 preload IPC → 主进程 runExtract/runDelete 全链路),强制终止主进程与其引擎子进程,
 * 重启核验:事务恢复先于任务历史判定、任务定格 interrupted、无自动重放、无敏感数据残留、
 * 归档与目标目录状态符合事务协议。
 *
 * 五个案例:
 *  C1 解压执行中崩溃 → interrupted + extract 暂存被启动回收,dest 未被写入
 *  C2 归档修改事务提交前(staged)崩溃 → 原归档逐字节不变,副本被回收,任务 interrupted
 *  C3a swapping 半态(替换 rename 之间)崩溃残留 → 按磁盘证据还原原归档,任务标 txnRolledBack
 *  C3b committed(刚提交)崩溃残留 → 新归档保持、仅清备份,绝不误回滚,任务不误标事务
 *  C4 正常退出对照 → 终态 done 保留,重启无 interrupted
 *
 * 边界如实:C3 的 swap 窗口为毫秒级两次原子 rename,真实进程 kill 无法确定性命中,
 * 其磁盘中间态由本控制器执行与 commitTxnSwap 相同的 rename 序列构造(故障注入),
 * 恢复判定 100% 走真实应用启动代码;C1/C2/C4 是货真价实的强制终止演练。
 *
 * 纪律:独立临时目录 + 隔离 --user-data-dir,绝不触碰真实用户文件;
 * 每案例硬超时,finally 级清理(spawn 的 pid 全记录,退出前逐个 taskkill /F + 目录删除)。
 */
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const EXE = path.resolve('release/win-unpacked/TongZip.exe');
const ENGINE = path.resolve('release/win-unpacked/resources/engine/7za.exe');
const PW = 'CrashDrill#测试-pw9';
let failures = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) { console.log('ok  :', msg); return; }
  failures++;
  console.error('FAIL:', msg);
}

/* ---------------- 基础工具 ---------------- */

const spawned = new Set<number>();
function killHard(pid: number | undefined): void {
  if (!pid || pid < 0) return;
  try { execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch { /* 已退出 */ }
  spawned.delete(pid);
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { spawned.delete(pid); return false; }
}

/** 全局兜底清理:任何退出路径都不留孤儿进程与临时目录 */
const dirs: string[] = [];
function cleanupAll(): void {
  for (const pid of spawned) { try { execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch { /* noop */ } }
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 占用则跳过 */ } }
}
process.on('exit', cleanupAll);
process.on('uncaughtException', (e) => { console.error('UNCAUGHT', e); failures++; cleanupAll(); process.exit(1); });

/** 按命令行列过滤 7za 进程(只认属于本演练工作目录的引擎)。CIM 冷启动要 1-2s,仅在快检命中后调用 */
function enginePids(hint: string): number[] {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='7za.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const rows = JSON.parse(out.trim().startsWith('[') ? out : `[${out}]`) as { ProcessId: number; CommandLine: string | null }[];
    return rows.filter((r) => (r.CommandLine ?? '').toLowerCase().includes(hint.toLowerCase())).map((r) => r.ProcessId);
  } catch { return []; }
}

/** 轻量快检:tasklist 一次 ~150ms 拿到全部 7za pid,可进毫秒级捕捉路径(CIM 冷启动 1-2s 只能用于非关键路径) */
function enginePidsFast(): number[] {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq 7za.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    const pids: number[] = [];
    for (const line of out.split('\n')) {
      const m = /^"7za\.exe","(\d+)"/i.exec(line.trim());
      if (m) pids.push(Number(m[1]));
    }
    return pids;
  } catch { return []; }
}

/** 超时现场快照:区分"任务没启动 / 秒完成错过 / 记录没写",不靠猜 */
function dumpDrillState(ud: string, work: string, jobId?: string): string {
  const parts: string[] = [];
  try { parts.push(`journal=${fs.readFileSync(txnFile(ud), 'utf8').replace(/\s+/g, ' ').slice(0, 600)}`); } catch { parts.push('journal=<无文件>'); }
  try {
    const h = histTasks(ud);
    parts.push(`history=${JSON.stringify(jobId ? h.filter((t) => t.id === jobId) : h).slice(0, 400)}`);
  } catch { parts.push('history=<无>'); }
  try { parts.push(`work目录=${fs.readdirSync(work).join('|').slice(0, 300)}`); } catch { /* noop */ }
  parts.push(`7za在场=${enginePidsFast().join(',') || '否'}`);
  return parts.join(' ;; ');
}

async function waitFor(desc: string, fn: () => boolean, timeoutMs = 30000, intervalMs = 20, diag?: () => string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    let ok = false;
    try { ok = fn(); } catch { ok = false; }
    if (ok) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`超时(${timeoutMs}ms):${desc}${diag ? ` ;; ${diag()}` : ''}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function pickFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = (srv.address() as net.AddressInfo).port; srv.close(() => res(p)); });
    srv.on('error', rej);
  });
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJsonSafe<T>(f: string): T | null {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) as T; } catch { return null; }
}

/* ---------------- 应用生命周期(CDP 测试通道) ---------------- */

interface App { proc: ChildProcess; ud: string; port: number }

function spawnApp(ud: string, port: number): App {
  const proc = spawn(EXE, [`--user-data-dir=${ud}`, `--remote-debugging-port=${port}`, '--no-first-run'], { stdio: 'ignore', windowsHide: true });
  if (!proc.pid) throw new Error('应用启动失败:无 pid');
  spawned.add(proc.pid);
  return { proc, ud, port };
}

async function cdpPageTarget(port: number): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; url?: string; webSocketDebuggerUrl?: string }[];
      // 解压完成会自动弹浏览窗(url 带 window=folder);任务指令只下发给主窗,否则 winClose 会关错窗口
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !(t.url ?? '').includes('window=folder'));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* devtools 未就绪 */ }
    if (Date.now() - t0 > 30000) throw new Error('CDP page target 等待超时');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function cdpEval(app: App, expr: string, timeoutMs = 20000): Promise<unknown> {
  const wsUrl = await cdpPageTarget(app.port);
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch { /* noop */ } rej(new Error('CDP eval 超时')); }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data)) as { id?: number; result?: { result?: { value?: unknown } } };
      if (d.id === 1) { clearTimeout(timer); try { ws.close(); } catch { /* noop */ } res(d.result?.result?.value); }
    };
    ws.onerror = () => { clearTimeout(timer); rej(new Error('CDP 连接失败')); };
  });
}

/** 等渲染层加载完且引擎预热成功(以真实 detectEngine 调用为准) */
async function waitReady(app: App): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const v = await cdpEval(app, `window.tz.detectEngine().then(r => r.ok ? r.data.version : 'IPCERR:' + JSON.stringify(r.error ?? r.err ?? 'unknown'))`, 8000) as string;
    if (typeof v === 'string' && v.startsWith('IPCERR')) throw new Error(`引擎探测失败:${v}`);
    if (typeof v === 'string' && v.length > 0) return;
    if (Date.now() - t0 > 60000) throw new Error(`应用就绪等待超时(最后回值=${String(v)})`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** 经 preload 真实 IPC 启动任务并登记路径(等价渲染层行为),返回 taskId */
async function startTask(app: App, jsExpr: string, pathInfo: string): Promise<string> {
  const expr = `${jsExpr}.then((r) => r.ok ? window.tz.taskPathSet(r.data.taskId, ${pathInfo}).then(() => r.data.taskId) : ('IPCERR:' + JSON.stringify(r.err ?? r.error ?? '')))`;
  const v = await cdpEval(app, expr, 30000);
  if (typeof v !== 'string' || v.startsWith('IPCERR')) throw new Error(`任务启动失败:${String(v)}`);
  return v;
}

/* ---------------- userData 状态读取 ---------------- */

const histFile = (ud: string) => path.join(ud, 'tongzip-history.json');
const txnFile = (ud: string) => path.join(ud, 'tongzip-txn.json');

interface HistTaskLike { id: string; status: string; txnRolledBack?: boolean; finishedAt?: number }
function histTasks(ud: string): HistTaskLike[] {
  const j = readJsonSafe<{ tasks?: HistTaskLike[] }>(histFile(ud));
  return j?.tasks ?? [];
}
function histStatus(ud: string, id: string): string | undefined {
  return histTasks(ud).find((t) => t.id === id)?.status;
}
interface TxnRecLike { id: string; archive: string; tmp: string; backup?: string; stage: string; kind?: string }
function txnRecords(ud: string): TxnRecLike[] {
  const j = readJsonSafe<{ records?: TxnRecLike[] }>(txnFile(ud));
  return j?.records ?? [];
}

/** 递归扫描演练目录全部文件,敏感串零残留(密码等) */
function scanForLeaks(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      try {
        if (fs.statSync(p).size > 64 * 1024 * 1024) continue; // 大文件是测试数据本身
        if (fs.readFileSync(p).includes(needle, 'utf8')) hits.push(p);
      } catch { /* 占用/特殊文件跳过 */ }
    }
  };
  try { walk(dir); } catch { /* noop */ }
  return hits;
}

/* ---------------- 测试数据构造(用随包引擎,与演练应用同版本) ---------------- */

/**
 * 捕捉「事务记录在场 && 引擎进程活着」的真实崩溃窗口:
 * journal 用 fs 读轮询(20ms),引擎 pid 用 tasklist 一次快检(~150ms)——两个廉价检查在同一次
 * 采样中同时为真即返回可杀目标。CIM(Get-CimInstance)冷启动 1-2s,放进采样循环会让引擎秒完
 * 都追不上(上上轮实测 800MB store 解压全程仅 702ms),只保留在非关键路径做目录归属复核。
 * 引擎归属保证:journal 记录在场 ⇒ 该记录由本演练应用写出,窗口内的 7za 即演练引擎;
 * 演练期间不允许无关 7za 存在(CI 干净环境原则,门禁文档已注明)。
 * 超时抛错附现场快照,区分"没启动 / 秒完成错过 / 记录没写"三种形态。
 */
async function catchLiveWindow(ud: string, work: string, match: (r: TxnRecLike) => boolean, desc: string, timeoutMs = 45000): Promise<number[]> {
  const t0 = Date.now();
  for (;;) {
    if (txnRecords(ud).some(match)) {
      const pids = enginePidsFast(); // 记录在场 = 任务未收尾;同一采样内双真即具备强杀条件
      if (pids.length) return pids;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`超时(${timeoutMs}ms):${desc} ;; ${dumpDrillState(ud, work)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function mkTemp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function engineCli(args: string[]): void {
  const r = spawnSync(ENGINE, args, { stdio: 'ignore' });
  if (r.status !== 0) throw new Error(`引擎预置命令失败(${args.join(' ')}):status=${r.status}`);
}

/**
 * 低熵数据(64 个随机 4KB 块循环):-mx1 可压缩成小包,但解压/重压缩要按原始体积走 CPU+IO。
 * 演练要的是"引擎真实执行中的秒级窗口"——纯随机 store 包在 OS 缓存热态下 800MB 也仅 702ms,
 * 任何轮询都追不上;换成压缩包后同样体积的引擎寿命放大 5-20 倍,强杀才确实切在执行中。
 */
function makeLowEntropy(file: string, mb: number): void {
  const blocks: Buffer[] = [];
  for (let i = 0; i < 64; i++) { const b = Buffer.allocUnsafe(4096); crypto.randomFillSync(b); blocks.push(b); }
  const total = mb * 1024 * 1024;
  const fd = fs.openSync(file, 'w');
  for (let written = 0, i = 0; written < total; written += 4096, i++) fs.writeSync(fd, blocks[i % blocks.length]);
  fs.closeSync(fd);
}

const q = (s: string) => JSON.stringify(s).replace(/\\/g, '\\\\');

/* ---------------- C1:解压执行中真实崩溃 ---------------- */

async function caseC1(): Promise<void> {
  console.log('--- C1 解压任务执行中强制终止 ---');
  const ud = mkTemp('tz-crash1-ud-');
  const work = mkTemp('tz-crash1-w-');
  let app: App | null = null;
  try {
    const big = path.join(work, 'big.bin');
    makeLowEntropy(big, 400);
    const arc = path.join(work, 'enc.7z');
    engineCli(['a', `-p${PW}`, '-mx1', arc, big]);
    const dest = path.join(work, 'out');

    app = spawnApp(ud, await pickFreePort());
    await waitReady(app);
    const jobId = await startTask(app,
      `window.tz.extract({archive:${q(arc)},dest:${q(dest)},overwrite:'skip',password:${q(PW)}})`,
      `{archive:${q(arc)},dest:${q(dest)}}`);

    const engPids = await catchLiveWindow(ud, work, (r) => r.kind === 'extract',
      'journal 出现 extract 暂存记录且引擎在跑(任务确实执行中)', 45000);
    /* 引擎在场时历史记录只会是 running(终态尚未发生);400ms 去抖落盘,此刻读到即证据 */
    await waitFor('历史已持久化 running(引擎执行中的记录已落盘)', () =>
      histTasks(ud).some((t) => t.id === jobId && t.status !== 'done'), 10000, 20,
      () => dumpDrillState(ud, work, jobId) + ` ;; jobId=${jobId} histFile=${fs.existsSync(histFile(ud))}`);

    /* 模拟非正常退出:强杀主进程 + 引擎子进程(Windows 子进程不随父死亡,必须都杀) */
    killHard(app.proc.pid);
    engPids.forEach(killHard);
    app = null;
    await waitFor('引擎进程确已消失', () => enginePids(work).length === 0, 10000);

    const stageGoneCheck = () => fs.readdirSync(path.dirname(dest)).some((n) => n.includes('tzstage'));
    const hadStage = stageGoneCheck();

    /* 重启:不带任何任务开关,验证恢复且不自动重放 */
    const app2 = spawnApp(ud, await pickFreePort());
    app = app2;
    await waitFor('重启后 journal 清零(extract 暂存被回收)', () => txnRecords(ud).length === 0, 30000);
    await waitFor('重启后历史定格 interrupted', () => histStatus(ud, jobId) === 'interrupted', 30000);
    assert(hadStage, 'C1 崩溃现场存在隔离暂存目录(演练确实切在解压中途)');
    assert(!stageGoneCheck(), 'C1 重启恢复后暂存残留被清理');
    const landed = fs.existsSync(dest) ? fs.readdirSync(dest) : [];
    assert(landed.length === 0, `C1 未提交半成品没有进入目标目录(${landed.length} 项)`);
    await new Promise((r) => setTimeout(r, 3000));
    assert(enginePids(work).length === 0, 'C1 重启后 3 秒内无引擎进程 = 没有自动重放');
    assert(!histTasks(ud).some((t) => t.status === 'running'), 'C1 重启后无新 running 记录');
    for (const leak of [...scanForLeaks(ud, PW), ...scanForLeaks(work, PW)]) assert(false, `C1 敏感数据残留:${leak}`);
    assert(true, 'C1 userData 与演练目录零密码残留');
  } finally {
    if (app) killHard(app.proc.pid);
    enginePids(work).forEach(killHard);
  }
}

/* ---------------- C2:修改事务提交前(staged)真实崩溃 ---------------- */

async function caseC2(): Promise<void> {
  console.log('--- C2 归档修改事务 staged 阶段强制终止 ---');
  const ud = mkTemp('tz-crash2-ud-');
  const work = mkTemp('tz-crash2-w-');
  let app: App | null = null;
  try {
    const arc = path.join(work, 'mod.7z');
    makeLowEntropy(path.join(work, 'big.bin'), 300);
    fs.writeFileSync(path.join(work, 'small.txt'), 'delete me please');
    engineCli(['a', `-p${PW}`, '-mx1', arc, path.join(work, 'big.bin'), path.join(work, 'small.txt')]);
    const hashBefore = sha256(arc);

    app = spawnApp(ud, await pickFreePort());
    await waitReady(app);
    const jobId = await startTask(app,
      `window.tz.deleteEntries(${q(arc)}, ['small.txt'], ${q(PW)})`,
      `{archive:${q(arc)}}`);

    const engPids = await catchLiveWindow(ud, work, (r) => r.stage === 'staged' && !r.kind,
      'journal 进入 staged 且引擎在改副本(事务提交前窗口)', 45000);
    await waitFor('历史已持久化 running(引擎执行中的记录已落盘)', () =>
      histTasks(ud).some((t) => t.id === jobId && t.status !== 'done'), 10000, 20,
      () => dumpDrillState(ud, work, jobId) + ` ;; jobId=${jobId} histFile=${fs.existsSync(histFile(ud))}`);
    const rec = txnRecords(ud).find((r) => r.stage === 'staged' && !r.kind);
    if (rec) assert(fs.existsSync(rec.tmp), 'C2 staged:副本(.tztmp)存在,修改只触碰副本');

    killHard(app.proc.pid);
    engPids.forEach(killHard);
    app = null;

    const app2 = spawnApp(ud, await pickFreePort());
    app = app2;
    await waitFor('重启后 journal 清零', () => txnRecords(ud).length === 0, 30000);
    await waitFor('重启后历史定格 interrupted', () => histStatus(ud, jobId) === 'interrupted', 30000);
    assert(sha256(arc) === hashBefore, 'C2 提交前崩溃:原归档逐字节不变,用户文件得到保护');
    assert(!rec || !fs.existsSync(rec.tmp), 'C2 staged 副本按规则被启动回收清理');
    assert(!fs.readdirSync(work).some((n) => n.includes('.tzbak') || n.includes('.tztmp')), 'C2 无事务残留文件');
    const t = histTasks(ud).find((x) => x.id === jobId)!;
    assert(!t.txnRolledBack, 'C2 staged 崩溃不进 restored 清单,不误标事务回滚(原归档从未被动过)');
    await new Promise((r) => setTimeout(r, 2000));
    assert(enginePids(work).length === 0, 'C2 重启后无自动重放');
    for (const leak of [...scanForLeaks(ud, PW), ...scanForLeaks(work, PW)]) assert(false, `C2 敏感数据残留:${leak}`);
    assert(true, 'C2 演练目录零密码残留');
  } finally {
    if (app) killHard(app.proc.pid);
    enginePids(work).forEach(killHard);
  }
}

/* ---------------- C3:提交边界(故障注入磁盘中间态 + 真实应用恢复) ---------------- */

interface C3Case { stage: 'swapping' | 'committed'; restoredExpect: 'old' | 'new'; rolledBackMark: boolean }
async function caseC3(name: string, c: C3Case): Promise<void> {
  console.log(`--- ${name} 事务提交边界注入态恢复 ---`);
  const ud = mkTemp(`tz-${name}-ud-`);
  const work = mkTemp(`tz-${name}-w-`);
  let app: App | null = null;
  try {
    const arc = path.join(work, 'swap.7z');
    const oldData = path.join(work, 'o.bin'); const newData = path.join(work, 'n.bin');
    fs.writeFileSync(oldData, 'OLD-payload'); fs.writeFileSync(newData, 'NEW-payload');
    engineCli(['a', '-mx0', arc, oldData]);
    const hashOld = sha256(arc);
    engineCli(['a', '-mx0', path.join(work, 'newarc.7z'), newData]);
    const hashNew = sha256(path.join(work, 'newarc.7z'));

    /* 构造与 commitTxnSwap 崩溃现场同形的磁盘状态(执行相同的 rename 序列) */
    const tmp = arc + '.inj01.tztmp'; const backup = arc + '.inj01.tzbak';
    if (c.stage === 'swapping') {
      fs.copyFileSync(path.join(work, 'newarc.7z'), tmp); // 修改完的副本待就位
      fs.renameSync(arc, backup); // 第一笔 rename 已完成、第二笔未发生 → 原归档缺位
    } else {
      fs.copyFileSync(path.join(work, 'newarc.7z'), arc); // tmp 已 rename 就位:archive=新内容
      fs.writeFileSync(backup, 'OLD-contents-not-deleted-yet'); // 备份没来得及删
    }
    fs.writeFileSync(txnFile(ud), JSON.stringify({
      v: 1, records: [{ id: 'inj01', archive: arc, tmp, backup, stage: c.stage, at: Date.now() }],
    }), 'utf8');
    fs.writeFileSync(histFile(ud), JSON.stringify({
      version: 1, tasks: [{ id: 'inj-task', kind: 'delete', label: 'swap.7z', src: arc, status: 'running', createdAt: Date.now() - 5000 }],
    }), 'utf8');

    app = spawnApp(ud, await pickFreePort());
    await waitFor('注入记录被真实恢复流程消费(journal 清零)', () => txnRecords(ud).length === 0, 30000);
    await waitFor('历史定格 interrupted', () => histStatus(ud, 'inj-task') === 'interrupted', 20000);

    const t = histTasks(ud).find((x) => x.id === 'inj-task')!;
    assert(t.status === 'interrupted', `${name} 任务标中断而非成功/失败(无法确认结果禁止自动重放)`);
    if (c.stage === 'swapping') {
      assert(fs.existsSync(arc) && sha256(arc) === hashOld, 'C3a swapping 半态:按磁盘证据还原原归档(不是盲删备份也不是判成功)');
      assert(!fs.existsSync(backup) && !fs.existsSync(tmp), 'C3a 还原后备份与副本收敛,无残留');
      assert(t.txnRolledBack === true, 'C3a 任务标记 txnRolledBack:结果由事务协议判定');
    } else {
      assert(fs.existsSync(arc) && sha256(arc) === hashNew, 'C3b committed:新归档保持(刚提交崩溃不误判为回滚)');
      assert(!fs.existsSync(backup), 'C3b 未删尽的备份被回收');
      assert(t.txnRolledBack === undefined, 'C3b 提交完成不进 restored 清单,任务不标事务回滚');
    }
    await new Promise((r) => setTimeout(r, 2000));
    assert(enginePids(work).length === 0 && histTasks(ud).length === 1, `${name} 恢复后无重放、历史无增殖(重复恢复安全)`);
  } finally {
    if (app) killHard(app.proc.pid);
  }
}

/* ---------------- C4:正常退出对照 ---------------- */

async function caseC4(): Promise<void> {
  console.log('--- C4 正常退出(非强杀)对照 ---');
  const ud = mkTemp('tz-crash4-ud-');
  const work = mkTemp('tz-crash4-w-');
  let app: App | null = null;
  try {
    const arc = path.join(work, 'small.7z');
    fs.writeFileSync(path.join(work, 'a.txt'), 'hello-crash-drill');
    engineCli(['a', '-mx0', arc, path.join(work, 'a.txt')]);
    const dest = path.join(work, 'out');

    app = spawnApp(ud, await pickFreePort());
    await waitReady(app);
    const jobId = await startTask(app,
      `window.tz.extract({archive:${q(arc)},dest:${q(dest)},overwrite:'skip'})`,
      `{archive:${q(arc)},dest:${q(dest)}}`);
    await waitFor('任务自然完成并写入历史 done', () => histStatus(ud, jobId) === 'done', 60000);

    /* 正常关闭:走用户点 ✕ 的同一条链路 —— 渲染层 winClose → 主窗 closed → app.quit → will-quit 强刷。
       (taskkill 不带 /F 的 WM_CLOSE 对 Electron 多进程窗口不可靠,上轮实测不生效)
       窗口销毁会截断 CDP 回包,eval 的连接错误属预期,吞掉后以进程退出为准 */
    await cdpEval(app, `window.tz.winClose()`, 10000).catch(() => undefined);
    await waitFor('应用进程正常退出', () => !pidAlive(app!.proc.pid!), 30000);
    const t = histTasks(ud).find((x) => x.id === jobId)!;
    assert(t.status === 'done' && typeof t.finishedAt === 'number', 'C4 正常退出保留终态,无 interrupted');
    assert(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8') === 'hello-crash-drill', 'C4 解压产物完整落位');
    assert(txnRecords(ud).length === 0, 'C4 退出后 journal 无残留记录');
    app = null;
  } finally {
    if (app) killHard(app.proc.pid);
  }
}

/* ---------------- 主流程 ---------------- */

(async () => {
  if (!fs.existsSync(EXE)) throw new Error(`打包产物缺失:${EXE}(先跑 npm run dist / gate 的打包步骤)`);
  if (!fs.existsSync(ENGINE)) throw new Error(`随包引擎缺失:${ENGINE}`);
  console.log('crash-drill exe =', EXE);
  const cases: [string, () => Promise<void>][] = [
    ['C1', caseC1], ['C2', caseC2],
    ['C3a', () => caseC3('crash3a', { stage: 'swapping', restoredExpect: 'old', rolledBackMark: true })],
    ['C3b', () => caseC3('crash3b', { stage: 'committed', restoredExpect: 'new', rolledBackMark: false })],
    ['C4', caseC4],
  ];
  for (const [name, run] of cases) {
    const t0 = Date.now();
    try {
      await Promise.race([run(), new Promise((_, rej) => setTimeout(() => rej(new Error(`${name} 案例总超时(300s)`)), 300000))]);
      console.log(`[${name}] 完成 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      failures++;
      console.error(`[${name}] 案例异常:${(e as Error).message}`);
    }
  }
  if (failures) { console.error(`\nCRASH DRILL FAILED (${failures})`); process.exit(1); }
  console.log('\nCRASH DRILL ALL PASSED');
})();
