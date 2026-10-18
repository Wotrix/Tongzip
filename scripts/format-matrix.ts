/**
 * 阶段 4 · 交付物二 — 格式能力实测矩阵(npm run fmt-matrix)
 *
 * 三层对照,全部以实测为唯一依据:
 *  L1 声明层  解析随包 7za `i` 输出的格式/扩展名清单;
 *  L2 引擎层  逐格式族实测 打开/解压(字节校验)/创建/test/加密创建/正确密码解/错误密码行为;
 *             RAR/ISO/ZSTD/CAB/ZIPX/分卷按各自能力实况记录(负向也要"干净失败")。
 *  L3 应用层  真实产物经 CDP 走 preload IPC:
 *             X1 应用声明的每个可开后缀 × 对应真实字节 → listArchive 必须可开;
 *             X2 SYS_ONLY 后缀假样本 → 必须返回明确 ERR(非静默、非挂起);
 *             X3 UI 提供的全套创建格式(含 tar.zst)→ 成功或干净失败,行为必须明确;
 *             另核"tar 族填密码是否被静默忽略"(产品诚实性问题)。
 * 输出 docs/phase4/format-matrix.json;交叉不一致计入断言失败,非零退出。
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  assert, cdpEval, engineRun, installEventCollector, killHard, makeLowEntropy, mkTemp, note,
  pickFreePort, q, runProbe, sha256, spawnApp, takeEvents, waitReady, writeOutJson, type ProbeApp,
} from './probe-lib';
import { ARCHIVE_EXTS_OPENABLE, ARCHIVE_EXTS_SYS_ONLY } from '../shared/types';

const PW = 'Fmt-Matrix-pw-ASCII-9'; // 加密往返基线用 ASCII:实测发现 zip 族非 ASCII 密码另立专项(见 L2 pw-unicode)
const ORIG_CWD = process.cwd(); // L2 需要 chdir(SRC) 做相对入包;产物路径必须锤定原始 cwd,否则 writeOutJson 会落进 %TEMP% 工作目录被 cleanupAll 删掉
const PW_UNI = 'Fmt#矩阵-pw-9';
const SRC_TXT = 'TongZip phase4 format probe ✓ 中文 ünïcode\n'.repeat(64);
const ENGINE = (() => {
  const u = path.resolve('release/win-unpacked/resources/engine/7za.exe');
  return fs.existsSync(u) ? u : path.resolve('engine/7za.exe');
})();
const APP_EXE = path.resolve('release/win-unpacked/TongZip.exe');
let WORK = '';
let SRC = '';
let ARC = '';
let XDIR = '';

interface Cell { create?: string; list?: string; extract?: string; test?: string; enc?: string; decOk?: string; decWrong?: string; note?: string }
interface Finding { id: string; level: 'engine' | 'app'; ext?: string; format?: string; expect: string; actual: string; verdict: 'ok' | 'mismatch' | 'note'; detail: string }
const findings: Finding[] = [];
const cells: Record<string, Cell> = {};
function record(f: Omit<Finding, 'verdict'> & { verdict?: Finding['verdict'] }): void {
  const rec = { ...f, id: f.id ?? `${f.level}:${f.ext ?? f.format ?? ''}`, verdict: f.verdict ?? 'note' } as Finding;
  findings.push(rec);
  const line = `[${rec.level}${rec.ext ? ' ' + rec.ext : ''}${rec.format ? ' ' + rec.format : ''}] 期望=${rec.expect} 实际=${rec.actual} :: ${rec.detail.slice(0, 140)}`;
  if (rec.verdict === 'mismatch') assert(false, '矩阵不一致 ' + line); else if (rec.verdict === 'ok') console.log('  ✓', line); else console.log('  ·', line);
}

/* ---------------- L1 声明层 ---------------- */

function parseFormats(iOut: string): { name: string; exts: string[] }[] {
  const lines = iOut.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === 'Formats:');
  const end = lines.findIndex((l) => l.trim() === 'Codecs:');
  const out: { name: string; exts: string[] }[] = [];
  for (const l of lines.slice(start + 1, end > start ? end : undefined)) {
    if (!/^\s{3,}\S/.test(l)) continue;
    const m = /^\s+(?:[A-Z*']+\s+)*(\S+)\s+(.*)$/.exec(l);
    if (!m) continue;
    const exts = (m[2] ?? '').split(/\s+/).filter((t) => /^[a-z0-9.]{2,}$/.test(t) && !/^[0-9a-f]{2}$/.test(t));
    out.push({ name: m[1], exts });
  }
  return out;
}

/* ---------------- L2 引擎往返实测 ---------------- */

interface Rt { fmt: string; arcName: string; srcArgs: string[]; verify: 'container' | 'singleFrom'; pw?: boolean; mhe?: boolean; createUnsupportedOk?: boolean }
function roundtrip(rt: Rt): void {
  const c = (cells[rt.fmt] = cells[rt.fmt] ?? {});
  const arc = path.join(ARC, rt.arcName);
  const mkArgs = (extra: string[]) => ['a', '-y', `-t${rt.fmt}`, ...extra, arc, ...rt.srcArgs];
  const rc = engineRun(ENGINE, mkArgs([]), 120_000);
  c.create = rc.status === 0 ? 'ok' : `fail(status=${rc.status})`;
  if (rc.status !== 0) {
    c.note = rc.out.slice(0, 120);
    if (rt.createUnsupportedOk) record({ id: `L2:${rt.fmt}:create`, level: 'engine', format: rt.fmt, expect: '独立版声明无创建能力(C 标志缺失)', actual: `status=${rc.status} ${rc.out.match(/System ERROR:[\s\S]*?$/)?.[0].replace(/\s+/g, ' ').slice(0, 40) ?? ''}`, verdict: 'ok', detail: '创建不支持但读取正常,属声明-实测一致的能力边界' });
    return;
  }
  c.list = engineRun(ENGINE, ['l', '-slt', arc]).status === 0 ? 'ok' : 'fail';
  c.test = engineRun(ENGINE, ['t', '-y', arc], 120_000).status === 0 ? 'ok' : 'fail';
  const dest = path.join(XDIR, rt.fmt);
  fs.mkdirSync(dest, { recursive: true });
  const rx = engineRun(ENGINE, ['x', '-y', arc, `-o${dest}`], 120_000);
  c.extract = rx.status !== 0 ? `fail(status=${rx.status})` : verifyExtract(dest, rt.verify) ? 'ok+bytes' : 'FAIL-DATA';
  if (rx.status !== 0) c.note = rx.out.slice(0, 120);
  if (!rt.pw) return;

  /* 加密往返:独立副本加密创建 → 正确密码可解 → 错误密码必须干净失败 → (7z)头加密行为 */
  const encArc = path.join(ARC, `enc.${rt.fmt}`);
  const encArgs = ['a', '-y', `-t${rt.fmt}`, `-p${PW}`, ...(rt.mhe ? ['-mhe=on'] : []), encArc, ...rt.srcArgs];
  const re = engineRun(ENGINE, encArgs, 120_000);
  c.enc = re.status === 0 ? 'ok' : `fail(status=${re.status})`;
  if (re.status !== 0) return;
  const d1 = path.join(XDIR, `${rt.fmt}-pwok`); fs.mkdirSync(d1, { recursive: true });
  c.decOk = engineRun(ENGINE, ['x', '-y', `-p${PW}`, encArc, `-o${d1}`], 120_000).status === 0 ? 'ok' : 'fail';
  const d2 = path.join(XDIR, `${rt.fmt}-pwwrong`); fs.mkdirSync(d2, { recursive: true });
  const rw = engineRun(ENGINE, ['x', '-y', '-pWrong-Pass!999', encArc, `-o${d2}`], 120_000);
  record({ id: `L2:${rt.fmt}:wrongpw`, level: 'engine', format: rt.fmt, expect: '错误密码干净失败(非零)', actual: `status=${rw.status}`, verdict: rw.status !== 0 ? 'ok' : 'mismatch', detail: rw.out.slice(0, 120) });
  if (rt.mhe) {
    const anon = engineRun(ENGINE, ['l', '-slt', encArc]);
    const withpw = engineRun(ENGINE, ['l', '-slt', `-p${PW}`, encArc]);
    record({ id: `L2:${rt.fmt}:mhe`, level: 'engine', format: rt.fmt, expect: '头加密:无名不可列/有密码可列', actual: `anon=${anon.status} pw=${withpw.status}`, verdict: anon.status !== 0 && withpw.status === 0 ? 'ok' : 'mismatch', detail: anon.out.slice(0, 100) });
  }
}

function verifyExtract(dest: string, mode: 'container' | 'singleFrom'): boolean {
  const files = walkFiles(dest);
  if (mode === 'container') {
    const a = files.find((f) => f.endsWith('a.txt'));
    const b = files.find((f) => f.endsWith(path.join('sub', 'b.bin')) || f.endsWith('b.bin'));
    return !!a && fs.readFileSync(a, 'utf8') === SRC_TXT && !!b && fs.statSync(b).size === fs.statSync(path.join(SRC, 'sub', 'b.bin')).size;
  }
  /* singleFrom:解出恰好一个文件且与某个已知源文件同哈希(gzip/lzma 头内名称形态不定,按内容认) */
  if (files.length !== 1) return false;
  const got = sha256(files[0]);
  const candidates = [path.join(ARC, 't.tar'), path.join(SRC, 'sample.bin'), path.join(SRC, 'a.txt')];
  return candidates.some((cand) => fs.existsSync(cand) && sha256(cand) === got);
}
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const st = fs.statSync(dir, { throwIfNoEntry: false });
  if (!st?.isDirectory()) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p)); else out.push(p);
  }
  return out;
}

/* ---------------- L3 应用层 ---------------- */

async function appList(app: ProbeApp, file: string, password?: string): Promise<{ ok: boolean; code: string; type?: string }> {
  const v = await cdpEval(app, `window.tz.listArchive(${q(file)},${password ? q(password) : 'undefined'}).then(r => r.ok ? JSON.stringify({ok:true,type:r.data.type}) : JSON.stringify({ok:false,code:r.code}))`, 30000);
  if (typeof v !== 'string' || !v) return { ok: false, code: 'CDP_NULL' };
  try { return JSON.parse(v) as { ok: boolean; code: string; type?: string }; } catch { return { ok: false, code: 'CDP_PARSE' }; }
}

async function appRunTask(app: ProbeApp, invokeExpr: string, timeoutMs = 60_000): Promise<{ status: string; code: string | null; message: string | null }> {
  const v = await cdpEval(app, `${invokeExpr}.then(r => r.ok && r.data && r.data.taskId ? r.data.taskId : (r.ok ? 'SYNC' : 'IPCERR:' + JSON.stringify({ code: r.code, message: r.message })))`, 30000);
  if (typeof v !== 'string') return { status: 'cdp_bad_return', code: null, message: String(v) };
  if (v === 'SYNC') return { status: 'sync_done', code: null, message: null };
  if (v.startsWith('IPCERR:')) { const j = JSON.parse(v.slice(7)) as { code: string; message: string }; return { status: 'ipc_error', code: j.code, message: j.message }; }
  /* 直接异步轮询事件流至终态/超时(waitFor 判据是同步函数,不能包 Promise) */
  const t0 = Date.now();
  for (;;) {
    const evs = await takeEvents(app);
    for (const e of evs) if (e.taskId === v && e.status !== 'running') terminals.set(v, { status: e.status, code: e.code, message: e.message });
    const term = terminals.get(v);
    if (term) return term;
    if (Date.now() - t0 > timeoutMs) return { status: 'timeout', code: null, message: null };
    await new Promise((r) => setTimeout(r, 50));
  }
}
const terminals = new Map<string, { status: string; code: string | null; message: string | null }>();

/* ---------------- 主流程 ---------------- */

async function main(): Promise<void> {
  console.log(`引擎: ${ENGINE}`);
  console.log(`应用: ${fs.existsSync(APP_EXE) ? APP_EXE : '<缺失:应用层将标注未验证>'}`);
  WORK = mkTemp('tz-fmt-');
  SRC = path.join(WORK, 'src'); ARC = path.join(WORK, 'arc'); XDIR = path.join(WORK, 'x');
  fs.mkdirSync(path.join(SRC, 'sub'), { recursive: true });
  fs.mkdirSync(ARC, { recursive: true });
  fs.mkdirSync(XDIR, { recursive: true });
  fs.writeFileSync(path.join(SRC, 'a.txt'), SRC_TXT, 'utf8');
  makeLowEntropy(path.join(SRC, 'sub', 'b.bin'), 1);
  makeLowEntropy(path.join(SRC, 'sample.bin'), 1);

  /* ---- L1 ---- */
  console.log('── L1 引擎声明层 ──');
  const iOut = engineRun(ENGINE, ['i'], 30_000).out;
  const declared = parseFormats(iOut);
  const declaredExtSet = new Set(declared.flatMap((d) => d.exts));
  for (const d of declared) console.log(`  ${d.name}: ${d.exts.join(' ')}`);
  for (const x of ['rar', 'rar5', 'iso', 'zst', 'wim']) {
    record({ id: `L1:${x}`, level: 'engine', ext: x, expect: '声明层存在性核验', actual: declaredExtSet.has(x) ? 'present' : 'absent', detail: `7za i ${declaredExtSet.has(x) ? '含' : '不含'} ${x}(打包引擎能力边界的声明侧证据)` });
  }

  /* ---- L2 ---- */
  console.log('── L2 引擎实测层 ──');
  process.chdir(SRC); // 容器类相对入包,条目路径干净
  roundtrip({ fmt: '7z', arcName: 't.7z', srcArgs: ['a.txt', 'sub', 'sample.bin'], verify: 'container', pw: true, mhe: true });
  roundtrip({ fmt: 'zip', arcName: 't.zip', srcArgs: ['a.txt', 'sub', 'sample.bin'], verify: 'container', pw: true });
  roundtrip({ fmt: 'tar', arcName: 't.tar', srcArgs: ['a.txt', 'sub', 'sample.bin'], verify: 'container' });
  roundtrip({ fmt: 'gzip', arcName: 't.tar.gz', srcArgs: [path.join(ARC, 't.tar')], verify: 'singleFrom' });
  roundtrip({ fmt: 'bzip2', arcName: 't.tar.bz2', srcArgs: [path.join(ARC, 't.tar')], verify: 'singleFrom' });
  roundtrip({ fmt: 'xz', arcName: 't.tar.xz', srcArgs: [path.join(ARC, 't.tar')], verify: 'singleFrom' });
  roundtrip({ fmt: 'lzma', arcName: 's.lzma', srcArgs: ['sample.bin'], verify: 'singleFrom', createUnsupportedOk: true });
  roundtrip({ fmt: 'lzma86', arcName: 's.lzma86', srcArgs: ['sample.bin'], verify: 'singleFrom', createUnsupportedOk: true });
  process.chdir(ORIG_CWD); // 后续全部绝对路径;必须离开 WORK,否则 docs/phase4 产物会被退出清理连带删除

  /* 非 ASCII 密码专项:实测基线(zip 族曾在此翻车)——两种格式对照,失败形态必须记录 */
  for (const fmt of ['7z', 'zip'] as const) {
    const f = path.join(ARC, `uni-pw.${fmt}`);
    const ru = engineRun(ENGINE, ['a', '-y', `-t${fmt}`, `-p${PW_UNI}`, f, path.join(SRC, 'a.txt')], 30_000);
    const dx = path.join(XDIR, `unipw-${fmt}`); fs.mkdirSync(dx, { recursive: true });
    const back = ru.status === 0 ? engineRun(ENGINE, ['x', '-y', `-p${PW_UNI}`, f, `-o${dx}`], 30_000) : null;
    record({
      id: `L2:pw-unicode:${fmt}`, level: 'engine', format: fmt,
      expect: '非 ASCII 密码创建要么成功要么干净失败且报错可读',
      actual: ru.status === 0 ? `create=ok 同密解=${back?.status}` : `create=fail(status=${ru.status})`,
      verdict: ru.status === 0 ? 'ok' : 'note',
      detail: ru.status === 0 ? '' : `输出尾部=${ru.out.replace(/\s+/g, ' ').slice(-120)} — 产品需验证:用户给 ${fmt} 设中文密码时的提示形态`,
    });
  }

  /* tar 加密码是否被静默忽略(诚实性关键):加密参数接受且无密可开 = 密码形同虚设 */
  const pwTar = path.join(ARC, 'pwtest.tar');
  const rpt = engineRun(ENGINE, ['a', '-y', '-ttar', `-p${PW}`, pwTar, path.join(SRC, 'a.txt')], 30_000);
  const ptx = path.join(XDIR, 'untar-pw'); fs.mkdirSync(ptx, { recursive: true });
  const rpx = engineRun(ENGINE, ['x', '-y', pwTar, `-o${ptx}`], 30_000);
  const silentIgnore = rpt.status === 0 && rpx.status === 0;
  record({ id: 'L2:tar:pw', level: 'engine', format: 'tar', expect: '密码不被静默接受', actual: `带密创建=${rpt.status} 无密解=${rpx.status}`, verdict: silentIgnore ? 'note' : 'ok', detail: silentIgnore ? '-p 被 tar/gz/bz2/xz 族静默忽略:若 UI 允许这些格式填密码即"密码无效"欺骗,须 UI 明示或拒填' : '引擎/解侧有拒绝,行为相对诚实' });

  /* cab:makecab 真样本 → 只读核验 */
  let cabOk = false;
  try {
    const cab = path.join(ARC, 't.cab');
    execFileSync('makecab', [path.join(SRC, 'a.txt'), cab], { stdio: 'ignore' });
    const rl = engineRun(ENGINE, ['l', '-slt', cab]);
    const rd = path.join(XDIR, 'cab'); fs.mkdirSync(rd, { recursive: true });
    const rx = engineRun(ENGINE, ['x', '-y', cab, `-o${rd}`]);
    cabOk = rl.status === 0 && rx.status === 0;
    cells['Cab'] = { create: 'n/a(独立版无创建)', list: rl.status === 0 ? 'ok' : 'fail', extract: rx.status === 0 ? 'ok' : 'fail' };
  } catch { cells['Cab'] = { note: 'makecab 不可用,真样本待人工补' }; }

  /* 分卷:创建多卷 → 合体解 → 缺卷必须干净失败 */
  const v1 = path.join(ARC, 'vol.7z');
  const rv = engineRun(ENGINE, ['a', '-y', '-t7z', '-v200k', v1, path.join(SRC, 'sample.bin')], 60_000);
  const vols = fs.readdirSync(ARC).filter((n) => n.startsWith('vol.7z.')).sort();
  if (rv.status === 0 && vols.length >= 2) {
    const dv = path.join(XDIR, 'vol'); fs.mkdirSync(dv, { recursive: true });
    const full = engineRun(ENGINE, ['x', '-y', path.join(ARC, vols[0]), `-o${dv}`], 60_000);
    fs.rmSync(path.join(ARC, vols[1]));
    const dv2 = path.join(XDIR, 'vol2'); fs.mkdirSync(dv2, { recursive: true });
    const miss = engineRun(ENGINE, ['x', '-y', path.join(ARC, vols[0]), `-o${dv2}`], 60_000);
    cells['Split'] = { create: `ok(${vols.length} 卷)`, extract: full.status === 0 ? 'ok' : 'fail', decWrong: miss.status !== 0 ? 'clean-fail' : 'DANGEROUS-SILENT' };
    record({ id: 'L2:split:missing', level: 'engine', format: 'split', expect: '缺卷干净失败', actual: `status=${miss.status}`, verdict: miss.status !== 0 ? 'ok' : 'mismatch', detail: miss.out.slice(0, 120) });
  } else cells['Split'] = { create: `fail(status=${rv.status})` };

  /* 负向:rar/iso/zst 假字节必须拒绝;真样本另列人工 */
  for (const ext of ['rar', 'iso', 'zst']) {
    const f = path.join(ARC, `fake.${ext}`);
    fs.writeFileSync(f, crypto.randomBytes(4096));
    const r = engineRun(ENGINE, ['l', '-slt', f]);
    record({ id: `L2:neg:${ext}`, level: 'engine', ext, expect: '打开干净失败', actual: `status=${r.status}`, verdict: r.status !== 0 ? 'ok' : 'mismatch', detail: r.out.slice(0, 100) });
  }
  record({ id: 'L2:neg:realsample', level: 'engine', expect: '真 RAR/ISO 样本可读性(正能力面)', actual: '未测', verdict: 'note', detail: '本机无合规样本可造,真样本验证列入人工清单(不假装通过)' });
  const rz = engineRun(ENGINE, ['a', '-y', '-tzstd', path.join(ARC, 'x.zst'), path.join(SRC, 'a.txt')]);
  cells['zstd'] = { create: rz.status === 0 ? 'ok?!' : 'unsupported-clean-fail' };
  const rxz = engineRun(ENGINE, ['a', '-y', '-tzipx', path.join(ARC, 'x.zipx'), path.join(SRC, 'a.txt')]);
  cells['zipx'] = { create: rxz.status === 0 ? 'ok' : `unsupported(status=${rxz.status})`, note: '真 zipx 样本读取待人工(需完整版 7-Zip 制造)' };

  /* ---- L3 ---- */
  console.log('── L3 应用交叉层 ──');
  const x1: Record<string, string> = {}; const x2: Record<string, string> = {}; const x3: Record<string, unknown> = {};
  if (!fs.existsSync(APP_EXE)) {
    note('真实产物缺失:X1-X3 标未验证,不出通过结论(先跑 npm run gate 的打包步)');
  } else {
    const ud = mkTemp('tz-fmt-ud-');
    const app = spawnApp(APP_EXE, ud, await pickFreePort());
    try {
      await waitReady(app);
      await installEventCollector(app);

      const baseOf: Record<string, string> = {
        '7z': 't.7z', zip: 't.zip', tar: 't.tar', gz: 't.tar.gz', bz2: 't.tar.bz2', xz: 't.tar.xz',
        lzma: 's.lzma', lzma86: 's.lzma86',
      };
      const aliasOf: Record<string, string> = {
        zipx: 't.zip', z01: 't.zip', jar: 't.zip', xpi: 't.zip', odt: 't.zip', ods: 't.zip', docx: 't.zip',
        xlsx: 't.zip', epub: 't.zip', ipa: 't.zip', apk: 't.zip', appx: 't.zip', war: 't.zip', ear: 't.zip',
        gzip: 't.tar.gz', tgz: 't.tar.gz', tpz: 't.tar.gz',
        tbz2: 't.tar.bz2', tbz: 't.tar.bz2', bzip2: 't.tar.bz2', txz: 't.tar.xz',
        ova: 't.tar', cab: 't.cab', '001': 'vol.7z.001',
      };
      for (const ext of ARCHIVE_EXTS_OPENABLE) {
        const base = baseOf[ext] ?? aliasOf[ext];
        if (!base || !fs.existsSync(path.join(ARC, base))) {
          x1[ext] = 'no-sample';
          record({ id: `X1:${ext}`, level: 'app', ext, expect: '真实字节 listArchive 可开', actual: '无对应样本', verdict: 'note', detail: '列入人工清单' });
          continue;
        }
        /* z01 分卷语义:7za 需同主名首卷(t.zip)存在才能开卷集——产品行为正确,
         * 样本必须落在同名词干上;孤立 z01 的"缺卷"可读提示已由侦查实测证实 */
        const f2 = ext === 'z01' ? path.join(ARC, 't.z01') : path.join(ARC, `probe_${ext}`) + '.' + ext;
        fs.copyFileSync(path.join(ARC, base), f2);
        const r = await appList(app, f2);
        x1[ext] = r.ok ? `open(${r.type})` : `ERR:${r.code}`;
        record({ id: `X1:${ext}`, level: 'app', ext, expect: '可开', actual: x1[ext], verdict: r.ok ? 'ok' : 'mismatch', detail: `base=${base}` });
      }

      for (const ext of ARCHIVE_EXTS_SYS_ONLY) {
        const f = path.join(ARC, `sysfake.${ext}`);
        fs.writeFileSync(f, crypto.randomBytes(4096));
        const r = await appList(app, f);
        x2[ext] = r.ok ? 'DANGEROUS-OPENED' : `clean-err(${r.code})`;
        record({ id: `X2:${ext}`, level: 'app', ext, expect: '明确 ERR 非静默', actual: x2[ext], verdict: r.ok ? 'mismatch' : 'ok', detail: `code=${r.code}` });
      }

      for (const fmt of ['7z', 'zip', 'tar', 'tar.gz', 'tar.bz2', 'tar.xz', 'tar.zst'] as const) {
        const out = path.join(ARC, `app-${fmt.replace(/\./g, '_')}.${fmt}`);
        const r = await appRunTask(app, `window.tz.compress({sources:[${q(path.join(SRC, 'a.txt'))},${q(path.join(SRC, 'sub'))}],output:${q(out)},format:${q(fmt)},level:3,dict:'',solid:'off',multiThread:false})`);
        const exists = fs.existsSync(out);
        x3[fmt] = { status: r.status, code: r.code, exists, message: r.message };
        if (fmt === 'tar.zst') {
          /* ISS-02 验收:启动前预检拦截(BAD_PARAM+明确不支持),不再透传引擎裸错 */
          const clean = r.code === 'BAD_PARAM' && !exists && /不支持/.test(r.message ?? '');
          record({ id: 'X3:tar.zst', level: 'app', format: fmt, expect: 'ISS-02 验收:预检 BAD_PARAM+明示不支持,无半成品', actual: `status=${r.status} code=${r.code} exists=${exists}`, verdict: clean ? 'ok' : 'mismatch', detail: JSON.stringify(r).slice(0, 160) });
        } else {
          record({ id: `X3:${fmt}`, level: 'app', format: fmt, expect: 'done 且产物存在可再开', actual: `status=${r.status}${r.code ? '/' + r.code : ''} exists=${exists}`, verdict: r.status === 'done' && exists ? 'ok' : 'mismatch', detail: JSON.stringify(r).slice(0, 160) });
          if (r.status === 'done' && exists) {
            const le = await appList(app, out);
            record({ id: `X3:${fmt}:reopen`, level: 'app', format: fmt, expect: '产物可再开', actual: le.ok ? `open(${le.type})` : `ERR:${le.code}`, verdict: le.ok ? 'ok' : 'mismatch', detail: '' });
          }
        }
      }

      /* 应用通道:tar.gz 带密码是否静默无效(直达 UI 语义的诚实性) */
      const pwOut = path.join(ARC, 'app-pw.tar.gz');
      const rp = await appRunTask(app, `window.tz.compress({sources:[${q(path.join(SRC, 'a.txt'))}],output:${q(pwOut)},format:'tar.gz',level:3,dict:'',solid:'off',multiThread:false,password:${q(PW)}})`);
      if (rp.status === 'done' && fs.existsSync(pwOut)) {
        const no = await appList(app, pwOut);
        record({ id: 'X3:tar.gz:pw', level: 'app', format: 'tar.gz', expect: '带密创建+无密可开=密码被静默忽略,须记问题', actual: `create=done 无密可开=${no.ok}`, verdict: 'note', detail: '问题清单候选:UI/任务链允许 tar 族输入密码但密码无任何效力,用户会误以为已加密' });
      } else {
        record({ id: 'X3:tar.gz:pw', level: 'app', format: 'tar.gz', expect: '带密创建行为明确', actual: `status=${rp.status}`, verdict: 'ok', detail: JSON.stringify(rp).slice(0, 120) });
      }

      /* 应用通道:ZIP + 非 ASCII 密码——ISS-02 修复后须被启动前预检拦截:BAD_PARAM + 指明出路 */
      const uzipOut = path.join(ARC, 'app-unipw.zip');
      const ru = await appRunTask(app, `window.tz.compress({sources:[${q(path.join(SRC, 'a.txt'))}],output:${q(uzipOut)},format:'zip',level:3,dict:'',solid:'off',multiThread:false,password:${q(PW_UNI)}})`);
      record({
        id: 'X3:zip:pw-unicode', level: 'app', format: 'zip',
        expect: 'ISS-02 验收:预检拦截 code=BAD_PARAM,message 给出 ASCII/7Z 出路且无半成品',
        actual: `status=${ru.status} code=${ru.code} msg=${(ru.message ?? '').slice(0, 80)} exists=${fs.existsSync(uzipOut)}`,
        verdict: ru.code === 'BAD_PARAM' && /ASCII/.test(ru.message ?? '') && !fs.existsSync(uzipOut) ? 'ok' : 'mismatch',
        detail: JSON.stringify(ru).slice(0, 200),
      });
      /* 反向护栏:ASCII 密码的 zip 创建必须仍成功(支持格式不被误拒) */
      const azipOut = path.join(ARC, 'app-azipw.zip');
      const ra = await appRunTask(app, `window.tz.compress({sources:[${q(path.join(SRC, 'a.txt'))}],output:${q(azipOut)},format:'zip',level:3,dict:'',solid:'off',multiThread:false,password:'Ascii#Pass-9'})`);
      record({
        id: 'X3:zip:pw-ascii', level: 'app', format: 'zip',
        expect: 'ASCII 密码 zip 创建必须 done 且有产物(预检不误拦)',
        actual: `status=${ra.status} code=${ra.code} exists=${fs.existsSync(azipOut)}`,
        verdict: ra.status === 'done' && fs.existsSync(azipOut) ? 'ok' : 'mismatch',
        detail: JSON.stringify(ra).slice(0, 160),
      });
    } finally {
      killHard(app.proc.pid);
    }
  }

  for (const [k, c] of Object.entries(cells)) console.log(`  ${k}: ${JSON.stringify(c)}`);
  const outF = writeOutJson('format-matrix.json', {
    generatedAt: new Date().toISOString(), engine: ENGINE, appVerified: fs.existsSync(APP_EXE),
    engineDeclared: declared, engineCells: cells, x1_openableByExt: x1, x2_sysOnlyBehavior: x2, x3_appCreate: x3,
    findings, mismatchCount: findings.filter((f) => f.verdict === 'mismatch').length,
    note: 'cab 真样本=' + (cabOk ? 'makecab 已测' : '待人工'),
  });
  if (!fs.existsSync(outF)) record({ id: 'IO:persist', level: 'io', expect: '产物落盘存活', actual: '写入后同进程复查不存在', verdict: 'mismatch', detail: outF });
  console.log(`\n矩阵记录 ${findings.length} 项;不一致 ${findings.filter((f) => f.verdict === 'mismatch').length} 项`);
}

runProbe(main);
