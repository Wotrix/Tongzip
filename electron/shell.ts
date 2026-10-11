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
import path from 'node:path';
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
/** 必须与 main.ts 的 app.setAppUserModelId 一致:Windows 按此 ID 反查应用显示名/图标,
 *  不绑定时「默认应用」页/任务管理器会回落到 electron.exe 的「Electron」身份 */
const AUMID = 'com.tongzip.app';

/** 右键菜单/文件关联的目标扩展名(带点小写),来自 shared 单一数据源 */
const EXTS: string[] = ARCHIVE_EXTS.map((e) => `.${e}`);
/** 「打开方式」兜底与双击默认只覆盖自带 7za 真能打开的格式(rar/zst/iso 等不抢) */
const EXTS_OPENABLE: string[] = ARCHIVE_EXTS_OPENABLE.map((e) => `.${e}`);
const SYS_ONLY_EXTS: string[] = ARCHIVE_EXTS_SYS_ONLY.map((e) => `.${e}`);

/** 扩展名 → 展示标签(首字母大写),用于按后缀区分的类型描述(zip→Zip, 7z→7z) */
function extLabel(ext: string): string {
  const b = ext.replace(/^\./, '');
  return b.charAt(0).toUpperCase() + b.slice(1);
}
/** 每个后缀独立 ProgID,使「打开方式/文件类型」描述能按后缀区分(而非共用一个「压缩包」) */
function progidFor(ext: string): string {
  return `TongZip.${ext.replace(/^\./, '')}`;
}
/** 按后缀的类型描述文案,如「TongZip Zip文件」 */
function typeDesc(ext: string): string {
  return `TongZip ${extLabel(ext)}文件`;
}

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

/** 图标资产路径:打包后在 resources(buildResources 不自动入包,随 extraResources 携带),开发期在 build/ */
function iconAsset(name: string): string {
  return app.isPackaged ? path.join(process.resourcesPath, name) : path.join(app.getAppPath(), 'build', name);
}
/** 应用/菜单图标(打包 exe 自带 icon.ico;开发期 exe 是 electron.exe,改指 build/icon.ico) */
function appIcon(): string {
  return app.isPackaged ? `"${process.execPath}",0` : `"${iconAsset('icon.ico')}"`;
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
 * 父键必须带 SubCommands(REG_SZ, 可空):Windows 11 新式菜单据此判定「这是子菜单」,
 *   缺省则即便子项齐全也会被折叠成单个叶子项(与系统内置「校验文件 Hash」同构)。
 * MultipleExtensions + %V 让多选文件时一次唤起;items 为空则整个不建。
 */
async function writeMenu(base: string, items: ItemDef[], cmd0: string): Promise<void> {
  if (!items.length) return;
  await reg('add', base, '/v', 'MUIVerb', '/d', 'TongZip', '/f');
  await reg('add', base, '/v', 'Icon', '/d', appIcon(), '/f');
  await reg('add', base, '/v', 'SubCommands', '/t', 'REG_SZ', '/d', '', '/f');
  await reg('add', base, '/v', 'MultipleExtensions', '/t', 'REG_SZ', '/d', '', '/f');
  for (const i of items) {
    const dir = `${base}\\${i.key}`;
    await reg('add', dir, '/v', 'MUIVerb', '/d', i.label, '/f');
    await reg('add', `${dir}\\command`, '/v', '', '/d', `${cmd0} ${i.args}`, '/f');
    /* Shift 右键(扩展命令)时 %V 展开为全部选中项 */
    await reg('add', dir, '/v', 'ExtendedCommandLine', '/d', `${cmd0} ${i.args.replace('%1', '%V')}`, '/f');
  }
}

/** 登记单个后缀的 ProgID:类型描述按后缀区分 + 图标 + 打开命令 + 绑定 AUMID */
async function writeProgid(ext: string, cmd0: string): Promise<void> {
  const p = `${ROOT}\\${progidFor(ext)}`;
  const d = typeDesc(ext);
  await reg('add', p, '/v', '', '/d', d, '/f');                    // ProgID 默认值 = 文件类型描述
  await reg('add', p, '/v', 'FriendlyTypeName', '/d', d, '/f');    // 「打开方式」条目副标题按后缀区分
  await reg('add', p, '/v', 'AppUserModelID', '/d', AUMID, '/f');  // 绑应用身份,取 TongZip 名与图标
  await reg('add', `${p}\\DefaultIcon`, '/v', '', '/d', `"${iconAsset('archive.ico')}"`, '/f');
  await reg('add', `${p}\\shell\\open\\command`, '/v', '', '/d', `${cmd0} --open "%1"`, '/f');
}

export async function installShell(o: ContextMenuSettings): Promise<void> {
  await uninstallShell(true); // 先清旧键,保证幂等与路径刷新;保留默认应用登记(刷新菜单不该抹掉它)
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
      await reg('add', `${ROOT}\\${e}\\OpenWithProgids`, '/v', progidFor(e), '/t', 'REG_NONE', '/f');
    }
  }
  /* 压缩包专属图标无条件写入:文件类型图标是品牌呈现,不该被「打开方式」开关连坐;
   * 注:已被系统默认程序接管的后缀(如 .zip)由 Windows 显示接管者图标,DefaultIcon 只对
   * 无系统默认的后缀(.7z/.tar/.001 等)直接生效 */
  for (const e of EXTS_OPENABLE) {
    await reg('add', `${ROOT}\\${e}\\DefaultIcon`, '/v', '', '/d', `"${iconAsset('archive.ico')}"`, '/f');
    if (o.openWith) {
      await reg('add', `${ROOT}\\${e}\\shell\\open\\command`, '/v', '', '/d', `${cmd0} --open "%1"`, '/f');
    } else {
      await deleteOpenIfOurs(e, cmd0); // 关闭开关时清理自己写过的兜底
    }
  }

  /* 「打开方式」里显示的应用条目:按后缀独立 ProgID,描述随后缀区分(如「TongZip Zip文件」) */
  if (o.openWith) {
    for (const e of EXTS_OPENABLE) await writeProgid(e, cmd0);
    await writeAppIdentity();
  }
  await refreshIconCache(); // 菜单/文件图标变更后立即刷新 Explorer 图标缓存
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

/** keepDefaultApps=true:installShell 内部重写菜单时不清「默认应用」登记(否则勾一下开关就会从默认应用列表消失) */
export async function uninstallShell(keepDefaultApps = false): Promise<void> {
  for (const t of ['*', 'Directory']) {
    await regQuiet('delete', `${ROOT}\\${t}\\shell\\TongZip`, '/f');
  }
  const cmd0 = launcher();
  for (const e of EXTS) {
    await regQuiet('delete', `${ROOT}\\${e}\\shell\\TongZip`, '/f');
    await regQuiet('delete', `${ROOT}\\${e}\\OpenWithProgids`, '/v', progidFor(e), '/f');
  }
  for (const e of EXTS_OPENABLE) {
    await deleteOpenIfOurs(e, cmd0);
  }
  /* 早期版本给 rar/zst/iso 等也写过 shell\open 兜底,同样清掉(抢 WinRAR 默认打开不合理) */
  for (const e of SYS_ONLY_EXTS) {
    await deleteOpenIfOurs(e, cmd0);
  }
  for (const e of EXTS_OPENABLE) {
    await regQuiet('delete', `${ROOT}\\${e}\\DefaultIcon`, '/ve');
  }
  /* 删除按后缀独立 ProgID(含历史共用的单 ProgID) */
  for (const e of EXTS) {
    await regQuiet('delete', `${ROOT}\\${progidFor(e)}`, '/f');
  }
  await regQuiet('delete', `${ROOT}\\TongZip.Archive`, '/f');
  if (!keepDefaultApps) {
    await unregisterDefaultAppCapabilities(); // 真正卸载时同步撤销「默认应用」登记,避免设置里残留死条目
    await regQuiet('delete', `${ROOT}\\AppUserModelID\\${AUMID}`, '/f');
  }
  /* 清理旧版遗留 */
  await regQuiet('delete', `${ROOT}\\AppUserModelID\\TongZip;classID=TongZip`, '/f');
  for (const legacy of ['.rar', '.001']) {
    await regQuiet('delete', `${ROOT}\\${legacy}\\OpenWithProgids`, '/v', 'TongZip;classID=TongZip', '/f');
  }
}

/** 刷新资源管理器图标缓存(改 DefaultIcon 后Explorer不重启看不到新图);尽力而为,失败忽略 */
async function refreshIconCache(): Promise<void> {
  try { await run('ie4uinit.exe', ['-show']); } catch { /* 桌面环境差异,忽略 */ }
}

/**
 * 应用身份登记:在 Classes\AppUserModelID 下登记显示名与图标。
 * 缺省时「设置▸默认应用」/「打开方式」与任务栏会回落显示成宿主 exe 的「Electron」名与地球图标;
 * 补上 Icon 后,应用条目改用 TongZip 图标(打包=exe 自带 icon.ico,开发期=build/icon.ico)。
 * (各后缀 ProgID 已在 writeProgid 内绑定 AppUserModelID)
 */
async function writeAppIdentity(): Promise<void> {
  const k = `${ROOT}\\AppUserModelID\\${AUMID}`;
  await reg('add', k, '/v', '', '/d', 'TongZip', '/f');
  await reg('add', k, '/v', 'Icon', '/d', appIcon(), '/f');
}

/**
 * 把 TongZip 登记为「可被设为默认」的应用。
 * Windows 10/11 不允许第三方程序静默改写默认关联(UserChoice 受哈希保护),
 * 但只要在 HKCU\Software\RegisteredApplications + Capabilities\FileAssociations 登记,
 * 「设置 ▸ 默认应用」里就会出现 TongZip 条目,用户点一下即可把压缩包格式设为默认。
 * 同时确保 ProgID 存在(默认应用按 ProgID 解析双击行为)。
 */
export async function registerDefaultAppCapabilities(): Promise<void> {
  const cmd0 = launcher();
  /* 按后缀独立 ProgID,默认应用页里每个类型显示「TongZip Xx文件」 */
  for (const e of EXTS_OPENABLE) await writeProgid(e, cmd0);
  await writeAppIdentity(); // 绑 AUMID + 图标,否则默认应用页里显示成「Electron」
  const cap = 'HKCU\\Software\\TongZip\\Capabilities';
  await reg('add', cap, '/v', 'ApplicationName', '/d', 'TongZip', '/f');
  await reg('add', cap, '/v', 'ApplicationDescription', '/d', 'TongZip 压缩包打开/解压', '/f');
  const fa = `${cap}\\FileAssociations`;
  for (const e of EXTS_OPENABLE) {
    await reg('add', fa, '/v', e, '/d', progidFor(e), '/f');
  }
  // RegisteredApplications 的值是相对本 hive 的 Capabilities 子键路径
  await reg('add', 'HKCU\\Software\\RegisteredApplications', '/v', 'TongZip', '/d', 'Software\\TongZip\\Capabilities', '/f');
}

/** 卸载时一并清理默认应用登记,避免「设置」里残留死条目 */
async function unregisterDefaultAppCapabilities(): Promise<void> {
  await regQuiet('delete', 'HKCU\\Software\\RegisteredApplications', '/v', 'TongZip', '/f');
  await regQuiet('delete', 'HKCU\\Software\\TongZip\\Capabilities', '/f');
}

/** 任一键位存在即视为已集成(菜单项可能全被勾掉,但 openWith 仍在) */
export async function shellStatus(): Promise<boolean> {
  const probes = [
    `${ROOT}\\*\\shell\\TongZip`,
    `${ROOT}\\.7z\\shell\\TongZip`,
    `${ROOT}\\${progidFor('.7z')}`,
  ];
  for (const p of probes) {
    try {
      await run(REG, ['query', p], { windowsHide: true });
      return true;
    } catch { /* 继续探测 */ }
  }
  return false;
}
