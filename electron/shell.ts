/**
 * TongZip Shell 集成 — 通过 HKCU 注册表写入 Windows 资源管理器右键菜单
 *
 * 菜单项由用户在设置页自行勾选(参考 Bandizip 的自定义菜单):
 *   文件/文件夹 ▸ TongZip   压缩为 7z | ZIP | tar.gz | 压缩选项…
 *   压缩包      ▸ TongZip   打开 | 解压到同名文件夹 | 解压到当前文件夹 | 解压到…
 *   关联        压缩包扩展名的 OpenWithProgids + shell\open(消除「没有关联应用」报错)
 *
 * 幂等策略: 每次安装先清空旧键再按当前选项重写,项目路径变化后可直接「重新注册」。
 */
import { execFile } from 'node:child_process';
import { app } from 'electron';
import { promisify } from 'node:util';
import type { ContextMenuSettings } from '../shared/types';
import { ARCHIVE_EXTS, ARCHIVE_EXTS_OPENABLE, ARCHIVE_EXTS_SYS_ONLY } from '../shared/types';

const run = promisify(execFile);
const REG = 'reg.exe';

async function reg(...args: string[]): Promise<void> {
  await run(REG, args, { windowsHide: true });
}
/** 卸载/清键时容忍「键不存在」 */
async function regQuiet(...args: string[]): Promise<void> {
  try { await reg(...args); } catch { /* 键不存在 */ }
}

const ROOT = 'HKCU\\Software\\Classes';
const PROGID = 'TongZip.Archive';

/** 右键菜单/文件关联的目标扩展名(带点小写),来自 shared 单一数据源 */
const EXTS: string[] = ARCHIVE_EXTS.map((e) => `.${e}`);
/** 「打开方式」兜底与双击默认只覆盖自带 7za 真能打开的格式(rar/zst/iso 等不抢) */
const EXTS_OPENABLE: string[] = ARCHIVE_EXTS_OPENABLE.map((e) => `.${e}`);
const SYS_ONLY_EXTS: string[] = ARCHIVE_EXTS_SYS_ONLY.map((e) => `.${e}`);

/**
 * 启动器前缀(不含 %1,由各菜单项自行拼参数)。
 * 打包后 = 主程序;开发期 = electron.exe + 项目根目录。
 * 注意:开发期必须传目录(而非 dist-electron/main.js),否则 Electron 视为不同应用,
 * userData/单实例锁错开,右键命令会另起独立实例而非移交当前窗口。
 */
function launcher(): string {
  if (app.isPackaged) return `"${process.execPath}"`;
  return `"${process.execPath}" "${app.getAppPath()}"`;
}

interface ItemDef { key: string; label: string; args: string }

function compressItems(o: ContextMenuSettings): ItemDef[] {
  const all: [keyof ContextMenuSettings, ItemDef][] = [
    ['compress7z', { key: 'Compress7z', label: '压缩为 7z', args: '--compress-as "%1" ".7z"' }],
    ['compressZip', { key: 'CompressZip', label: '压缩为 ZIP', args: '--compress-as "%1" ".zip"' }],
    ['compressTarGz', { key: 'CompressTarGz', label: '压缩为 tar.gz', args: '--compress-as "%1" ".tar.gz"' }],
    ['compressDialog', { key: 'CompressDialog', label: '压缩选项…', args: '--compress-dialog "%1"' }],
  ];
  return all.filter(([k]) => o[k]).map(([, v]) => v);
}

function extractItems(o: ContextMenuSettings): ItemDef[] {
  const all: [keyof ContextMenuSettings, ItemDef][] = [
    ['open', { key: 'Open', label: '打开', args: '--open "%1"' }],
    ['extractTo', { key: 'ExtractTo', label: '解压到同名文件夹', args: '--extract "%1"' }],
    ['extractHere', { key: 'ExtractHere', label: '解压到当前文件夹', args: '--extract-here "%1"' }],
    ['extractDialog', { key: 'ExtractDialog', label: '解压到…', args: '--extract-dialog "%1"' }],
  ];
  return all.filter(([k]) => o[k]).map(([, v]) => v);
}

/**
 * 在 shell\TongZip 下写一组真实子菜单项(Bandizip 式二级上下文菜单)。
 * 结构铁律:每个菜单项是独立子键 shell\TongZip\<ItemKey>,
 *   子键默认值/MUIVerb = 显示名,子键\command 默认值 = 命令行。
 *   (写成 command\<label> 是无效结构,资源管理器不会渲染任何项)
 * MultipleExtensions + %V 让多选文件时一次唤起;items 为空则整个不建。
 */
async function writeMenu(base: string, items: ItemDef[], cmd0: string): Promise<void> {
  if (!items.length) return;
  await reg('add', base, '/v', 'MUIVerb', '/d', 'TongZip', '/f');
  await reg('add', base, '/v', 'Icon', '/d', `"${process.execPath}",0`, '/f');
  await reg('add', base, '/v', 'MultipleExtensions', '/t', 'REG_SZ', '/d', '', '/f');
  for (const i of items) {
    const dir = `${base}\\${i.key}`;
    await reg('add', dir, '/v', 'MUIVerb', '/d', i.label, '/f');
    await reg('add', `${dir}\\command`, '/v', '', '/d', `${cmd0} ${i.args}`, '/f');
    /* Shift 右键(扩展命令)时 %V 展开为全部选中项 */
    await reg('add', dir, '/v', 'ExtendedCommandLine', '/d', `${cmd0} ${i.args.replace('%1', '%V')}`, '/f');
  }
}

export async function installShell(o: ContextMenuSettings): Promise<void> {
  await uninstallShell(); // 先清旧键,保证幂等与路径刷新
  const cmd0 = launcher();

  /* 文件/文件夹上的压缩菜单 */
  const cItems = compressItems(o);
  for (const t of ['*', 'Directory']) {
    await writeMenu(`${ROOT}\\${t}\\shell\\TongZip`, cItems, cmd0);
  }

  /* 压缩包扩展名上的解压菜单 */
  const eItems = extractItems(o);
  for (const e of EXTS) {
    await writeMenu(`${ROOT}\\${e}\\shell\\TongZip`, eItems, cmd0);
    if (o.openWith) {
      await reg('add', `${ROOT}\\${e}\\OpenWithProgids`, '/v', PROGID, '/t', 'REG_NONE', '/f');
    }
  }
  /* 无系统默认程序的扩展由 shell\open 兜底双击打开;.zip 等仍听用户「默认应用」 */
  for (const e of EXTS_OPENABLE) {
    if (o.openWith) {
      await reg('add', `${ROOT}\\${e}\\shell\\open\\command`, '/v', '', '/d', `${cmd0} --open "%1"`, '/f');
    } else {
      await deleteOpenIfOurs(e, cmd0); // 关闭开关时清理自己写过的兜底
    }
  }

  /* 「打开方式」里显示的应用条目 */
  if (o.openWith) {
    const p = `${ROOT}\\${PROGID}`;
    await reg('add', p, '/v', 'FriendlyTypeName', '/d', 'TongZip 压缩包', '/f');
    await reg('add', p, '/v', 'ApplicationName', '/d', 'TongZip', '/f');
    await reg('add', p, '/v', 'ApplicationDescription', '/d', 'TongZip 压缩包打开/解压', '/f');
    await reg('add', `${p}\\DefaultIcon`, '/v', '', '/d', `"${process.execPath}",0`, '/f');
    await reg('add', `${p}\\shell\\open\\command`, '/v', '', '/d', `${cmd0} --open "%1"`, '/f');
  }
}

/** 只有当 .ext\shell\open 确实指向 TongZip 时才删除,避免误伤用户设置 */
async function deleteOpenIfOurs(e: string, cmd0: string): Promise<void> {
  const key = `${ROOT}\\${e}\\shell\\open\\command`;
  try {
    const { stdout } = await run(REG, ['query', key, '/ve'], { windowsHide: true });
    // reg.exe 长值会折行,双方去掉引号/空白后再比对是否为本应用写入
    const flat = stdout.replace(/["'\s]/g, '');
    if (flat.includes(cmd0.replace(/["'\s]/g, ''))) await reg('delete', `${ROOT}\\${e}\\shell\\open`, '/f');
  } catch { /* 键不存在 */ }
}

export async function uninstallShell(): Promise<void> {
  for (const t of ['*', 'Directory']) {
    await regQuiet('delete', `${ROOT}\\${t}\\shell\\TongZip`, '/f');
  }
  const cmd0 = launcher();
  for (const e of EXTS) {
    await regQuiet('delete', `${ROOT}\\${e}\\shell\\TongZip`, '/f');
    await regQuiet('delete', `${ROOT}\\${e}\\OpenWithProgids`, '/v', PROGID, '/f');
  }
  for (const e of EXTS_OPENABLE) {
    await deleteOpenIfOurs(e, cmd0);
  }
  /* 早期版本给 rar/zst/iso 等也写过 shell\open 兜底,同样清掉(抢 WinRAR 默认打开不合理) */
  for (const e of SYS_ONLY_EXTS) {
    await deleteOpenIfOurs(e, cmd0);
  }
  await regQuiet('delete', `${ROOT}\\${PROGID}`, '/f');
  /* 清理旧版遗留 */
  await regQuiet('delete', `${ROOT}\\AppUserModelID\\TongZip;classID=TongZip`, '/f');
  for (const legacy of ['.rar', '.001']) {
    await regQuiet('delete', `${ROOT}\\${legacy}\\OpenWithProgids`, '/v', 'TongZip;classID=TongZip', '/f');
  }
}

/** 任一键位存在即视为已集成(菜单项可能全被勾掉,但 openWith 仍在) */
export async function shellStatus(): Promise<boolean> {
  const probes = [
    `${ROOT}\\*\\shell\\TongZip`,
    `${ROOT}\\.7z\\shell\\TongZip`,
    `${ROOT}\\${PROGID}`,
  ];
  for (const p of probes) {
    try {
      await run(REG, ['query', p], { windowsHide: true });
      return true;
    } catch { /* 继续探测 */ }
  }
  return false;
}
