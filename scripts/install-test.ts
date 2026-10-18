/**
 * 阶段 4 · 交付物四 — 安装/卸载/关联受控测试(npm run install-test)
 *
 * 已获用户授权在本机做受控安装。纪律(硬性):
 *  - 只装进独立临时目录(os.tmpdir 下,无空格短路径);绝不动开发机现有安装与 UserChoice 默认应用。
 *  - 注册表核验用「从 shell.ts 键面推导的枚举快照」而非全局 dump:基线若发现 TongZip 键
 *    (dev 期注册残留),跳过 shell 写入步骤以免覆盖,并在结尾精确清理本次写过的键。
 *  - shell 集成键只由应用运行期写入(NSIS 本身不写 HKCU shell 键),故"卸载后键残留"
 *    是说明书 12.3 关注点:NSIS 卸载不调用 uninstallShell → 实测记录差集,如实登记。
 *  - 检查更新:cmpSemver/ghLatestRelease 未导出且依赖 electron → 行为证(CDP 实跑记录形态)
 *    + 静态审(main.ts 源码断言 404→notfound、非200/超时→NETWORK_FAILED 分支存在)。
 * 输出 docs/phase4/install-results.json;任何断言失败非零退出;结束清理进程/目录/注册表。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assert, cdpEval, killTree, mkTemp, note, pickFreePort, runProbe, sha256, spawnApp,
  waitFor, waitReady, writeOutJson, type ProbeApp,
} from './probe-lib';
import { ARCHIVE_EXTS, ARCHIVE_EXTS_OPENABLE } from '../shared/types';

const ROOT = process.cwd();
const SETUP_EXE = path.resolve('release/TongZip Setup 1.0.0.exe');
const WIN_UNPACKED = path.resolve('release/win-unpacked');
const APP_NAME = 'TongZip';

interface Finding { id: string; item: string; expect: string; actual: string; verdict: 'ok' | 'mismatch' | 'note' | 'pending-real'; detail: string }
const findings: Finding[] = [];
function record(f: Finding): void {
  findings.push(f);
  const line = `[${f.id}] 期望=${f.expect} 实际=${f.actual} :: ${f.detail.slice(0, 180)}`;
  if (f.verdict === 'mismatch') assert(false, line);
  else console.log(f.verdict === 'ok' ? '  ✓' : f.verdict === 'pending-real' ? '  ◻' : '  ·', line);
}

/* ---------- 注册表枚举快照(键面从 shell.ts 推导,零猜测) ---------- */
const CLASSES = 'HKCU\\Software\\Classes';
const EXTS = ARCHIVE_EXTS.map((e) => `.${e}`);
const EXTS_OPENABLE = ARCHIVE_EXTS_OPENABLE.map((e) => `.${e}`);
const progidFor = (ext: string) => `${CLASSES}\\TongZip.${ext.replace(/^\./, '')}`;
function shellKeySet(): string[] {
  const keys: string[] = [
    `${CLASSES}\\*\\shell\\TongZip`,
    `${CLASSES}\\Directory\\shell\\TongZip`,
  ];
  for (const e of EXTS) keys.push(`${CLASSES}\\${e}\\shell\\TongZip`);
  for (const e of EXTS_OPENABLE) { keys.push(progidFor(e)); keys.push(`${CLASSES}\\${e}\\DefaultIcon`); }
  keys.push(`${CLASSES}\\AppUserModelID\\com.tongzip.app`);
  keys.push('HKCU\\Software\\TongZip\\Capabilities');
  keys.push('HKCU\\Software\\TongZip\\Capabilities\\FileAssociations');
  return keys;
}
function regQuery(args: string[]): { code: number; out: string } {
  const r = spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
function keyExists(k: string): boolean {
  const r = regQuery(['query', k]);
  if (r.code === 0) return true;
  /* reg.exe 对不存在的键固定报 error: 2 / 系统找不到指定的注册表项或值;其余失败不当不存在处理 */
  return /error: 2\b|找不到/i.test(r.out);
}
function regValue(k: string, v: string): string | null {
  const r = regQuery(['query', k, '/v', v]);
  if (r.code !== 0) return null;
  /* 默认值(/ve)行形如 "    REG_SZ    值";命名值行形如 "    名    REG_SZ    值";长值折行取首段足够核验 */
  const m = r.out.match(/REG_\S+\s+(.+)/);
  return m ? m[1].trim() : null;
}
function snapshotKeys(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const k of shellKeySet()) out[k] = keyExists(k);
  /* 卸载键以固定条目名记账(存在性由枚举得出),避免 GUID↔猜名随安装状态漂移出假 diff */
  out[UNINS_KEY_GUESS] = uninsKeyFound() !== null;
  return out;
}
/* electron-builder NSIS 的卸载键是 GUID 形态(实测 4d2a2ef1-…),不能写死 TongZip:枚举取 DisplayName 匹配者 */
const UNINS_ROOT = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const UNINS_KEY_GUESS = UNINS_ROOT + '\\TongZip';
function uninsKeyFound(): string | null {
  const r = regQuery(['query', UNINS_ROOT]);
  if (r.code !== 0) return null;
  for (const m of r.out.matchAll(/\\Uninstall\\([^\r\n]+)/g)) {
    const k = `${UNINS_ROOT}\\${m[1]}`;
    const dn = regValue(k, 'DisplayName');
    if (dn && /tongzip/i.test(dn)) return k;
  }
  return null;
}
function diffKeys(before: Record<string, boolean>, after: Record<string, boolean>): { added: string[]; removed: string[] } {
  const added: string[] = [], removed: string[] = [];
  for (const k of Object.keys(after)) {
    if (after[k] && !before[k]) added.push(k);
    if (!after[k] && before[k]) removed.push(k);
  }
  return { added, removed };
}

/* ---------- 文件清单与快捷方式 ---------- */
/** 直读 PE 头第 5 个数目录(Certificate/Security)的文件偏移+尺寸:size>0 即含签名块。
 * 不依赖 PowerShell Security 模块(spawnSync 下无法自动加载),跨环境确定。 */
function peCertTable(file: string): string {
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch { return 'READERR'; }
  try {
    const head = Buffer.alloc(0x40);
    fs.readSync(fd, head, 0, 0x40, 0);
    if (head.readUInt16LE(0) !== 0x5a4d) return 'NOT_PE'; // MZ
    const peOff = head.readUInt32LE(0x3c);
    const sig = Buffer.alloc(4);
    fs.readSync(fd, sig, 0, 4, peOff);
    if (sig.readUInt32LE(0) !== 0x00004550) return 'NOT_PE'; // PE\0\0
    const coff = Buffer.alloc(20);
    fs.readSync(fd, coff, 0, 20, peOff + 4);
    const optOff = peOff + 4 + 20;
    const magicBuf = Buffer.alloc(2);
    fs.readSync(fd, magicBuf, 0, 2, optOff);
    const magic = magicBuf.readUInt16LE(0); // 0x10b=PE32, 0x20b=PE32+
    const ddOff = optOff + (magic === 0x20b ? 144 : 128); // 数据目录数组起始
    const cert = Buffer.alloc(8);
    fs.readSync(fd, cert, 0, 8, ddOff + 4 * 8); // 第 5 项(index 4)
    const size = cert.readUInt32LE(4);
    return size > 0 ? `SIGNED_TABLE(${size}B)` : 'NotSigned';
  } catch (e) { return 'PE_ERR:' + (e as Error).message.slice(0, 40); }
  finally { fs.closeSync(fd); }
}

function walkFiles(dir: string, base = dir): string[] {
  let es: fs.Dirent[];
  try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p, base)); else out.push(path.relative(base, p).toLowerCase());
  }
  return out;
}
function fileManifest(dir: string): Record<string, string> {
  const m: Record<string, string> = {};
  for (const rel of walkFiles(dir)) {
    try { m[rel] = sha256(path.join(dir, rel)); } catch { m[rel] = 'READERR'; }
  }
  return m;
}
function shortcuts(): string[] {
  const cand = [
    path.join(process.env.APPDATA ?? '', 'Microsoft\\Windows\\Start Menu\\Programs'),
    path.join(process.env.USERPROFILE ?? '', 'Desktop'),
    path.join(publicDesktop(), ''),
  ];
  const found: string[] = [];
  for (const d of cand) {
    let es: string[];
    try { es = fs.readdirSync(d); } catch { continue; }
    for (const n of es) if (n.toLowerCase().includes('tongzip') && n.toLowerCase().endsWith('.lnk')) found.push(path.join(d, n));
  }
  return found;
}
function publicDesktop(): string { try { return execPs('echo $env:Public') + '\\Desktop'; } catch { return 'C:\\Users\\Public\\Desktop'; } }
function execPs(cmd: string): string {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if ((r.status ?? -1) !== 0) throw new Error(`ps 失败:${r.stderr}`);
  return r.stdout.trim();
}

/* ---------- 静默执行安装/卸载 ----------
 * NSIS 安装/卸载器都会自复制到 temp 后原进程早退(start /wait 与直接 spawn 都等不到真实终态),
 * 故不依赖退出码,只拉起进程后由调用方轮询文件系统/注册表终态。 */
function launchSilent(exe: string, args: string[]): void {
  const child = spawn(exe, args, { windowsHide: true, stdio: 'ignore', detached: false });
  child.on('error', (e) => console.error('拉起失败:', e.message));
  child.unref();
}
/** NSIS 头部进程早退后真正干活的尾部进程名形如 ~NSxxxx.tmp;它消失 + 目标 exe 尺寸稳定 = 真终态。
 * 重装会先卸后装,中途目录短暂为空/尾部进程短暂缺席,故不能只看瞬时信号。
 * 不用 tasklist /FI 通配符(老版本不支持),全量 CSV 内存里筛。 */
function nsisTailBusy(): boolean {
  const r = spawnSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
  const out = r.stdout ?? '';
  return out.split('\n').some((line) => {
    const m = line.match(/^"([^"]+)"/); // 首列 = 映像名
    const name = (m?.[1] ?? '').toLowerCase();
    return name.startsWith('nsis') || (name.startsWith('~ns') && name.endsWith('.tmp')) || (name.includes('nullsoft') && name.endsWith('.tmp'));
  });
}
/** 等待安装/重装落盘稳定:需 exe 存在 ∧ 卸载器存在 ∧ 连续两轮 exe 尺寸相同 ∧ 尾部进程空
 *  (尺寸稳定而非 mtime:避开"卸后装"瞬时窗口,避免抢在写入中途读空目录) */
async function waitSettled(desc: string, exePath: string, needUnins: () => boolean, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  let lastSize = -1, stable = 0;
  await new Promise((r) => setTimeout(r, 1500)); // 给头部→尾部交接留窗口
  for (;;) {
    let size = -1;
    try { size = fs.statSync(exePath).size; } catch { size = -1; }
    const filesReady = size > 0 && (needUnins() || !needUnins);
    if (filesReady && size === lastSize) stable++; else stable = 0;
    lastSize = size;
    if (stable >= 2 && !nsisTailBusy()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 800));
  }
}

/* ---------- 主流程 ---------- */
const tmp = mkTemp('tz-inst-');
const INST_DIR = path.join(tmp, 'app'); // 无空格:os.tmpdir 本机为 C:\Users\<u>\AppData\Local\Temp
const APPDATA_TONGZIP = path.join(process.env.APPDATA ?? '', APP_NAME);

async function main(): Promise<void> {
  /* 预检:安装包与源产物在场;临时路径无空格(/D= 安全) */
  if (!fs.existsSync(SETUP_EXE)) throw new Error(`缺少安装包,先执行 npm run dist:${SETUP_EXE}`);
  if (!fs.existsSync(WIN_UNPACKED)) throw new Error(`缺少 win-unpacked 源产物:${WIN_UNPACKED}`);
  if (/\s/.test(tmp)) throw new Error(`临时目录含空格,不适合 /D= 静默安装:${tmp}`);

  /* 1. 基线快照 */
  const base = snapshotKeys();
  const baseShellKeysPresent = shellKeySet().filter((k) => base[k]);
  const baseLnk = new Set(shortcuts().map((p) => p.toLowerCase())); // 现有合法安装的快捷方式,绝不计入本次删除断言
  const appdataExistedBefore = fs.existsSync(APPDATA_TONGZIP);
  record({ id: 'INS-00', item: '基线快照', expect: '登记 shell 键/Uninstall 键/%APPDATA% 状态', actual: `shell 键在场=${baseShellKeysPresent.length}`, verdict: 'note', detail: `已存在键:${baseShellKeysPresent.slice(0, 6).join(' | ') || '(无)'}; APPDATA\\TongZip 基线=${appdataExistedBefore ? '存在(不触碰)' : '不存在'}` });
  const shellWriteSafe = baseShellKeysPresent.length === 0; // 有 dev 残留则跳过写入,防污染现有注册

  /* 2. 静默安装到独立临时目录(安装器早退是常态:轮询真实终态) */
  launchSilent(SETUP_EXE, ['/S', `/D=${INST_DIR}`]);
  const exePath = path.join(INST_DIR, `${APP_NAME}.exe`);
  const guessUnins = path.join(INST_DIR, `Uninstall ${APP_NAME}.exe`);
  const uninsPresent = (): boolean => fs.existsSync(guessUnins) || fs.existsSync(path.join(INST_DIR, 'Uninstall.exe'));
  const installDone = await waitSettled('安装落盘稳定', exePath, uninsPresent, 5 * 60_000);
  if (!installDone) note(`安装等待超时,目录现状:${(() => { try { return fs.readdirSync(INST_DIR).slice(0, 8).join(','); } catch (e) { return 'ERR ' + (e as Error).message; } })()}`);
  const uninsPath = fs.existsSync(guessUnins) ? guessUnins : (fs.existsSync(path.join(INST_DIR, 'Uninstall.exe')) ? path.join(INST_DIR, 'Uninstall.exe') : (fs.existsSync(exePath) ? (() => { try { const hit = fs.readdirSync(INST_DIR).find((n) => /^uninstall.*\.exe$/i.test(n)); return hit ? path.join(INST_DIR, hit) : ''; } catch { return ''; } })() : ''));
  const dirOk = fs.existsSync(exePath) && !!uninsPath;
  record({ id: 'INS-01', item: '静默安装 /S /D=临时目录', expect: 'exe+卸载器在场', actual: `dir=${dirOk ? 'ok' : 'MISSING'}`, verdict: dirOk ? 'ok' : 'mismatch', detail: `安装目录=${INST_DIR}; 卸载器=${uninsPath ? path.basename(uninsPath) : '(未找到)'}` });
  if (!dirOk) throw new Error('安装失败,终止后续步骤');

  /* 3. 产物完整性:目录结构 + 7za 哈希与源产物一致 */
  const manifest = fileManifest(INST_DIR);
  const engInstalled = path.join(INST_DIR, 'resources', 'engine', '7za.exe');
  const engSource = path.join(WIN_UNPACKED, 'resources', 'engine', '7za.exe');
  const hashMatch = fs.existsSync(engInstalled) && fs.existsSync(engSource) && sha256(engInstalled) === sha256(engSource);
  record({ id: 'INS-02', item: '引擎 7za 哈希一致性', expect: '与 win-unpacked 源一致', actual: hashMatch ? 'match' : 'DIFF', verdict: hashMatch ? 'ok' : 'mismatch', detail: `files=${Object.keys(manifest).length}, asar=${'resources/app.asar' in manifest}` });

  /* 4. 卸载登记 + 快捷方式 */
  const uninsKey = uninsKeyFound() ?? UNINS_KEY_GUESS;
  const displayName = regValue(uninsKey, 'DisplayName');
  const lnks = shortcuts().filter((p) => !baseLnk.has(p.toLowerCase()));
  record({ id: 'INS-03', item: '卸载登记与快捷方式', expect: 'Uninstall 键 DisplayName 存在、本次新增快捷方式≥１', actual: `DisplayName=${displayName ?? '无'}, 新增lnk=${lnks.length}(基线已有 ${baseLnk.size})`, verdict: displayName && lnks.length ? 'ok' : 'mismatch', detail: lnks.join(' | ') });

  /* 5. 启动安装后的 exe 一次(隔离 userData,不碰 %APPDATA%) */
  const ud = path.join(tmp, 'ud');
  const port = await pickFreePort();
  const app: ProbeApp = spawnApp(exePath, ud, port);
  let engineVersion = '';
  try {
    await waitReady(app); // 内部 detectEngine 回值即引擎版本
    engineVersion = String(await cdpEval(app, `window.tz.detectEngine().then(r => r.ok ? r.data.version : 'ERR')`));
    const r = await cdpEval(app, `window.tz.getSettings().then(s => JSON.stringify({shell:s.shellIntegration}))`);
    record({ id: 'INS-04', item: '安装产物启动冒烟', expect: 'CDP 就绪+引擎探测 ok', actual: `engine=${engineVersion}, ${String(r)}`, verdict: engineVersion !== 'ERR' ? 'ok' : 'mismatch', detail: `userData=${ud}` });
    /* 6. shell 集成写键核验(仅基线干净时执行) */
    if (shellWriteSafe) {
      const si = await cdpEval(app, `window.tz.shellInstall().then(r => r.ok ? 'ok' : 'ERR:' + r.code)`);
      await new Promise((r2) => setTimeout(r2, 500)); // 落键收尾
      const afterInstall = snapshotKeys();
      const added = diffKeys(base, afterInstall).added.filter((k) => k !== uninsKey && k !== UNINS_KEY_GUESS);
      const menuVerb = regValue(`${CLASSES}\\*\\shell\\TongZip`, 'MUIVerb');
      const dirVerb = regValue(`${CLASSES}\\Directory\\shell\\TongZip`, 'MUIVerb');
      const cmdLine = regValue(`${CLASSES}\\${EXTS_OPENABLE[0]}\\shell\\TongZip\\Open\\command`, '');
      const pointsToInstall = !!cmdLine && cmdLine.includes(INST_DIR); // 注册表存的是单反斜杠原文
      const capValue = regQuery(['query', 'HKCU\\Software\\RegisteredApplications', '/v', 'TongZip']).code === 0;
      record({ id: 'INS-05', item: 'shellInstall 写键齐全', expect: 'shell 键写入且 command 指安装目录', actual: `新增=${added.length}, 命令指向安装目录=${pointsToInstall}, 默认应用登记=${capValue}`, verdict: added.length && menuVerb && dirVerb && pointsToInstall && capValue ? 'ok' : 'mismatch', detail: `MUIVerb=${menuVerb}/${dirVerb}; command=${(cmdLine ?? '').slice(0, 90)}; shellInstall 返回=${String(si)}` });
      /* 应用自检:uninstallShell  designed 路径能把自己写的键清干净 */
      const su = await cdpEval(app, `window.tz.shellUninstall().then(r => r.ok ? 'ok' : 'ERR:' + r.code)`);
      await new Promise((r2) => setTimeout(r2, 500));
      const selfCleanDiff = diffKeys(base, snapshotKeys());
      const valveClean = regQuery(['query', 'HKCU\\Software\\RegisteredApplications', '/v', 'TongZip']).code !== 0;
      record({ id: 'INS-05b', item: 'uninstallShell 自检清零', expect: '键级+值级 diff 归零', actual: `added=${selfCleanDiff.added.length}, removed=${selfCleanDiff.removed.length}, RegisteredApps值已清=${valveClean}`, verdict: selfCleanDiff.added.length === 0 && valveClean ? 'ok' : 'mismatch', detail: `差集=${selfCleanDiff.added.concat(selfCleanDiff.removed).slice(0, 6).join(' | ') || '(无)'}; shellUninstall 返回=${String(su)}` });
      /* 自检清零后重新灌入:让 NSIS 卸载面对真实键态,INS-08 残留核验才有证据 */
      await cdpEval(app, `window.tz.shellInstall().then(r => r.ok ? 'ok' : 'ERR:' + r.code)`);
      await new Promise((r2) => setTimeout(r2, 500));
    } else {
      record({ id: 'INS-05', item: 'shellInstall 写键核验', expect: '基线干净才执行', actual: 'skipped', verdict: 'note', detail: `基线已有 ${baseShellKeysPresent.length} 个 shell 键(dev 期注册),跳过写入以免覆盖现有注册;shell 写键逻辑已由 dev 期键面存在性佐证` });
    }
    /* 检查更新行为证必须在应用存活期取(真实网络,只验回包形态不断言结果) */
    const upd = await cdpEval(app, `window.tz.checkUpdate().then(r => r.ok ? 'OK:' + JSON.stringify(r.data) : 'ERR:' + r.code)`).catch((e) => `CDPFAIL:${(e as Error).message}`);
    const updStr = String(upd);
    const shapeOk = /^(OK:\{"status":"(latest|available|notfound)"|ERR:(NETWORK_FAILED)\b)/.test(updStr);
    record({ id: 'INS-11', item: '检查更新回包形态(真实网络)', expect: 'status 枚举或 NETWORK_FAILED', actual: updStr.slice(0, 120), verdict: shapeOk ? 'ok' : 'mismatch', detail: '回包结构失守=渲染层会拿到无法理解的更新状态' });
    /* 关应用(为重装/卸载让路) */
    await cdpEval(app, `window.tz.winClose(); 'fired'`).catch(() => undefined);
    await waitFor('安装产物应用退出', () => { try { process.kill(app.proc.pid, 0); return false; } catch { return true; } }, 20000, 200, () => `pid=${app.proc.pid} 仍存活`);
  } finally {
    killTree(app.proc.pid); // 无论走到哪步,不留孤儿进程
  }

  /* 7. 同版本重装(升级幂等):重装先卸后装,同样用尺寸稳定判据等真完成 */
  const manifestBefore = fileManifest(INST_DIR);
  launchSilent(SETUP_EXE, ['/S', `/D=${INST_DIR}`]);
  if (!(await waitSettled('重装落盘稳定', exePath, uninsPresent, 5 * 60_000))) note('重装等待超时,结果以文件清单对比为准');
  const manifestAfter = fileManifest(INST_DIR);
  const keysSame = JSON.stringify(Object.keys(manifestBefore).sort()) === JSON.stringify(Object.keys(manifestAfter).sort());
  const hashSame = keysSame && Object.keys(manifestAfter).every((f) => manifestBefore[f] === manifestAfter[f]);
  record({ id: 'INS-06', item: '同版本重装幂等', expect: '文件清单与哈希不变', actual: `清单=${keysSame ? 'same' : 'DIFF'}, 哈希=${hashSame ? 'same' : 'DIFF'}`, verdict: hashSame ? 'ok' : 'mismatch', detail: `files=${Object.keys(manifestAfter).length}` });

  /* 8. 静默卸载 + 快照 diff */
  const appdataBeforeUninst = fs.existsSync(APPDATA_TONGZIP);
  launchSilent(uninsPath, ['/S']);
  /* NSIS 卸载器自拷贝到 temp 后原进程早退,真实删除由尾部进程异步完成:轮询 exe 消失 ∧ 尾部进程空 */
  await waitFor('卸载器删除程序文件', () => !fs.existsSync(exePath) && !nsisTailBusy(), 4 * 60_000, 1000).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1500));
  const exeGone = !fs.existsSync(exePath);
  const post = snapshotKeys();
  const residual = diffKeys(base, post).added.filter((k) => k !== UNINS_KEY_GUESS); // 相对基线还多出来的键 = 本次写入且卸载未清
  const uninsKeyGone = post[UNINS_KEY_GUESS] === false;
  const lnkAfter = shortcuts().filter((p) => !baseLnk.has(p.toLowerCase())); // 只看本次新增的,基线快捷方式不管
  record({ id: 'INS-07', item: '卸载清除程序与卸载登记', expect: 'exe 删除、Uninstall 键消失、本次新增 lnk 清除', actual: `exe=${exeGone ? 'gone' : 'KEPT'}, uninsKey=${uninsKeyGone ? 'gone' : 'KEPT'}, 残留新增lnk=${lnkAfter.length}`, verdict: exeGone && uninsKeyGone && lnkAfter.length === 0 ? 'ok' : 'mismatch', detail: `残留 lnk=${lnkAfter.join('|') || '(无)'}; 基线原有=${baseLnk.size}` });
  record({ id: 'INS-08', item: '卸载后 shell 键残留(说明书 12.3)', expect: '自己写入的键全部清除 或 明确保留策略', actual: `残留=${residual.length}`, verdict: residual.length ? 'note' : 'ok', detail: residual.length ? `NSIS 卸载不调用 uninstallShell,以下本次写入键残留:${residual.slice(0, 8).join(' | ')}${residual.length > 8 ? ' …' : ''} — 问题清单候选(卸载残留死菜单/死 ProgID)` : '无残留' });
  const appdataAfterUninst = fs.existsSync(APPDATA_TONGZIP);
  record({ id: 'INS-09', item: '个人数据卸载处置(说明书 12.3"允许选择保留")', expect: '静默卸载行为如实记录', actual: `前=${appdataBeforeUninst ? '有' : '无'}, 后=${appdataAfterUninst ? '有' : '无'}`, verdict: 'note', detail: appdataBeforeUninst === appdataAfterUninst ? `静默 /S 卸载对 %APPDATA%\\TongZip 无动作(现网 GUI 卸载是否有询问待真机核验)` : `卸载改变了 %APPDATA%\\TongZip 存在性` });

  /* 9. 注册表零残留收尾:精确删除本次写入的键(只删 diff 出来的,绝不动基线键) */
  for (const k of residual) {
    const r = regQuery(['delete', k, '/f']);
    if (r.code !== 0) note(`注册表清理失败(可能键已被卸载器回收):${k}`);
  }
  const finalDiff = diffKeys(base, snapshotKeys());
  record({ id: 'INS-10', item: '测试后注册表回归基线', expect: 'diff 为空', actual: `added=${finalDiff.added.length}, removed=${finalDiff.removed.length}`, verdict: finalDiff.added.length === 0 && finalDiff.removed.length === 0 ? 'ok' : 'mismatch', detail: `${finalDiff.added.concat(finalDiff.removed).slice(0, 5).join(' | ')}` });

  /* 10. 检查更新健壮性:静态审(行为证 INS-11 已在应用存活期取证) */
  const mainSrc = fs.readFileSync(path.join(ROOT, 'electron', 'main.ts'), 'utf8');
  const audit = {
    notfound404: /statusCode === 404[\s\S]{0,80}resolve\(null\)/.test(mainSrc) && /if \(!r\) return \{ status: 'notfound' \}/.test(mainSrc),
    nonetErr: /statusCode !== 200[\s\S]{0,120}NETWORK_FAILED/.test(mainSrc),
    timeout: /req\.on\('timeout'[\s\S]{0,80}destroy/.test(mainSrc) && /req\.on\('error'[\s\S]{0,100}NETWORK_FAILED/.test(mainSrc),
    semver: /function cmpSemver/.test(mainSrc) && /cmpSemver\(latest, cur\) > 0/.test(mainSrc),
  };
  const auditOk = Object.values(audit).every(Boolean);
  record({ id: 'INS-12', item: '更新链静态审(404→notfound/非200与超时→NETWORK_FAILED/逐段 semver)', expect: '四分支齐备', actual: JSON.stringify(audit), verdict: auditOk ? 'ok' : 'mismatch', detail: 'electron/main.ts ghLatestRelease + tz:check-update 处理器' });
  record({ id: 'INS-13', item: '更新下载/校验/回滚未实现', expect: '发布前已知限制登记', actual: 'known-limit', verdict: 'note', detail: '检查更新只跳转 Release 页;下载/校验/回滚属另一阶段(矩阵 REL 区已记)' });

  /* 11. 数字签名:直读 PE 证书数据目录(无 PS 模块依赖、跨环境确定)。SECURITY 表项 size>0 = 含签名块 */
  const sigState = peCertTable(SETUP_EXE);
  record({ id: 'INS-14', item: '安装包数字签名(PE 证书表)', expect: '如实登记', actual: sigState, verdict: 'note', detail: '无签名→SmartScreen 警告与发布者不可信;证书表缺失=确定 NotSigned,存在仍需真机验链信任(矩阵 REL-11)' });

  /* 12. 待真机项 */
  const pending: [string, string, string][] = [
    ['INS-P1', 'GUI 安装向导全流程(许可页/目录选择/自定义勾选)', '真机手工:双击 Setup.exe 走完向导,核验每步文案与最终安装结果与静默一致'],
    ['INS-P2', '卸载 GUI 中"是否保留个人数据"询问(说明书 12.3)', '真机手工:运行 Uninstall.exe 交互卸载,记录是否出现保留历史/settings 的询问及两种选择的结果'],
    ['INS-P3', 'UserChoice 默认应用不被程序触碰', '真机核验:安装/卸载/重新注册前后,设置▸默认应用里用户手工指定的选择保持不变(本测试从未写 UserChoice,静态可审支持)'],
    ['INS-P4', '旧版本→新版本升级安装', '真机手工:先装 0.x 再覆盖 1.x,核验历史/settings 迁移与 shell 键刷新(本机只有一个版本产物)'],
  ];
  for (const [id, item, detail] of pending) record({ id, item, expect: '真机验收', actual: 'pending-real', verdict: 'pending-real', detail });

  writeOutJson('install-results.json', {
    at: new Date().toISOString(),
    setup: path.relative(ROOT, SETUP_EXE),
    installDir: INST_DIR,
    envBaseline: { shellKeys: baseShellKeysPresent, appdataExistedBefore },
    findings,
    pendingReal: pending.map(([id, item]) => ({ id, item })),
  });
  const mism = findings.filter((f) => f.verdict === 'mismatch').length;
  console.log(`\n=== 安装测试完成:通过 ${findings.filter((f) => f.verdict === 'ok').length} / 记录 ${findings.filter((f) => f.verdict === 'note').length} / 待真机 ${findings.filter((f) => f.verdict === 'pending-real').length} / 不一致 ${mism} ===`);
}

runProbe(main);
