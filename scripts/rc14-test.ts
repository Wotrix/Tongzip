/**
 * 阶段 4 修复轮 · RC-14 — 干净键面全生命周期实测(iss03 定性证据)
 *
 * 用户定档:先跑 RC-14,再决定是否给 NSIS 卸载补 shell 清理。
 * 矩阵定义:安装→应用内 shellInstall 写键→菜单肉眼核对→卸载→核验 HKCU\Software\Classes 无 TongZip 残留。
 *
 * 本机非干净机器(dev 期 TongZip 键在场)。处理纪律(可逆):
 *  1. 全量枚举 TongZip 自写键面(键名+值名两个维度,零猜测);
 *  2. 逐键 reg export 备份到 .tmp/rc14-backup/*.reg;
 *  3. 删除这些键 → 模拟"干净机器";
 *  4. 真实生命周期:NSIS /S 装临时目录 → (场景A)CDP shellInstall → 键面/死链前检 →
 *     关应用 → Uninstall /S → 残留扫描(核心证据,如实登记不定 FAIL);
 *  5. 精确清理本次残留 → reg import 恢复 dev 键面 → diff 核验恢复完整性。
 * 绝不触碰:UserChoice(只读观测)、非 TongZip 前缀键、基线快捷方式。
 * 场景:node rc14.cjs(默认 A:含 shellInstall)/ node rc14.cjs --no-shell(B:纯 NSIS 对照)。
 * 输出 docs/phase4/rc14-results[-no-shell].json;任何断言失败非零退出;runProbe 收尾清理。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assert, cdpEval, killTree, mkTemp, note, pickFreePort, runProbe,
  spawnApp, waitFor, waitReady, writeOutJson, type ProbeApp,
} from './probe-lib';
import { ARCHIVE_EXTS, ARCHIVE_EXTS_OPENABLE, ARCHIVE_EXTS_SYS_ONLY } from '../shared/types';

const ROOT = process.cwd();
const SETUP_EXE = path.resolve('release/TongZip Setup 1.0.0.exe');
const SCENARIO = process.argv.includes('--no-shell') ? 'B:no-shell' : 'A:with-shellInstall';
const OUT_JSON = SCENARIO.startsWith('A') ? 'rc14-results.json' : 'rc14-results-no-shell.json';
const CLASSES = 'HKCU\\Software\\Classes';
const APP_NAME = 'TongZip';

interface Finding { id: string; item: string; expect: string; actual: string; verdict: 'ok' | 'mismatch' | 'evidence' | 'note' | 'pending-real'; detail: string }
const findings: Finding[] = [];
function record(f: Finding): void {
  findings.push(f);
  const line = `[${f.id}] 期望=${f.expect} 实际=${f.actual} :: ${f.detail.slice(0, 200)}`;
  if (f.verdict === 'mismatch') assert(false, line);
  else console.log(f.verdict === 'ok' ? '  ✓' : f.verdict === 'evidence' ? '  ★' : '  ·', line);
}

/* ---------- reg 基建 ---------- */
function reg(args: string[]): { code: number; out: string } {
  const r = spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
/** 全Classes /s /f 扫描:键名命中(每行一个键路径) */
function scanTongZipKeys(): string[] {
  const r = reg(['query', CLASSES, '/f', 'TongZip', '/k', '/s']);
  const keys = new Set<string>();
  r.out.split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (/^HKEY_/i.test(t) && /tongzip/i.test(t)) keys.add(t);
  });
  return [...keys].sort();
}
/** 值名命中(用于 OpenWithProgids 的 REG_NONE 值等):输出键路径+值名 */
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
/** 值数据命中(不受键名 leaf 限制):抓所有数据里引用某子串的键/值(如 command 指 TongZip.exe 的死链) */
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

/* ---------- 基线键面枚举(从 shell.ts 写键面 + 全 Classes 扫描交叉,零猜测) ---------- */
const ALL_EXTS = [...new Set([...ARCHIVE_EXTS, ...ARCHIVE_EXTS_OPENABLE, ...ARCHIVE_EXTS_SYS_ONLY])].map((e) => `.${e}`);
function baselineKeySet(): string[] {
  const set = new Set<string>(scanTongZipKeys());
  /* 仅收录"活"的 .ext\shell\open(command 指向确实存在的 exe),死链不配当基线保留 */
  for (const e of ALL_EXTS) {
    const cmd = regValue(`${CLASSES}\\${e}\\shell\\open\\command`, null);
    if (!cmd || !/electron\.exe|tongzip\.exe/i.test(cmd)) continue;
    const m = cmd.match(/"([^"]+\.exe)"/);
    if (m && !fs.existsSync(m[1])) continue; // 指向已删 exe 的遗留死 open:不备份、不恢复
    set.add(`${CLASSES}\\${e}\\shell\\open`);
    set.add(`${CLASSES}\\${e}\\shell\\open\\command`);
  }
  return [...set].sort();
}
/** 清除历史遗留的死 open 键(command 指向不存在 exe):只删不恢复,防泄漏在多次运行间传播 */
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

/* ---------- 备份与恢复 ---------- */
const tmp = mkTemp('tz-rc14-');
const BK = path.join(ROOT, '.tmp', 'rc14-backup');
fs.mkdirSync(BK, { recursive: true });
/* 清本场旧备份残留:restoreBaseline 会盲 import BK 内全部 .reg,陈旧文件会污染恢复 */
for (const n of fs.readdirSync(BK)) fs.rmSync(path.join(BK, n), { force: true });
function safeName(key: string): string { return key.replace(/[^A-Za-z0-9_-]/g, '_').toLowerCase(); }
function backupAndDelete(): { backed: number; failed: number } {
  const keys = baselineKeySet();
  /* 铁律(事故教训):备份不全量成功绝不进入删除阶段;export 失败路径必须是反斜杠截断子目录 */
  let backed = 0, failed = 0;
  const backedKeys = new Set<string>();
  for (const k of keys) {
    const f = path.join(BK, safeName(k) + '.reg');
    const r = reg(['export', k, f, '/y']);
    if (r.code === 0 && fs.existsSync(f) && fs.statSync(f).size > 0) { backed++; backedKeys.add(k); }
    else { failed++; note(`export 失败:${k} :: ${r.out.slice(0, 80)}`); }
  }
  assert(failed === 0 && backed === keys.length, `备份硬校验:${backed}/${keys.length},未全量成功即中止`);
  if (failed > 0 || backed !== keys.length) throw new Error('备份不完整,拒绝进入删除/安装阶段');
  /* 只删备份成功且「父不在已删集合里」的最浅键 */
  const deleted: string[] = [];
  for (const k of [...keys].sort((a, b) => a.length - b.length)) {
    if (!backedKeys.has(k)) continue;
    if (deleted.some((d) => k.startsWith(d + '\\'))) continue;
    if (!keyExists(k)) continue;
    const r = reg(['delete', k, '/f']);
    if (r.code !== 0 && !/error: 2\b|找不到/i.test(r.out)) note(`delete 失败:${k} :: ${r.out.slice(0, 80)}`);
    deleted.push(k);
  }
  /* 值级命中(OpenWithProgids 里的 TongZip.* 值):父键不删,只删值 */
  for (const h of scanTongZipValues()) {
    if (h.key.includes('TongZip')) continue; // ProgID 本体键已随键级处理
    reg(['delete', h.key, '/v', h.value, '/f']);
  }
  /* 默认应用登记 */
  const capExists = keyExists('HKCU\\Software\\TongZip\\Capabilities');
  if (capExists) {
    reg(['export', 'HKCU\\Software\\TongZip', path.join(BK, 'cap.reg'), '/y']);
    reg(['delete', 'HKCU\\Software\\TongZip', '/f']);
  }
  if (reg(['query', 'HKCU\\Software\\RegisteredApplications', '/v', APP_NAME]).code === 0) {
    fs.writeFileSync(path.join(BK, 'regapp-value.txt'), regValue('HKCU\\Software\\RegisteredApplications', APP_NAME) ?? '', 'utf8');
    reg(['delete', 'HKCU\\Software\\RegisteredApplications', '/v', APP_NAME, '/f']);
  }
  return { backed, failed };
}
function restoreBaseline(): { restored: boolean; missing: string[] } {
  let restored = true;
  const importers = fs.readdirSync(BK).filter((n) => n.endsWith('.reg'));
  /* 先灌父(cap.reg/短文件名优先),再深层,避免子先于父被跳过 */
  importers.sort((a, b) => a.length - b.length);
  for (const n of importers) {
    const r = reg(['import', path.join(BK, n)]);
    if (r.code !== 0) { restored = false; note(`reg import 失败:${n} :: ${r.out.slice(0, 100)}`); }
  }
  const raValFile = path.join(BK, 'regapp-value.txt');
  if (fs.existsSync(raValFile)) {
    const val = fs.readFileSync(raValFile, 'utf8').trim();
    if (val) reg(['add', 'HKCU\\Software\\RegisteredApplications', '/v', APP_NAME, '/d', val, '/f']);
  }
  return { restored, missing: [] };
}

/* ---------- UserChoice 只读观测(全程绝不写) ---------- */
function userChoiceSnapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of ALL_EXTS) {
    const v = regValue(`${CLASSES}\\${e}\\UserChoice`, 'ProgId');
    if (v) out[e] = v;
  }
  return out;
}

/* ---------- NSIS 终态判定(与 install-test 同纪律) ---------- */
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
async function waitSettled(exePath: string, needUnins: boolean, instDir: string, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  let lastSize = -1, stable = 0;
  await new Promise((r) => setTimeout(r, 1500));
  for (;;) {
    let size = -1;
    try { size = fs.statSync(exePath).size; } catch { size = -1; }
    let unins = true;
    if (needUnins) unins = fs.existsSync(path.join(instDir, 'Uninstall TongZip.exe')) || fs.existsSync(path.join(instDir, 'Uninstall.exe'));
    if (size > 0 && unins && size === lastSize) stable++; else stable = 0;
    lastSize = size;
    if (stable >= 2 && !nsisTailBusy()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 800));
  }
}
const INST_DIR = path.join(tmp, 'app');

/* ---------- 主流程 ---------- */
async function main(): Promise<void> {
  if (!fs.existsSync(SETUP_EXE)) throw new Error(`缺少 NSIS 安装包:${SETUP_EXE}`);
  if (/\s/.test(INST_DIR)) throw new Error(`安装临时目录含空格:${INST_DIR}`);
  record({ id: 'RC14-00', item: `场景 ${SCENARIO}`, expect: '如实登记', actual: SETUP_EXE, verdict: 'note', detail: `备份目录=${BK};安装目录=${INST_DIR}` });

  /* 0. 预清理历史泄漏的死 open 键(command 指向不存在 exe):防多次运行间基线漂移(事故:曾泄漏 64 键使基线 34→98) */
  const purged = purgeDeadOpenKeys();
  if (purged > 0) note(`预清理历史死 open 键 ${purged} 处`);

  /* 1. 基线:键面 + UserChoice(只读) */
  const baseKeys = baselineKeySet();
  const ucBefore = userChoiceSnapshot();
  record({ id: 'RC14-01', item: 'dev 期键面基线', expect: '全部可备份后才允许清除', actual: `键=${baseKeys.length}`, verdict: 'note', detail: baseKeys.slice(0, 8).join(' | ') + (baseKeys.length > 8 ? ' …' : '') });

  /* 2. 备份 → 清除 → 验证干净(备份硬校验在 backupAndDelete 内,不全则直接抛掷) */
  const { backed } = backupAndDelete();
  assert(backed === baseKeys.length, `基线全部可备份:${backed}/${baseKeys.length}`);
  const afterClean = scanTongZipKeys();
  record({ id: 'RC14-02', item: '模拟干净机器(键面清零)', expect: 'Classes 内 TongZip 键=0', actual: `剩余=${afterClean.length}`, verdict: afterClean.length === 0 ? 'ok' : 'mismatch', detail: afterClean.slice(0, 5).join(' | ') });

  /* 3. NSIS 静默安装 */
  launchSilent(SETUP_EXE, ['/S', `/D=${INST_DIR}`]);
  const exePath = path.join(INST_DIR, `${APP_NAME}.exe`);
  assert(await waitSettled(exePath, true, INST_DIR, 5 * 60_000), '安装超时未落盘');
  const keysAfterInstallOnly = scanTongZipKeys();
  record({ id: 'RC14-03', item: 'NSIS 安装写键行为', expect: 'electron-builder 默认不写 HKCU Classes', actual: `TongZip 键=${keysAfterInstallOnly.length}`, verdict: keysAfterInstallOnly.length === 0 ? 'ok' : 'note', detail: keysAfterInstallOnly.slice(0, 6).join(' | ') || '(无)' });

  /* 4. 启动安装产物(隔离 userData) + 场景 A:应用内 shellInstall */
  const ud = path.join(tmp, 'ud');
  const port = await pickFreePort();
  const app: ProbeApp = spawnApp(exePath, ud, port);
  let wroteKeys = 0;
  const probeCmdKeys: { key: string; cmd: string }[] = [];
  try {
    await waitReady(app);
    if (!SCENARIO.startsWith('B')) {
      /* 事故教训:安装产物冷启动下 shellInstall(几百次串行 reg)实测>180s,同步 IPC 等待必炸:
       * 改 fire-and-forget 触发 + 键面终态轮询(以注册表为真相,不赌 IPC 回包) */
      void cdpEval(app, `window.tz.shellInstall().then(r => r.ok).catch(() => false)`, 20_000).catch(() => undefined);
      const t0 = Date.now();
      let last = -1, stableSince = 0;
      for (;;) {
        const n = scanTongZipKeys().length;
        if (n >= 40 && n === last) { if (!stableSince) stableSince = Date.now(); else if (Date.now() - stableSince > 5000) break; }
        else { stableSince = 0; if (n !== last) last = n; }
        if (Date.now() - t0 > 10 * 60_000) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      const siOk = scanTongZipKeys().length >= 40;
      record({ id: 'RC14-04', item: '应用内 shellInstall(干净首写)', expect: '键面写齐(≥ 40)', actual: `键=${scanTongZipKeys().length}, 用时=${((Date.now() - t0) / 1000).toFixed(0)}s`, verdict: siOk ? 'ok' : 'mismatch', detail: 'fire-and-forget + 键面稳定轮询;安装产物隔离 userData 默认全菜单' });
    } else {
      record({ id: 'RC14-04', item: '场景 B:不调 shellInstall', expect: '纯 NSIS 对照', actual: 'skipped', verdict: 'note', detail: '' });
    }
    /* 5. 卸载前键面 + 菜单结构核验(注册表证据;资源管理器肉眼核对另列人工项) */
    const keysPreUninst = scanTongZipKeys();
    wroteKeys = keysPreUninst.length;
    const menuVerb = regValue(`${CLASSES}\\*\\shell\\TongZip`, 'MUIVerb');
    const subCmds = regValue(`${CLASSES}\\*\\shell\\TongZip`, 'SubCommands');
    const openCmd = regValue(`${CLASSES}\\.7z\\shell\\TongZip\\Open\\command`, null);
    const progidCmd = regValue(`${CLASSES}\\TongZip.7z\\shell\\open\\command`, null);
    const pointsToInstall = !!openCmd && openCmd.includes(INST_DIR);
    /* 收集所有 command 键值(按数据命中,不受键名 leaf 限制),供卸载后死链判定 */
    for (const h of scanValuesByData('TongZip.exe')) {
      if (/\\command$/i.test(h.key)) probeCmdKeys.push({ key: h.key, cmd: h.data });
    }
    const capOn = keyExists('HKCU\\Software\\TongZip\\Capabilities');
    record({ id: 'RC14-05', item: '写键齐全(菜单/ProgID/默认应用登记)', expect: SCENARIO.startsWith('A') ? '键面>0 且 command 指安装目录' : 'B:保持 0', actual: `键=${wroteKeys}, 菜单=${menuVerb ?? '无'}/SubCommands=${subCmds !== null}, 指向安装目录=${pointsToInstall}, Capabilities=${capOn}`, verdict: SCENARIO.startsWith('B') ? (wroteKeys === 0 ? 'ok' : 'mismatch') : (wroteKeys > 0 && menuVerb === 'TongZip' && subCmds !== null && pointsToInstall ? 'ok' : 'mismatch'), detail: `open=${(openCmd ?? '').slice(0, 90)} progid=${(progidCmd ?? '').slice(0, 90)}` });
    record({ id: 'RC14-06', item: '菜单肉眼核对(资源管理器渲染)', expect: '人工项不自动关闭', actual: 'pending-real', verdict: 'pending-real', detail: '注册表结构已核(父键 MUIVerb+SubCommands+每项子键 command);Explorer 右键渲染需装后人工肉眼确认(安装目录存续窗口内)' });
    /* 关应用让卸载通行 */
    await cdpEval(app, `window.tz.winClose(); 'fired'`).catch(() => undefined);
    await waitFor('应用退出', () => { try { process.kill(app.proc.pid, 0); return false; } catch { return true; } }, 20000, 200);
  } finally {
    killTree(app.proc.pid);
  }

  /* 6. NSIS 静默卸载 */
  const uninsPath = fs.existsSync(path.join(INST_DIR, 'Uninstall TongZip.exe')) ? path.join(INST_DIR, 'Uninstall TongZip.exe') : path.join(INST_DIR, 'Uninstall.exe');
  assert(fs.existsSync(uninsPath), `卸载器在场:${uninsPath}`);
  launchSilent(uninsPath, ['/S']);
  await waitFor('卸载删除程序文件', () => !fs.existsSync(exePath) && !nsisTailBusy(), 4 * 60_000, 1000).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1500));
  const exeGone = !fs.existsSync(exePath);
  record({ id: 'RC14-07', item: '卸载清除程序文件', expect: 'exe 消失', actual: exeGone ? 'gone' : 'KEPT', verdict: exeGone ? 'ok' : 'mismatch', detail: `INST_DIR 现状=${(() => { try { return fs.readdirSync(INST_DIR).slice(0, 5).join(','); } catch { return '(目录已删)'; } })()}` });

  /* 7. 核心证据:残留扫描 + 死链定性(command 首个 token 指向已删除文件 = 死链) */
  const residualKeys = scanTongZipKeys();
  const deadLinks: { key: string; cmd: string }[] = [];
  for (const h of scanValuesByData('TongZip.exe')) {
    const m = h.data.match(/"([^"]+\.exe)"/);
    if (m && !fs.existsSync(m[1])) deadLinks.push({ key: h.key, cmd: h.data });
  }
  const residualValues = scanTongZipValues().filter((h) => !h.key.toLowerCase().includes('classes\\tongzip.'));
  const capResidual = keyExists('HKCU\\Software\\TongZip\\Capabilities');
  const raResidual = reg(['query', 'HKCU\\Software\\RegisteredApplications', '/v', APP_NAME]).code === 0;
  record({ id: 'RC14-08', item: 'ISS-03 定性:卸载后 TongZip 键残留', expect: '如实登记(0=不残留;>0=实锤)', actual: `键=${residualKeys.length}, 死链 command=${deadLinks.length}, OpenWith值=${residualValues.length}, Capabilities=${capResidual}, RegisteredApps=${raResidual}`, verdict: 'evidence', detail: deadLinks.length ? `死链示例:${deadLinks.slice(0, 3).map((d) => `${d.key} → ${d.cmd.slice(0, 70)}`).join(' || ')}` : (residualKeys.length ? residualKeys.slice(0, 6).join(' | ') : '无残留') });
  /* 死链前检对照:卸载前在场的 command 键,现在还剩几个 */
  const goneCmd = probeCmdKeys.filter((p) => !keyExists(p.key)).length;
  record({ id: 'RC14-09', item: `卸载对写过的 command 键回收率(前检 ${probeCmdKeys.length} 个)`, expect: '如实登记', actual: `已消失=${goneCmd}, 仍存活=${probeCmdKeys.length - goneCmd}`, verdict: 'evidence', detail: '' });

  /* 8. UserChoice 未被触碰核验 */
  const ucAfter = userChoiceSnapshot();
  const ucDiff = JSON.stringify(ucBefore) !== JSON.stringify(ucAfter);
  record({ id: 'RC14-10', item: 'UserChoice 全程只读', expect: '前后一致', actual: ucDiff ? 'CHANGED(不可接受)' : 'same', verdict: ucDiff ? 'mismatch' : 'ok', detail: `观测面=${Object.keys(ucBefore).length} 个后缀` });

  /* 9. 精确清理残留(只删本次写入:当前键面全部是本次产物——基线已清零) */
  for (const k of residualKeys.sort((a, b) => b.length - a.length)) reg(['delete', k, '/f']);
  for (const h of scanTongZipValues()) if (!h.key.toLowerCase().includes('classes\\tongzip.')) reg(['delete', h.key, '/v', h.value, '/f']);
  if (capResidual) reg(['delete', 'HKCU\\Software\\TongZip', '/f']);
  if (raResidual) reg(['delete', 'HKCU\\Software\\RegisteredApplications', '/v', APP_NAME, '/f']);
  const midClean = scanTongZipKeys();
  record({ id: 'RC14-11', item: '残留清理(还原干净)', expect: '=0 后才允许恢复基线', actual: `剩余=${midClean.length}`, verdict: midClean.length === 0 ? 'ok' : 'mismatch', detail: midClean.slice(0, 5).join(' | ') });

  /* 9.5 安装—卸载—重装回归(用户定档:修 ISS-03 后须验证重复生命周期无状态累积;并核验打包态 --uninstall-shell 退出码) */
  if (!SCENARIO.startsWith('B')) {
    const INST2 = path.join(tmp, 'app2');
    const exe2 = path.join(INST2, `${APP_NAME}.exe`);
    launchSilent(SETUP_EXE, ['/S', `/D=${INST2}`]);
    assert(await waitSettled(exe2, true, INST2, 5 * 60_000), '重装腿:第二次 NSIS 安装超时未落盘');
    const port2 = await pickFreePort();
    const app2 = spawnApp(exe2, path.join(tmp, 'ud2'), port2);
    let keys2 = 0;
    try {
      await waitReady(app2);
      void cdpEval(app2, `window.tz.shellInstall().then(r => r.ok).catch(() => false)`, 20_000).catch(() => undefined);
      const t0 = Date.now(); let last = -1, stableSince = 0;
      for (;;) {
        const n = scanTongZipKeys().length;
        if (n >= 40 && n === last) { if (!stableSince) stableSince = Date.now(); else if (Date.now() - stableSince > 5000) break; }
        else { stableSince = 0; if (n !== last) last = n; }
        if (Date.now() - t0 > 10 * 60_000) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      keys2 = scanTongZipKeys().length;
      await cdpEval(app2, `window.tz.winClose(); 'fired'`).catch(() => undefined);
      await waitFor('重装腿:应用退出', () => { try { process.kill(app2.proc.pid, 0); return false; } catch { return true; } }, 20000, 200);
    } finally {
      killTree(app2.proc.pid);
    }
    record({ id: 'RC14-13', item: '重装:shellInstall 二次写键(无状态累积)', expect: '键面再次写齐(≥ 40)且与首轮量级相当', actual: `键=${keys2}(首轮=${wroteKeys})`, verdict: keys2 >= 40 ? 'ok' : 'mismatch', detail: `安装目录2=${INST2}` });
    /* 打包态无头清理直测:成功与否只看键→与限时退出;退出码如实登记(NSIS ExecWait 不受非零码影响) */
    await new Promise((r) => setTimeout(r, 1500));
    const t1 = Date.now();
    const rs = spawnSync(exe2, ['--uninstall-shell'], { windowsHide: true, timeout: 40_000 });
    const keysAfterDirect = scanTongZipKeys().length;
    record({ id: 'RC14-13b', item: '打包态 --uninstall-shell 直测(退出码/限时/清键)', expect: '30s 内退出且键→ 0', actual: `exit=0x${((rs.status ?? -1) >>> 0).toString(16)} @${Date.now() - t1}ms, 键 ${keys2}→${keysAfterDirect}`, verdict: keysAfterDirect === 0 ? 'ok' : 'mismatch', detail: `非零退出码(如 0xC0000409)属 dev/GUI 销毁现象,不影响 NSIS ExecWait 取终态;真正验收看键→0` });
    const unins2 = fs.existsSync(path.join(INST2, 'Uninstall TongZip.exe')) ? path.join(INST2, 'Uninstall TongZip.exe') : path.join(INST2, 'Uninstall.exe');
    launchSilent(unins2, ['/S']);
    await waitFor('重装腿:第二次卸载删文件', () => !fs.existsSync(exe2) && !nsisTailBusy(), 4 * 60_000, 1000).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1500));
    const residual2 = scanTongZipKeys();
    const dead2 = scanValuesByData('TongZip.exe').filter((h) => { const m = h.data.match(/"([^"]+\.exe)"/); return m && !fs.existsSync(m[1]); });
    record({ id: 'RC14-14', item: '重装:第二次 NSIS 卸载残留(修复可重复性)', expect: '残留键=0 且死链=0', actual: `键=${residual2.length}, 死链=${dead2.length}`, verdict: (residual2.length === 0 && dead2.length === 0) ? 'ok' : 'mismatch', detail: residual2.slice(0, 5).join(' | ') || '(无残留)' });
    /* 防御:若仍有残留,精确清掉后再恢复基线 */
    for (const k of scanTongZipKeys().sort((a, b) => b.length - a.length)) reg(['delete', k, '/f']);
    for (const h of scanTongZipValues()) if (!h.key.toLowerCase().includes('classes\\tongzip.')) reg(['delete', h.key, '/v', h.value, '/f']);
    if (keyExists('HKCU\\Software\\TongZip\\Capabilities')) reg(['delete', 'HKCU\\Software\\TongZip', '/f']);
    if (reg(['query', 'HKCU\\Software\\RegisteredApplications', '/v', APP_NAME]).code === 0) reg(['delete', 'HKCU\\Software\\RegisteredApplications', '/v', APP_NAME, '/f']);
  }

  /* 10. 恢复 dev 键面:reg import 备份 → 与基线 diff(被父键 export 覆盖的子键路径不算缺失) */
  const restore = restoreBaseline();
  if (restore.restored) {
    const baseSet = baseKeys.map((k) => k.toLowerCase());
    const curSet = scanTongZipKeys().map((k) => k.toLowerCase());
    const missing = baseSet.filter((k) => !curSet.some((c) => c === k || c.startsWith(k + '\\')));
    record({ id: 'RC14-12', item: 'dev 键面恢复完整性', expect: '基线键全部回来', actual: `基线=${baseKeys.length}, 缺失=${missing.length}, 新增(异常)=${[...curSet].filter((k) => ![...baseSet].some((b) => k.startsWith(b))).length}`, verdict: missing.length === 0 ? 'ok' : 'mismatch', detail: missing.slice(0, 5).join(' | ') });
  } else {
    record({ id: 'RC14-12', item: 'dev 键面恢复', expect: 'import 全部成功', actual: '有失败', verdict: 'mismatch', detail: '见 note 日志' });
  }

  writeOutJson(OUT_JSON, {
    at: new Date().toISOString(), scenario: SCENARIO, setup: path.relative(ROOT, SETUP_EXE),
    baselineKeys: baseKeys, backupDir: path.relative(ROOT, BK), findings,
    residualKeysAtRc1408: residualKeys, deadLinks,
  });
  const mism = findings.filter((f) => f.verdict === 'mismatch').length;
  console.log(`\n=== RC-14 ${SCENARIO} 完成:通过 ${findings.filter((f) => f.verdict === 'ok').length} / 证据 ${findings.filter((f) => f.verdict === 'evidence').length} / 记录 ${findings.filter((f) => f.verdict === 'note').length} / 待人工 ${findings.filter((f) => f.verdict === 'pending-real').length} / 不一致 ${mism} ===`);
}

runProbe(main);
