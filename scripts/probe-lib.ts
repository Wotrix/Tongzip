/**
 * 阶段 4 探针共用基建 — 从 crash-test.ts 的实战纪律提炼(不反向修改门禁资产)。
 * 硬性约定:独立临时目录 + 隔离 userData;任何退出路径清理进程与目录;
 * 断言失败计数,进程以非零退出;绝不静默吞掉失败。
 */
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/* ---------------- 断言与失败记账 ---------------- */

let failures = 0;
export function assert(cond: unknown, msg: string): boolean {
  if (cond) { console.log('ok  :', msg); return true; }
  failures++;
  console.error('FAIL:', msg);
  return false;
}
/** 探测型记录:不算失败,只如实登记观察结果(矩阵填格用) */
export function note(msg: string): void {
  console.log('note:', msg);
}
export function failureCount(): number { return failures; }

/* ---------------- 进程与目录纪律 ---------------- */

const spawned = new Set<number>();
const dirs: string[] = [];

export function killHard(pid: number | undefined): void {
  if (!pid || pid < 0) return;
  try { process.kill(pid); } catch { /* 已退出 */ }
  spawned.delete(pid);
}
export function killTree(pid: number): void {
  try { execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch { /* noop */ }
}
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { spawned.delete(pid); return false; }
}
export function cleanupAll(): void {
  for (const pid of spawned) killTree(pid);
  for (const d of dirs) { try { rmRecursive(d); } catch { /* 占用则跳过 */ } }
}
/** Windows 只读位会挡 rmSync(icacls 测试后常见),先清属性再删 */
export function rmRecursive(d: string): void {
  try { execFileSync('attrib', ['-R', path.join(d, '*'), '/S', '/D'], { stdio: 'ignore' }); } catch { /* noop */ }
  fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

export function mkTemp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** 探针主入口包装:统一退出码 + 全局清理 */
export async function runProbe(main: () => Promise<void>): Promise<void> {
  process.on('exit', cleanupAll);
  process.on('uncaughtException', (e) => { console.error('UNCAUGHT', e); failures++; cleanupAll(); process.exit(1); });
  const t0 = Date.now();
  try { await main(); } catch (e) { console.error('PROBE ERROR:', e); failures++; }
  console.log(`── 探针用时 ${((Date.now() - t0) / 1000).toFixed(1)}s,失败 ${failures} 项 ──`);
  process.exit(failures > 0 ? 1 : 0);
}

/* ---------------- 通用工具 ---------------- */

export function waitFor(desc: string, fn: () => boolean, timeoutMs = 30000, intervalMs = 20, diag?: () => string): Promise<void> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let ok = false;
      try { ok = fn(); } catch { ok = false; }
      if (ok) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`超时(${timeoutMs}ms):${desc}${diag ? ` ;; ${diag()}` : ''}`));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

export function pickFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = (srv.address() as net.AddressInfo).port; srv.close(() => res(p)); });
    srv.on('error', rej);
  });
}

export function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function readJsonSafe<T>(f: string): T | null {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) as T; } catch { return null; }
}

/** 字符串 → CDP 表达式里的 JS 字符串字面量。只转义一层(JS 源码层);
 * ws 帧的 JSON 转义由 cdpEval 内部 JSON.stringify 自动完成,额外翻倍只会让页面里的
 * Windows 路径变成 C:\\Users 形态——短路径靠内核归一化侥幸无事,长路径则击穿 7za 的
 * MAX_PATH 启发式(阶段 4 长路径实测翻车的真因,非产品缺陷)。 */
export const q = (s: string) => JSON.stringify(s);

/* ---------------- 引擎 CLI ---------------- */

export interface EngineRun { status: number | null; out: string; err: string }
export function engineRun(exe: string, args: string[], timeoutMs = 60_000): EngineRun {
  const r = spawnSync(exe, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, killSignal: 'SIGKILL' });
  return { status: r.status === null ? -1 : r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), err: r.stderr ?? '' };
}

/** 低熵数据:可压缩又足够耗时(同 crash-test 实证策略) */
export function makeLowEntropy(file: string, mb: number): void {
  const blocks: Buffer[] = [];
  for (let i = 0; i < 64; i++) { const b = Buffer.allocUnsafe(4096); crypto.randomFillSync(b); blocks.push(b); }
  const total = mb * 1024 * 1024;
  const fd = fs.openSync(file, 'w');
  for (let written = 0, i = 0; written < total; written += 4096, i++) fs.writeSync(fd, blocks[i % blocks.length]);
  fs.closeSync(fd);
}

/* ---------------- 真实应用(CDP 通道) ---------------- */

export interface ProbeApp { proc: ChildProcess; ud: string; port: number; exe: string }

export function spawnApp(exe: string, ud: string, port: number): ProbeApp {
  const proc = spawn(exe, [`--user-data-dir=${ud}`, `--remote-debugging-port=${port}`, '--no-first-run'], { stdio: 'ignore', windowsHide: true });
  if (!proc.pid) throw new Error('应用启动失败:无 pid');
  spawned.add(proc.pid);
  return { proc, ud, port, exe };
}

async function cdpPageTarget(port: number): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; url?: string; webSocketDebuggerUrl?: string }[];
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !(t.url ?? '').includes('window=folder') && !(t.url ?? '').includes('window=task'));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* devtools 未就绪 */ }
    if (Date.now() - t0 > 30000) throw new Error('CDP page target 等待超时');
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function cdpEval(app: ProbeApp, expr: string, timeoutMs = 20000): Promise<unknown> {
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

/** 等渲染层加载完且引擎可用(以真实 detectEngine 为准) */
export async function waitReady(app: ProbeApp): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const v = await cdpEval(app, `window.tz.detectEngine().then(r => r.ok ? r.data.version : 'IPCERR:' + JSON.stringify(r.code ?? 'unknown'))`, 8000) as string;
    if (typeof v === 'string' && v.startsWith('IPCERR')) throw new Error(`引擎探测失败:${v}`);
    if (typeof v === 'string' && v.length > 0) return;
    if (Date.now() - t0 > 60000) throw new Error(`应用就绪等待超时(最后回值=${String(v)})`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** 页面内挂进度收集器(onProgress 真实事件流),供轮询取终态 */
export async function installEventCollector(app: ProbeApp): Promise<void> {
  await cdpEval(app, `window.__probe = []; window.tz.onProgress(e => window.__probe.push({taskId:e.taskId,kind:e.kind,status:e.status,code:e.code??null,message:e.message??null})); 'ok'`);
}

export async function takeEvents(app: ProbeApp): Promise<{ taskId: string; kind: string; status: string; code: string | null; message: string | null }[]> {
  const v = await cdpEval(app, `(() => { const a = window.__probe || []; window.__probe = []; return a; })()`);
  return Array.isArray(v) ? v as never : [];
}

/** 经真实 IPC 启动压缩任务,等终态事件(带硬超时),返回终态记录 */
export async function runAppCompress(app: ProbeApp, job: Record<string, unknown>, timeoutMs = 60_000): Promise<{ status: string; code: string | null; message: string | null; taskId: string }> {
  const expr = `window.tz.compress(${JSON.stringify(job)}).then(r => r.ok ? r.data.taskId : ('IPCERR:' + JSON.stringify({ code: r.code, message: r.message })))`;
  const v = await cdpEval(app, expr, 30000);
  if (typeof v !== 'string' || v.startsWith('IPCERR')) {
    const j = v.startsWith('IPCERR') ? JSON.parse(v.slice(7)) as { code: string; message: string } : { code: 'CDP', message: String(v) };
    return { status: 'ipc_error', code: j.code, message: j.message, taskId: '' };
  }
  const taskId = v;
  /* 直接异步轮询事件流直至终态/超时(waitFor 判据是同步函数,不能包 Promise) */
  const t0 = Date.now();
  for (;;) {
    const evs = await takeEvents(app);
    const term = evs.find((e) => e.taskId === taskId && e.status !== 'running');
    if (term) { terminalCache.set(taskId, term); return { ...term, taskId }; }
    if (terminalCache.has(taskId)) { const c = terminalCache.get(taskId)!; return { ...c, taskId }; }
    if (Date.now() - t0 > timeoutMs) return { status: 'no_terminal_event', code: null, message: null, taskId };
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 已消费事件里命中过终态的备忘录:防止轮询读取与外部读事件竞争丢帧 */
const terminalCache = new Map<string, { status: string; code: string | null; message: string | null }>();

/** 通用 IPC 任务:表达式需 resolve 成 {ok,data:{taskId}} 或 {ok:false,code,message};
    成功则轮询 onProgress 事件流至终态/超时。压缩/解压/测试/删除任务统一入口。 */
export async function runIpcTask(app: ProbeApp, invokeExpr: string, timeoutMs = 120_000): Promise<{ status: string; code: string | null; message: string | null; taskId: string }> {
  const v = await cdpEval(app, `${invokeExpr}.then(r => r.ok && r.data && r.data.taskId ? r.data.taskId : (r.ok ? 'SYNC' : 'IPCERR:' + JSON.stringify({ code: r.code, message: r.message })))`, 30000);
  if (typeof v !== 'string') return { status: 'cdp_bad_return', code: null, message: String(v), taskId: '' };
  if (v === 'SYNC') return { status: 'sync_done', code: null, message: null, taskId: '' };
  if (v.startsWith('IPCERR:')) { const j = JSON.parse(v.slice(7)) as { code: string; message: string }; return { status: 'ipc_error', code: j.code, message: j.message, taskId: '' }; }
  const t0 = Date.now();
  for (;;) {
    const evs = await takeEvents(app);
    const term = evs.find((e) => e.taskId === v && e.status !== 'running');
    if (term) return { ...term, taskId: v };
    if (Date.now() - t0 > timeoutMs) return { status: 'timeout', code: null, message: null, taskId: v };
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 应用真实列目录(走 tz:archive-list IPC) */
export async function appListArchive(app: ProbeApp, file: string, password?: string): Promise<{ ok: boolean; code: string; type?: string; entries?: number }> {
  const v = await cdpEval(app, `window.tz.listArchive(${q(file)},${password ? q(password) : 'undefined'}).then(r => r.ok ? JSON.stringify({ok:true,type:r.data.type,entries:r.data.entries.length}) : JSON.stringify({ok:false,code:r.code}))`, 30000);
  if (typeof v !== 'string' || !v) return { ok: false, code: 'CDP_NULL' };
  try { return JSON.parse(v) as { ok: boolean; code: string; type?: string; entries?: number }; } catch { return { ok: false, code: 'CDP_PARSE' }; }
}

/* ---------------- userData 读取(与 crash-test 同路径约定) ---------------- */
export const histFile = (ud: string) => path.join(ud, 'tongzip-history.json');
export const txnFile = (ud: string) => path.join(ud, 'tongzip-txn.json');
export interface HistTaskLike { id: string; status: string; kind?: string }
export function histTasks(ud: string): HistTaskLike[] {
  return readJsonSafe<{ tasks?: HistTaskLike[] }>(histFile(ud))?.tasks ?? [];
}
export interface TxnRecLike { id: string; archive: string; tmp: string; backup?: string; stage: string; kind?: string }
export function txnRecords(ud: string): TxnRecLike[] {
  return readJsonSafe<{ records?: TxnRecLike[] }>(txnFile(ud))?.records ?? [];
}

/* ---------------- 产物路径 ---------------- */

export function writeOutJson(rel: string, data: unknown): string {
  const f = path.resolve('docs/phase4', rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8');
  console.log(`结果已写入 ${path.relative(process.cwd(), f)}`);
  return f;
}
