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

/** 自带 7za 21.07 实测可创建的格式(单一真相,阶段 4 X3 实测;tar.zst 无 zstd 编码器不在列)。
 * 主进程 preflightCompress 与 UI 禁用态共用(ISS-02):不支持的创建格式在引擎启动前明确拒绝 */
export const CREATABLE_FORMATS: readonly ArchiveFormat[] = ['7z', 'zip', 'tar', 'tar.gz', 'tar.bz2', 'tar.xz'];

export function isCreatableFormat(f: ArchiveFormat): boolean {
  return CREATABLE_FORMATS.includes(f);
}

/** ZIP 传统加密口令合法字符集(ASCII 可打印);阶段 4 实测非 ASCII 密码引擎裸报「参数错误」,
 * UI 预校验与主进程拦截共用。7z 不受此限(实测可用),不得误拦。 */
export const ZIP_PW_OK = /^[\x20-\x7E]*$/;

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
  /** 符号链接/硬链接条目(7za -slt 的 Mode 'l' 前缀或 Symbolic/Hard Link 字段非空) */
  isLink?: boolean;
  /** 链接条目的目标路径原文(仅 isLink 时给出,可能指向归档外) */
  linkTo?: string;
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
  /** 嵌套解压深度(0=用户直接发起;资源防护按 maxNestDepth 熔断,预留给后续智能解压) */
  nestDepth?: number;
}

/** 解压启动结果:taskId=任务已启动;conflicts=ask 预检发现的已存在目标文件清单(上限 50 项) */
export type ExtractStart = { taskId?: string; conflicts?: string[] };

/* ------------------------------------------------------------------ */
/* 解压资源防护上限(阶段 3.2)— 安全默认值 + settings.guard 可配置       */
/* 设计:声明值可伪造,预检只是第一道;执行中看门狗以真实落盘量为准      */
/* ------------------------------------------------------------------ */
export interface GuardLimits {
  /** 单任务条目数上限(预检按列表声明、执行中按真实落地计数) */
  maxEntries: number;
  /** 声明总解压体积上限(预检),同时是执行中真实输出量硬顶 */
  maxTotalBytes: number;
  /** 单文件声明体积上限 */
  maxFileBytes: number;
  /** 解压比上限(声明总体积/归档物理大小);仅当声明总体积超过 ratioMinDeclared 时生效,避免误伤正常高压缩比小文件 */
  maxRatio: number;
  /** 压缩比规则的最小声明体积门槛 */
  ratioMinDeclared: number;
  /** 解压运行时长上限(毫秒) */
  maxRunMs: number;
  /** 输出卷最低剩余空间(预检与执行中监控共用) */
  minFreeBytes: number;
  /** 嵌套解压最大深度(预留给智能解压;超限熔断) */
  maxNestDepth: number;
  /** 重型任务(压缩/解压/测试)全局并发上限,防多任务共同耗尽 CPU/内存/磁盘 */
  maxHeavyTasks: number;
  /** 看门狗采样周期(毫秒) */
  watchIntervalMs: number;
}

export const DEFAULT_GUARD: GuardLimits = {
  maxEntries: 100_000,
  maxTotalBytes: 64 * 1024 ** 3,
  maxFileBytes: 32 * 1024 ** 3,
  maxRatio: 1000,
  ratioMinDeclared: 1 * 1024 ** 3,
  maxRunMs: 30 * 60_000,
  minFreeBytes: 64 * 1024 * 1024,
  maxNestDepth: 2,
  maxHeavyTasks: 2,
  watchIntervalMs: 1000,
};

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
  NETWORK_FAILED: 'NETWORK_FAILED',
  /** 目标卷剩余空间不足,事务/压缩未启动,原数据未触碰 */
  SPACE_LOW: 'SPACE_LOW',
  /** 修改后的临时副本结构/完整性校验失败,副本被丢弃,原归档未替换 */
  VERIFY_FAILED: 'VERIFY_FAILED',
  /** 归档替换环节失败(卷走细节:原归档保留或已还原) */
  TXN_FAILED: 'TXN_FAILED',
  /** 资源防护熔断:条目数/总体积/单文件/压缩比/运行时长超限,或执行中监控越界;半产物已清理,原归档未触碰 */
  GUARD_LIMIT: 'GUARD_LIMIT',
  /** 路径与链接安全拦截:穿越/绝对/盘符/UNC/保留设备名/数据流/链接条目/重复落点 */
  UNSAFE_PATH: 'UNSAFE_PATH',
  /** 启动前参数预检拦截(ISS-02):引擎不支持的创建格式、ZIP 密码字符集越界等——
   * 在引擎执行前给出明确原因与出路,不允许底层错误冒充格式诊断 */
  BAD_PARAM: 'BAD_PARAM',
} as const;

/** 启动时陈旧事务的恢复结果(阶段 3.1):restored=半替换中断被还原的归档,cleaned=清理掉的残留副本 */
export interface TxnRecoveryInfo {
  restored: string[];
  cleaned: string[];
}

/** 任务类型 */
export type JobKind = 'compress' | 'extract' | 'test' | 'delete';

/**
 * 持久化任务状态机(阶段 3.4)。恢复原则:恢复状态不重放任务。
 * running/queued 是崩溃前瞬态,重启后被映射,不会长期存在;
 * interrupted=上次运行中断(不假定成功或失败);retryable=排队任务重启且源文件校验通过,
 * 等待用户手动重发——系统绝不自动重放。
 */
export type PersistedTaskStatus =
  | 'running' | 'queued'
  | 'done' | 'error' | 'cancelled'
  | 'interrupted' | 'retryable';

/** 持久化任务记录:只存状态与路径,不存密码、错误文案、引擎日志(脱敏红线) */
export interface PersistedTask {
  id: string;
  kind: JobKind;
  label: string;
  /** 源压缩包路径;压缩任务为首个源(可缺) */
  src?: string;
  /** 输出归档/解压目标目录(可缺) */
  out?: string;
  createdAt: number;
  finishedAt?: number;
  status: PersistedTaskStatus;
  /** 机读错误码(ERR.*),不存人类可读消息 */
  errCode?: string;
  /** 进度摘要 0-100 */
  percent?: number;
  /** 启动恢复时置位:该任务的归档曾被事务 journal 回滚(任务结果=事务恢复,非引擎完成) */
  txnRolledBack?: boolean;
}

/** 版本化历史文件结构:格式演进时递增 version,旧版/未知版本按隔离处理 */
export interface TaskHistoryFile {
  version: 1;
  tasks: PersistedTask[];
}

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

/** 关于页:应用与运行时版本信息(主进程采集,渲染层不直接碰 process.versions) */
export interface AppAbout {
  version: string;
  electron: string;
  chromium: string;
  node: string;
}

/** 检查更新结果:available=有新版 / latest=已最新 / notfound=发布页暂无版本 */
export interface UpdateCheck {
  status: 'available' | 'latest' | 'notfound';
  latest?: string;
  url?: string;
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

/** 磁盘扫描进度事件(主进程流式推送,渲染层据此显示动画与进度) */
export interface ScanProgress {
  /** 阶段:start=开始 / scanning=逐目录推进 / done=完成 */
  phase: 'start' | 'scanning' | 'done';
  /** 已完成的顶层目录数 */
  rootsDone: number;
  /** 顶层目录总数(桌面/文档/下载,取实际可用数) */
  rootsTotal: number;
  /** 当前正在扫描的顶层目录展示名(如「桌面」),done/start 时为空 */
  current: string;
  /** 截至当前已发现的压缩包数量(增量,供实时反馈) */
  found: number;
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
  /** 浏览视图右侧详细信息面板开关:用户开/关跨会话记忆,默认开 */
  browseDetails: boolean;
  /** 目录树是否收起为 36px 竖条:用户切换跨会话记忆,默认完整展示 */
  browseTreeRail: boolean;
  /** 浏览文件列表可拖列宽(px):缺省=该列按当前目录内容自适应收紧(尽量小且完整),拖过才定宽;双击回自适应 */
  listColumnWidths: { type?: number; size?: number; time?: number; name?: number };
  /** 被拖到 0 而隐藏的列(名称列不可隐藏);表头右键菜单可恢复 */
  hiddenColumns: string[];
  /** 解压资源防护上限覆盖(阶段 3.2):缺省=DEFAULT_GUARD 安全默认值;放开上限属明确风险操作 */
  guard: Partial<GuardLimits>;
}

/** 启动载荷:通过 argv 打开的初始目标 */
export interface LaunchPayload {
  kind: 'archive' | 'compress';
  paths: string[];
  /** kind=compress 专属:--compress-as 菜单命令的显式格式 token(如 ".tar.gz")。
   *  ISS-11:协议单一入口,由主进程 parseArgv 提取、渲染层经 tokenToFormat 解析;
   *  无法识别的显式请求必须明确报错,禁止静默回退默认格式 */
  token?: string;
}

/* ------------------------------------------------------------------ */
/* 压缩格式 token 协议(ISS-11)— shell.ts 注册命令 / main.parseArgv /   */
/* App.handlePayload 三方共用单一数据源,防止词表再次漂移               */
/* ------------------------------------------------------------------ */

const TOKEN_FORMAT: Record<string, ArchiveFormat> = {
  '.7z': '7z',
  '.zip': 'zip',
  '.tar': 'tar',
  '.tar.gz': 'tar.gz', '.tgz': 'tar.gz', '.gz': 'tar.gz',
  '.tar.bz2': 'tar.bz2', '.tbz2': 'tar.bz2', '.bz2': 'tar.bz2',
  '.tar.xz': 'tar.xz', '.txz': 'tar.xz', '.xz': 'tar.xz',
  '.tar.zst': 'tar.zst', '.zst': 'tar.zst',
};

/** --compress-as 命令行可携带的全部格式 token(带点小写) */
export const COMPRESS_TOKENS: readonly string[] = Object.keys(TOKEN_FORMAT);

/** 格式 token → ArchiveFormat;未知 token 返回 null(调用方必须显式处理,不得 default) */
export function tokenToFormat(token: string): ArchiveFormat | null {
  return TOKEN_FORMAT[token.toLowerCase()] ?? null;
}

/** IPC 通道名 */
export const IPC = {
  engineDetect: 'tz:engine-detect',
  archiveList: 'tz:archive-list',
  scanArchives: 'tz:scan-archives',
  scanProgress: 'tz:scan-progress',
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
