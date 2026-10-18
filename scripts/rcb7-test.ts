/**
 * RC-B7 — NSIS 升级安装守卫实测(uninstall.nsh ${ifNot} ${isUpdated} 的高风险边界)
 *
 * 用户定档要求:覆盖 首次安装 / 同版本覆盖安装 / 升级安装 / 正常卸载,证明升级不触发
 * 卸载清理钩子;保存各阶段注册表快照、关联状态、安装目录与卸载器终态。
 * 纪律与 rc14-test 完全一致:备份硬校验→键面清零→临时目录安装→CDP shellInstall→
 * 覆盖/升级→断言键面不丢(守卫未误触)→卸载断言键→0→防御清理→恢复基线 diff。
 * 绝不触碰 UserChoice(只读观测)。
 *
 * 用法:node rcb7.cjs --setup0 "<Setup 1.0.0.exe>" --setup1 "<Setup 1.0.1.exe>"
 * 输出 docs/phase4/rcb7-results.json;断言失败非零退出。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  assert, cdpEval, killTree, mkTemp, note, pickFreePort, runProbe,
  spawnApp, waitFor, waitReady, writeOutJson, type ProbeApp,
} from './probe-lib';
import { ARCHIVE_EXTS, ARCHIVE_EXTS_OPENABLE, ARCHIVE_EXTS_SYS_ONLY } from '../shared/types';

const ROOT = process.cwd();
function argOf(flag: string): string {
  const i = process.argv.indexOf(flag);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`缺少参数 ${flag}`);
  return path.resolve(process.argv[i + 1]);
}
const SETUP_V0 = argOf('--setup0'); // 冻结基线 1.0.0
const SETUP_V1 = argOf('--setup1'); // 同源换版本号 1.0.1(仅 extraMetadata.version)
const CLASSES = 'HKCU\\Software\\Classes';
const APP_NAME = 'TongZip';
const UNINST_ROOT = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';

interface Finding { id: string; item: string; expect: string; actual: string; verdict: 'ok' | 'mismatch' | 'evidence' | 'note' | 'pending-real'; detail: string }
const findings: Finding[] = [];
function record(f: Finding): void {
  findings.push(f);
  const line = `[${f.id}] 期望=${f.expect} 实际=${f.actual} :: ${f.detail.slice(0, 220)}`;
  if (f.verdict === 'mismatch') assert(false, line);
  else console.log(f.verdict === 'ok' ? '  ✓' : f.verdict === 'evidence' ? '  ★' : '  ·', line);
}

/* ---------- reg 基建(与 rc14-test 同源) ---------- */
function reg(args: string[]): { code: number; out: string } {
  const r = spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
function scanTongZipKeys(): string[] {
  const r = reg(['query', CLASSES, '/f', 'TongZip', '/k', '/s']);
  const keys = new Set<string>();
  r.out.split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (/^HKEY_/i.test(t) && /tongzip/i.test(t)) keys.add(t);
  });
  return [...keys].sort();
}
function scanTongZipValues(): { key: string; value: string }[] {
  const r = reg(['query', CLASSES, '/f', 'TongZip', '/v', '/s']);
  const hits: { key: string; value: string }[] = [];
  let curKey = '';
  r.out.split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (/^HKEY_/i.test(t)) { curKey = t; return; }
    const m = t.match(/^(.+?)\s+REG_\w+/);
    if (m && /tongzip/i.test(m[1]) && curKey) hits.push({ key: curKey, value: m[1].trim() });
  });
  return hits;
}
function scanValuesByData(needle: string): { key: string; value: string; data: string }[] {
  const r = reg(['query', CLASSES, '/f', needle, '/d', '/s']);
  const hits: { key: string; value: string; data: string }[] = [];
  let curKey = '';
  r.out.split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (/^HKEY_/i.test(t)) { curKey = t; return; }
    const m = t.match(/^(.+?)\s+REG_\w+\s+(.+)$/);
    if (m && curKey) hits.push({ key: curKey, value: m[1].trim(), data: m[2].trim() });
  });
  return hits;
}
function regValue(k: string, v: string | null): string | null {
  const args = v === null ? ['query', k, '/ve'] : ['query', k, '/v', v];
  const r = reg(args);
  if (r.code !== 0) return null;
  const m = r.out.match(/REG_\S+\s+(.+)/);
  return m ? m[1].trim() : null;
}
function keyExists(k: string): boolean { return reg(['query', k]).code === 0; }

/* ---------- 卸载登记项观测(安装版本/目录/UninstallString) ---------- */
/** 实测:electron-builder 的 DisplayName 是 "TongZip <version>"(带版本号)且无 InstallLocation 值,
 *  安装目录需从 UninstallString 反推。匹配一律用前缀,不做全等。 */
function findUninstallEntry(): { key: string; displayName: string | null; displayVersion: string | null; installLocation: string | null } | null {
  const r = reg(['query', UNINST_ROOT]);
  if (r.code !== 0) return null;
  const subs = r.out.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^HKEY_/i.test(s));
  for (const s of subs) {
    const dn = regValue(s, 'DisplayName');
    if (dn === APP_NAME || (dn !== null && dn.startsWith(`${APP_NAME} `))) {
      const us = regValue(s, 'UninstallString');
      const um = us?.match(/"([^"]+Uninstall[^"]*\.exe)"/i);
      return {
        key: s, displayName: dn, displayVersion: regValue(s, 'DisplayVersion'),
        installLocation: regValue(s, 'InstallLocation') ?? (um ? path.dirname(um[1]) : null),
      };
    }
  }
  return null;
}

/* ---------- 基线键面/备份/恢复(与 rc14-test 同源纪律) ---------- */
const ALL_EXTS = [...new Set([...ARCHIVE_EXTS, ...ARCHIVE_EXTS_OPENABLE, ...ARCHIVE_EXTS_SYS_ONLY])].map((e) => `.${e}`);
function baselineKeySet(): string[] {
  const set = new Set<string>(scanTongZipKeys());
  for (const e of ALL_EXTS) {
    const cmd = regValue(`${CLASSES}\\${e}\\shell\\open\\command`, null);
    if (!cmd || !/electron\.exe|tongzip\.exe/i.test(cmd)) continue;
    const m = cmd.match(/"([^"]+\.exe)"/);
    if (m && !fs.existsSync(m[1])) continue;
    set.add(`${CLASSES}\\${e}\\shell\\open`);
    set.add(`${CLASSES}\\${e}\\shell\\open\\command`);
  }
  return [...set].sort();
}
function purgeDeadOpenKeys(): number {
  let n = 0;
  for (const e of ALL_EXTS) {
    const key = `${CLASSES}\\${e}\\shell\\open\\command`;
    const cmd = regValue(key, null);
    if (!cmd || !/electron\.exe|tongzip\.exe/i.test(cmd)) continue;
    const m = cmd.match(/"([^"]+\.exe)"/);
    if (m && !fs.existsSync(m[1])) { reg(['delete', `${CLASSES}\\${e}\\shell\\open`, '/f']); n++; }
  }
  return n;
}
const tmp = mkTemp('tz-rcb7-');
const BK = path.join(ROOT, '.tmp', 'rcb7-backup');
fs.mkdirSync(BK, { recursive: true });
for (const n of fs.readdirSync(BK)) fs.rmSync(path.join(BK, n), { force: true });
function safeName(key: string): string { return key.replace(/[^A-Za-z0-9_-]/g, '_').toLowerCase(); }
function backupAndDelete(): number {
  const keys = baselineKeySet();
  let backed = 0;
  const backedKeys = new Set<string>();
  for (const k of keys) {
    const f = path.join(BK, safeName(k) + '.reg');
    const r = reg(['export', k, f, '/y']);
    if (r.code === 0 && fs.existsSync(f) && fs.statSync(f).size > 0) { backed++; backedKeys.add(k); }
    else note(`export 失败:${k} :: ${r.out.slice(0, 80)}`);
  }
  assert(backed === keys.length, `备份硬校验:${backed}/${keys.length},未全量成功即中止`);
  const deleted: string[] = [];
  for (const k of [...keys].sort((a, b) => a.length - b.length)) {
    if (!backedKeys.has(k)) continue;
    if (deleted.some((d) => k.startsWith(d + '\\'))) continue;
    if (!keyExists(k)) continue;
    const r = reg(['delete', k, '/f']);
    if (r.code !== 0 && !/error: 2\b|找不到/i.test(r.out)) note(`delete 失败:${k} :: ${r.out.slice(0, 80)}`);
    deleted.push(k);
  }
  for (const h of scanTongZipValues()) {
    if (h.key.includes('TongZip')) continue;
    reg(['delete', h.key, '/v', h.value, '/f']);
  }
  if (keyExists('HKCU\\Software\\TongZip\\Capabilities')) {
    reg(['export', 'HKCU\\Software\\TongZip', path.join(BK, 'cap.reg'), '/y']);
    reg(['delete', 'HKCU\\Software\\TongZip', '/f']);
  }
  if (reg(['query', 'HKCU\\Software\\RegisteredApplications', '/v', APP_NAME]).code === 0) {
    fs.writeFileSync(path.join(BK, 'regapp-value.txt'), regValue('HKCU\\Software\\RegisteredApplications', APP_NAME) ?? '', 'utf8');
    reg(['delete', 'HKCU\\Software\\RegisteredApplications', '/v', APP_NAME, '/f']);
  }
  return keys.length;
}
function restoreBaseline(): boolean {
  let ok = true;
  const importers = fs.readdirSync(BK).filter((n) => n.endsWith('.reg'));
  importers.sort((a, b) => a.length - b.length);
  for (const n of importers) {
    const r = reg(['import', path.join(BK, n)]);
    if (r.code !== 0) { ok = false; note(`reg import 失败:${n} :: ${r.out.slice(0, 100)}`); }
  }
  const raValFile = path.join(BK, 'regapp-value.txt');
  if (fs.existsSync(raValFile)) {
    const val = fs.readFileSync(raValFile, 'utf8').trim();
    if (val) reg(['add', 'HKCU\\Software\\RegisteredApplications', '/v', APP_NAME, '/d', val, '/f']);
  }
  return ok;
}
function userChoiceSnapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of ALL_EXTS) {
    const v = regValue(`${CLASSES}\\${e}\\UserChoice`, 'ProgId');
    if (v) out[e] = v;
  }
  return out;
}

/* ---------- NSIS 终态判定(与 rc14 同纪律) ---------- */
function nsisTailBusy(): boolean {
  const r = spawnSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
  return (r.stdout ?? '').split('\n').some((line) => {
    const name = (line.match(/^"([^"]+)"/)?.[1] ?? '').toLowerCase();
    return name.startsWith('nsis') || (name.startsWith('~ns') && name.endsWith('.tmp')) || (name.includes('nullsoft') && name.endsWith('.tmp'));
  });
}
function launchSilent(exe: string, args: string[]): void {
  const child = spawn(exe, args, { windowsHide: true, stdio: 'ignore', detached: false });
  child.on('error', (e) => console.error('拉起失败:', e.message));
  child.unref();
}
async function waitSettled(exePath: string, instDir: string, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  let lastSize = -1, stable = 0;
  await new Promise((r) => setTimeout(r, 1500));
  for (;;) {
    let size = -1;
    try { size = fs.statSync(exePath).size; } catch { size = -1; }
    const unins = fs.existsSync(path.join(instDir, 'Uninstall TongZip.exe')) || fs.existsSync(path.join(instDir, 'Uninstall.exe'));
    if (size > 0 && unins && size === lastSize) stable++; else stable = 0;
    lastSize = size;
    if (stable >= 2 && !nsisTailBusy()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 800));
  }
}

/* ---------- 阶段快照(注册表+卸载登记+安装目录,用户要求"保存前后快照") ---------- */
interface Snap { keyCount: number; keys: string[]; uninst: { displayVersion: string | null; installLocation: string | null } | null; dirFiles: string[]; asarSize: number }
const INST_DIR = path.join(tmp, 'app');
function takeSnap(): Snap {
  const keys = scanTongZipKeys();
  const u = findUninstallEntry();
  let dirFiles: string[] = [];
  let asarSize = -1;
  try { dirFiles = fs.readdirSync(INST_DIR).slice(0, 12); } catch { /* 目录不存在 */ }
  try { asarSize = fs.statSync(path.join(INST_DIR, 'resources', 'app.asar')).size; } catch { /* 未装 */ }
  return { keyCount: keys.length, keys, uninst: u ? { displayVersion: u.displayVersion, installLocation: u.installLocation } : null, dirFiles, asarSize };
}
function keyDiffLost(before: string[], after: string[]): string[] {
  const now = new Set(after.map((k) => k.toLowerCase()));
  return before.filter((k) => !now.has(k.toLowerCase()));
}

/* ---------- shellInstall 触发(与 rc14 同:fire-and-forget + 键面稳定轮询) ---------- */
async function runShellInstall(app: ProbeApp): Promise<number> {
  void cdpEval(app, `window.tz.shellInstall().then(r => r.ok).catch(() => false)`, 20_000).catch(() => undefined);
  const t0 = Date.now(); let last = -1, stableSince = 0;
  for (;;) {
    const n = scanTongZipKeys().length;
    if (n >= 40 && n === last) { if (!stableSince) stableSince = Date.now(); else if (Date.now() - stableSince > 5000) return n; }
    else { stableSince = 0; if (n !== last) last = n; }
    if (Date.now() - t0 > 10 * 60_000) return n;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/* ---------- 主流程 ---------- */
async function main(): Promise<void> {
  for (const [flag, p] of [['--setup0', SETUP_V0], ['--setup1', SETUP_V1]] as const) {
    if (!fs.existsSync(p)) throw new Error(`缺少安装包 ${flag}:${p}`);
  }
  if (/\s/.test(INST_DIR)) throw new Error(`安装临时目录含空格:${INST_DIR}`);
  const snap0 = { v0: fs.statSync(SETUP_V0).size, v1: fs.statSync(SETUP_V1).size };
  record({ id: 'B7-00', item: '环境与输入', expect: '如实登记', actual: `setup0=${path.basename(SETUP_V0)} setup1=${path.basename(SETUP_V1)}`, verdict: 'note', detail: `大小 v0=${snap0.v0} v1=${snap0.v1};安装目录=${INST_DIR};快照/备份=${BK}` });

  const purged = purgeDeadOpenKeys();
  if (purged > 0) note(`预清理历史死 open 键 ${purged} 处`);
  const baseKeys = baselineKeySet();
  const ucBefore = userChoiceSnapshot();
  const backedN = backupAndDelete();
  assert(scanTongZipKeys().length === 0, '键面清零未达成');
  record({ id: 'B7-01', item: '模拟干净机器(备份+清零)', expect: 'Classes 内 TongZip 键=0', actual: `基线=${backedN}, 剩余=0`, verdict: 'ok', detail: '' });

  /* A. 首次安装 1.0.0 + shellInstall */
  launchSilent(SETUP_V0, ['/S', `/D=${INST_DIR}`]);
  const exePath = path.join(INST_DIR, `${APP_NAME}.exe`);
  assert(await waitSettled(exePath, INST_DIR, 5 * 60_000), '首装超时未落盘');
  const port = await pickFreePort();
  let k1 = 0;
  const app: ProbeApp = spawnApp(exePath, path.join(tmp, 'ud'), port);
  try {
    await waitReady(app);
    k1 = await runShellInstall(app);
    await cdpEval(app, `window.tz.winClose(); 'fired'`).catch(() => undefined);
    await waitFor('应用退出', () => { try { process.kill(app.proc.pid, 0); return false; } catch { return true; } }, 20_000, 200);
  } finally {
    killTree(app.proc.pid);
  }
  const snapA = takeSnap();
  record({ id: 'B7-02', item: '首装+关联写入(前置态)', expect: '键≥40 且 DisplayVersion=1.0.0 且命令指向安装目录', actual: `键=${k1}, DisplayVersion=${snapA.uninst?.displayVersion ?? '无'}`, verdict: (k1 >= 40 && snapA.uninst?.displayVersion === '1.0.0' && snapA.keyCount === k1) ? 'ok' : 'mismatch', detail: `installLocation=${snapA.uninst?.installLocation};asar=${snapA.asarSize};dir=[${snapA.dirFiles.slice(0, 6).join(',')}…]` });

  /* B. 同版本覆盖安装(1.0.0 → 1.0.0,/D 同目录):断言守卫未误触、键面不丢 */
  await new Promise((r) => setTimeout(r, 2000)); // 让上一 inst 的 NSIS 临时进程彻底退场
  launchSilent(SETUP_V0, ['/S', `/D=${INST_DIR}`]);
  assert(await waitSettled(exePath, INST_DIR, 5 * 60_000), '同版本覆盖安装超时');
  await new Promise((r) => setTimeout(r, 3000));
  const snapB = takeSnap();
  const lostB = keyDiffLost(snapA.keys, snapB.keys);
  record({ id: 'B7-03', item: '同版本覆盖安装:关联键面保持', expect: '键面与覆盖前一致(丢失=0)', actual: `键 ${snapA.keyCount}→${snapB.keyCount}, 丢失=${lostB.length}, DisplayVersion=${snapB.uninst?.displayVersion ?? '无'}`, verdict: (lostB.length === 0 && snapB.keyCount >= 40) ? 'ok' : 'mismatch', detail: lostB.length ? `丢失样例:${lostB.slice(0, 5).join(' | ')}` : `dir=[${snapB.dirFiles.slice(0, 6).join(',')}…]` });

  /* C. 升级安装(1.0.0 → 1.0.1 同源换版本):核心断言 isUpdated 守卫生效,清理钩子不误触 */
  launchSilent(SETUP_V1, ['/S', `/D=${INST_DIR}`]);
  assert(await waitSettled(exePath, INST_DIR, 5 * 60_000), '升级安装超时');
  await new Promise((r) => setTimeout(r, 3000));
  const snapC = takeSnap();
  const lostC = keyDiffLost(snapA.keys, snapC.keys);
  const cmdAlive = scanValuesByData('TongZip.exe').filter((h) => /\\command$/i.test(h.key) && h.data.includes(INST_DIR) && fs.existsSync(exePath)).length;
  record({ id: 'B7-04', item: '升级安装:守卫未误触卸载清理', expect: 'DisplayVersion=1.0.1 且 键面丢失=0 且 command 指向安装目录存活', actual: `DisplayVersion=${snapC.uninst?.displayVersion ?? '无'}, 键 ${snapA.keyCount}→${snapC.keyCount}, 丢失=${lostC.length}, 存活command=${cmdAlive}`, verdict: (snapC.uninst?.displayVersion === '1.0.1' && lostC.length === 0 && snapC.keyCount >= 40 && cmdAlive > 0) ? 'ok' : 'mismatch', detail: lostC.length ? `丢失样例:${lostC.slice(0, 5).join(' | ')}` : `asar=${snapC.asarSize}(覆盖前=${snapB.asarSize});注:1.0.1 由 extraMetadata.version 换版,代码与 1.0.0 同源` });

  /* D. 正常卸载:清理钩子必须生效(与升级互为正反两证) */
  const uninsPath = fs.existsSync(path.join(INST_DIR, 'Uninstall TongZip.exe')) ? path.join(INST_DIR, 'Uninstall TongZip.exe') : path.join(INST_DIR, 'Uninstall.exe');
  assert(fs.existsSync(uninsPath), `卸载器在场:${uninsPath}`);
  launchSilent(uninsPath, ['/S']);
  await waitFor('卸载删除程序文件', () => !fs.existsSync(exePath) && !nsisTailBusy(), 4 * 60_000, 1000).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1500));
  const snapD = takeSnap();
  const deadD = scanValuesByData('TongZip.exe').filter((h) => { const m = h.data.match(/"([^"]+\.exe)"/); return m && !fs.existsSync(m[1]); });
  const uGone = findUninstallEntry() === null;
  record({ id: 'B7-05', item: '正常卸载:清理钩子生效', expect: 'exe 消失 且 残留键=0 且 死链=0 且 卸载登记消失', actual: `exe=${fs.existsSync(exePath) ? 'KEPT' : 'gone'}, 键=${snapD.keyCount}, 死链=${deadD.length}, 卸载项=${uGone ? 'gone' : '仍在'}`, verdict: (!fs.existsSync(exePath) && snapD.keyCount === 0 && deadD.length === 0 && uGone) ? 'ok' : 'mismatch', detail: deadD.length ? `死链:${deadD.slice(0, 3).map((d) => d.key).join(' | ')}` : '' });

  /* E. UserChoice 全程未动 + 防御清理 + 恢复基线 */
  const ucAfter = userChoiceSnapshot();
  const ucDiff = JSON.stringify(ucBefore) !== JSON.stringify(ucAfter);
  record({ id: 'B7-06', item: 'UserChoice 全程只读', expect: '前后一致', actual: ucDiff ? 'CHANGED(不可接受)' : 'same', verdict: ucDiff ? 'mismatch' : 'ok', detail: `观测面=${Object.keys(ucBefore).length} 个后缀` });

  for (const k of scanTongZipKeys().sort((a, b) => b.length - a.length)) reg(['delete', k, '/f']);
  for (const h of scanTongZipValues()) if (!h.key.toLowerCase().includes('classes\\tongzip.')) reg(['delete', h.key, '/v', h.value, '/f']);
  if (keyExists('HKCU\\Software\\TongZip\\Capabilities')) reg(['delete', 'HKCU\\Software\\TongZip', '/f']);
  if (reg(['query', 'HKCU\\Software\\RegisteredApplications', '/v', APP_NAME]).code === 0) reg(['delete', 'HKCU\\Software\\RegisteredApplications', '/v', APP_NAME, '/f']);

  const restoreOk = restoreBaseline();
  if (restoreOk) {
    const baseSet = baseKeys.map((k) => k.toLowerCase());
    const curSet = scanTongZipKeys().map((k) => k.toLowerCase());
    const missing = baseSet.filter((k) => !curSet.some((c) => c === k || c.startsWith(k + '\\')));
    record({ id: 'B7-07', item: 'dev 键面恢复完整性', expect: '基线键全部回来', actual: `基线=${baseKeys.length}, 缺失=${missing.length}`, verdict: missing.length === 0 ? 'ok' : 'mismatch', detail: missing.slice(0, 5).join(' | ') });
  } else {
    record({ id: 'B7-07', item: 'dev 键面恢复', expect: 'import 全部成功', actual: '有失败', verdict: 'mismatch', detail: '见 note 日志' });
  }
  record({ id: 'B7-08', item: 'Explorer 右键菜单渲染肉眼核对(升级前后)', expect: '人工项不自动关闭', actual: 'pending-real', verdict: 'pending-real', detail: '自动化只证注册表状态迁移正确;菜单实际渲染(升级前后右键 TongZip 子菜单在位)须人工肉眼确认(RC-B1/B3 同口径)' });

  writeOutJson('rcb7-results.json', {
    at: new Date().toISOString(), setup0: path.relative(ROOT, SETUP_V0), setup1: path.relative(ROOT, SETUP_V1),
    baselineKeys: baseKeys, snapshots: { firstInstall: snapA, sameVersionOverwrite: snapB, upgrade: snapC, uninstall: snapD }, findings,
  });
  const mism = findings.filter((f) => f.verdict === 'mismatch').length;
  console.log(`\n=== RC-B7 完成:通过 ${findings.filter((f) => f.verdict === 'ok').length} / 记录 ${findings.filter((f) => f.verdict === 'note').length} / 待人工 ${findings.filter((f) => f.verdict === 'pending-real').length} / 不一致 ${mism} ===`);
}

runProbe(main);
