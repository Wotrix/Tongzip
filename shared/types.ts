/**
 * TongZip 共享类型 — 主进程 / 预加载 / 渲染进程通用契约
 */

/** 支持的压缩格式族 */
export type ArchiveFormat = '7z' | 'zip' | 'tar' | 'tar.gz' | 'tar.xz' | 'tar.bz2' | 'tar.zst';

/* ------------------------------------------------------------------ */
/* 压缩包扩展名清单 — 全工程单一数据源(按自带 7za 21.07 实测能力)      */
/* ------------------------------------------------------------------ */

/** 自带 7za 可直接识别/解压的格式(不含点,小写) */
export const ARCHIVE_EXTS_OPENABLE: readonly string[] = [
  '7z', 'zip', 'zipx', 'z01', 'tar', 'tgz', 'tpz', 'ova', 'gz', 'gzip',
  'bz2', 'tbz2', 'tbz', 'bzip2', 'xz', 'txz', 'lzma', 'lzma86',
  'cab', '001', 'apk', 'ipa', 'appx', 'jar', 'xpi', 'odt', 'ods',
  'docx', 'xlsx', 'epub', 'war', 'ear',
];

/** 仅当引擎为完整版 7z(系统安装/手动指定)时可打开 —「打开方式」兜底不该覆盖这类扩展 */
export const ARCHIVE_EXTS_SYS_ONLY: readonly string[] = [
  'rar', 'zst', 'iso', 'wim', 'swm', 'esd',
];

/** 全部可识别为压缩包的扩展名(列表识别、扫描、文件图标用) */
export const ARCHIVE_EXTS: readonly string[] = [...ARCHIVE_EXTS_OPENABLE, ...ARCHIVE_EXTS_SYS_ONLY];

export function isArchiveExt(ext: string): boolean {
  return (ARCHIVE_EXTS as readonly string[]).includes(ext.toLowerCase());
}

/** 压缩包内条目 */
export interface ArchiveEntry {
  /** 归档内全路径(已归一化为 / 分隔) */
  path: string;
  /** 所在目录(含尾部 / ,根目录为空串) */
  dir: string;
  /** 文件名 */
  name: string;
  /** 是否目录 */
  isDir: boolean;
  /** 原始字节数 */
  size: number;
  /** 打包后字节数 */
  packed: number;
  /** 修改时间,形如 2026-09-29 18:21:03 */
  mtime: string;
  /** 是否加密 */
  encrypted: boolean;
}

/** 打开压缩包的返回 */
export interface ArchiveInfo {
  /** 归档类型描述,如 7z / zip */
  type: string;
  /** 物理文件大小 */
  physSize: number;
  entries: ArchiveEntry[];
  /** 是否包含加密内容 */
  hasEncrypted: boolean;
}

/** 条目预览结果(主进程解压单文件后归类) */
export interface EntryPreview {
  kind: 'text' | 'image' | 'file';
  name: string;
  size: number;
  /** kind=text 时的 UTF-8 内容(截断至 64KB) */
  text?: string;
  /** kind=image 时的 data URL */
  dataUrl?: string;
  /** 内容被截断 */
  truncated?: boolean;
}

/** 压缩任务参数 */
export interface CompressJob {
  /** 待压缩的绝对路径列表 */
  sources: string[];
  /** 输出归档绝对路径 */
  output: string;
  format: ArchiveFormat;
  /** 0-9,store=0 */
  level: number;
  /** 字典,如 "16m" ;仅 7z 生效 */
  dict: string;
  /** 固实块,如 "64m" / "on" / "off";仅 7z 生效 */
  solid: string;
  /** 多线程;仅 7z 生效 */
  multiThread: boolean;
  password?: string;
  /** 是否将密码应用于文件头(zip) */
  encryptHeaders?: boolean;
  /** 分卷大小,如 "700m";7z/zip 生效 */
  volume?: string;
  /** 从输出中排除(删除后再添加) */
  updateMode?: boolean;
}

/** 解压任务参数 */
export interface ExtractJob {
  archive: string;
  dest: string;
  /** 归档内的相对路径列表;为空表示全量 */
  entries?: string[];
  password?: string;
  /** 已存在时: ask | overwrite | skip | rename */
  overwrite: 'ask' | 'overwrite' | 'skip' | 'rename';
  /** 解压后把指定 entry 的落地名改为新名(归档内相对路径 → 新文件名) */
  renames?: Record<string, string>;
  /** 仅解压匹配 entry 的文件并返回其本地路径(用于单文件打开) */
  extractToTemp?: boolean;
}

/** 解压启动结果:taskId=任务已启动;conflicts=ask 预检发现的已存在目标文件清单(上限 50 项) */
export type ExtractStart = { taskId?: string; conflicts?: string[] };

/** 错误码单一数据源:主进程 EngineError.code / 进度事件 ProgressEvent.code / 渲染层比对共用,
 * 禁止再散落魔法字符串(字符串匹配用户可读 message 属于反模式) */
export const ERR = {
  NEED_PASSWORD: 'NEED_PASSWORD',
  ENGINE_MISSING: 'ENGINE_MISSING',
  LIST_FAILED: 'LIST_FAILED',
  BAD_NAME: 'BAD_NAME',
  EXISTS: 'EXISTS',
  NO_OUTPUT: 'NO_OUTPUT',
  BAD_URL: 'BAD_URL',
  OPEN_FAILED: 'OPEN_FAILED',
} as const;

/** 任务类型 */
export type JobKind = 'compress' | 'extract' | 'test' | 'delete';

/** 主进程推送的进度事件 */
export interface ProgressEvent {
  taskId: string;
  kind: JobKind;
  /** 0-100,-1 表示不确定 */
  percent: number;
  /** 当前文件/信息行 */
  file: string;
  /** 流式日志 */
  log?: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  /** 错误信息或结果说明(用户可读文案) */
  message?: string;
  /** status=error 时的机读错误码(如 NEED_PASSWORD),渲染层据此分支重试而非匹配文案 */
  code?: string;
}

/** 磁盘目录条目 — 应用内文件夹浏览的数据单元(路径统一正斜杠) */
export interface FolderEntry {
  name: string;
  path: string;
  isDir: boolean;
  /** 字节(文件夹为 0,列表不展开统计) */
  size: number;
  /** 修改时间,已格式化为 YYYY-MM-DD HH:MM */
  mtime: string;
  /** .exe/.lnk 等可直接执行的系统文件 */
  isExe: boolean;
  /** 可被本应用打开的压缩包扩展名 */
  isArchive: boolean;
}

/** IPC 统一响应壳 */
export type IpcResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

/** 引擎自检信息 */
export interface EngineInfo {
  path: string;
  version: string;
  source: 'bundled' | 'system' | 'manual';
}

/** Shell 集成状态 */
export interface ShellState {
  installed: boolean;
}

/** 本地磁盘上扫描到的压缩包文件(「我的压缩包」页) */
export interface ArchiveFile {
  path: string;
  name: string;
  size: number;
  /** 修改时间,形如 2026-09-29 18:21 */
  mtime: string;
}

/** 主题强调色预设(与 app.css 的 [data-accent] 对应) */
export type AccentKey = 'violet' | 'blue' | 'orange' | 'cyan' | 'green' | 'indigo';

/** 资源管理器右键菜单项开关(参考 Bandizip 的自定义菜单) */
export interface ContextMenuSettings {
  /* 压缩包菜单 */
  /** 用 TongZip 打开 */
  open: boolean;
  /** 解压到同名文件夹 */
  extractTo: boolean;
  /** 解压到当前文件夹 */
  extractHere: boolean;
  /** 解压到…(弹对话框选去向) */
  extractDialog: boolean;
  /** 把 TongZip 加入压缩包「打开方式」并作为无默认程序时的默认打开 */
  openWith: boolean;
  /* 文件/文件夹压缩菜单 */
  compress7z: boolean;
  compressZip: boolean;
  compressTarGz: boolean;
  /** 压缩选项…(打开压缩对话框) */
  compressDialog: boolean;
}

/** 设置项 */
export interface Settings {
  theme: 'auto' | 'light' | 'dark';
  enginePath: string | null;
  shellIntegration: boolean;
  /** 右键菜单自定义项(仅在 shellIntegration 开启时写入注册表) */
  contextMenu: ContextMenuSettings;
  dblClickAction: 'open' | 'extractDialog' | 'quickExtract';
  rememberPassword: boolean;
  /** 最近打开的压缩包路径(最新在前,上限 8) */
  recentArchives: string[];
  /** 强调色,默认竹影紫(#5A36DE) */
  accent: AccentKey;
  /** 新建压缩包的默认格式 */
  defaultFormat: ArchiveFormat;
  /** 新建压缩包的默认压缩等级 0-9 */
  defaultLevel: number;
  /** 首页是否显示「最近打开」板块 */
  showRecentOpen: boolean;
  /** 首页是否显示「最近任务」板块 */
  showRecentTasks: boolean;
  /** 左侧导航栏宽度(px),可拖 156–260,默认 156(取下限) */
  sidebarWidth: number;
  /** 侧边栏被拖到最小后收起(留竖条恢复入口);与冷启动自动隐藏(sbHidden)是两回事 */
  sidebarCollapsed: boolean;
  /** 目录树面板宽度(px),可拖 160–400,默认 160(取下限) */
  treeWidth: number;
  /** 浏览文件列表可拖列宽(px):缺省=该列按当前目录内容自适应收紧(尽量小且完整),拖过才定宽;双击回自适应 */
  listColumnWidths: { type?: number; size?: number; time?: number; name?: number };
  /** 被拖到 0 而隐藏的列(名称列不可隐藏);表头右键菜单可恢复 */
  hiddenColumns: string[];
}

/** 启动载荷:通过 argv 打开的初始目标 */
export interface LaunchPayload {
  kind: 'archive' | 'compress';
  paths: string[];
}

/** IPC 通道名 */
export const IPC = {
  engineDetect: 'tz:engine-detect',
  archiveList: 'tz:archive-list',
  scanArchives: 'tz:scan-archives',
  compress: 'tz:compress',
  extract: 'tz:extract',
  test: 'tz:test',
  deleteEntries: 'tz:delete-entries',
  taskCancel: 'tz:task-cancel',
  pickFiles: 'tz:pick-files',
  pickFolder: 'tz:pick-folder',
  saveAs: 'tz:save-as',
  revealInExplorer: 'tz:reveal',
  openExternal: 'tz:open-external',
  settingsGet: 'tz:settings-get',
  settingsSet: 'tz:settings-set',
  shellInstall: 'tz:shell-install',
  shellUninstall: 'tz:shell-uninstall',
  shellStatus: 'tz:shell-status',
  shellRefresh: 'tz:shell-refresh',
  openDefaultApps: 'tz:open-default-apps',
  windowMinimize: 'tz:win-minimize',
  windowMaximize: 'tz:win-maximize',
  windowClose: 'tz:win-close',
  getLaunchPayload: 'tz:get-launch-payload',
  progress: 'tz:progress',
  launchEvent: 'tz:launch-event',
} as const;
