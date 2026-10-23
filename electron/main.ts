/**
 * TongZip 主进程 — 窗口、生命周期、IPC 装配、命令行任务调度
 *
 * 窗口走 frameless + 自绘标题栏;主题色由渲染层通知,同步到原生背景。
 */
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, nativeImage, shell, Menu } from 'electron';
import { exec } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type {
  AppAbout, ArchiveFile, CompressJob, ExtractJob, ExtractStart, FolderEntry, IpcResult, LaunchPayload,
  ProgressEvent, ScanProgress, Settings, UpdateCheck,
} from '../shared/types';
import { ERR, isArchiveExt } from '../shared/types';
import {
  EngineError, cancelTask, configureGuard, configureTxnJournal, defaultOutputFor, detectEngine, extractConflicts, extractSingleToTemp,
  inferFormat, isArchivePath, listArchive, pauseTask, preflightCompress, assertZipPw, previewEntry, quickExtractDest, recoverStaleTransactions,
  runCompress, runDelete, runExtract, runTest, totalSize,
} from './engine';
import {
  backfillTaskPaths, clearTaskHistory, configureTaskHistory, flushTaskHistory, getTaskHistory, loadTaskHistory, observeTaskEvent, removeTaskHistory,
} from './history';
import { installShell, registerDefaultAppCapabilities, shellStatus, uninstallShell } from './shell';
import { checkForUpdate, initUpdater, installUpdate, scheduleStartupCheck } from './updater';

/* ------------------------------------------------------------------ */
/* 常量与状态                                                          */
/* ------------------------------------------------------------------ */

const DEV_URL = process.env.VITE_DEV_SERVER_URL;

/* 关于页与更新源:仓库名以远程 origin 为准(Wotrix/Tongzip) */
const REPO = 'Wotrix/Tongzip';
const isWin = process.platform === 'win32';

let win: BrowserWindow | null = null;
/** 独立任务窗口:压缩启动时弹出,展示进行中任务进度 */
let taskWin: BrowserWindow | null = null;
/** 任务快照:taskId → 最新进度事件(任务窗口晚开时回放进行中任务;终态延迟清除) */
const taskFeed = new Map<string, ProgressEvent>();
/** 任务路径登记:taskId → 源包/输出/解压目标(任务窗「打开位置」双钮的数据源) */
interface TaskPaths { archive?: string; output?: string; dest?: string }
const taskPaths = new Map<string, TaskPaths>();
let pendingPayload: LaunchPayload | null = null;

/** 极简 JSON 设置存储(同步读写,存于 userData 目录) */
const DEFAULTS: Settings = {
  theme: 'auto',
  enginePath: null,
  shellIntegration: false,
  contextMenu: {
    open: true, extractTo: true, extractHere: true, extractDialog: true, openWith: true,
    compress7z: true, compressZip: true, compressTarGz: true, compressDialog: true,
  },
  dblClickAction: 'open',
  rememberPassword: false,
  recentArchives: [],
  accent: 'violet',
  defaultFormat: '7z',
  defaultLevel: 5,
  showRecentOpen: true,
  showRecentTasks: true,
  sidebarWidth: 156,
  sidebarCollapsed: false,
  treeWidth: 160,
  browseDetails: true,
  browseTreeRail: false,
  listColumnWidths: {},
  hiddenColumns: [],
  guard: {}, // 缺省=引擎侧 DEFAULT_GUARD 安全默认值;用户覆盖只存差量
};
/** 设置存储:内存缓存 + 去抖落盘。此前 raw 每键重读文件、settings-set 逐键同步写,
 * 一次 patch 多个键会反复读写的磁盘;改为首次加载后常驻内存,变更后 150ms 合写一次 */
const settingsFile = () => path.join(app.getPath('userData'), 'tongzip-settings.json');
let settingsCache: Settings | null = null;
let settingsWriteTimer: ReturnType<typeof setTimeout> | null = null;

function flushSettings(): void {
  if (settingsWriteTimer) { clearTimeout(settingsWriteTimer); settingsWriteTimer = null; }
  if (!settingsCache) return;
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settingsCache, null, 2), 'utf8');
  } catch { /* 写入失败不阻断运行 */ }
}

const store = {
  get raw(): Settings {
    if (!settingsCache) {
      try {
        settingsCache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) } as Settings;
      } catch {
        settingsCache = { ...DEFAULTS };
      }
    }
    return settingsCache;
  },
  get(key: keyof Settings): Settings[keyof Settings] {
    return store.raw[key];
  },
  set(key: keyof Settings, value: unknown): void {
    settingsCache = { ...store.raw, [key]: value };
    if (!settingsWriteTimer) settingsWriteTimer = setTimeout(flushSettings, 150);
  },
};

/* ------------------------------------------------------------------ */
/* 命令行解析(shell 右键菜单 / 双击关联进入这里)                       */
/* ------------------------------------------------------------------ */

const OWN_SWITCHES = new Set(['--compress-as', '--compress-dialog', '--extract', '--extract-here', '--extract-dialog', '--open']);

function parseArgv(argv: string[]): LaunchPayload | null {
  /* 不能直接 slice:dev 下 second-instance 的 argv 会被 Electron 注入额外开关(--allow-file-access…)
   * 及应用目录参数,统一过滤后只剩自己的开关与文件路径 */
  const appDir = path.resolve(app.getAppPath());
  /* 入口(main.js)必须排除:dev 移交时 Electron 重排 argv,入口可能落在 --open 与其目标之间被当成目标 */
  const entries = new Set([appDir, path.resolve(__dirname, 'main.js')]);
  const args = argv.slice(1).filter((a) => {
    if (OWN_SWITCHES.has(a)) return true;
    if (a.startsWith('-')) return false;
    return !entries.has(path.resolve(a));
  });
  const switchOf = (name: string) => args.findIndex((a) => a === `--${name}`);

  const tryPath = (p: string | undefined): string | null =>
    (p && fs.existsSync(p) ? p : null);

  const compressAsIdx = switchOf('compress-as');
  if (compressAsIdx >= 0) {
    const target = tryPath(args[compressAsIdx + 1]);
    /* ISS-11:token 原样移交渲染层经 shared 协议表解析;不再 default ".7z" 兜底,
       未识别的显式格式请求由渲染层明确报错,禁止静默改格式 */
    const token = args[compressAsIdx + 2];
    if (target) return { kind: 'compress', paths: [target], ...(token ? { token } : {}) };
  }
  const compressDialogIdx = switchOf('compress-dialog');
  if (compressDialogIdx >= 0) {
    const target = tryPath(args[compressDialogIdx + 1]);
    if (target) return { kind: 'compress', paths: [target] };
  }
  const extractIdx = switchOf('extract');
  if (extractIdx >= 0) {
    const target = tryPath(args[extractIdx + 1]);
    if (target) return { kind: 'archive', paths: [target, '--auto-extract'] };
  }
  const extractHereIdx = switchOf('extract-here');
  if (extractHereIdx >= 0) {
    const target = tryPath(args[extractHereIdx + 1]);
    if (target) return { kind: 'archive', paths: [target, '--extract-here'] };
  }
  const extractDialogIdx = switchOf('extract-dialog');
  if (extractDialogIdx >= 0) {
    const target = tryPath(args[extractDialogIdx + 1]);
    if (target) return { kind: 'archive', paths: [target, '--extract-dialog'] };
  }
  const openIdx = switchOf('open');
  if (openIdx >= 0) {
    const target = tryPath(args[openIdx + 1]);
    if (target) return { kind: 'archive', paths: [target] };
  }
  // 直接传入的文件
  const real = args.filter((a) => !a.startsWith('-')).map(tryPath).filter((p): p is string => !!p);
  if (real.length) {
    if (isArchivePath(real[0])) return { kind: 'archive', paths: real };
    return { kind: 'compress', paths: real };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1080,
    height: 700,
    minWidth: 860,
    minHeight: 560,
    show: false,
    frame: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'), // Linux/开发期窗口图标;Windows 任务栏取自 icon.ico
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1b22' : '#ffffff',
    title: 'TongZip',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  w.once('ready-to-show', () => w.show());
  if (DEV_URL) {
    w.loadURL(DEV_URL);
    w.webContents.openDevTools({ mode: 'detach' });
  } else {
    w.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
  return w;
}

/** 独立文件夹浏览窗口(浏览视图右键「在新窗口浏览」手动调用;解压不再自动弹此窗) */
function openBrowseWindow(dir: string): void {
  const q = encodeURIComponent(dir);
  const w = new BrowserWindow({
    width: 1000,
    height: 660,
    minWidth: 800,
    minHeight: 500,
    show: false,
    frame: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1b22' : '#ffffff',
    title: 'TongZip',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  w.once('ready-to-show', () => w.show());
  if (DEV_URL) {
    void w.loadURL(`${DEV_URL}${DEV_URL.includes('?') ? '&' : '?'}window=folder&dir=${q}`);
  } else {
    void w.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query: { window: 'folder', dir: q } });
  }
}

/* 进度事件节流合帧:7za 大 archive 每秒可输出数十行日志,逐行×逐窗广播会打满 IPC;
 * 运行中事件每 100ms 转发一次(同任务仅保留最新帧),终态立即送达;广播剔除 log 字段(渲染层无消费者) */
const feedPending = new Map<string, ProgressEvent>();
let feedTimer: ReturnType<typeof setTimeout> | null = null;

function pushFeed(): void {
  feedTimer = null;
  const events = [...feedPending.values()];
  feedPending.clear();
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    for (const ev of events) w.webContents.send('tz:progress', { ...ev, log: undefined });
  }
}

function send(ev: ProgressEvent): void {
  /* 快照维护:任务窗口打开瞬间靠它回放已在跑的任务;终态 6s 后清理
   * taskFeed/feedPending 一律存剔除 log 的副本:log 是引擎原始输出行,属跨进程边界
   * 不该传递的中间数据(密码不回显是实测事实,不是依赖) */
  const stripped: ProgressEvent = ev.log === undefined ? ev : { ...ev, log: undefined };
  /* 任务历史持久化(3.4):从事件流定格记录——只取 kind/status/percent/code 与路径登记表,
   * message/log 永不入库;路径晚到由 tz:task-path-set 在终态时补最新 */
  observeTaskEvent(stripped, taskPaths.get(ev.taskId));
  taskFeed.set(ev.taskId, stripped);
  if (ev.status !== 'running') setTimeout(() => taskFeed.delete(ev.taskId), 6000);
  feedPending.set(ev.taskId, stripped);
  if (ev.status !== 'running') {
    /* 终态:先清定时器并把合帧中的最新状态一并发出,不等下一拍 */
    if (feedTimer) { clearTimeout(feedTimer); feedTimer = null; }
    pushFeed();
    return;
  }
  if (!feedTimer) feedTimer = setTimeout(pushFeed, 100);
}

/** 打开/唤回独立任务窗口(frameless 小窗,同 bundle 加 ?window=task 分流渲染) */
function openTaskWindow(): void {
  if (taskWin && !taskWin.isDestroyed()) {
    if (taskWin.isMinimized()) taskWin.restore();
    taskWin.show();
    taskWin.focus();
    return;
  }
  taskWin = new BrowserWindow({
    width: 760,
    height: 520,
    minWidth: 640,
    minHeight: 460,
    show: false,
    frame: false,
    title: 'TongZip 任务',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1b22' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  taskWin.once('ready-to-show', () => taskWin?.show());
  taskWin.on('closed', () => { taskWin = null; });
  if (DEV_URL) {
    void taskWin.loadURL(`${DEV_URL}${DEV_URL.includes('?') ? '&' : '?'}window=task`);
  } else {
    void taskWin.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query: { window: 'task' } });
  }
}

function deliverPayload(p: LaunchPayload | null): void {
  if (!p) return;
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    /* 页面还没加载完时 send 会丢事件 — 存入 pending 由渲染层启动后拉取 */
    if (win.webContents.isLoading()) { pendingPayload = p; return; }
    win.webContents.send('tz:launch-event', p);
  } else {
    pendingPayload = p;
  }
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function ok<T>(data: T): IpcResult<T> { return { ok: true, data }; }
function fail(err: unknown): IpcResult<never> {
  if (err instanceof EngineError) return { ok: false, code: err.code, message: err.message };
  const e = err as Error;
  return { ok: false, code: e.name ?? 'ERROR', message: e.message };
}

function wrap<A extends unknown[], T>(fn: (...args: A) => Promise<T> | T) {
  return async (_e: Electron.IpcMainInvokeEvent, ...args: A): Promise<IpcResult<T>> => {
    try { return ok(await fn(...args)); } catch (err) { return fail(err); }
  };
}

/** 扫描常用目录中的压缩包(深度≤2,上限 120,按修改时间倒序) — 「我的压缩包」页数据源。
 *  异步逐目录推进并回调 onProgress:同步一次性扫描无法报进度,且大目录会阻塞主进程事件循环;
 *  每发现一批/切一个顶层目录就 setImmediate 让行,IPC 进度事件才能及时刷到渲染层 */
function fmtMtime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const tick = () => new Promise<void>((r) => setImmediate(r));
async function scanArchives(onProgress?: (p: ScanProgress) => void): Promise<ArchiveFile[]> {
  const rootDefs = [['desktop', '桌面'], ['documents', '文档'], ['downloads', '下载']] as const;
  const roots: { name: string; path: string }[] = [];
  for (const [key, label] of rootDefs) {
    try { const p = app.getPath(key); if (p) roots.push({ name: label, path: p }); } catch { /* 该目录不可用则跳过 */ }
  }
  const total = roots.length;
  const out: ArchiveFile[] = [];
  onProgress?.({ phase: 'start', rootsDone: 0, rootsTotal: total, current: '', found: 0 });
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 2 || out.length >= 120) return;
    let items: fs.Dirent[];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (out.length >= 120) return;
      if (it.name.startsWith('.')) continue;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) { await walk(full, depth + 1); continue; }
      const dot = it.name.lastIndexOf('.');
      if (dot < 0 || !isArchiveExt(it.name.slice(dot + 1))) continue;
      try {
        const st = fs.statSync(full);
        out.push({ path: full, name: it.name, size: st.size, mtime: fmtMtime(st.mtime) });
        if (out.length % 16 === 0) await tick();
      } catch { /* 跳过无法读取的文件 */ }
    }
  };
  for (let r = 0; r < roots.length; r++) {
    onProgress?.({ phase: 'scanning', rootsDone: r, rootsTotal: total, current: roots[r].name, found: out.length });
    await walk(roots[r].path, 0);
    await tick();
  }
  onProgress?.({ phase: 'done', rootsDone: total, rootsTotal: total, current: '', found: out.length });
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

/** 跳到 Windows「设置 ▸ 默认应用」并定位 TongZip 条目;ms-settings 不可用时用 start 兜底 */
async function openDefaultAppsSettings(): Promise<void> {
  const uris = ['ms-settings:defaultapps?registeredAppUser=TongZip', 'ms-settings:defaultapps'];
  for (const uri of uris) {
    try { await shell.openExternal(uri); return; } catch { /* 尝试下一级 */ }
  }
  await new Promise<void>((resolve, reject) => {
    exec(`start "" "${uris[0]}"`, (e) => (e ? reject(e) : resolve()));
  });
}

/** 语义化版本逐段数字比较(1.0.10 > 1.0.9),供检查更新判断新旧 */
function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** GitHub 最新 Release:404(无发布)返回 null;网络/解析失败抛 NETWORK_FAILED。
 * 走主进程 https 而非渲染层 fetch,避开 CORS 与 CSP,也不给渲染层开任意请求能力 */
function ghLatestRelease(): Promise<{ tag: string; url: string } | null> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers: { 'User-Agent': 'TongZip', Accept: 'application/vnd.github+json' }, timeout: 8000 },
      (res) => {
        if (res.statusCode === 404) { res.resume(); resolve(null); return; }
        if (res.statusCode !== 200) { res.resume(); reject(new EngineError(ERR.NETWORK_FAILED, `更新源返回了状态码 ${res.statusCode}。`)); return; }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(body) as { tag_name?: unknown; html_url?: unknown };
            resolve({ tag: String(j.tag_name ?? ''), url: String(j.html_url ?? '') });
          } catch {
            reject(new EngineError(ERR.NETWORK_FAILED, '更新源返回了无法解析的内容。'));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', (e) => reject(new EngineError(ERR.NETWORK_FAILED, `检查更新失败：${e.message}`)));
  });
}

function installIpc(): void {
  ipcMain.handle('tz:engine-detect', wrap(() => detectEngine(store.get('enginePath') as string | null)));
  ipcMain.handle('tz:archive-list', wrap((a: { archive: string; password?: string }) => {
    assertZipPw(a.archive, a.password); // ISS-02:ZIP 非 ASCII 口令提前定性,不透传引擎裸错
    return listArchive(a.archive, a.password);
  }));
  ipcMain.handle('tz:compress', wrap(async (job: CompressJob) => {
    if (!job.output) throw new EngineError(ERR.NO_OUTPUT, '缺少输出路径。');
    preflightCompress(job); // ISS-02:不支持格式/密码字符集在启动引擎前明确拒绝
    const r = runCompress(job, send);
    /* taskId 由引擎内部先生成后同步登记:runCompress 同步阶段即 tasks.set,invoke 返回时已可查 */
    return r;
  }));
  ipcMain.handle('tz:extract', wrap(async (job: ExtractJob): Promise<ExtractStart> => {
    assertZipPw(job.archive, job.password); // ISS-02
    /* 询问模式预检:目标已有同名文件时不启动任务,返回冲突清单由渲染层让用户决策(否则等于静默覆盖) */
    if (job.overwrite === 'ask') {
      const conflicts = await extractConflicts(job);
      if (conflicts.length) return { conflicts };
    }
    /* 解压完成不自动打开任何窗口(用户要求);需要时由任务窗「打开目标文件夹」
       或应用内「在资源管理器中打开」手动走系统资源管理器 */
    openTaskWindow();
    return runExtract(job, send);
  }));
  ipcMain.handle('tz:test', wrap((a: { archive: string; password?: string }) => {
    assertZipPw(a.archive, a.password);
    return runTest(a.archive, a.password, send);
  }));
  ipcMain.handle('tz:delete-entries', wrap((a: { archive: string; entries: string[]; password?: string }) => {
    assertZipPw(a.archive, a.password);
    return runDelete(a.archive, a.entries, send, a.password);
  }));
  /* 重命名磁盘上的压缩包文件:保留原扩展名,校验合法名与目标冲突,成功后返回新路径 */
  ipcMain.handle('tz:archive-rename', wrap(({ archive, newName }: { archive: string; newName: string }) => {
    const name = newName.trim();
    if (!name || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') throw new EngineError(ERR.BAD_NAME, '文件名不能包含 \\ / : * ? " < > |。');
    const dir = path.dirname(archive);
    const ext = path.extname(archive);
    const finalName = ext && name.toLowerCase().endsWith(ext.toLowerCase()) ? name : `${name}${ext}`;
    const newPath = path.join(dir, finalName);
    if (path.basename(newPath).toLowerCase() !== finalName) throw new EngineError(ERR.BAD_NAME, '不允许修改压缩包扩展名。');
    if (path.normalize(archive).toLowerCase() === path.normalize(newPath).toLowerCase()) return { newPath: archive };
    if (fs.existsSync(newPath)) throw new EngineError(ERR.EXISTS, `同名文件已存在:${finalName}`);
    fs.renameSync(archive, newPath);
    return { newPath };
  }));
  ipcMain.handle('tz:task-cancel', wrap((taskId: string) => cancelTask(taskId)));
  ipcMain.handle('tz:task-pause', wrap((taskId: string) => pauseTask(taskId)));
  ipcMain.handle('tz:preview-entry', wrap((a: { archive: string; entry: string; password?: string }) => {
    assertZipPw(a.archive, a.password);
    return previewEntry(a.archive, a.entry, a.password);
  }));
  ipcMain.handle('tz:total-size', wrap((paths: string[]) => totalSize(paths)));
  ipcMain.handle('tz:extract-single', wrap((a: { archive: string; entry: string; password?: string }) => {
    assertZipPw(a.archive, a.password);
    return extractSingleToTemp(a.archive, a.entry, a.password);
  }));

  /* 拖拽压缩包内条目到窗口外:先解到临时目录,再启动系统文件拖拽 */
  ipcMain.handle('tz:drag-entry', wrap(async (a: { archive: string; entry: string; password?: string }) => {
    const local = await extractSingleToTemp(a.archive, a.entry, a.password);
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.startDrag({ file: local, icon: nativeImage.createEmpty() });
      } catch {
        shell.showItemInFolder(local); // 拖拽链不可用时降级为在资源管理器中定位
      }
    }
    return local;
  }));

  ipcMain.handle('tz:pick-files', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'] });
    return ok(r.canceled ? [] : r.filePaths);
  });
  ipcMain.handle('tz:pick-folder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
    return ok(r.canceled ? null : r.filePaths[0]);
  });
  ipcMain.handle('tz:save-as', async (_e, a: { defaultPath: string; filters: Electron.FileFilter[] }) => {
    const r = await dialog.showSaveDialog(win!, { defaultPath: a.defaultPath, filters: a.filters });
    return ok(r.canceled ? null : r.filePath);
  });

  ipcMain.handle('tz:reveal', wrap(async (p: string) => { shell.showItemInFolder(p); }));
  ipcMain.handle('tz:open-external', wrap(async (url: string) => {
    /* 协议白名单:防止经由 file: 等处理器启动本地程序;mailto: 只拉起邮件客户端,不执行本地载荷 */
    let proto = '';
    try { proto = new URL(url).protocol; } catch { throw new EngineError(ERR.BAD_URL, '无效的链接地址。'); }
    if (proto !== 'https:' && proto !== 'http:' && proto !== 'mailto:') throw new EngineError(ERR.BAD_URL, '仅允许打开 http/https/mailto 链接。');
    await shell.openExternal(url);
  }));

  /* —— 关于页:版本信息与检查更新 —— */
  ipcMain.handle('tz:about-info', wrap((): AppAbout => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
  })));
  ipcMain.handle('tz:check-update', wrap(async (): Promise<UpdateCheck> => {
    /* 打包态走 electron-updater（GitHub Releases + latest.yml，支持自动下载/安装）；
       开发态无 app-update.yml，退回原有 API 检查，避免假装自动更新可用 */
    if (app.isPackaged) return checkForUpdate();
    const r = await ghLatestRelease();
    if (!r) return { status: 'notfound' };
    const latest = r.tag.replace(/^v/i, '');
    const cur = app.getVersion();
    if (!latest) return { status: 'latest', url: r.url };
    return cmpSemver(latest, cur) > 0
      ? { status: 'available', latest, url: r.url }
      : { status: 'latest', latest, url: r.url };
  }));
  /* 下载完成后由用户确认重启安装（autoInstallOnAppQuit 亦会在退出时兜底） */
  ipcMain.handle('tz:update-install', wrap(async () => { installUpdate(); }));

  ipcMain.handle('tz:settings-get', () => store.raw);
  ipcMain.handle('tz:settings-set', (_e, patch: Partial<Settings>) => {
    for (const [k, v] of Object.entries(patch)) store.set(k as keyof Settings, v);
    if (patch.theme && patch.theme !== 'auto') nativeTheme.themeSource = patch.theme;
    if (patch.theme === 'auto') nativeTheme.themeSource = 'system';
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('tz:theme-changed', nativeTheme.shouldUseDarkColors);
    }
    if (patch.enginePath) void detectEngine(patch.enginePath).catch(() => undefined);
    /* 防护上限改的是引擎行为,须即时重灌(存储只留差量,回落逻辑在 configureGuard 内) */
    if ('guard' in patch) configureGuard(store.raw.guard);
    return store.raw;
  });

  ipcMain.handle('tz:shell-status', async () => ok({ installed: await shellStatus() }));
  ipcMain.handle('tz:shell-install', wrap(async () => { await installShell(store.raw.contextMenu); store.set('shellIntegration', true); }));
  ipcMain.handle('tz:shell-uninstall', wrap(async () => { await uninstallShell(); store.set('shellIntegration', false); }));
  /* 菜单选项变化/项目路径变更后按当前选项重新注册 */
  ipcMain.handle('tz:shell-refresh', wrap(async () => {
    if (store.raw.shellIntegration) await installShell(store.raw.contextMenu);
  }));

  /* 打开 Windows「设置 ▸ 默认应用」(TongZip 条目优先,失败逐级降级) */
  ipcMain.handle('tz:open-default-apps', wrap(async () => {
    await openDefaultAppsSettings();
  }));

  /* 设为默认:先把 TongZip 登记进可选应用(写 Capabilities + RegisteredApplications),
   * 再跳到系统默认应用页,用户点一下即可把压缩包格式关联过来。
   * Windows 不允许第三方静默改 UserChoice,故只能「登记 + 引导」两步。 */
  ipcMain.handle('tz:shell-set-default', wrap(async () => {
    await registerDefaultAppCapabilities();
    await openDefaultAppsSettings();
  }));

  /* 窗控按 sender 定位各自窗口:主窗/任务窗口互不误伤 */
  ipcMain.handle('tz:win-minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.handle('tz:win-maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
  });
  ipcMain.handle('tz:win-close', (e) => {
    /* 按 sender 关各自窗口:任务窗口的关闭钮不应误关主窗 */
    BrowserWindow.fromWebContents(e.sender)?.close();
  });
  /* 置顶开关:任务窗标题栏图钉钮,切换 alwaysOnTop 并回读窗口真实状态供渲染层高亮 */
  ipcMain.handle('tz:win-pin', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return false;
    w.setAlwaysOnTop(!w.isAlwaysOnTop(), 'floating');
    return w.isAlwaysOnTop();
  });
  /* 任务窗口:打开/唤回 + 进行中任务快照(晚开的窗口回放)+ 路径登记(打开位置) */
  ipcMain.handle('tz:task-window-open', () => { openTaskWindow(); return true; });
  ipcMain.handle('tz:task-snapshot', () => [...taskFeed.values()]);
  ipcMain.handle('tz:task-paths', () => Object.fromEntries(taskPaths));
  ipcMain.handle('tz:task-path-set', (_e, taskId: string, p: TaskPaths) => {
    taskPaths.set(taskId, p);
    /* 快任务终态可能先于登记到达:回填历史记录的 src/out/label */
    backfillTaskPaths(taskId, p);
    return true;
  });

  /* 任务历史(3.4):跨会话查看;清空同步落盘。返回主进程恢复状态机处理后的记录 */
  ipcMain.handle('tz:history-get', () => getTaskHistory());
  ipcMain.handle('tz:history-clear', () => { clearTaskHistory(); return true; });
  ipcMain.handle('tz:history-remove', (_e, taskId: string) => removeTaskHistory(taskId));

  /* 文件夹浏览:目录读取 / 默认程序打开 / 移入回收站 / 新开浏览窗口 */
  ipcMain.handle('tz:dir-list', wrap((dir: string): FolderEntry[] => {
    const fmt = (st: fs.Stats) => {
      const d = st.mtime;
      const p2 = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    };
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e): FolderEntry[] => {
      if (e.name.startsWith('~$')) return []; // Office 临时锁文件不展示
      let st: fs.Stats;
      try { st = fs.statSync(path.join(dir, e.name)); } catch { return []; }
      const isDir = st.isDirectory();
      const ext = path.extname(e.name).slice(1).toLowerCase();
      return [{
        name: e.name,
        path: `${dir.replace(/\\/g, '/')}/${e.name}`,
        isDir, size: isDir ? 0 : st.size, mtime: fmt(st),
        isExe: !isDir && ['exe', 'msi', 'lnk', 'bat', 'cmd'].includes(ext),
        isArchive: !isDir && isArchiveExt(ext),
      }];
    }).sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }) : a.isDir ? -1 : 1));
  }));
  ipcMain.handle('tz:open-path', wrap(async (p: string) => {
    const err = await shell.openPath(p);
    if (err) throw new EngineError(ERR.OPEN_FAILED, err);
  }));
  ipcMain.handle('tz:trash', wrap(async (paths: string[]) => {
    for (const p of paths) await shell.trashItem(p); // 单项失败直接抛→渲染层 toast
  }));
  ipcMain.handle('tz:browse-window-open', (_e, dir: string) => { openBrowseWindow(dir); return true; });
  ipcMain.handle('tz:get-launch-payload', () => {
    const p = pendingPayload;
    pendingPayload = null;
    return p;
  });
  ipcMain.handle('tz:default-output', (_e, sources: string[]) => defaultOutputFor(sources));
  ipcMain.handle('tz:quick-dest', (_e, archive: string) => quickExtractDest(archive));
  ipcMain.handle('tz:infer-format', (_e, output: string) => inferFormat(output));
  ipcMain.handle('tz:exists', (_e, p: string) => fs.existsSync(p));
  ipcMain.handle('tz:scan-archives', async (e): Promise<IpcResult<ArchiveFile[]>> => {
    /* 进度回推到发起本次扫描的窗口(渲染层订阅 tz:scan-progress 显示动画/进度) */
    try {
      const data = await scanArchives((p) => { if (!e.sender.isDestroyed()) e.sender.send('tz:scan-progress', p); });
      return ok(data);
    } catch (err) { return fail(err); }
  });
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

/* 清理陈旧临时提取目录(>24h):双击打开/拖拽导出的副产物此前只增不删,
 * 挂起脚本(也写入同目录)意外残留同样被回收;占用中的条目 rmSync 会失败,跳过即可 */
function gcTempDir(): void {
  const dir = path.join(os.tmpdir(), 'TongZip');
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const n of names) {
    const p = path.join(dir, n);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true, maxRetries: 1 });
    } catch { /* 无权限/正占用:下次启动再试 */ }
  }
}

/* 卸载清理(无头):NSIS 卸载器删文件前调用 `TongZip.exe --uninstall-shell`,仅撤销
 * TongZip 自写的 HKCU 注册项(shell 菜单/ProgID/DefaultIcon/默认应用登记),绝不触碰
 * UserChoice。RC-14 实测:不此举则卸载后残留数十个指向已删 exe 的死链(ISS-03)。
 * 独立实例改用临时 userData,避免与仍在运行的 GUI 抢 Chromium profile 锁。*/
if (isWin && process.argv.includes('--uninstall-shell')) {
  app.setPath('userData', path.join(os.tmpdir(), `tz-shell-cleanup-${process.pid}`));
  void app.whenReady().then(async () => {
    await Promise.race([
      uninstallShell().catch(() => undefined),
      new Promise((r) => setTimeout(r, 30_000)), // 兜底:任何 reg 卡点都不许吊死卸载器
    ]);
    app.exit(0);
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    deliverPayload(parseArgv(argv));
  });

  void app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    /* Windows 任务栏按 AppUserModelID 决定图标/分组:不设则回落 electron.exe 默认标(黑环绿点),
     * 我们的窗口 icon.png 再大也不显示。给一个稳定 ID 后,任务栏按钮才用 TongZip 图标。 */
    if (isWin) app.setAppUserModelId('com.tongzip.app');
    /* 归档修改事务(3.1):journal 落 userData;先还原上次崩溃遗留的半替换,再开窗 */
    configureTxnJournal(path.join(app.getPath('userData'), 'tongzip-txn.json'));
    /* 解压资源防护(3.2):设置中的上限覆盖灌入引擎;缺省回落 DEFAULT_GUARD */
    configureGuard(store.raw.guard);
    const txnRecovery = recoverStaleTransactions();
    /* 任务历史(3.4):必须晚于事务恢复——提交阶段崩溃的任务结果由 journal 判定,
     * 历史侧只把 running 映射为 interrupted 并按 restored 清单标记 txnRolledBack */
    configureTaskHistory(path.join(app.getPath('userData'), 'tongzip-history.json'));
    loadTaskHistory(new Set(txnRecovery.restored));
    const theme = store.get('theme') as Settings['theme'];
    nativeTheme.themeSource = theme === 'auto' ? 'system' : theme;
    installIpc();
    win = createWindow();
    /* 自动更新：事件经 tz:update-event 推给渲染层；打包态启动 15s 后静默检查一次 */
    initUpdater(() => win);
    scheduleStartupCheck();
    if (txnRecovery.restored.length || txnRecovery.cleaned.length) {
      /* 页面加载完成前 send 会丢(同启动载荷教训),挂 did-finish-load 一次性广播 */
      win.webContents.once('did-finish-load', () => {
        if (win && !win.isDestroyed()) win.webContents.send('tz:txn-recovered', txnRecovery);
      });
    }
    // 主窗关闭即退出(否则任务窗口残留会让 app 不退)
    win.on('closed', () => { win = null; app.quit(); });
    deliverPayload(parseArgv(process.argv));
    // 引擎预热(失败不阻塞 UI,渲染层会引导用户处理)
    void detectEngine(store.get('enginePath') as string | null).catch(() => undefined);
    // 临时目录回收放在首帧之后,不拖慢启动
    setTimeout(gcTempDir, 3000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) win = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (!isWin || process.platform !== 'darwin') app.quit();
  });

  /* 退出去掉去抖窗口期,确保最后一笔设置与任务历史落盘 */
  app.on('will-quit', () => { flushSettings(); flushTaskHistory(); });
}
