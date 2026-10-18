/**
 * 交付物五：稳定性长跑(npm run stability)— 独立长时运行,不进 CI 门禁。
 * - STAB-01 大文件往返:约 4GB 半熵文件(磁盘余量不足自动降档并如实登记)单任务
 *   压缩/解压往返;期间每 2s 采样 TongZip.exe 与 7za.exe 工作集(RSS 曲线),
 *   断言峰值不设"内存失控"红线之内且往返文件 sha256 一致。
 * - STAB-02 长时间多任务:混合队列(压缩 zip/7z/tar.gz、解压、测试、删除副本)经
 *   真实任务通道连跑 + 一次并发突发;断言全程无崩溃、终态全 done、任务历史与实际产物一致。
 * - STAB-04 异常退出恢复:引用阶段 3.5 崩溃演练结论(五案例/本地 gate 6/6/CI run
 *   38385301903 success),不重做,只记引用。
 * 纪律沿用 probe-lib:隔离 userData + 临时目录;断言失败非零退出;退出路径清理进程与目录。
 * 输出 docs/phase4/stability-results.json。
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runProbe, assert, note, mkTemp, makeLowEntropy, spawnApp, cdpEval, waitReady,
  installEventCollector, takeEvents, pickFreePort, runIpcTask, waitFor, pidAlive,
  killHard, histFile, histTasks, txnRecords, writeOutJson, q, type ProbeApp,
} from './probe-lib';
import { checkFreeSpace } from '../electron/engine';

const APP_EXE = path.resolve('release/win-unpacked/TongZip.exe');
const ENGINE = path.resolve('release/win-unpacked/resources/engine/7za.exe');

interface Finding { id: string; item: string; expect: string; actual: string; verdict: 'ok' | 'mismatch' | 'note' | 'pending-real' | 'citation'; detail: string }
const findings: Finding[] = [];
function record(f: Finding): void {
  findings.push(f);
  const line = `[${f.id}] 期望=${f.expect} 实际=${f.actual} :: ${f.detail.slice(0, 150)}`;
  if (f.verdict === 'mismatch') assert(false, line);
  else console.log(f.verdict === 'ok' ? '  ✓' : f.verdict === 'citation' ? '  §' : '  ·', line);
}

/* ---------------- RSS 采样(tasklist CSV,按 PID 归因,排除无关同名进程干扰) ---------------- */
interface RssRow { pid: number; mb: number; name: string }
function tasklistRows(): RssRow[] {
  let out = '';
  try { out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 15000 }); } catch { return []; }
  const rows: RssRow[] = [];
  for (const line of out.split('\n')) {
    const c = line.trim().split('","');
    if (c.length < 5) continue;
    const name = c[0].replace(/^"/, '').toLowerCase();
    const pid = Number(c[1]);
    const kb = Number((c[4].match(/[\d,.]+/) ?? ['0'])[0].replace(/[,.]/g, ''));
    if (Number.isFinite(pid) && pid > 0) rows.push({ pid, mb: Math.round(kb / 1024), name });
  }
  return rows;
}
const pidsOf = (name: string) => new Set(tasklistRows().filter((r) => r.name === name).map((r) => r.pid));
interface RssSample { t: number; appMb: number; engineMb: number }
class RssWatch {
  samples: RssSample[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** appPid=探针自己拉起的实例;engineBase=点火前已存在的 7za PID(与本次无关,不计入) */
  constructor(private appPid: number, private engineBase: Set<number>) {}
  start(everyMs = 1000): void {
    const tick = () => {
      const rows = tasklistRows();
      const app = rows.filter((r) => r.pid === this.appPid).reduce((s, r) => s + r.mb, 0);
      const engine = rows.filter((r) => r.name === '7za.exe' && !this.engineBase.has(r.pid)).reduce((s, r) => s + r.mb, 0);
      this.samples.push({ t: Date.now(), appMb: app, engineMb: engine });
    };
    tick();
    this.timer = setInterval(tick, everyMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  peak(which: 'appMb' | 'engineMb'): number { return this.samples.reduce((m, s) => Math.max(m, s[which]), 0); }
  summary(): string {
    return `n=${this.samples.length} app峰值=${this.peak('appMb')}MB engine峰值(仅本任务进程)=${this.peak('engineMb')}MB`;
  }
}

/* ---------------- 大文件哈希(分块读,避免 readFileSync 整读 4GB) ---------------- */
function sha256File(f: string): string {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(f, 'r');
  const buf = Buffer.alloc(8 * 1024 * 1024);
  for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, null); if (!n) break; h.update(buf.subarray(0, n)); }
  fs.closeSync(fd);
  return h.digest('hex');
}

/** 优雅关窗(winClose 的 invoke 回复随窗口销毁会丢,取火不管) */
async function closeApp(app: ProbeApp): Promise<void> {
  try { await cdpEval(app, `void window.tz.winClose(); 'bye'`, 5000); } catch { /* 渲染层先走属正常 */ }
  await waitFor('应用进程退出', () => !pidAlive(app.proc.pid), 15000, 100).catch(() => killHard(app.proc.pid));
}

/** 列目录取条目名(删除任务取证用) */
async function cdpListEntries(app: ProbeApp, file: string): Promise<string[]> {
  const v = await cdpEval(app, `window.tz.listArchive(${q(file)}).then(r => r.ok ? JSON.stringify(r.data.entries.map(e => e.path ?? e.name)) : '[]')`, 30000);
  if (typeof v !== 'string') return [];
  try { return JSON.parse(v) as string[]; } catch { return []; }
}

/** 并发突发:一次点火多个任务,统一轮询事件流至全部终态 */
async function runBurst(app: ProbeApp, exprs: string[], timeoutMs = 300_000): Promise<Record<string, string>> {
  const ids: string[] = [];
  for (const e of exprs) {
    const v = await cdpEval(app, `${e}.then(r => r.ok && r.data && r.data.taskId ? r.data.taskId : ('IPCERR:' + JSON.stringify({ code: r.code, message: r.message })))`, 30000);
    if (typeof v !== 'string') return { __error: 'cdp_bad_return' };
    if (v.startsWith('IPCERR:')) return { __error: v.slice(0, 160) };
    ids.push(v);
  }
  const done: Record<string, string> = {};
  const t0 = Date.now();
  while (Object.keys(done).length < ids.length) {
    for (const ev of await takeEvents(app)) if (ids.includes(ev.taskId) && ev.status !== 'running') done[ev.taskId] = ev.status;
    if (Date.now() - t0 > timeoutMs) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return done;
}

/* ---------------- 主流程 ---------------- */
async function main(): Promise<void> {
  if (!fs.existsSync(APP_EXE) || !fs.existsSync(ENGINE)) throw new Error(`真实产物缺失,先跑 npm run dist(${APP_EXE})`);
  const WORK = mkTemp('tz-stab-');
  const ud = mkTemp('tz-stab-ud-');
  const app = spawnApp(APP_EXE, ud, await pickFreePort());
  await waitReady(app);
  await installEventCollector(app);
  await takeEvents(app); // 清掉启动期事件

  /* ---- STAB-01 大文件往返 + RSS 曲线 ---- */
  console.log('── STAB-01 大文件往返 ──');
  const MB_PER_GB = 1024;
  let bigMb = 4 * MB_PER_GB;
  // 需求 = 源 bigMb + 解出 bigMb + 归档余量 1.5GB;降档阶梯如实登记
  const ladder = [4096, 3072, 2048, 1024, 512];
  for (const cand of ladder) {
    if (checkFreeSpace(WORK, (cand * 2 + 1536) * 1024 * 1024)) { bigMb = cand; break; }
  }
  if (bigMb !== 4096) note(`磁盘余量不足 4GB 档,降档至 ${bigMb}MB`);
  const bigFile = path.join(WORK, 'big.bin');
  record({ id: 'STAB-00', item: '容量档位与磁盘余量', expect: '尽力 4GB,不足降档', actual: `bigMb=${bigMb} freeGB=${(fs.statfsSync(WORK).bsize * fs.statfsSync(WORK).bavail / 1073741824).toFixed(1)}`, verdict: 'note', detail: '半熵:256KB 随机块循环,可压缩且足够耗时' });
  const genT0 = Date.now();
  makeLowEntropy(bigFile, bigMb);
  const srcHash = sha256File(bigFile);
  note(`大文件生成 ${bigMb}MB 用时 ${((Date.now() - genT0) / 1000).toFixed(1)}s sha=${srcHash.slice(0, 12)}…`);

  const bigArc = path.join(WORK, 'big.7z');
  const bigOut = path.join(WORK, 'big-out');
  fs.mkdirSync(bigOut, { recursive: true });
  const watch = new RssWatch(app.proc.pid, pidsOf('7za.exe'));
  watch.start(1000);
  const rc = await runIpcTask(app, `window.tz.compress({sources:[${q(bigFile)}],output:${q(bigArc)},format:'7z',level:1,dict:'16m',solid:'on',multiThread:true})`, 25 * 60_000);
  const rx = rc.status === 'done'
    ? await runIpcTask(app, `window.tz.extract({archive:${q(bigArc)},dest:${q(bigOut)},overwrite:'overwrite'})`, 25 * 60_000)
    : { status: 'skipped', code: null, message: '压缩未成功', taskId: '' };
  watch.stop();
  const extracted = path.join(bigOut, 'big.bin');
  const bytesOk = rx.status === 'done' && fs.existsSync(extracted) && sha256File(extracted) === srcHash;
  const arcRatio = rc.status === 'done' && fs.existsSync(bigArc) ? (fs.statSync(bigArc).size / (bigMb * 1024 * 1024)).toFixed(3) : 'n/a';
  record({ id: 'STAB-01a', item: `${bigMb}MB 半熵文件 7z 压缩→解压往返`, expect: '全 done 且往返 sha256 一致', actual: `压缩=${rc.status} 解压=${rx.status} 字节一致=${bytesOk} 归档比=${arcRatio}`, verdict: bytesOk ? 'ok' : 'mismatch', detail: `code=${rc.code ?? rx.code ?? ''}` });
  const APP_RSS_CAP_MB = 1536, ENGINE_RSS_CAP_MB = 4096;
  const peakApp = watch.peak('appMb'), peakEngine = watch.peak('engineMb');
  record({ id: 'STAB-01b', item: `RSS 绝对红线(app<${APP_RSS_CAP_MB}MB / engine<${ENGINE_RSS_CAP_MB}MB,按 PID 归因)`, expect: '无失控式占用;平台形态由 01c 定容验证', actual: watch.summary(), verdict: peakApp >= 0 && peakApp < APP_RSS_CAP_MB && peakEngine < ENGINE_RSS_CAP_MB ? 'ok' : 'mismatch', detail: '每 1s 采样 tasklist 工作集;曲线随 stability-rss.json 落盘' });
  const t0curve = watch.samples[0]?.t ?? Date.now();
  fs.writeFileSync(path.join(path.resolve('docs/phase4'), 'stability-rss.json'), JSON.stringify({
    startedAt: new Date(t0curve).toISOString(),
    samples: watch.samples.map((s) => ({ ...s, t: s.t - t0curve })),
  }, null, 2), 'utf8');

  /* STAB-01c 对照定容:512MB 同参数压缩——若引擎峰值与 4GB 档同量级,则内存由
   * 配置(字典×线程)定档而非随文件尺寸线性增长,即"无失控"的实质判据 */
  const smallFile = path.join(WORK, 'small.bin');
  makeLowEntropy(smallFile, 512);
  const smallArc = path.join(WORK, 'small.7z');
  const watch2 = new RssWatch(app.proc.pid, pidsOf('7za.exe'));
  watch2.start(1000);
  const rc2 = await runIpcTask(app, `window.tz.compress({sources:[${q(smallFile)}],output:${q(smallArc)},format:'7z',level:1,dict:'16m',solid:'on',multiThread:true})`, 10 * 60_000);
  watch2.stop();
  const peakEngine512 = watch2.peak('engineMb');
  const ratio = peakEngine512 > 64 ? peakEngine / peakEngine512 : Infinity;
  /* 标度指数 α = ln(峰值比)/ln(容量比):α≥1 即线性失控,α<1 为亚线性增长(曲线平台形态另见 rss json) */
  const alpha = Number.isFinite(ratio) && ratio > 0 ? Math.log(ratio) / Math.log(bigMb / 512) : Infinity;
  record({ id: 'STAB-01c', item: '内存标度对照(512MB vs 4096MB 同参数压缩)', expect: 'α<1 ⇒ 内存不随尺寸线性增长(无失控);实测值如实登记', actual: `512MB档峰值=${peakEngine512}MB 4GB档峰值=${peakEngine}MB 比=${ratio.toFixed(2)} α=${alpha.toFixed(2)} 小档压缩=${rc2.status}`, verdict: rc2.status === 'done' && alpha < 1 ? 'ok' : 'mismatch', detail: `×${Math.round(bigMb / 512)} 容量→×${ratio.toFixed(1)} 引擎内存:亚线性但 4GB 档绝对峰值 ${peakEngine}MB 对低内存机器仍构成压力,登记为问题清单候选(资源防护按可用 RAM 限线程/字典)` });

  /* ---- STAB-02 长时间混合队列 ---- */
  console.log('── STAB-02 混合任务队列 ──');
  const SRC = path.join(WORK, 'q-src');
  fs.mkdirSync(SRC, { recursive: true });
  for (let i = 0; i < 8; i++) {
    const d = path.join(SRC, `d${i}`);
    fs.mkdirSync(d, { recursive: true });
    for (let k = 0; k < 4; k++) fs.writeFileSync(path.join(d, `f${k}.txt`), `${'稳定长跑样本-'.repeat(50)}${i}-${k}\n`);
  }
  const FORMATS = ['zip', '7z', 'tar.gz'] as const;
  const archives: string[] = [];
  let crashAt = -1, taskNo = 0, failStatus = '';
  for (let round = 0; round < 4 && crashAt < 0; round++) {
    const fmt = FORMATS[round % FORMATS.length];
    const arc = path.join(WORK, `q-r${round}.${fmt === 'tar.gz' ? 'tar.gz' : fmt}`);
    // C1 压缩
    const c = await runIpcTask(app, `window.tz.compress({sources:[${q(path.join(SRC, `d${round}`))}],output:${q(arc)},format:${q(fmt)},level:1,dict:'8m',solid:'on',multiThread:true})`, 120_000);
    taskNo++;
    if (c.status !== 'done') { crashAt = taskNo; failStatus = `compress=${c.status}:${c.code ?? ''}`; }
    archives.push(arc);
    // C2 解压
    const xd = path.join(WORK, `x-r${round}`);
    fs.mkdirSync(xd, { recursive: true });
    const x = await runIpcTask(app, `window.tz.extract({archive:${q(arc)},dest:${q(xd)},overwrite:'overwrite'})`, 120_000);
    taskNo++;
    if (x.status !== 'done') { crashAt = taskNo; failStatus = `extract=${x.status}:${x.code ?? ''}`; }
    // C3 测试
    const t = await runIpcTask(app, `window.tz.test(${q(arc)})`, 120_000);
    taskNo++;
    if (t.status !== 'done') { crashAt = taskNo; failStatus = `test=${t.status}:${t.code ?? ''}`; }
    // C4 删除(副本):仅 zip/7z — 引擎本就不能更新压缩 tar(format-matrix 已证),对 tar.gz 强行删除属探针预期错误
    if (fmt === 'zip' || fmt === '7z') {
      const delCopy = path.join(WORK, `del-r${round}.${fmt}`);
      fs.copyFileSync(arc, delCopy);
      const entry = await cdpListEntries(app, delCopy);
      if (entry.length) {
        const dr = await runIpcTask(app, `window.tz.deleteEntries(${q(delCopy)},[${q(entry[0])}])`, 120_000);
        taskNo++;
        if (dr.status !== 'done') { crashAt = taskNo; failStatus = `delete=${dr.status}:${dr.code ?? ''}:${(dr.message ?? '').slice(0, 80)}`; }
      }
    }
  }
  // C5 并发突发:先备好 3 个源目录,再同时点火 3 个压缩
  for (let i = 0; i < 3; i++) { fs.mkdirSync(path.join(SRC, `b${i}`), { recursive: true }); fs.writeFileSync(path.join(SRC, `b${i}`, 'x.txt'), '稳定长跑-突发样本-'.repeat(200)); }
  const burst = await runBurst(app, FORMATS.map((f, i) => 'window.tz.compress(' + JSON.stringify({
    sources: [path.join(SRC, 'b' + i)], output: path.join(WORK, `burst-${i}.${f === 'tar.gz' ? 'tar.gz' : f}`), format: f, level: 1, dict: '4m', solid: 'off', multiThread: true,
  }) + ')'), 180_000);
  taskNo += 3;
  const burstDetail = JSON.stringify(burst).slice(0, 300);
  const burstOk = !burst.__error && Object.keys(burst).length === 3 && Object.values(burst).every((s) => s === 'done');
  if (!burstOk && crashAt < 0) { crashAt = taskNo; failStatus = `burst=${burstDetail}`; }
  const alive = pidAlive(app.proc.pid);
  record({ id: 'STAB-02a', item: `混合队列连跑(${taskNo} 个任务:压缩/解压/测试/删除/并发突发)`, expect: '全 done 且应用无崩溃', actual: crashAt < 0 && alive ? `全部完成,进程存活` : `第 ${crashAt} 任务异常(${failStatus}) 存活=${alive}`, verdict: crashAt < 0 && alive ? 'ok' : 'mismatch', detail: `burst=${burstDetail}` });
  // 历史与产物一致:每个成功压缩归档在历史有 done 记录且磁盘文件存在;无 running 残留
  // (先给持久化一个稳定窗口:防 debounce 晚于事件终态落盘造成假残留)
  await new Promise((r) => setTimeout(r, 3000));
  const hist = histTasks(ud) as Array<{ id: string; status: string; kind?: string; out?: string }>;
  const histBreakdown = Object.entries(hist.reduce<Record<string, number>>((m, h) => { m[`${h.kind}/${h.status}`] = (m[`${h.kind}/${h.status}`] ?? 0) + 1; return m; }, {})).join(' ');
  const compressDone = hist.filter((h) => h.status === 'done');
  const missingArtifacts = archives.filter((a) => hist.some((h) => h.out === a) && !fs.existsSync(a));
  const runningResidue = hist.filter((h) => h.status === 'running' || h.status === 'queued');
  const histJsonOk = (() => { try { JSON.parse(fs.readFileSync(histFile(ud), 'utf8')); return true; } catch { return false; } })();
  record({ id: 'STAB-02b', item: '历史与产物一致:done 记录↔磁盘归档、无 running 残留、JSON 完好', expect: '一致', actual: `历史 ${hist.length} 条(done ${compressDone.length}) 缺失产物 ${missingArtifacts.length} running残留 ${runningResidue.length} JSON=${histJsonOk}`, verdict: missingArtifacts.length === 0 && runningResidue.length === 0 && histJsonOk ? 'ok' : 'mismatch', detail: `分布=[${histBreakdown}] 残留=${JSON.stringify(runningResidue.map((h) => ({ kind: h.kind, out: h.out }))).slice(0, 300)}` });
  record({ id: 'STAB-02c', item: '事务记账收尾干净', expect: 'txn 记录不增长(全提交/回滚)', actual: `txn=${txnRecords(ud).length} 条`, verdict: 'note', detail: '长跑期间事务生命周期参考' });

  await closeApp(app);

  /* ---- STAB-04 崩溃恢复:引用既有证据 ---- */
  record({ id: 'STAB-04', item: '异常退出后恢复', expect: '引用阶段 3.5 崩溃演练结论,不重做', actual: '五案例全过:本地 gate 6/6、CI run 38385301903 success', verdict: 'citation', detail: '证据见 docs/阶段3.5 崩溃演练报告与矩阵 STAB-04 行' });

  /* ---- 环境登记 ---- */
  record({ id: 'ENV', item: '长跑环境', expect: '如实记录', actual: `os=${os.type()} ${os.release()} arch=${os.arch()} 引擎=${path.relative(process.cwd(), ENGINE)}`, verdict: 'note', detail: `大文件档位 ${bigMb}MB` });

  writeOutJson('stability-results.json', {
    generatedAt: new Date().toISOString(), app: APP_EXE, engine: ENGINE, bigMb,
    findings, mismatchCount: findings.filter((f) => f.verdict === 'mismatch').length,
    rss: { peakAppMb: peakApp, peakEngineMb: peakEngine, samples: watch.samples.length },
  });
}

runProbe(main);
