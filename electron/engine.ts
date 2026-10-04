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
  JobKind,
  ProgressEvent,
} from '../shared/types';
import { isArchiveExt } from '../shared/types';

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
    'ENGINE_MISSING',
    '未找到压缩引擎。请安装 7-Zip,或在设置中手动指定 7z.exe 路径。',
  );
}

function infoFrom(stdout: string, exe: string, source: EngineInfo['source']): EngineInfo {
  const m = stdout.match(/7-?Zip(?:\s*\([a-zA-Z]\))?\s+([0-9][0-9a-zA-Z.]*)/i);
  return { path: exe, version: m ? m[1] : '未知', source };
}

function engineExe(): string {
  if (!cachedEngine) throw new EngineError('ENGINE_MISSING', '压缩引擎未就绪,请先检测引擎。');
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
  const scriptPath = path.join(os.tmpdir(), 'TongZip', `suspend-${pid}-${suspend ? 's' : 'r'}.ps1`);
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
function emitError(taskId: string, kind: JobKind, onProgress: ProgressFn, message: string) {
  onProgress({ taskId, kind, percent: 0, file: '', status: 'error', message });
}

/** 将失败退出码翻译成用户可读原因 */
function interpretFailure(code: number, stdout: string): { message: string; needsPassword: boolean } {
  const lower = stdout.toLowerCase();
  const needsPassword =
    lower.includes('wrong password') || lower.includes('data error in encrypted') ||
    lower.includes('not correct password');
  if (needsPassword) return { message: '密码不正确。', needsPassword: true };
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
  /* 兑底也附上引擎输出末几行,避免只报裸退出码 */
  const detail = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(-2).join(' / ');
  return { message: `引擎返回错误 (code ${code})${detail ? `: ${detail.slice(0, 160)}` : ''}`, needsPassword: false };
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
    if (e.code === 'ENOENT') throw new EngineError('ENGINE_MISSING', '压缩引擎未就绪。');
    const text = (e.stdout ?? '') + (e.message ?? '');
    const why = interpretFailure(2, text);
    if (why.needsPassword) throw new EngineError('NEED_PASSWORD', '该压缩包已加密。');
    throw new EngineError('LIST_FAILED', why.message);
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
    execFile(engineExe(), args, { windowsHide: true, maxBuffer: 128 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
      const text = decodeEngineOutput(Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0));
      if (err) reject(Object.assign(err, { stdout: text })); else resolve({ stdout: text });
    });
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
    args.push(`-p${job.password}`);
    if (fmt === '7z' && job.encryptHeaders) args.push('-mhe=on');
  }
  if (job.volume && (fmt === '7z' || fmt === 'zip')) args.push(`-v${job.volume}`);
  args.push(...job.sources);
  return args;
}

/**
 * 创建/追加压缩包;复合格式内部两阶段(先生成 tar 再整体压缩),共用一个 taskId。
 * 返回的 Promise 在引擎就绪且任务启动后 resolve;结果通过 onProgress 事件流反馈。
 */
export async function runCompress(job: CompressJob, onProgress: ProgressFn): Promise<{ taskId: string }> {
  engineExe(); // 引擎不可用直接抛 EngineError
  const taskId = randomUUID();
  const handle: TaskHandle = { proc: null, cancelled: false };
  tasks.set(taskId, handle);
  emitStart(taskId, 'compress', onProgress);
  const compound = COMPOUND[job.format];

  (async () => {
    try {
      if (compound) {
        const uid = taskId.slice(0, 8);
        const tar = path.join(os.tmpdir(), `tongzip-${uid}.tar`);
        const tmpOut = path.join(os.tmpdir(), `tongzip-${uid}.tmp`);
        const r1 = await runStep(handle, taskId, 'compress', compressArgs({ ...job, format: 'tar' }, tar), onProgress);
        if (handle.cancelled) return finishCancel(taskId, 'compress', onProgress);
        if (r1.code > 1) return emitError(taskId, 'compress', onProgress, interpretFailure(r1.code, r1.stdout).message);
        const r2 = await runStep(handle, taskId, 'compress', ['a', '-y', `-t${compound}`, tmpOut, tar], onProgress);
        fs.rmSync(tar, { force: true });
        if (handle.cancelled) { fs.rmSync(tmpOut, { force: true }); return finishCancel(taskId, 'compress', onProgress); }
        if (r2.code > 1 || !fs.existsSync(tmpOut)) {
          fs.rmSync(tmpOut, { force: true });
          return emitError(taskId, 'compress', onProgress, r2.code > 1 ? interpretFailure(r2.code, r2.stdout).message : '压缩未生成输出文件。');
        }
        try {
          fs.mkdirSync(path.dirname(job.output), { recursive: true });
          fs.rmSync(job.output, { force: true });
          fs.renameSync(tmpOut, job.output);
        } catch (e) {
          return emitError(taskId, 'compress', onProgress, `写入目标失败: ${(e as Error).message}`);
        }
        emitDone(taskId, 'compress', onProgress, path.basename(job.output));
      } else {
        const r = await runStep(handle, taskId, 'compress', compressArgs(job, job.output), onProgress);
        if (handle.cancelled) return finishCancel(taskId, 'compress', onProgress);
        if (r.code > 1) return emitError(taskId, 'compress', onProgress, interpretFailure(r.code, r.stdout).message);
        emitDone(taskId, 'compress', onProgress, path.basename(job.output));
      }
    } catch (err) {
      emitError(taskId, 'compress', onProgress, (err as Error).message);
    } finally {
      tasks.delete(taskId);
    }
  })();

  return { taskId };
}

type JobKindName = JobKind;
void (0 as unknown as JobKindName);
function finishCancel(_id: string, kind: JobKind, fn: ProgressFn) {
  fn({ taskId: _id, kind, percent: 0, file: '', status: 'cancelled', message: '任务已取消。' });
}

/* ------------------------------------------------------------------ */
/* 解压                                                                */
/* ------------------------------------------------------------------ */

export async function runExtract(job: ExtractJob, onProgress: ProgressFn): Promise<{ taskId: string }> {
  engineExe();
  const taskId = randomUUID();
  const handle: TaskHandle = { proc: null, cancelled: false };
  tasks.set(taskId, handle);
  emitStart(taskId, 'extract', onProgress);

  const args = ['x', '-y', '-spd']; // -spd: 条目名字面匹配,防 */?/# 误扩展连带解压其他条目
  if (job.overwrite === 'overwrite') args.push('-aoa');
  else if (job.overwrite === 'skip') args.push('-aos');
  else if (job.overwrite === 'rename') args.push('-aou');
  if (job.password) args.push(`-p${job.password}`);
  /* 7z 把第一个非开关参数当压缩包:archive 必须在 entries 之前 */
  args.push(job.archive);
  if (job.entries?.length) args.push(...job.entries);
  args.push(`-o${job.dest}`);

  (async () => {
    try {
      fs.mkdirSync(job.dest, { recursive: true });
      const r = await runStep(handle, taskId, 'extract', args, onProgress);
      if (handle.cancelled) return finishCancel(taskId, 'extract', onProgress);
      if (r.code > 1) {
        const why = interpretFailure(r.code, r.stdout);
        if (why.needsPassword && !job.password) {
          return emitError(taskId, 'extract', onProgress, 'NEED_PASSWORD');
        }
        return emitError(taskId, 'extract', onProgress, why.message);
      }
      applyExtractRenames(job);
      emitDone(taskId, 'extract', onProgress, path.basename(job.archive));
    } catch (err) {
      emitError(taskId, 'extract', onProgress, (err as Error).message);
    } finally {
      tasks.delete(taskId);
    }
  })();

  return { taskId };
}

/** 解压完成后按用户指定的新名重命名落地条目;单条失败不影响整体结果 */
function applyExtractRenames(job: ExtractJob): void {
  if (!job.renames) return;
  for (const [entry, newName] of Object.entries(job.renames)) {
    try {
      const parts = entry.split('/').filter(Boolean);
      const clean = newName.replace(/[\\/:*?"<>|]/g, '').trim();
      if (!parts.length || !clean || clean === parts[parts.length - 1]) continue;
      const src = path.join(job.dest, ...parts);
      const dst = path.join(path.dirname(src), clean);
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.renameSync(src, dst);
    } catch { /* 重命名失败时保留原名 */ }
  }
}

/** 提取单个文件到临时目录并返回其绝对路径(双击预览用) */
export async function extractSingleToTemp(archive: string, entry: string, password?: string): Promise<string> {
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
    if (why.needsPassword) throw new EngineError('NEED_PASSWORD', '该文件需要密码。');
    throw new Error(why.message);
  }
  const direct = path.join(dest, entry.replace(/\//g, path.sep));
  if (fs.existsSync(direct)) return direct;
  const walk = (d: string): string | null => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, f.name);
      if (f.isDirectory()) { const r = walk(fp); if (r) return r; } else return fp;
    }
    return null;
  };
  const first = walk(dest);
  if (!first) throw new Error('提取失败:未找到目标文件。');
  return first;
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
      const buf = fs.readFileSync(local);
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
  if (password) args.push(`-p${password}`);
  args.push(archive);
  (async () => {
    try {
      const r = await runStep(handle, taskId, 'test', args, onProgress);
      if (handle.cancelled) return finishCancel(taskId, 'test', onProgress);
      if (r.code > 1) return emitError(taskId, 'test', onProgress, interpretFailure(r.code, r.stdout).message);
      emitDone(taskId, 'test', onProgress, '压缩包完好。');
    } catch (err) {
      emitError(taskId, 'test', onProgress, (err as Error).message);
    } finally { tasks.delete(taskId); }
  })();
  return { taskId };
}

export async function runDelete(archive: string, entries: string[], onProgress: ProgressFn): Promise<{ taskId: string }> {
  engineExe();
  const taskId = randomUUID();
  const handle: TaskHandle = { proc: null, cancelled: false };
  tasks.set(taskId, handle);
  emitStart(taskId, 'delete', onProgress);
  (async () => {
    try {
      const r = await runStep(handle, taskId, 'delete', ['d', '-y', '-spd', archive, ...entries], onProgress);
      if (handle.cancelled) return finishCancel(taskId, 'delete', onProgress);
      if (r.code > 1) return emitError(taskId, 'delete', onProgress, interpretFailure(r.code, r.stdout).message);
      emitDone(taskId, 'delete', onProgress, '');
    } catch (err) {
      emitError(taskId, 'delete', onProgress, (err as Error).message);
    } finally { tasks.delete(taskId); }
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
