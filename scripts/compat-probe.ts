/**
 * 阶段 4 · 交付物三 — 兼容性探测(npm run compat)
 *
 * 本机可自动实测项(其余格子在矩阵中如实标"待真机"):
 *  COMP-01 长路径 >260:深目录压缩/解压往返;超限失败必须报可读码、事务无残留、无半成品。
 *  COMP-02 Unicode/特殊字符文件名:中文/emoji/空格/连续点往返逐字节一致。
 *  COMP-03 保留名条目:手工构造 store 法 ZIP(con.txt/nul.bin/LPT9.log)—
 *         Windows 磁盘造不出这些文件,只能撕格式;应用必须"干净拒绝或替换落地",静默蒸发=失败。
 *  COMP-05 icacls 只读目标目录:解压必须干净失败(ERR 码可读)、journal 清零、无伪成功。
 *  COMP-12 重复启动 ×10(真实产物,优雅 winClose)+ userData 完好 + 二次实例移交。
 *  STAB-03 磁盘预检 guard 单元断言(checkFreeSpace 直连引擎模块)。
 *  COMP-04 权限证据:当前进程权限档位实测登记(本环境即普通用户档),核心链路可用性由以上各节证明。
 * 输出 docs/phase4/compat-results.json;任何不一致非零退出。
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assert, cdpEval, engineRun, histFile, histTasks, installEventCollector, killHard, mkTemp,
  pidAlive, pickFreePort, q, runIpcTask, runProbe, spawnApp, txnFile, txnRecords, waitFor,
  appListArchive, waitReady, writeOutJson, type ProbeApp,
} from './probe-lib';
import { checkFreeSpace } from '../electron/engine';

const ENGINE = (() => {
  const u = path.resolve('release/win-unpacked/resources/engine/7za.exe');
  return fs.existsSync(u) ? u : path.resolve('engine/7za.exe');
})();
const APP_EXE = path.resolve('release/win-unpacked/TongZip.exe');

interface Finding { id: string; item: string; expect: string; actual: string; verdict: 'ok' | 'mismatch' | 'note' | 'pending-real'; detail: string }
const findings: Finding[] = [];
function record(f: Finding): void {
  findings.push(f);
  const line = `[${f.id}] 期望=${f.expect} 实际=${f.actual} :: ${f.detail.slice(0, 150)}`;
  if (f.verdict === 'mismatch') assert(false, line);
  else if (f.verdict === 'ok') console.log('  ✓', line);
  else if (f.verdict === 'pending-real') console.log('  ◻', line);
  else console.log('  ·', line);
}

const LP = (p: string) => (path.isAbsolute(p) ? '\\\\?\\' + p : p);
function forceMkdirWin(p: string): void { fs.mkdirSync(LP(p), { recursive: true }); }
/** 逐段加深直到 join(dir, 文件名) 超过 targetLen(默认 270 > MAX_PATH) */
function buildDeep(baseDir: string, targetLen = 270): string {
  let d = baseDir, i = 0;
  forceMkdirWin(d);
  while (path.join(d, 'x.txt').length < targetLen) { d = path.join(d, `长路径段-LP${i++}-0123456789abcdef`); forceMkdirWin(d); }
  return d;
}
function walkLong(dir: string): string[] {
  const out: string[] = [];
  let es: fs.Dirent[];
  try { es = fs.readdirSync(LP(dir), { withFileTypes: true }); } catch { return out; }
  for (const e of es) { const p = path.join(dir, e.name); if (e.isDirectory()) out.push(...walkLong(p)); else out.push(p); }
  return out;
}
const readFileLong = (f: string) => fs.readFileSync(LP(f));
const readable = (s: string | null) => !!s && s.trim().length > 0 && !s.includes('\uFFFD');

/* ---------- 手工 store 法 ZIP(条目名任意,含保留名) ---------- */
const CRC_T = (() => { const t = new Int32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c; } return t; })();
function crc32(b: Buffer): number { let c = -1; for (const x of b) c = (c >>> 8) ^ CRC_T[(c ^ x) & 0xff]; return (c ^ -1) >>> 0; }
function buildStoreZip(entries: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = []; const cents: Buffer[] = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'); const crc = crc32(e.data); const sz = e.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x0021, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(sz, 18); lh.writeUInt32LE(sz, 22);
    lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, e.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x0021, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(sz, 20); ch.writeUInt32LE(sz, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    cents.push(ch, name);
    off += 30 + name.length + sz;
  }
  const cd = Buffer.concat(cents);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

/** 优雅关窗(winClose 的 invoke 回复随窗口销毁会丢,取火不管) */
async function closeApp(app: ProbeApp): Promise<void> {
  try { await cdpEval(app, `void window.tz.winClose(); 'bye'`, 5000); } catch { /* 渲染层先走属正常 */ }
  await waitFor('应用进程退出', () => !pidAlive(app.proc.pid), 15000, 100).catch(() => killHard(app.proc.pid));
}
function checkUserData(ud: string): { tasks: number; corrupt: boolean } {
  for (const f of [histFile(ud), txnFile(ud)]) {
    if (fs.existsSync(f)) {
      try { JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return { tasks: -1, corrupt: true }; }
    }
  }
  return { tasks: histTasks(ud).length, corrupt: false };
}

/* ---------------- 主流程 ---------------- */
async function main(): Promise<void> {
  console.log(`引擎: ${ENGINE}`);
  if (!fs.existsSync(APP_EXE)) throw new Error(`真实产物缺失(${APP_EXE}):compat-probe 全部围绕应用层,先跑 npm run dist`);
  const WORK = mkTemp('tz-compat-');
  const SRC = path.join(WORK, 'src'); const ARC = path.join(WORK, 'arc'); const X = path.join(WORK, 'x');
  forceMkdirWin(SRC); forceMkdirWin(ARC); forceMkdirWin(X);

  /* ---- 环境证据(权限档位权威判定 + 长路径开关) ---- */
  console.log('── 环境证据 ──');
  let whoamiGroups = '';
  try { whoamiGroups = execFileSync('whoami', ['/groups'], { encoding: 'utf8', timeout: 10000 }); } catch { /* noop */ }
  const elevated = /High Mandatory Level|高强制级别|S-1-16-12288/.test(whoamiGroups) ? 'yes(High IL)'
    : /Medium Mandatory Level|中强制级别|S-1-16-8192/.test(whoamiGroups) ? 'no(Medium IL)' : 'unknown';
  let winDirWritable = 'unknown';
  try { fs.accessSync(process.env.SystemRoot ?? 'C:\\Windows', fs.constants.W_OK); winDirWritable = 'yes'; } catch { winDirWritable = 'no'; }
  let longPathReg = 'unknown';
  try {
    const rq = execFileSync('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', '/v', 'LongPathsEnabled'], { encoding: 'utf8', timeout: 10000 });
    longPathReg = /0x1\b/.test(rq) ? 'enabled' : /0x0\b/.test(rq) ? 'disabled' : 'unknown';
  } catch { /* 查询失败按未知 */ }
  record({ id: 'ENV', item: '执行环境登记', expect: '如实记录', actual: `os=${os.release()} arch=${os.arch()} 权限=${elevated} 系统目录可写=${winDirWritable} LongPaths=${longPathReg}`, verdict: 'note', detail: elevated.startsWith('yes') ? '实测为提升档:计划假设“本环境非提升”不成立,COMP-04 普通用户档改判待真机' : '矩阵总原则:本环境 Win11 x64 单机;提升/其他版本标待真机' });
  const pendingReal = (id: string, item: string, checklist: string) => record({ id, item, expect: '真机验收', actual: '本机不可测', verdict: 'pending-real', detail: checklist });

  /* ---- 起应用(全部功能项共用一个实例) ---- */
  const ud = mkTemp('tz-compat-ud-');
  const app = spawnApp(APP_EXE, ud, await pickFreePort());
  await waitReady(app);
  await installEventCollector(app);
  const txnBase = txnRecords(ud).length;

  /* ---- COMP-01 长路径压缩往返 ---- */
  console.log('── COMP-01 长路径 ──');
  {
    const deep = buildDeep(path.join(WORK, 'deep-src'));
    const deepFile = path.join(deep, '深路径样本.bin');
    const payload = crypto.randomBytes(65_536);
    fs.writeFileSync(LP(deepFile), payload);
    const deepLen = deepFile.length;
    const out = path.join(ARC, 'long.zip');
    const rc = await runIpcTask(app, `window.tz.compress({sources:[${q(deepFile)}],output:${q(out)},format:'zip',level:1,dict:'',solid:'off',multiThread:false})`);
    if (rc.status === 'done' && fs.existsSync(out)) {
      const xd = path.join(X, 'long-out'); forceMkdirWin(xd);
      const rx = await runIpcTask(app, `window.tz.extract({archive:${q(out)},dest:${q(xd)},overwrite:'overwrite'})`);
      const got = walkLong(xd).find((f) => f.endsWith('深路径样本.bin'));
      const bytesOk = rx.status === 'done' && !!got && readFileLong(got).equals(payload);
      record({ id: 'COMP-01a', item: `长路径(${deepLen}字符)压缩+解压往返`, expect: 'done 且逐字节一致', actual: `压缩=${rc.status} 解压=${rx.status} 字节=${bytesOk}`, verdict: bytesOk ? 'ok' : 'mismatch', detail: `longPathsReg=${longPathReg} 解压终态=${JSON.stringify({ code: rx.code, message: (rx.message ?? '').slice(0, 160), taskId: rx.taskId })}` });
    } else if (rc.status === 'error' || rc.status === 'ipc_error') {
      const half = fs.existsSync(out);
      record({ id: 'COMP-01a', item: `长路径(${deepLen}字符)压缩超限`, expect: '干净失败:可读错误+无半成品', actual: `status=${rc.status} code=${rc.code} 半成品=${half}`, verdict: !half && readable(rc.message) ? 'ok' : 'mismatch', detail: (rc.message ?? '').slice(0, 120) });
    } else {
      record({ id: 'COMP-01a', item: '长路径压缩', expect: 'done 或干净失败', actual: JSON.stringify(rc).slice(0, 120), verdict: 'mismatch', detail: '既非成功也非明确失败(伪成功/挂起/无终态)' });
    }
    /* 解压落地到深目录:单独造一个普通长度归档再解进去 */
    const flat = path.join(SRC, 'flat.bin'); const flatPayload = crypto.randomBytes(32_768);
    fs.writeFileSync(flat, flatPayload);
    const out2 = path.join(ARC, 'flat.zip');
    engineRun(ENGINE, ['a', '-y', '-tzip', out2, flat], 60000);
    const deepDest = buildDeep(path.join(WORK, 'deep-dest'));
    if (fs.existsSync(out2)) {
      const rx2 = await runIpcTask(app, `window.tz.extract({archive:${q(out2)},dest:${q(deepDest)},overwrite:'overwrite'})`);
      if (rx2.status === 'done') {
        const got2 = walkLong(deepDest).find(() => true);
        const okB = !!got2 && readFileLong(got2).equals(flatPayload);
        record({ id: 'COMP-01b', item: `解压落地到长路径目录(${deepDest.length}字符)`, expect: 'done 且字节一致', actual: `status=${rx2.status} 字节=${okB}`, verdict: okB ? 'ok' : 'mismatch', detail: '' });
      } else {
        const leftovers = walkLong(deepDest).length;
        record({ id: 'COMP-01b', item: '解压到长路径目录超限', expect: '干净失败+可读错误+目标目录无冒充产物', actual: `status=${rx2.status} code=${rx2.code} 残留=${leftovers}`, verdict: readable(rx2.message) && leftovers === 0 ? 'ok' : 'mismatch', detail: (rx2.message ?? '').slice(0, 120) });
      }
    } else record({ id: 'COMP-01b', item: '引擎基线归档缺失', actual: '未测', expect: '—', verdict: 'note', detail: 'flat.zip 引擎创建失败,前置异常' });
  }

  /* ---- COMP-02 Unicode/特殊字符 ---- */
  console.log('── COMP-02 Unicode 文件名 ──');
  {
    const udir = path.join(SRC, 'uni'); forceMkdirWin(udir);
    const names = ['中文报告-季度汇总.txt', 'emoji 🚀🌈 火焰.bin', '  前后空格  .log', '多重.点.点.final.txt', 'Ñoño ümlaütoï.dat', 'Mix中-eng文123.txt'];
    const contentOf = new Map<string, Buffer>();
    names.forEach((n, i) => { const b = Buffer.from(`tz-compat-${i}-`.repeat(32) + n, 'utf8'); fs.writeFileSync(path.join(udir, n), b); contentOf.set(n, b); });
    const out = path.join(ARC, 'uni.zip');
    const rc = await runIpcTask(app, `window.tz.compress({sources:[${q(udir)}],output:${q(out)},format:'zip',level:1,dict:'',solid:'off',multiThread:false})`);
    if (rc.status === 'done' && fs.existsSync(out)) {
      const le = await appListArchive(app, out);
      const xd = path.join(X, 'uni'); forceMkdirWin(xd);
      const rx = await runIpcTask(app, `window.tz.extract({archive:${q(out)},dest:${q(xd)},overwrite:'overwrite'})`);
      const landed = walkLong(xd);
      let byteOk = 0; const missing: string[] = [];
      for (const n of names) {
        const got = landed.find((f) => path.basename(f) === n);
        if (got && readFileLong(got).equals(contentOf.get(n)!)) byteOk++; else missing.push(n);
      }
      const allOk = rx.status === 'done' && byteOk === names.length;
      record({ id: 'COMP-02', item: '中文/emoji/空格/连续点文件名往返', expect: `列表 ${names.length} 项 + 全部逐字节一致`, actual: `list=${le.entries} extract=${rx.status} 字节一致=${byteOk}/${names.length}`, verdict: allOk ? 'ok' : 'mismatch', detail: missing.length ? `缺失/不一致: ${missing.join(' | ')}` : '' });
    } else {
      record({ id: 'COMP-02', item: 'Unicode 文件名压缩', expect: 'done(特殊字符名必须可压缩)', actual: `status=${rc.status} code=${rc.code} msg=${(rc.message ?? '').slice(0, 80)}`, verdict: 'mismatch', detail: '中文/emoji/空格名导致任务失败属产品缺陷' });
    }
  }

  /* ---- COMP-03 保留名条目(手工 store ZIP) ---- */
  console.log('── COMP-03 保留名条目 ──');
  {
    const rz = path.join(ARC, 'reserved.zip');
    fs.writeFileSync(rz, buildStoreZip([
      { name: 'con.txt', data: Buffer.from('reserved-con-payload') },
      { name: 'nul.bin', data: Buffer.from('reserved-nul-payload') },
      { name: 'LPT9.log', data: Buffer.from('reserved-lpt9-payload') },
      { name: 'com1.dat', data: Buffer.from('reserved-com1-payload') },
      { name: 'ok.txt', data: Buffer.from('normal-entry-payload') },
    ]));
    const le = await appListArchive(app, rz);
    record({ id: 'COMP-03-list', item: '保留名条目 ZIP 列目录', expect: '可列(纯内存解码不受文件系统限制)', actual: le.ok ? `open(${le.type}, ${le.entries}项)` : `ERR:${le.code}`, verdict: le.ok ? 'ok' : 'mismatch', detail: '列不出则用户无从知道包里有这些条目' });
    const xd = path.join(X, 'reserved'); forceMkdirWin(xd);
    const rx = await runIpcTask(app, `window.tz.extract({archive:${q(rz)},dest:${q(xd)},overwrite:'overwrite'})`);
    const landed = walkLong(xd);
    if (rx.status === 'done') {
      /* done 只有一种诚实形态:保留名被替换落地(≥5 个条目痕迹);1 个条目=其余静默蒸发 */
      const replaced = landed.filter((f) => /con|nul|lpt|com/i.test(path.basename(f)) && path.basename(f) !== 'ok.txt');
      const silentLost = le.ok && (le.entries ?? 5) - landed.length >= 2 && replaced.length === 0;
      record({ id: 'COMP-03-ext', item: '保留名条目解压', expect: '替换落地(可接受)或拒绝/失败(可接受),静默丢失不可接受', actual: `done 落地${landed.length}个/包内${le.entries ?? '?'}个,替换痕迹${replaced.length}`, verdict: silentLost ? 'mismatch' : 'note', detail: silentLost ? '保留名条目无声消失,用户不知情' : `落地清单=${landed.map((f) => path.basename(f)).join(',')}`.slice(0, 200) });
    } else if (rx.status === 'error' || rx.status === 'ipc_error') {
      const hasOk = landed.some((f) => path.basename(f) === 'ok.txt');
      record({ id: 'COMP-03-ext', item: '保留名条目解压拦截', expect: '干净失败+可读错误(UNSAFE_PATH 类)', actual: `code=${rx.code} 落地=${landed.length}个 ok.txt=${hasOk}`, verdict: readable(rx.message) ? 'ok' : 'mismatch', detail: (rx.message ?? '').slice(0, 120) });
    } else {
      record({ id: 'COMP-03-ext', item: '保留名条目解压', expect: '明确终态', actual: `status=${rx.status}`, verdict: 'mismatch', detail: JSON.stringify(rx).slice(0, 140) });
    }
  }

  /* ---- COMP-05 只读目标目录(icacls) ---- */
  console.log('── COMP-05 写权限缺失 ──');
  {
    const roArc = path.join(ARC, 'ro.zip');
    fs.writeFileSync(path.join(SRC, 'ro-a.txt'), 'AAAA'.repeat(2048));
    fs.writeFileSync(path.join(SRC, 'ro-b.txt'), 'BBBB'.repeat(2048));
    engineRun(ENGINE, ['a', '-y', '-tzip', roArc, path.join(SRC, 'ro-a.txt'), path.join(SRC, 'ro-b.txt')], 60000);
    const dest = path.join(X, 'readonly'); forceMkdirWin(dest);
    try {
      execFileSync('icacls', [dest, '/inheritance:r', '/grant:r', '*S-1-1-0:(OI)(CI)RX'], { stdio: 'pipe', timeout: 15000 });
      const rx = await runIpcTask(app, `window.tz.extract({archive:${q(roArc)},dest:${q(dest)},overwrite:'overwrite'})`);
      const landed = walkLong(dest);
      const fakeDone = rx.status === 'done' && landed.length < 2;
      const cleanFail = (rx.status === 'error' || rx.status === 'ipc_error') && readable(rx.message);
      record({ id: 'COMP-05', item: '只读目录解压(icacls 去写权)', expect: '干净失败:ERR 码可读、无半成品冒充成功', actual: `status=${rx.status} code=${rx.code} 落地=${landed.length}/2`, verdict: fakeDone ? 'mismatch' : cleanFail ? 'ok' : rx.status === 'done' && landed.length === 2 ? 'mismatch' : 'mismatch', detail: rx.status === 'done' && landed.length === 2 ? 'ACL 未生效或权限判定异常:只读目录竟写入成功,前置证据存疑' : (rx.message ?? '').slice(0, 120) });
      try { execFileSync('icacls', [dest, '/reset', '/t', '/c'], { stdio: 'ignore', timeout: 15000 }); } catch { /* 清理兜底交给 rmRecursive */ }
    } catch (e) {
      record({ id: 'COMP-05', item: 'icacls 可用性', actual: `执行失败:${String(e).slice(0, 80)}`, expect: '—', verdict: 'note', detail: '工具不可用则该格转真机人工,不假装' });
    }
  }

  /* ---- 事务 journal 全程零增长(以上均为普通压缩/解压,不应产生事务记录) ---- */
  const txnNow = txnRecords(ud).length;
  record({ id: 'COMP-TXN', item: '常规压缩/解压全程事务 journal', expect: `零增长(基线 ${txnBase})`, actual: `当前 ${txnNow}`, verdict: txnNow === txnBase ? 'ok' : 'mismatch', detail: '残留事务=半成品冒充/回滚链未收口的信号' });

  /* ---- COMP-04 核心链路权限档 ---- */
  {
    const coreWorks = findings.filter((f) => f.id.startsWith('COMP-01') || f.id === 'COMP-02' || f.id === 'COMP-03-ext').some((f) => f.verdict === 'ok' && /往返|拦截|一致|干净/.test(f.item + f.actual));
    if (elevated.startsWith('yes')) {
      record({ id: 'COMP-04', item: '普通用户(非提升)权限档核心链路', expect: '压缩/解压/列表/任务事件全部可用', actual: `本探针进程=${elevated},全部实测均在提升档完成`, verdict: 'pending-real', detail: '如实改判:提升档证据不代替普通档;手工步骤-以标准用户登录运行安装版,核心链路+右键菜单全过;另注:文件关联写 HKCU 在普通档才能代表真实用户态' });
    } else {
      record({ id: 'COMP-04', item: `非提升权限(证据:${elevated})下核心链路`, expect: '压缩/解压/列表/任务事件全部可用', actual: `权限档=${elevated} 核心链路跑通=${coreWorks}`, verdict: coreWorks ? 'ok' : 'note', detail: '本节全部实测即在当前权限档完成' });
    }
  }

  /* ---- COMP-12 重复启动 ×10 + userData 完好 ---- */
  console.log('── COMP-12 重复启动 ──');
  await closeApp(app); // 第 0 次优雅退出(前面已算一次完整使用)
  const tasksBefore = checkUserData(ud);
  let cyclesOk = 0; let corruptAt = -1; let stuckAt = -1;
  for (let i = 1; i <= 10; i++) {
    const p = await pickFreePort();
    const cyc = spawnApp(APP_EXE, ud, p);
    try {
      await waitReady(cyc);
      cyclesOk++;
    } catch { stuckAt = stuckAt < 0 ? i : stuckAt; }
    await closeApp(cyc);
    const chk = checkUserData(ud);
    if (chk.corrupt && corruptAt < 0) corruptAt = i;
    if (pidAlive(cyc.proc.pid)) { assert(false, `COMP-12 第${i}轮退出后进程仍存活(孤儿)`); }
  }
  const tasksAfter = checkUserData(ud);
  record({ id: 'COMP-12a', item: '真实产物连续启动/退出 ×10(共用 userData)', expect: '10/10 就绪 + JSON 全程完好 + 无孤儿', actual: `就绪 ${cyclesOk}/10 损坏轮=${corruptAt < 0 ? '无' : corruptAt} 卡死轮=${stuckAt < 0 ? '无' : stuckAt}`, verdict: cyclesOk === 10 && corruptAt < 0 && stuckAt < 0 ? 'ok' : 'mismatch', detail: `任务数 ${tasksBefore.tasks} → ${tasksAfter.tasks}(历史跨重启保留)` });
  record({ id: 'COMP-12b', item: 'userData 跨 10 次冷启动完好', expect: 'tongzip-history.json 可解析且任务记录不丢', actual: `corrupt=${tasksAfter.corrupt} tasks=${tasksAfter.tasks}`, verdict: !tasksAfter.corrupt && tasksAfter.tasks >= Math.max(1, tasksBefore.tasks) ? 'ok' : 'mismatch', detail: '' });

  /* ---- COMP-12c 二次实例移交 ---- */
  {
    const pA = await pickFreePort();
    const a = spawnApp(APP_EXE, ud, pA);
    await waitReady(a);
    const pB = await pickFreePort();
    const b = spawnApp(APP_EXE, ud, pB); // 同一 userData:单实例锁应让 B 自行退出
    let bExitCode: number | null = null;
    try { await waitFor('二次实例自行退出', () => { const c = b.proc.exitCode; if (c !== null && c !== undefined) { bExitCode = c; return true; } return !pidAlive(b.proc.pid); }, 20000, 100); } catch { /* 未退出 */ }
    const aAlive = pidAlive(a.proc.pid);
    record({ id: 'COMP-12c', item: '同 userData 二次启动移交', expect: '第二实例自行退出、首实例存活并收到移交', actual: `B退出=${bExitCode ?? (pidAlive(b.proc.pid) ? '未退出' : 'code?')} A存活=${aAlive}`, verdict: bExitCode === 0 && aAlive ? 'ok' : bExitCode !== null && aAlive ? 'note' : 'mismatch', detail: bExitCode === null && !pidAlive(b.proc.pid) ? 'B 消失但退出码未捕获' : '' });
    await closeApp(a);
  }

  /* ---- STAB-03 guard 单元断言(checkFreeSpace 直连) ---- */
  {
    const small = checkFreeSpace(WORK, 1024);
    const huge = checkFreeSpace(WORK, 1e15);
    record({ id: 'STAB-03u', item: '磁盘空间预检 guard 单元', expect: '小需求=true 1PB 需求=false', actual: `small=${small} huge=${huge}`, verdict: small === true && huge === false ? 'ok' : 'mismatch', detail: '真实填满磁盘全链路 → 待真机' });
  }

  /* ---- 待真机格子(验收标准即手工步骤) ---- */
  pendingReal('COMP-06', '管理员权限运行', '右键以管理员运行:压缩/解压/关联写入 HKLM/更新自检全过一遍');
  pendingReal('COMP-07', 'Windows 10 各主流版本', '1809/21H2/22H2:安装+启动+Win10 经典右键+全格式往返');
  pendingReal('COMP-08b', 'Win11 新版右键菜单(SubCommands)', '本机已 Win11:设置项/注册表键存在性自动测过,肉眼菜单核对待人工');
  pendingReal('COMP-09', '网络盘/NAS(SMB)与断连恢复', 'SMB 映射盘压缩解压;任务进行中拔网线/断服务:必须干净失败或可恢复,无伪成功');
  pendingReal('COMP-10', 'U 盘 exFAT/FAT32', 'FAT32 单文件 >4GB 预检提示;非法字符/保留名降级策略透明');
  pendingReal('COMP-11', 'ARM64 设备', '原生 ARM64 构建 + ARM64 引擎;本机构建为 x64 不适用');
  pendingReal('COMP-13', '文件被占用时压缩/解压', 'libuv 共享读模式使 Node 侧无法可靠制造独占锁;真机用资源监视器/其他独占进程人工验证:干净失败+原档完好');
  pendingReal('STAB-03r', '磁盘真实填满', '小容量盘填满后解压/压缩:SPACE_LOW 提示且原数据未触碰');

  writeOutJson('compat-results.json', {
    generatedAt: new Date().toISOString(), engine: ENGINE, app: APP_EXE,
    env: { os: `${os.type()} ${os.release()}`, arch: os.arch(), elevated, longPathReg: longPathReg },
    findings, mismatchCount: findings.filter((f) => f.verdict === 'mismatch').length,
    pendingReal: findings.filter((f) => f.verdict === 'pending-real').map((f) => f.id),
  });
  console.log(`\n矩阵记录 ${findings.length} 项;不一致 ${findings.filter((f) => f.verdict === 'mismatch').length};待真机 ${findings.filter((f) => f.verdict === 'pending-real').length}`);
}

runProbe(main);
