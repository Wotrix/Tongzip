/**
 * TongZip 引擎层 — 封装 7z 命令行核心的调用、进度解析与任务管理
 *
 * 设计取向:
 * - 不依赖任何原生压缩绑定,统一通过子进程调用 7z.exe,能力与 NanaZip/7-Zip 内核一致;
 * - 每个任务有稳定 taskId,复合任务(tar.gz 等)内部多阶段共用同一 id,可整体取消;
 * - 输出解析容错:密码错误/缺分卷/磁盘满/格式不可识别均有语义化错误。
 */
import { spawn, execFile, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ArchiveEntry,
  ArchiveFormat,
  ArchiveInfo,
  CompressJob,
  EngineInfo,
  EntryPreview,
  ExtractJob,
  GuardLimits,
  JobKind,
  ProgressEvent,
} from '../shared/types';
import { DEFAULT_GUARD, ERR, isArchiveExt, isCreatableFormat, ZIP_PW_OK } from '../shared/types';

/* ------------------------------------------------------------------ */
/* 引擎定位                                                            */
/* ------------------------------------------------------------------ */

export function isArchivePath(p: string): boolean {
  const base = path.basename(p).toLowerCase();
  const ext = path.extname(base).slice(1);
  if (isArchiveExt(ext)) return true;
  return /^.+\.7z\.\d{3}$/.test(base) || /^.+\.r\d{2}$/.test(base) || /\.part\d+\.rar$/.test(base);
}

interface Located { exe: string; source: EngineInfo['source'] }
let cachedEngine: Located | null = null;

function engineCandidates(): Located[] {
  const list: Located[] = [];
  const res = process.resourcesPath ?? path.join(__dirname, '..', '..',);
  const names = ['7z.exe', '7za.exe'];
  for (const n of names) {
    list.push({ exe: path.join(res, 'engine', n), source: 'bundled' });
    list.push({ exe: path.join(res, 'app.asar.unpacked', 'engine', n), source: 'bundled' });
    list.push({ exe: path.join(__dirname, '..', 'engine', n), source: 'bundled' });
    list.push({ exe: path.join(process.cwd(), 'engine', n), source: 'bundled' });
  }
  const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  list.push({ exe: path.join(pf, '7-Zip', '7z.exe'), source: 'system' });
  list.push({ exe: path.join(pf86, '7-Zip', '7z.exe'), source: 'system' });
  list.push({ exe: '7z.exe', source: 'system' });
  return list;
}

function probe(exe: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(exe, ['i'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

export class EngineError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export async function detectEngine(manual?: string | null): Promise<EngineInfo> {
  if (manual && fs.existsSync(manual)) {
    try {
      const out = await probe(manual);
      cachedEngine = { exe: manual, source: 'manual' };
      return infoFrom(out, manual, 'manual');
    } catch { /* 手动路径无效,回退自动检测 */ }
  }
  for (const c of engineCandidates()) {
    if (c.exe.includes(path.sep) && !fs.existsSync(c.exe)) continue;
    try {
      const out = await probe(c.exe);
      cachedEngine = c;
      return infoFrom(out, c.exe, c.source);
    } catch { /* 继续下一个候选 */ }
  }
  throw new EngineError(
    ERR.ENGINE_MISSING,
    '未找到压缩引擎。请安装 7-Zip,或在设置中手动指定 7z.exe 路径。',
  );
}

function infoFrom(stdout: string, exe: string, source: EngineInfo['source']): EngineInfo {
  const m = stdout.match(/7-?Zip(?:\s*\([a-zA-Z]\))?\s+([0-9][0-9a-zA-Z.]*)/i);
  return { path: exe, version: m ? m[1] : '未知', source };
}

function engineExe(): string {
  if (!cachedEngine) throw new EngineError(ERR.ENGINE_MISSING, '压缩引擎未就绪,请先检测引擎。');
  return cachedEngine.exe;
}

/* ------------------------------------------------------------------ */
/* 进程运行器 + 任务表                                                 */
/* ------------------------------------------------------------------ */

/**
 * 7za 重定向到管道时用系统 OEM 代码页(中文 Windows = CP936/GBK)输出文件名,
 * 部分版本/区域则输出 UTF-8。统一策略:严格 UTF-8 失败则按 GBK 解码,
 * 避免固定 utf8 读取导致中文条目名变 U+FFFD(乱码 + 解压选中条目匹配不到)。
 */
const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const gbkDecoder = new TextDecoder('gbk');
function decodeEngineOutput(b: Buffer): string {
  if (!b.length) return '';
  try { return utf8Strict.decode(b); } catch { return gbkDecoder.decode(b); }
}

type ProgressFn = (ev: ProgressEvent) => void;

interface TaskHandle {
  proc: ChildProcess | null;
  cancelled: boolean;
  paused?: boolean;
}
const tasks = new Map<string, TaskHandle>();

function runStep(
  handle: TaskHandle,
  taskId: string,
  kind: JobKind,
  args: string[],
  onProgress: ProgressFn,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcess;
    try {
      proc = spawn(engineExe(), args, { windowsHide: true });
    } catch (e) { reject(e); return; }
    /* 必须立即关闭 stdin:加密包缺密码时引擎会打"Enter password"并阻塞等输入;
       管道常开=任务永挂,关闭(EOF)则引擎以空密码继续→快速失败(实测 255/2) */
    proc.stdin?.end();
    handle.proc = proc;

    /* 引擎输出按字节累积、按行切分后逐行解码,避免多字节字符被 chunk 截断 */
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let pending = Buffer.alloc(0);
    let currentFile = '';
    let percent = -1;

    proc.stdout?.on('data', (chunk: Buffer) => {
      outChunks.push(chunk);
      pending = Buffer.concat([pending, chunk]);
      let idx: number;
      while ((idx = pending.indexOf(0x0a)) >= 0) {
        const lineBuf = pending.subarray(0, idx);
        pending = pending.subarray(idx + 1);
        const line = decodeEngineOutput(lineBuf).replace(/\r$/, '');
        const t = line.trim();
        const pm = t.match(/^(\d{1,3})%/);
        if (pm) {
          percent = Math.min(100, parseInt(pm[1], 10));
          const rest = t.slice(pm[0].length).trim();
          if (rest) currentFile = rest;
        }
        onProgress({ taskId, kind, percent, file: currentFile, log: line, status: 'running' });
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => { errChunks.push(chunk); });
    proc.on('error', (err) => {
      handle.proc = null;
      reject(err);
    });
    proc.on('close', (code) => {
      handle.proc = null;
      if (pending.length) onProgress({ taskId, kind, percent, file: currentFile, log: decodeEngineOutput(pending), status: 'running' });
      const stdout = decodeEngineOutput(Buffer.concat(outChunks));
      const stderr = decodeEngineOutput(Buffer.concat(errChunks));
      resolve({ code: code ?? 0, stdout: stdout + (stderr ? `\n${stderr}` : '') });
    });
  });
}

export function cancelTask(taskId: string): boolean {
  const h = tasks.get(taskId);
  if (!h) return false;
  h.cancelled = true;
  // 挂起的进程收不到信号,取消前先恢复再继续终止流程(异步失败无需处理,随后 SIGKILL 兜底)
  if (h.paused && h.proc?.pid) {
    Promise.resolve(setProcessSuspended(h.proc.pid, false)).catch(() => { /* 尽力而为 */ });
    h.paused = false;
  }
  h.proc?.kill('SIGKILL');
  return true;
}

/** Windows:通过 PowerShell 调用 ntdll 挂起/恢复目标进程 */
async function setProcessSuspended(pid: number, suspend: boolean): Promise<void> {
  // 实测:静态类型名与 -PassThru 变量仅在 -File 脚本内跨语句可靠(-Command 在 PS5.1/7 行为不一致),
  // 故将脚本落盘后用 -File 执行,退出码即 NTSTATUS(0=成功)。
  // 文件名含随机后缀:固定可预测名存在被预占替换(TOCTOU)风险,也避免并发挂起/恢复互踩。
  const cs = [
    'using System;using System.Runtime.InteropServices;',
    'public static class TZSuspend{',
    '[DllImport("ntdll.dll")]public static extern int NtSuspendProcess(IntPtr h);',
    '[DllImport("ntdll.dll")]public static extern int NtResumeProcess(IntPtr h);',
    '[DllImport("kernel32.dll")]public static extern IntPtr OpenProcess(int a,bool i,int p);',
    '[DllImport("kernel32.dll")]public static extern bool CloseHandle(IntPtr h);',
    'public static int Go(int pid,bool s){IntPtr h=OpenProcess(0x1F0FFF,false,pid);if(h==IntPtr.Zero)return 1;',
    'int r=s?NtSuspendProcess(h):NtResumeProcess(h);CloseHandle(h);return r;}',
    '}',
  ].join('');
  const scriptPath = path.join(os.tmpdir(), 'TongZip', `suspend-${pid}-${randomUUID().slice(0, 8)}.ps1`);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  const body = [
    `$t=Add-Type -PassThru -TypeDefinition '${cs.replace(/'/g, "''")}'`,
    `$rc = &$t::Go(${pid},${suspend ? '$true' : '$false'});`,
    'exit $rc',
  ].join('\r\n');
  fs.writeFileSync(scriptPath, body, 'utf8');
  const run = (exe: string) => new Promise<void>((resolve, reject) => {
    execFile(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
  try {
    await run('pwsh.exe').catch(() => run('powershell.exe'));
  } finally {
    try { fs.unlinkSync(scriptPath); } catch { /* 清理失败无碍 */ }
  }
}

/** 暂停/恢复任务(进程级挂起,再次调用即恢复),返回切换后的暂停状态 */
export async function pauseTask(taskId: string): Promise<boolean> {
  const h = tasks.get(taskId);
  const pid = h?.proc?.pid;
  if (!h || !pid) return false;
  const wantSuspend = !h.paused;
  if (process.platform === 'win32') {
    await setProcessSuspended(pid, wantSuspend);
  } else {
    process.kill(pid, wantSuspend ? 'SIGSTOP' : 'SIGCONT');
  }
  h.paused = wantSuspend;
  return h.paused;
}

/** 任务启动即发初始 running 事件:不等 7za 首行输出,任务窗口/快照开窗即有卡 */
function emitStart(taskId: string, kind: JobKind, onProgress: ProgressFn) {
  onProgress({ taskId, kind, percent: -1, file: '', status: 'running' });
}
function emitDone(taskId: string, kind: JobKind, onProgress: ProgressFn, message: string) {
  onProgress({ taskId, kind, percent: 100, file: '', status: 'done', message });
}
function emitError(taskId: string, kind: JobKind, onProgress: ProgressFn, message: string, code?: string) {
  onProgress({ taskId, kind, percent: 0, file: '', status: 'error', message, code });
}

/** 将失败退出码翻译成用户可读原因 */
function interpretFailure(code: number, stdout: string): { message: string; needsPassword: boolean } {
  const lower = stdout.toLowerCase();
  const needsPassword =
    lower.includes('wrong password') || lower.includes('data error in encrypted') ||
    lower.includes('not correct password');
  if (needsPassword) return { message: '密码不正确。', needsPassword: true };
  /* 管道模式无密码解压加密包:引擎会打"Enter password (will not be echoed)"后以 255 退出(实测),
     这行提示只在首次询问时出现,密码错误时不会出现,可用来区分「缺密码」与「错密码」 */
  if (lower.includes('enter password')) return { message: '该压缩包已加密,需要密码。', needsPassword: true };
  if (lower.includes('missing volume') || lower.includes('cannot open the file as archive') && lower.includes('volume')) {
    return { message: '缺少其余分卷文件,请把所有分卷放在同一目录。', needsPassword: false };
  }
  if (lower.includes('cannot open') && lower.includes('as archive')) {
    return { message: '文件不是可识别的压缩包,或已损坏。', needsPassword: false };
  }
  if (lower.includes('not enough disk space') || lower.includes('disk is full')) {
    return { message: '目标磁盘空间不足。', needsPassword: false };
  }
  if (lower.includes('there are errors')) {
    return { message: '存在错误:部分文件处理失败,详见日志。', needsPassword: false };
  }
  if (code === 1) return { message: '完成,但存在警告(部分文件被跳过)。', needsPassword: false };
  /* 引擎把参数不合法(如 ZIP 口令字符集越界)报成裸「System ERROR: 参数错误」:
     提前分类给出原因与出路,不再落入下方透传(ISS-02);预检已拦 UI 路径,此处服务直连 IPC/漏网参数 */
  if (stdout.includes('System ERROR') && /参数错误|cannot parse the command line|wrong param/i.test(stdout)) {
    return {
      message: '引擎拒绝了当前参数(常见原因:ZIP 密码含中文等非 ASCII 字符,或格式与参数不匹配)。'
        + '请改用 ASCII 密码或 7Z 格式后重试;若参数无误,请检查源文件与磁盘状态。',
      needsPassword: false,
    };
  }
  /* 兜底也附上引擎输出末几行,避免只报裸退出码 */
  const detail = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(-2).join(' / ');
  return { message: `引擎执行失败 (code ${code})${detail ? `:${detail.slice(0, 160)}` : ''}。完整原因见任务日志。`, needsPassword: false };
}

/* ------------------------------------------------------------------ */
/* 列目录(7z l -slt 块格式,解析稳定)                                 */
/* ------------------------------------------------------------------ */

export async function listArchive(archive: string, password?: string): Promise<ArchiveInfo> {
  const args = ['l', '-slt'];
  if (password) args.push(`-p${password}`);
  args.push(archive);
  let stdout: string;
  try {
    stdout = (await probeArgs(args)).stdout;
  } catch (err) {
    const e = err as { code?: string; stdout?: string; message?: string };
    if (e.code === 'ENOENT') throw new EngineError(ERR.ENGINE_MISSING, '压缩引擎未就绪。');
    const text = (e.stdout ?? '') + (e.message ?? '');
    const why = interpretFailure(2, text);
    if (why.needsPassword) throw new EngineError(ERR.NEED_PASSWORD, '该压缩包已加密。');
    throw new EngineError(ERR.LIST_FAILED, why.message);
  }
  const info = parseSlt(stdout);
  /* zip 系:7za 的 Modified 来自本地头,缺失/置 0 时用中央目录(权威源)纠偏 */
  if (/^zip/i.test(info.type) && info.entries.some((e) => !e.mtime || e.mtime.startsWith('1980-01-01'))) {
    const cd = zipCentralTimes(archive);
    if (cd.size) for (const e of info.entries) {
      if (e.mtime && !e.mtime.startsWith('1980-01-01')) continue;
      const t = cd.get(e.path) ?? cd.get(e.path.toLowerCase()) ?? [...cd].find(([k]) => k.toLowerCase() === e.path.toLowerCase())?.[1];
      if (t) e.mtime = t;
    }
  }
  return info;
}

function probeArgs(args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const cp = execFile(engineExe(), args, { windowsHide: true, maxBuffer: 128 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
      const text = decodeEngineOutput(Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0));
      if (err) reject(Object.assign(err, { stdout: text })); else resolve({ stdout: text });
    });
    /* 与 runStep 同理必须立即 EOF stdin:加密头包无密码列表时引擎打"Enter password"
       等交互输入,execFile 的 stdin 管道常开=主进程侧永久挂起(阶段 3.3 PW3 实测) */
    cp.stdin?.end();
  });
}

interface SltBlock { [k: string]: string }

function parseSlt(stdout: string): ArchiveInfo {
  const lines = stdout.split(/\r?\n/);
  const blocks: SltBlock[] = [];
  let cur: SltBlock | null = null;
  let physSize = 0;
  let type = '?';
  let seenDivider = false;
  const flush = () => { if (cur) { blocks.push(cur); cur = null; } };
  for (const line of lines) {
    if (!seenDivider && /^\s*-{6,}\s*$/.test(line)) { seenDivider = true; flush(); continue; }
    const m = line.match(/^([A-Za-z][A-Za-z0-9 ()_/-]*)\s=\s(.*)$/);
    if (m) {
      if (!cur) cur = {};
      cur[m[1].trim()] = m[2];
    } else if (!line.trim()) {
      flush();
    }
  }
  flush();

  const entries: ArchiveEntry[] = [];
  let hasEncrypted = false;
  for (const b of blocks) {
    // 头部块:带 Type/Physical Size 且无 Attributes
    if (b['Attributes'] === undefined && (b['Type'] !== undefined || b['Physical Size'] !== undefined)) {
      if (b['Type']) type = b['Type'].trim();
      if (b['Physical Size']) physSize = Number(b['Physical Size'].replace(/[^\d]/g, '')) || 0;
      continue;
    }
    if (b['Path'] === undefined) continue;
    const attr = (b['Attributes'] ?? '.').trim();
    let p = (b['Path'] ?? '').replace(/\\/g, '/');
    /* 过滤噪音条目:NTFS 备用数据流(如 xxx:Zone.Identifier,资源管理器不可见)、
       Mac 打包残留(__MACOSX/、.DS_Store)、Windows 缩略图缓存 —— 与资源管理器观感一致 */
    const base = p.slice(p.lastIndexOf('/') + 1);
    if (base.includes(':') || p.startsWith('__MACOSX/') || p.includes('/__MACOSX/')
      || base === '.DS_Store' || /^thumbs\.db$/i.test(base) || base.toLowerCase() === 'desktop.ini') continue;
    const size = Number((b['Size'] ?? '').replace(/[^\d]/g, '')) || 0;
    const packed = Number((b['Packed Size'] ?? '').replace(/[^\d]/g, '')) || 0;
    const enc = (b['Encrypted'] ?? '').trim() === '+';
    if (enc) hasEncrypted = true;
    /* 链接条目识别(实测 7za 21.07 tar 列表):Mode 以 'l' 开头或 Symbolic/Hard Link 字段非空;
       链接可指向解压目录外,资源防护默认一律拒绝(阶段 3.2) */
    const mode = (b['Mode'] ?? '').trim();
    const linkTo = (b['Symbolic Link'] ?? '').trim() || (b['Hard Link'] ?? '').trim();
    const isLink = /^l/.test(mode) || linkTo !== '';
    const slash = p.lastIndexOf('/');
    entries.push({
      path: p,
      dir: slash >= 0 ? p.slice(0, slash + 1) : '',
      name: slash >= 0 ? p.slice(slash + 1) : p,
      isDir: attr.startsWith('D'),
      size,
      packed,
      mtime: (b['Modified'] ?? '').trim(),
      encrypted: enc,
      ...(isLink ? { isLink: true, linkTo } : {}),
    });
  }
  return { type, physSize, entries, hasEncrypted };
}

/* ------------------------------------------------------------------ */
/* ZIP 时间纠偏                                                         */
/* 部分打包器(旧 Java/Go/下载器合并等)把 DOS 时间字段置 0,真实时间只   */
/* 写进 NTFS(0x0009)/Unix(0x7875)/Info-ZIP UT(0x5455) 扩展字段;        */
/* 7za -slt 不解析这些字段 → 界面显示 1980-01-01。                      */
/* 这里自读中央目录,按 DOS→UT→Unix0→NTFS 优先级还原,失败静默保留原值。 */
/* ------------------------------------------------------------------ */

function dosTime(w: number) { return { h: w >> 11, m: (w >> 5) & 63, s: (w & 31) * 2 }; }
function dosDate(w: number) { return { y: (w >> 9) + 1980, mo: (w >> 5) & 15, d: w & 31 }; }
const pad2 = (n: number) => String(n).padStart(2, '0');
const fmtTs = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const dosToStr = (dosT: number, dosD: number) => { const t = dosTime(dosT), d = dosDate(dosD); return `${d.y}-${pad2(d.mo)}-${pad2(d.d)} ${pad2(t.h)}:${pad2(t.m)}:${pad2(t.s)}`; };

/** 解析中央目录条目的 extra 字段,返回可还原的修改时间(DOS 之外的扩展源) */
function extraToTime(buf: Buffer): string | null {
  for (let q = 0; q + 4 <= buf.length; ) {
    const tag = buf.readUInt16LE(q), len = buf.readUInt16LE(q + 2);
    const body = buf.subarray(q + 4, Math.min(q + 4 + len, buf.length));
    if (tag === 0x5455 && body.length >= 5) {
      /* Info-ZIP UT:flags 低位=1 含 mtime(4B unix,按本地时间解读与 DOS 一致) */
      if (body[0] & 1) return fmtTs(body.readUInt32LE(1) * 1000);
    } else if (tag === 0x7875 && body.length >= 13) {
      /* UNIX0 (Ashley):version + 3 x (flags + unix32);按 UTC 存储,换算本地 */
      const ver = body[0];
      const n = ver === 1 ? 4 : 8;
      if (ver <= 1 && body.length >= 1 + 3 * n) {
        const flags = body[1 + n];
        if (flags & 2) return fmtTs(Number(body.readBigUInt64LE(1 + 2 * n)) * 1000);
      }
    } else if (tag === 0x0009 && body.length >= 34) {
      /* NTFS:4B 签名 + 2B 版本 + 属性头 4B,其后三对为 mtime/atime/ctime(FILETIME,UTC) */
      const ft = body.readBigUInt64LE(10);
      if (ft > 0n) {
        const ms = Number((ft - 116444736000000000n) / 10000n);
        if (Number.isFinite(ms) && ms > 0) return fmtTs(ms);
      }
    }
    q += 4 + len;
  }
  return null;
}

/** 读 zip 中央目录,返回 条目路径 → 修改时间 */
function zipCentralTimes(archive: string): Map<string, string> {
  const out = new Map<string, string>();
  let fd: number | null = null;
  try {
    fd = fs.openSync(archive, 'r');
    const st = fs.fstatSync(fd);
    const tail = Buffer.alloc(Math.min(st.size, 66 * 1024));
    fs.readSync(fd, tail, 0, tail.length, st.size - tail.length);
    let eo = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eo = i; break; }
    if (eo < 0) return out;
    let cdCount = tail.readUInt16LE(eo + 10);
    let cdOff = tail.readUInt32LE(eo + 16);
    /* zip64:偏移/条数为哨兵值时,从 locator + 64 位记录取真实值 */
    if (cdOff === 0xffffffff || cdCount === 0xffff) {
      let lo = -1;
      for (let i = eo - 20; i >= 0; i--) if (tail.readUInt32LE(i) === 0x07064b50) { lo = i; break; }
      if (lo >= 0) {
        const lbuf = Buffer.alloc(20);
        fs.readSync(fd, lbuf, 0, 20, st.size - tail.length + lo);
        const z64Off = Number(lbuf.readBigUInt64LE(8));
        const z64 = Buffer.alloc(56);
        fs.readSync(fd, z64, 0, 56, z64Off);
        if (z64.readUInt32LE(0) === 0x06064b50) { cdCount = Number(z64.readBigUInt64LE(32)); cdOff = Number(z64.readBigUInt64LE(48)); }
      }
    }
    const cd = Buffer.alloc(Math.min(st.size - cdOff, 128 * 1024 * 1024));
    fs.readSync(fd, cd, 0, cd.length, cdOff);
    let p = 0;
    for (let n = 0; n < cdCount && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const flag = cd.readUInt16LE(p + 8);
      const dosT = cd.readUInt16LE(p + 12), dosD = cd.readUInt16LE(p + 14);
      const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), cmtLen = cd.readUInt16LE(p + 32);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString(flag & 0x800 ? 'utf8' : 'latin1');
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      p += 46 + nameLen + extraLen + cmtLen;
      if (name.includes('\uFFFD')) continue;
      /* DOS 字段有效优先用(与 7za 口径一致);否则依次尝试扩展字段 */
      const t = (dosD && dosT) ? dosToStr(dosT, dosD) : extraToTime(extra);
      if (t) out.set(name.replace(/\\/g, '/'), t);
    }
  } catch { /* 结构异常/超大文件:保留 7za 结果 */ } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 归档修改事务(阶段 3.1)                                             */
/* 就地修改(d / a 到既有归档)一律在同目录副本上进行:预检空间 → 复制 → */
/* 引擎只碰副本 → 结构+完整性校验 → swap 替换 → 删备份;任一环节失败   */
/* 都丢弃副本、原归档零改动。journal 落 userData,进程崩溃由启动恢复兜底 */
/* ------------------------------------------------------------------ */

const TXN_TMP_EXT = '.tztmp';
const TXN_BAK_EXT = '.tzbak';
/** 修改既有归档:完整性测试上限(用户数据,宁慢必测) */
const TXN_MODIFY_TEST_MAX = 2 * 1024 ** 3;
/** 新建归档:测试上限(避免大包压缩后再等一遍全解,结构校验仍必做) */
const TXN_CREATE_TEST_MAX = 512 * 1024 ** 2;

interface TxnRecord {
  id: string;
  /** 原归档(替换目标);kind=extract 时为解压目标目录(仅作定位,恢复绝不删它) */
  archive: string;
  /** 同目录临时副本(.tztmp),引擎实际修改的对象;kind=extract 时为解压暂存目录 */
  tmp: string;
  /** 原归档备份(.tzbak),仅替换窗口期存在 */
  backup?: string;
  /** staged=副本修改中; swapping=正在替换原归档; committed=替换完成待清备份 */
  stage: 'staged' | 'swapping' | 'committed';
  /** modify=归档修改事务(3.1);extract=解压暂存(3.2),崩溃遗留的暂存目录整体可删 */
  kind?: 'modify' | 'extract';
  at: number;
}

let txnJournalFile = path.join(os.tmpdir(), 'TongZip', 'txn-journal.json');
/** 主进程把 journal 指向 userData;默认落临时目录,保证 selftest 在纯 node 可跑 */
export function configureTxnJournal(file: string): void { txnJournalFile = file; }

function readTxnJournal(): TxnRecord[] {
  try {
    const j = JSON.parse(fs.readFileSync(txnJournalFile, 'utf8')) as { records?: unknown };
    return Array.isArray(j.records) ? (j.records as TxnRecord[]) : [];
  } catch {
    /* 文件在但解析失败=撕裂(CI 崩溃演练实测:非原子写被强杀命中 truncate 窗口,
       撕裂被当"无记录"→ 恢复早退 → .tztmp 副本永久残留)。隔离留证,后续从空重建 */
    try {
      if (fs.existsSync(txnJournalFile)) fs.renameSync(txnJournalFile, `${txnJournalFile}.corrupt-${Date.now()}`);
    } catch { /* 隔离失败不阻断,后续写入仍会覆盖 */ }
    return [];
  }
}
/** 原子替换写:先落 .swap 再 rename 覆盖;强杀任何时刻 journal 只会是完整旧版或新版,不会撕裂。
    rename 失败(AV 占用目标文件)回落直写——带撕裂风险也好过整条记录丢 */
function writeTxnJournal(records: TxnRecord[]): void {
  const data = JSON.stringify({ v: 1, records }, null, 2);
  try {
    fs.mkdirSync(path.dirname(txnJournalFile), { recursive: true });
    const swap = `${txnJournalFile}.swap`;
    try {
      fs.writeFileSync(swap, data, 'utf8');
      fs.renameSync(swap, txnJournalFile);
      return;
    } catch { /* 走回落 */ }
    fs.writeFileSync(txnJournalFile, data, 'utf8');
  } catch { /* journal 写失败不阻断操作,代价是崩溃恢复能力下降 */ }
}
function txnUpsert(rec: TxnRecord): void {
  const rs = readTxnJournal().filter((r) => r.id !== rec.id);
  rs.push(rec);
  writeTxnJournal(rs);
}
function txnRemove(id: string): void {
  writeTxnJournal(readTxnJournal().filter((r) => r.id !== id));
}

/** 目录所在卷剩余可写字节;无法判定返回 -1(不拦截) */
function freeBytesAt(dir: string): number {
  try { const s = fs.statfsSync(dir); return s.bsize * s.bavail; } catch { return -1; }
}
export function checkFreeSpace(dir: string, needBytes: number): boolean {
  const f = freeBytesAt(dir);
  return f < 0 || f >= needBytes;
}

/** 复制原归档为同目录临时副本并登记事务;此后一切修改只触碰副本。同卷 staging 也规避了跨卷 rename 失败 */
export function stageForModify(archive: string, uid: string): { tmp: string } {
  const dir = path.dirname(archive);
  const size = fs.statSync(archive).size;
  /* 副本本身 + 重打包峰值余量 */
  if (!checkFreeSpace(dir, Math.ceil(size * 1.2) + 64 * 1024 * 1024)) {
    throw new EngineError(ERR.SPACE_LOW, '目标磁盘空间不足,无法安全修改压缩包(需要在同目录创建归档副本再替换)。');
  }
  const tmp = path.join(dir, `${path.basename(archive)}.${uid}${TXN_TMP_EXT}`);
  fs.copyFileSync(archive, tmp);
  txnUpsert({ id: uid, archive, tmp, stage: 'staged', at: Date.now() });
  return { tmp };
}

/** 校验产物:结构可读必做;不超过阈值时再做全量完整性测试(密码用于加密头/加密条目场景) */
export async function verifyArchiveArtifact(
  file: string, password?: string, testLimit = TXN_MODIFY_TEST_MAX,
): Promise<void> {
  try {
    await listArchive(file, password);
  } catch (e) {
    if (e instanceof EngineError && e.code === ERR.NEED_PASSWORD) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new EngineError(ERR.VERIFY_FAILED, `归档结构校验失败,修改未生效,原压缩包保持原样(${msg})`);
  }
  let size = Infinity;
  try { size = fs.statSync(file).size; } catch { /* stat 失败交由后续替换环节报错 */ }
  if (size <= testLimit) {
    const args = ['t', '-y'];
    if (password) args.push(`-p${password}`);
    args.push(file);
    try {
      await probeArgs(args);
    } catch (err) {
      const t = (err as { stdout?: string }).stdout ?? '';
      throw new EngineError(ERR.VERIFY_FAILED, `完整性校验失败,修改未生效,原压缩包保持原样(${interpretFailure(2, t).message})`);
    }
  }
}

/**
 * 把临时副本安全落成目标归档:
 * - 目标不存在 → 直接挪位;
 * - 目标存在 → rename 备份 → rename 就位,任一步失败可还原;双失败时保留 journal 交启动恢复。
 * 本函数自行管理 journal 归属,调用方失败后不得再盲清 tmp。
 */
export function commitTxnSwap(archive: string, tmp: string, uid: string): void {
  if (!fs.existsSync(archive)) {
    try { fs.renameSync(tmp, archive); return; }
    catch (e) {
      if (!fs.existsSync(archive)) {
        txnRemove(uid);
        try { fs.rmSync(tmp, { force: true }); } catch { /* 残留交启动回收 */ }
        throw new EngineError(ERR.TXN_FAILED, `写入目标压缩包失败:${(e as Error).message}`);
      }
      /* 挪位瞬间目标被别人创建:继续走 swap,现有文件受备份保护 */
    }
  }
  const backup = path.join(path.dirname(archive), `${path.basename(archive)}.${uid}${TXN_BAK_EXT}`);
  txnUpsert({ id: uid, archive, tmp, backup, stage: 'swapping', at: Date.now() });
  try {
    fs.renameSync(archive, backup);
  } catch (e) {
    txnRemove(uid);
    try { fs.rmSync(tmp, { force: true }); } catch { /* 残留交启动回收 */ }
    throw new EngineError(ERR.TXN_FAILED, `无法替换原压缩包(文件可能被占用),已保持原样:${(e as Error).message}`);
  }
  try {
    fs.renameSync(tmp, archive);
  } catch (e) {
    let rolledBack = false;
    try { fs.renameSync(backup, archive); rolledBack = true; txnRemove(uid); } catch { /* 回滚也失败:保留 journal,启动恢复 */ }
    if (rolledBack) { try { fs.rmSync(tmp, { force: true }); } catch { /* 残留交启动回收 */ } }
    throw new EngineError(ERR.TXN_FAILED, `压缩包替换失败,${rolledBack ? '原文件已还原' : '原文件已由备份保护'}:${(e as Error).message}`);
  }
  txnUpsert({ id: uid, archive, tmp, backup, stage: 'committed', at: Date.now() });
  try { fs.rmSync(backup, { force: true }); } catch { /* 备份删除失败由启动回收兜底 */ }
  txnRemove(uid);
}

/** 事务失败/取消:丢弃副本并注销 journal(原归档从未被触碰) */
export function abortTxn(uid: string, tmp?: string): void {
  if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch { /* 残留交启动回收 */ } }
  txnRemove(uid);
}

/**
 * 启动恢复:处理上次进程崩溃遗留的事务。
 * swapping 半态优先还原原归档;staged/committed 只清残留副本与备份。
 * 单项失败保留其 journal 记录,下次启动再试。
 */
export function recoverStaleTransactions(): { restored: string[]; cleaned: string[] } {
  const restored: string[] = [];
  const cleaned: string[] = [];
  const records = readTxnJournal();
  if (!records.length) return { restored, cleaned };
  const remaining: TxnRecord[] = [];
  for (const r of records) {
    try {
      /* 解压暂存(kind=extract):目录整体是本任务生成的可丢弃产物,一律删除;
         目标目录(dest)可能已部分提交,属用户数据,绝不触碰 */
      if (r.kind === 'extract') {
        if (fs.existsSync(r.tmp)) { fs.rmSync(r.tmp, { recursive: true, force: true }); cleaned.push(r.tmp); }
        continue;
      }
      const hasArchive = fs.existsSync(r.archive);
      const hasBackup = !!r.backup && fs.existsSync(r.backup);
      const hasTmp = fs.existsSync(r.tmp);
      if (r.stage === 'swapping') {
        /* 原归档没了但备份在:替换中途崩溃 → 还原原件 */
        if (!hasArchive && hasBackup) { fs.renameSync(r.backup!, r.archive); restored.push(r.archive); }
        else if (hasArchive && hasBackup) fs.rmSync(r.backup!, { force: true }); // 替换已完成,备份多余
        if (hasTmp) { fs.rmSync(r.tmp, { force: true }); cleaned.push(r.tmp); }
      } else if (r.stage === 'staged') {
        if (hasTmp) { fs.rmSync(r.tmp, { force: true }); cleaned.push(r.tmp); }
      } else { // committed:仅可能剩没删掉的备份
        if (hasBackup) { fs.rmSync(r.backup!, { force: true }); cleaned.push(r.backup!); }
        if (hasTmp) { fs.rmSync(r.tmp, { force: true }); cleaned.push(r.tmp); }
      }
    } catch { remaining.push(r); }
  }
  writeTxnJournal(remaining);
  return { restored, cleaned };
}

/* ------------------------------------------------------------------ */
/* 资源防护(阶段 3.2)                                                  */
/* 三层防线:① 静态预检(条目名/链接/声明量/压缩比/空间)→ ② 隔离暂存    */
/* (解压只进 dest 旁的隐藏暂存目录,失败/熔断整体丢弃)→ ③ 执行中看门狗  */
/* (真实落盘量/文件数/链接/时长/剩余空间,越界即 SIGKILL)。             */
/* 声明值可伪造,预检只是第一道;commit 前再做一次链接扫描兜底。          */
/* ------------------------------------------------------------------ */

let guard: GuardLimits = { ...DEFAULT_GUARD };
/** 主进程在启动与 settings 变更后灌入上限覆盖;缺省回落安全默认值 */
export function configureGuard(patch?: Partial<GuardLimits> | null): GuardLimits {
  guard = { ...DEFAULT_GUARD, ...(patch ?? {}) };
  return { ...guard };
}
export function currentGuard(): GuardLimits { return { ...guard }; }

/** Windows 保留设备名(CON/PRN/AUX/NUL/COM1-9/LPT1-9,含带扩展名形态) */
const DOS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.[^.]*)?$/i;

/**
 * 归档条目名 → 安全相对路径段数组;null = 危险条目。
 * 拦截:路径穿越(..)、绝对路径/盘符/UNC、NTFS 数据流冒号(可静默注入既有文件的 ADS)、
 * 控制字符、保留设备名、异常目录深度。
 * '*'?'<' 等 Windows 非法字符不拦:它们不构成逃逸面,7za 落盘时自有替换(实测 C:/→C_\),
 * 整包拒绝反而误伤合法归档(实测 21.07 CON.dat→_CON.dat)。
 */
export function sanitizeEntryPath(raw: string): string[] | null {
  const unified = raw.replace(/\\/g, '/');
  if (unified.startsWith('//')) return null; // UNC
  if (/^[a-zA-Z]:/.test(unified)) return null; // 盘符绝对路径
  const segs = unified.split('/');
  if (segs[0] === '') return null; // /abs 风格绝对路径
  const out: string[] = [];
  for (const s of segs) {
    if (!s || s === '.') continue;
    if (s === '..') return null;
    if (s.includes(':')) return null;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(s)) return null;
    if (DOS_RESERVED.test(s)) return null;
    out.push(s);
    if (out.length > 32) return null; // 超出 MAX_PATH 风险的异常深度
  }
  return out.length ? out : null;
}

/** 首个已存在的祖先目录(statfs 需真实路径,深路径 dest 尚不存在时向上取) */
function existingAncestor(p: string): string {
  let d = path.resolve(p);
  while (!fs.existsSync(d) && d !== path.dirname(d)) d = path.dirname(d);
  return d;
}

interface TreeStats { files: number; bytes: number; links: number }

/** 递归量测目录真实落地量;超过任一 cap 提前返回(truncated 语义由调用方按数值判断) */
function measureTree(dir: string, capFiles: number, capBytes: number): TreeStats {
  const acc: TreeStats = { files: 0, bytes: 0, links: 0 };
  const walk = (d: string) => {
    let items: fs.Dirent[];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const fp = path.join(d, it.name);
      if (it.isSymbolicLink()) { acc.links++; }
      else if (it.isDirectory()) { walk(fp); }
      else if (it.isFile()) {
        acc.files++;
        try { acc.bytes += fs.statSync(fp).size; } catch { /* 写入中的瞬时 stat 失败忽略 */ }
      }
      if (acc.files > capFiles || acc.bytes > capBytes) return; // 越界早停
    }
  };
  walk(dir);
  return acc;
}

/** 选择器匹配:空选择=全量;前缀语义与 extractConflicts 一致 */
function selectedEntries(job: ExtractJob, info: ArchiveInfo): ArchiveEntry[] {
  const sels = (job.entries ?? []).map((s) => s.replace(/\/+$/, ''));
  return !sels.length ? info.entries
    : info.entries.filter((e) => sels.some((s) => e.path === s || e.path.startsWith(`${s}/`)));
}

/**
 * 静态预检:声明值不可全信(伪造由看门狗兜底),但能拦掉绝大多数恶意包于写盘之前。
 * info=null(列表不可读)时跳过静态项,执行中监控与 commit 前扫描仍然生效。
 */
export function preflightExtract(job: ExtractJob, info: ArchiveInfo | null): void {
  if ((job.nestDepth ?? 0) > guard.maxNestDepth) {
    throw new EngineError(ERR.GUARD_LIMIT, `嵌套归档深度超过上限(${guard.maxNestDepth}),已阻止。`);
  }
  if (!info) return;
  const targets = selectedEntries(job, info);
  if (targets.length > guard.maxEntries) {
    throw new EngineError(ERR.GUARD_LIMIT, `归档条目数 ${targets.length} 超过防护上限 ${guard.maxEntries},解压未启动。`);
  }
  let total = 0;
  const seen = new Map<string, string>(); // 规范化落点 → 首个条目名(不同条目塌缩到同一文件=静默覆盖)
  for (const e of targets) {
    const parts = sanitizeEntryPath(e.path);
    if (!parts) throw new EngineError(ERR.UNSAFE_PATH, `归档包含危险条目名,解压已阻止:${e.path}`);
    if (e.isLink) throw new EngineError(ERR.UNSAFE_PATH, `归档包含链接条目(默认阻止,可指向目录外):${e.path}${e.linkTo ? ` → ${e.linkTo}` : ''}`);
    if (e.isDir) continue;
    if (e.size > guard.maxFileBytes) {
      throw new EngineError(ERR.GUARD_LIMIT, `单文件声明体积超过上限:${e.path}`);
    }
    total += e.size;
    const key = parts.join('/').toLowerCase();
    const prev = seen.get(key);
    if (prev && prev !== e.path) {
      throw new EngineError(ERR.UNSAFE_PATH, `两个条目指向同一落地文件,拒绝后写覆盖先写:${prev} / ${e.path}`);
    }
    seen.set(key, e.path);
  }
  if (total > guard.maxTotalBytes) {
    throw new EngineError(ERR.GUARD_LIMIT, `声明总解压体积超过上限(${Math.round(guard.maxTotalBytes / 1024 ** 3)} GiB),解压未启动。`);
  }
  /* 压缩比只在大体量声明时才作为炸弹信号:文本/备份类正常文件高压缩比很常见,不能单独定罪 */
  if (info.physSize > 0 && total > guard.ratioMinDeclared && total / info.physSize > guard.maxRatio) {
    throw new EngineError(ERR.GUARD_LIMIT, `疑似解压炸弹(解压比 ${Math.round(total / info.physSize)}:1 超过上限 ${guard.maxRatio}:1),解压已阻止。`);
  }
  const destVolDir = existingAncestor(job.dest);
  if (!checkFreeSpace(destVolDir, Math.ceil(total * 1.05) + guard.minFreeBytes)) {
    throw new EngineError(ERR.SPACE_LOW, '目标磁盘剩余空间不足以容纳解压结果,未启动。');
  }
}

/* ── 重型任务并发闸:全局信号量,防多任务同时压缩/解压共同耗尽 CPU/内存/磁盘 ── */
let heavyActive = 0;
const heavyQueue: Array<() => void> = [];

async function acquireHeavySlot(handle: TaskHandle): Promise<() => void> {
  while (heavyActive >= guard.maxHeavyTasks && !handle.cancelled) {
    await new Promise<void>((res) => heavyQueue.push(res));
  }
  if (handle.cancelled) {
    /* 排队期间被取消:让出这次唤醒,避免容量空转导致其他等待者饿死 */
    Promise.resolve().then(() => heavyQueue.shift()?.());
    return () => { /* 未占坑,无需释放 */ };
  }
  heavyActive++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    heavyActive--;
    heavyQueue.shift()?.();
  };
}

/** 并发闸实时状态(selftest/诊断用) */
export function guardStats(): { active: number; waiting: number; maxHeavyTasks: number } {
  return { active: heavyActive, waiting: heavyQueue.length, maxHeavyTasks: guard.maxHeavyTasks };
}

/* ── 暂存 → 目标的提交合并 ── */

function uniqueTargetPath(dst: string): string {
  const ext = path.extname(dst);
  const stem = dst.slice(0, dst.length - ext.length);
  for (let i = 1; ; i++) {
    const cand = `${stem} (${i})${ext}`;
    if (!fs.existsSync(cand)) return cand;
  }
}

/** 把 src 落到 dst:同卷 rename 优先(O(1)),跨卷/被拒退化为复制;目录逐层合并 */
function moveInto(src: string, dst: string): void {
  try { fs.renameSync(src, dst); return; } catch { /* EXDEV/瞬时占用 → 复制兜底 */ }
  const st = fs.lstatSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) moveInto(path.join(src, name), path.join(dst, name));
    fs.rmdirSync(src);
  } else {
    fs.copyFileSync(src, dst);
    fs.rmSync(src);
  }
}

/**
 * 提交暂存目录到用户目标:dest 不存在 → 整体挪位(瞬间完成,无半成品窗口);
 * 已存在 → 按覆盖策略逐项合并。ask 的冲突已在 IPC 层预检拦截,走到这里按 overwrite 落。
 */
export function commitExtract(staging: string, dest: string, mode: 'overwrite' | 'skip' | 'rename'): void {
  if (!fs.existsSync(dest)) { moveInto(staging, dest); return; }
  const queue: Array<[string, string]> = [];
  for (const name of fs.readdirSync(staging)) queue.push([path.join(staging, name), path.join(dest, name)]);
  while (queue.length) {
    const [src, dst] = queue.shift()!;
    const srcIsDir = fs.lstatSync(src).isDirectory();
    if (!fs.existsSync(dst)) {
      moveInto(src, dst); // 整树挪位,其子项已在最终位置,无需再入队
      continue;
    }
    if (srcIsDir && fs.lstatSync(dst).isDirectory()) {
      for (const name of fs.readdirSync(src)) queue.push([path.join(src, name), path.join(dst, name)]);
      continue;
    }
    if (mode === 'skip') { fs.rmSync(src, { recursive: true, force: true }); continue; }
    if (mode === 'rename') { moveInto(src, uniqueTargetPath(dst)); continue; }
    fs.rmSync(dst, { recursive: true, force: true });
    moveInto(src, dst);
  }
  fs.rmSync(staging, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* 压缩                                                                */
/* ------------------------------------------------------------------ */

export function inferFormat(output: string): ArchiveFormat {
  const n = output.toLowerCase();
  if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'tar.gz';
  if (n.endsWith('.tar.bz2') || n.endsWith('.tbz2')) return 'tar.bz2';
  if (n.endsWith('.tar.xz') || n.endsWith('.txz')) return 'tar.xz';
  if (n.endsWith('.tar.zst')) return 'tar.zst';
  if (n.endsWith('.tar')) return 'tar';
  if (n.endsWith('.zip')) return 'zip';
  return '7z';
}

/* ------------------------------------------------------------------ */
/* 启动前参数预检(ISS-02)——格式能力表 + 密码字符集(定义在 shared/types 单一真相)  */
/* ------------------------------------------------------------------ */

/** ZIP 包密码入口统一拦截(创建/打开/解压/追加):非 ASCII 口令提前给出原因,
 * 不再让引擎裸报「参数错误」(ISS-02)。仅限 zip——7z 非 ASCII 密码实测可用,不得误拦。 */
export function assertZipPw(archive: string, pw: string | undefined): void {
  if (/\.zip$/i.test(archive) && pw && !ZIP_PW_OK.test(pw)) {
    throw new EngineError(ERR.BAD_PARAM, 'ZIP 传统加密仅支持 ASCII 可打印字符密码(中文等字符会导致引擎失败)。若该包实为 7Z 等其他格式请重命名扩展名;需要中文密码请改用 7Z 格式创建。');
  }
}

/** 压缩任务启动前预检:不支持的创建格式/密码字符集直接给出原因与出路;tar 族拒收密码字段(ISS-01 纵深加固) */
export function preflightCompress(job: CompressJob): void {
  const fmt = job.format ?? inferFormat(job.output);
  if (!isCreatableFormat(fmt)) {
    throw new EngineError(ERR.BAD_PARAM, `当前内置引擎(7-Zip 21.07 独立版)不支持创建 ${fmt.toUpperCase()} 格式,请改用 7Z/ZIP/TAR.GZ/TAR.XZ/TAR.BZ2,或安装完整版 7-Zip 后在设置中指定其路径。`);
  }
  if (job.password) {
    if (fmt === 'zip' && !ZIP_PW_OK.test(job.password)) {
      throw new EngineError(ERR.BAD_PARAM, 'ZIP 传统加密仅支持 ASCII 可打印字符密码(中文等字符会导致引擎失败)。请改用 ASCII 密码,或切换为 7Z 格式(支持任意字符并可加密文件名)。');
    }
    if (fmt !== 'zip' && fmt !== '7z') {
      throw new EngineError(ERR.BAD_PARAM, `${fmt} 格式本身不支持加密,密码不会有任何效果。需要加密请改用 7Z 或 ZIP 格式。`);
    }
  }
}

const COMPOUND: Record<string, string> = {
  'tar.gz': 'gzip', 'tar.bz2': 'bzip2', 'tar.xz': 'xz', 'tar.zst': 'zstd',
};

function compressArgs(job: CompressJob, output: string): string[] {
  const fmt = job.format;
  const args = ['a', '-y', `-t${fmt}`, output];
  if (fmt === '7z' || fmt === 'zip') args.push(`-mx=${job.level}`);
  if (fmt === '7z') {
    if (job.level > 0 && job.dict) args.push(`-md=${job.dict}`);
    if (job.solid && job.solid !== 'auto') args.push(`-ms=${job.solid}`);
    args.push(job.multiThread ? '-mmt=on' : '-mmt=off');
  }
  if (job.password) {
    /* 密码只能经 argv 传递——7za 21.07 两轮实测(阶段 3.2/3.3)确证无旁路:
     * @listfile 把 "-p…" 行当文件名(不支持开关);管道下 stdin 读不到密码交互;
     * 引擎 stdout 不回显 argv(无 Command Line 头,故 interpretFailure 兜底 detail 安全)。
     * 泄露面控制:进度广播/快照均已剔除 log 字段,事务 journal 与设置持久化不含密码,
     * argv 的 OS 级可见性(同机进程查询)属引擎能力边界,应用层无法在不换引擎下消除。 */
    args.push(`-p${job.password}`);
    if (fmt === '7z' && job.encryptHeaders) args.push('-mhe=on');
  }
  if (job.volume && (fmt === '7z' || fmt === 'zip')) args.push(`-v${job.volume}`);
  args.push(...job.sources);
  return args;
}

/**
 * 创建/追加压缩包;复合格式内部两阶段(先生成 tar 再整体压缩),共用一个 taskId。
 * 事务化(3.1):追加到既有归档 = 同目录副本上修改、校验通过后 swap 替换;
 * 新建归档先落同目录 .tztmp 再挪位,失败/cancel 清理半成品,绝不留下冒充成功的残缺输出,
 * 同时规避跨卷 rename 限制。
 * 返回的 Promise 在引擎就绪且任务启动后 resolve;结果通过 onProgress 事件流反馈。
 */
export async function runCompress(job: CompressJob, onProgress: ProgressFn): Promise<{ taskId: string }> {
  engineExe(); // 引擎不可用直接抛 EngineError
  const taskId = randomUUID();
  const uid = taskId.slice(0, 8);
  const handle: TaskHandle = { proc: null, cancelled: false };
  tasks.set(taskId, handle);
  emitStart(taskId, 'compress', onProgress);
  const compound = COMPOUND[job.format];

  (async () => {
    let stagedTmp: string | undefined; // 追加模式:既有归档的同目录副本
    let stagePath = '';                // 新建模式:输出的同目录暂存位
    let tar = '';                      // 复合格式中间产物
    let handedOff = false;             // journal/文件归属已移交 commitTxnSwap,外层不得再清
    let completed = false;
    let release: (() => void) | null = null; // 重型任务并发闸(3.2)
    try {
      release = await acquireHeavySlot(handle);
      if (handle.cancelled) return finishCancel(taskId, 'compress', onProgress);
      const outDir = path.dirname(job.output);
      try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* 目录不可建,由复制/引擎报错 */ }
      if (!compound && fs.existsSync(job.output)) {
        stagedTmp = stageForModify(job.output, uid).tmp; // 追加:预检空间 + 复制 + 登记
      } else {
        stagePath = path.join(outDir, `${path.basename(job.output)}.${uid}${TXN_TMP_EXT}`);
        /* 新建没有可备份的对象,先按源体积预估,空间不足直接不启动 */
        const need = totalSize(job.sources) + 64 * 1024 * 1024;
        if (!checkFreeSpace(outDir, need)) {
          throw new EngineError(ERR.SPACE_LOW, '目标磁盘空间不足,压缩未启动。');
        }
      }
      const sink = stagedTmp ?? stagePath;

      if (compound) {
        tar = path.join(os.tmpdir(), `tongzip-${uid}.tar`);
        const r1 = await runStep(handle, taskId, 'compress', compressArgs({ ...job, format: 'tar' }, tar), onProgress);
        if (handle.cancelled) return finishCancel(taskId, 'compress', onProgress);
        if (r1.code > 1) return emitError(taskId, 'compress', onProgress, interpretFailure(r1.code, r1.stdout).message);
        const r2 = await runStep(handle, taskId, 'compress', ['a', '-y', `-t${compound}`, stagePath, tar], onProgress);
        if (handle.cancelled) return finishCancel(taskId, 'compress', onProgress);
        if (r2.code > 1 || !fs.existsSync(stagePath)) {
          return emitError(taskId, 'compress', onProgress, r2.code > 1
            ? interpretFailure(r2.code, r2.stdout).message
            : '压缩未生成输出文件。');
        }
        await verifyArchiveArtifact(stagePath, job.password, TXN_CREATE_TEST_MAX);
      } else {
        const r = await runStep(handle, taskId, 'compress', compressArgs(job, sink), onProgress);
        if (handle.cancelled) return finishCancel(taskId, 'compress', onProgress);
        if (r.code > 1) return emitError(taskId, 'compress', onProgress, interpretFailure(r.code, r.stdout).message);
        await verifyArchiveArtifact(sink, job.password, stagedTmp ? TXN_MODIFY_TEST_MAX : TXN_CREATE_TEST_MAX);
      }
      handedOff = true; // 自此文件与 journal 由替换流程(含其失败路径/启动恢复)负责
      commitTxnSwap(job.output, sink, uid);
      completed = true;
      emitDone(taskId, 'compress', onProgress, path.basename(job.output));
    } catch (err) {
      const e = err as EngineError;
      emitError(taskId, 'compress', onProgress, e.message ?? String(err), e.code);
    } finally {
      if (!completed && !handedOff) {
        if (stagedTmp) abortTxn(uid, stagedTmp); // 原归档从未被触碰,副本丢弃
        if (stagePath) { try { fs.rmSync(stagePath, { force: true }); } catch { /* 残留交启动回收 */ } }
      }
      if (tar) { try { fs.rmSync(tar, { force: true }); } catch { /* 中间产物清理失败无碍 */ } }
      release?.();
      tasks.delete(taskId);
    }
  })();

  return { taskId };
}

function finishCancel(_id: string, kind: JobKind, fn: ProgressFn) {
  fn({ taskId: _id, kind, percent: 0, file: '', status: 'cancelled', message: '任务已取消。' });
}

/* ------------------------------------------------------------------ */
/* 解压                                                                */
/* ------------------------------------------------------------------ */

export async function runExtract(job: ExtractJob, onProgress: ProgressFn): Promise<{ taskId: string }> {
  engineExe();
  /* 条目选择器同样过安全检查:渲染层传回的 entry 源自列表,但 IPC 面不可信任 */
  for (const s of job.entries ?? []) {
    if (!sanitizeEntryPath(s)) throw new EngineError(ERR.UNSAFE_PATH, `非法条目选择路径:${s}`);
  }
  const taskId = randomUUID();
  const uid = taskId.slice(0, 8);
  const handle: TaskHandle = { proc: null, cancelled: false };
  tasks.set(taskId, handle);
  emitStart(taskId, 'extract', onProgress);

  (async () => {
    const destRoot = path.resolve(job.dest);
    /* 暂存目录与 dest 同卷同父:提交挪位是 O(1) rename;「.」前缀 + .tzstage 后缀 = 隐藏且可安全整体删除 */
    const stageDir = path.join(path.dirname(destRoot), `.${path.basename(destRoot)}.tzstage-${uid}`);
    let release: (() => void) | null = null;
    let committed = false;
    let watchTimer: ReturnType<typeof setInterval> | null = null;
    let guardAbort = '';
    try {
      release = await acquireHeavySlot(handle);
      if (handle.cancelled) return finishCancel(taskId, 'extract', onProgress);

      /* 预检数据:列表可读才做静态拦截;加密头无密码 → 由错误链路直接拦下 */
      let info: ArchiveInfo | null = null;
      try { info = await listArchive(job.archive, job.password); }
      catch (e) {
        if (e instanceof EngineError && e.code === ERR.NEED_PASSWORD && !job.password) throw e;
        info = null; // 其余列表失败不阻断(引擎解压自有错误路径),动态监控仍生效
      }
      preflightExtract(job, info);

      fs.mkdirSync(path.dirname(stageDir), { recursive: true });
      txnUpsert({ id: uid, archive: destRoot, tmp: stageDir, stage: 'staged', kind: 'extract', at: Date.now() });

      const args = ['x', '-y', '-spd']; // -spd: 条目名字面匹配,防 */?/# 误扩展连带解压其他条目
      /* 覆盖策略(-aoa/-aos/-aou)不再下发:解压目标是空暂存目录,不存在冲突;
         与 dest 既有文件的取舍改由 commitExtract 按用户模式执行(语义等价且可回退) */
      if (job.password) args.push(`-p${job.password}`); // 密码仅能走 argv,见 compressArgs 内实测说明
      args.push(job.archive);
      if (job.entries?.length) args.push(...job.entries);
      args.push(`-o${stageDir}`);

      /* 执行中看门狗:声明值可伪造,一切以真实落盘为准;越界 → SIGKILL + 暂存整体丢弃 */
      const t0 = Date.now();
      watchTimer = setInterval(() => {
        if (guardAbort) return;
        if (Date.now() - t0 > guard.maxRunMs) {
          guardAbort = `超过解压运行时长上限(${Math.round(guard.maxRunMs / 1000)}s)`;
        } else {
          const m = measureTree(stageDir, guard.maxEntries, guard.maxTotalBytes);
          if (m.links > 0) guardAbort = '检测到符号链接落地';
          else if (m.files > guard.maxEntries) guardAbort = `实际文件数超过上限(${guard.maxEntries})`;
          else if (m.bytes > guard.maxTotalBytes) guardAbort = `实际输出体积超过上限(${guard.maxTotalBytes} 字节)`;
          else {
            const free = freeBytesAt(path.dirname(destRoot));
            if (free >= 0 && free < guard.minFreeBytes) guardAbort = '磁盘剩余空间低于安全水位';
          }
        }
        if (guardAbort) handle.proc?.kill('SIGKILL');
      }, Math.max(50, guard.watchIntervalMs));

      const r = await runStep(handle, taskId, 'extract', args, onProgress);
      if (guardAbort) {
        return emitError(taskId, 'extract', onProgress,
          `资源防护熔断:${guardAbort}。已安全中止,原归档未受影响,半成品输出已清理。`, ERR.GUARD_LIMIT);
      }
      if (handle.cancelled) return finishCancel(taskId, 'extract', onProgress);
      if (r.code > 1) {
        const why = interpretFailure(r.code, r.stdout);
        if (why.needsPassword) {
          /* 机读码供渲染层弹密码框;文案保持人可读,任务窗口直接展示也不刺眼 */
          return emitError(taskId, 'extract', onProgress, job.password ? '密码不正确。' : '该压缩包已加密,需要密码。', ERR.NEED_PASSWORD);
        }
        return emitError(taskId, 'extract', onProgress, `${why.message}(半成品输出未提交,已清理)`);
      }
      /* 提交前链接复扫:覆盖「列表不可读未做静态预检」的归档,双保险 */
      const scan = measureTree(stageDir, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      if (scan.links > 0) {
        return emitError(taskId, 'extract', onProgress,
          '解压产物包含符号链接,基于安全策略已放弃本次输出(原归档未受影响)。', ERR.UNSAFE_PATH);
      }
      applyExtractRenames(job, stageDir);
      commitExtract(stageDir, destRoot, job.overwrite === 'skip' ? 'skip' : job.overwrite === 'rename' ? 'rename' : 'overwrite');
      committed = true; // 自此产物属于用户目标目录,外层不得再清
      txnRemove(uid);
      emitDone(taskId, 'extract', onProgress, path.basename(job.archive));
    } catch (err) {
      const e = err as EngineError;
      emitError(taskId, 'extract', onProgress, e.message ?? String(err), e.code);
    } finally {
      if (watchTimer) clearInterval(watchTimer);
      if (!committed) { try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* 残留交启动回收 */ } }
      txnRemove(uid);
      release?.();
      tasks.delete(taskId);
    }
  })();

  return { taskId };
}

/** 解压完成后按用户指定的新名重命名落地条目(在暂存目录内执行);单条失败不影响整体结果 */
function applyExtractRenames(job: ExtractJob, root: string): void {
  if (!job.renames) return;
  for (const [entry, newName] of Object.entries(job.renames)) {
    try {
      /* 剪除 . / .. 段:恶意条目名(../../x)不得借重命名逃出目标目录(zip-slip 防线) */
      const parts = sanitizeEntryPath(entry);
      const clean = newName.replace(/[\\/:*?"<>|]/g, '').trim();
      if (!parts?.length || !clean || /^\.+$/.test(clean) || clean === parts[parts.length - 1]) continue;
      const src = path.resolve(root, ...parts);
      if (src !== root && !src.startsWith(root + path.sep)) continue; // 最终校验:解析后仍在解压根内
      const dst = path.resolve(path.dirname(src), clean);
      if (!dst.startsWith(root + path.sep)) continue;
      if (src !== dst && fs.existsSync(src) && !fs.existsSync(dst)) fs.renameSync(src, dst);
    } catch { /* 重命名失败时保留原名 */ }
  }
}

/**
 * ask 模式预检:列出解压后会覆盖目标目录已有文件的条目(上限 50 项)。
 * 7z 经管道时无法交互询问且 -y 恒传,不预检则「询问」实际等于静默覆盖。
 * 列目录失败(加密无密码/引擎异常)时返回空 = 不拦截,由任务错误链路兜底。
 */
export async function extractConflicts(job: ExtractJob): Promise<string[]> {
  let info: ArchiveInfo;
  try { info = await listArchive(job.archive, job.password); } catch { return []; }
  const sels = (job.entries ?? []).map((s) => s.replace(/\/+$/, ''));
  const inSel = (p: string) => !sels.length || sels.some((s) => p === s || p.startsWith(`${s}/`));
  const out: string[] = [];
  for (const e of info.entries) {
    if (e.isDir || e.path.endsWith('/') || !inSel(e.path)) continue;
    const parts = e.path.split('/').filter((s) => s && s !== '.' && s !== '..');
    if (!parts.length) continue;
    try { if (fs.existsSync(path.resolve(job.dest, ...parts))) out.push(e.path); } catch { /* 非法段跳过 */ }
    if (out.length >= 50) break;
  }
  return out;
}

/** 提取单个文件到临时目录并返回其绝对路径(双击预览用) */
export async function extractSingleToTemp(archive: string, entry: string, password?: string): Promise<string> {
  /* 恶意条目名(../x、C:/x)绝不能逃出临时根:previewEntry 会按返回路径的父目录做
     递归清理,一旦逃逸等价于「预览顺手删用户目录」(阶段 3.2 修复的 P0 缺陷) */
  const parts = sanitizeEntryPath(entry);
  if (!parts) throw new EngineError(ERR.UNSAFE_PATH, '非法条目路径。');
  const dest = path.join(os.tmpdir(), 'TongZip', randomUUID().slice(0, 8));
  fs.mkdirSync(dest, { recursive: true });
  const args = ['x', '-y', '-spd'];
  if (password) args.push(`-p${password}`);
  args.push(archive, entry, `-o${dest}`);
  try {
    await probeArgs(args);
  } catch (err) {
    const e = err as { stdout?: string; message?: string };
    const why = interpretFailure(2, (e.stdout ?? '') + (e.message ?? ''));
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
    if (why.needsPassword) throw new EngineError(ERR.NEED_PASSWORD, '该文件需要密码。');
    throw new Error(why.message);
  }
  const direct = path.join(dest, ...parts);
  let hit: string | null = fs.existsSync(direct) ? direct : null;
  if (!hit) {
    /* 兜底遍历:收集全部落地文件,优先同名匹配(7z 对异常条目名可能改写入位置),
       避免盲取第一个文件导致「双击打开 a.txt 实际打开 b.txt」的错拿 */
    const want = path.basename(entry).toLowerCase();
    const found: string[] = [];
    const walk = (d: string) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, f.name);
        if (f.isSymbolicLink()) continue; // 链接产物不参与单文件提取
        if (f.isDirectory()) walk(fp); else found.push(fp);
      }
    };
    walk(dest);
    hit = found.find((f) => f.toLowerCase() === direct.toLowerCase())
      ?? found.find((f) => path.basename(f).toLowerCase() === want)
      ?? found[0] ?? null;
  }
  if (!hit) throw new Error('提取失败:未找到目标文件。');
  /* 返回值必须仍在本次临时根内:越界即丢弃(宁可失败,不可把目录外路径交给调用方) */
  const resolved = path.resolve(hit);
  const root = path.resolve(dest);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
    throw new EngineError(ERR.UNSAFE_PATH, '条目落地位置越界,已阻止打开。');
  }
  return hit;
}

/* ------------------------------------------------------------------ */
/* 预览 / 体积统计                                                     */
/* ------------------------------------------------------------------ */

const TEXT_EXT = new Set(['txt', 'md', 'log', 'csv', 'json', 'xml', 'yml', 'yaml', 'ini', 'conf', 'cfg',
  'js', 'mjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less', 'html', 'htm', 'svg', 'py', 'rs', 'go', 'c',
  'h', 'cpp', 'hpp', 'cs', 'java', 'kt', 'swift', 'sh', 'bat', 'ps1', 'lua', 'rb', 'php', 'sql', 'toml', 'env']);
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif' };
const PREVIEW_TEXT_MAX = 64 * 1024;
const PREVIEW_IMAGE_MAX = 8 * 1024 * 1024;
/** 文本嗅探整体读入上限:扩展名是 .log 的 10GB 文件绝不能整读进内存(3.2 资源防护) */
const PREVIEW_READ_CAP = 16 * 1024 * 1024;

/** 解压单个条目并归类为文本/图片预览(其余只返回元信息) */
export async function previewEntry(archive: string, entry: string, password?: string): Promise<EntryPreview> {
  const local = await extractSingleToTemp(archive, entry, password);
  const name = path.basename(local);
  const ext = path.extname(name).slice(1).toLowerCase();
  try {
    const size = fs.statSync(local).size;
    /* 图片优先:避免小尺寸图片(内嵌 0 字节前的文本嗅探区)被误判为文本 */
    if (IMAGE_MIME[ext] && size <= PREVIEW_IMAGE_MAX) {
      const b64 = fs.readFileSync(local).toString('base64');
      return { kind: 'image', name, size, dataUrl: `data:${IMAGE_MIME[ext]};base64,${b64}` };
    }
    if (TEXT_EXT.has(ext) || size < 4096) {
      /* 只读防护上限内的前缀:嗅探 0 字节 + 截断文本,巨型文件不进内存 */
      const buf = Buffer.alloc(Math.min(size, PREVIEW_READ_CAP));
      const fd = fs.openSync(local, 'r');
      try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
      if (!buf.subarray(0, Math.min(buf.length, 1024)).includes(0)) {
        const text = buf.subarray(0, PREVIEW_TEXT_MAX).toString('utf8');
        return { kind: 'text', name, size, text, truncated: size > PREVIEW_TEXT_MAX };
      }
    }
    return { kind: 'file', name, size };
  } finally {
    try { fs.rmSync(path.dirname(local), { recursive: true, force: true, maxRetries: 2 }); } catch { /* 清理失败不影响预览 */ }
  }
}

/** 递归统计待压缩源的总体积(目录深度限 8,跳过符号链接) */
export function totalSize(paths: string[]): number {
  let sum = 0;
  const walk = (p: string, depth: number) => {
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) return;
      if (st.isFile()) { sum += st.size; return; }
      if (st.isDirectory() && depth < 8) {
        for (const child of fs.readdirSync(p)) walk(path.join(p, child), depth + 1);
      }
    } catch { /* 无权访问的子项跳过 */ }
  };
  for (const p of paths) walk(p, 0);
  return sum;
}

/* ------------------------------------------------------------------ */
/* 测试 / 删除条目                                                     */
/* ------------------------------------------------------------------ */

export async function runTest(archive: string, password: string | undefined, onProgress: ProgressFn): Promise<{ taskId: string }> {
  engineExe();
  const taskId = randomUUID();
  const handle: TaskHandle = { proc: null, cancelled: false };
  tasks.set(taskId, handle);
  emitStart(taskId, 'test', onProgress);
  const args = ['t', '-y'];
  if (password) args.push(`-p${password}`); // 密码仅能走 argv,见 compressArgs 内实测说明
  args.push(archive);
  (async () => {
    let release: (() => void) | null = null;
    try {
      release = await acquireHeavySlot(handle); // 完整性测试同样吃 CPU/磁盘,纳入重型并发闸(3.2)
      if (handle.cancelled) return finishCancel(taskId, 'test', onProgress);
      const r = await runStep(handle, taskId, 'test', args, onProgress);
      if (handle.cancelled) return finishCancel(taskId, 'test', onProgress);
      if (r.code > 1) {
        const why = interpretFailure(r.code, r.stdout);
        return emitError(taskId, 'test', onProgress, why.message, why.needsPassword ? ERR.NEED_PASSWORD : undefined);
      }
      emitDone(taskId, 'test', onProgress, '压缩包完好。');
    } catch (err) {
      emitError(taskId, 'test', onProgress, (err as Error).message);
    } finally { release?.(); tasks.delete(taskId); }
  })();
  return { taskId };
}

/**
 * 删除条目(事务化 3.1):一律在同目录副本上执行 7za d,校验通过后才替换原归档;
 * 引擎报错/校验失败/取消/崩溃都不碰原件。password 供加密头归档使用。
 */
export async function runDelete(archive: string, entries: string[], onProgress: ProgressFn, password?: string): Promise<{ taskId: string }> {
  engineExe();
  const taskId = randomUUID();
  const uid = taskId.slice(0, 8);
  const handle: TaskHandle = { proc: null, cancelled: false };
  tasks.set(taskId, handle);
  emitStart(taskId, 'delete', onProgress);
  (async () => {
    let tmp: string | undefined;
    let handedOff = false;
    try {
      tmp = stageForModify(archive, uid).tmp;
      const args = ['d', '-y', '-spd'];
      if (password) args.push(`-p${password}`);
      args.push(tmp, ...entries);
      const r = await runStep(handle, taskId, 'delete', args, onProgress);
      if (handle.cancelled) return finishCancel(taskId, 'delete', onProgress);
      if (r.code > 1) {
        const why = interpretFailure(r.code, r.stdout);
        return emitError(taskId, 'delete', onProgress, `${why.message}原压缩包未做任何修改。`, why.needsPassword ? ERR.NEED_PASSWORD : undefined);
      }
      await verifyArchiveArtifact(tmp, password);
      handedOff = true; // 文件/journal 归属移交替换流程
      commitTxnSwap(archive, tmp, uid);
      emitDone(taskId, 'delete', onProgress, '');
    } catch (err) {
      const e = err as EngineError;
      emitError(taskId, 'delete', onProgress, e.message ?? String(err), e.code);
    } finally {
      if (!handedOff && tmp) abortTxn(uid, tmp);
      tasks.delete(taskId);
    }
  })();
  return { taskId };
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

/** 生成不冲突的默认输出路径 */
export function defaultOutputFor(sources: string[], ext = '.7z'): string {
  if (!sources.length) return '';
  const first = sources[0];
  const dir = path.dirname(first);
  const base = sources.length === 1 ? path.basename(first, path.extname(first)) : '归档';
  let p = path.join(dir, `${base}${ext}`);
  let i = 2;
  while (fs.existsSync(p)) p = path.join(dir, `${base} (${i++})${ext}`);
  return p;
}

/** 快速解压的目录名 */
export function quickExtractDest(archive: string): string {
  const dir = path.dirname(archive);
  const base = path.basename(archive);
  const stem = base.replace(/(\.tar)?\.(7z|zip|rar|tar|gz|tgz|bz2|tbz2|xz|txz|zst|0\d{2})$/i, '')
    || base;
  let p = path.join(dir, stem);
  let i = 2;
  while (fs.existsSync(p)) p = path.join(dir, `${stem} (${i++})`);
  return p;
}
