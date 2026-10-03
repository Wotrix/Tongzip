/**
 * TongZip 主进程 — 窗口、生命周期、IPC 装配、命令行任务调度
 *
 * 窗口走 frameless + 自绘标题栏;主题色由渲染层通知,同步到原生背景。
 */
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, nativeImage, shell, Menu } from 'electron';
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ArchiveFile, CompressJob, ExtractJob, IpcResult, LaunchPayload, ProgressEvent, Settings,
} from '../shared/types';
import { isArchiveExt } from '../shared/types';
import {
  EngineError, cancelTask, defaultOutputFor, detectEngine, extractSingleToTemp, inferFormat,
  isArchivePath, listArchive, pauseTask, previewEntry, quickExtractDest, runCompress, runDelete,
  runExtract, runTest, totalSize,
} from './engine';
import { installShell, shellStatus, uninstallShell } from './shell';

/* ------------------------------------------------------------------ */
/* 常量与状态                                                          */
/* ------------------------------------------------------------------ */

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const isWin = process.platform === 'win32';

let win: BrowserWindow | null = null;
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
  accent: 'blue',
  defaultFormat: '7z',
  defaultLevel: 5,
  showRecentOpen: true,
  showRecentTasks: true,
  sidebarWidth: 176,
  listColumnWidths: { type: 110, size: 110, time: 160 },
};
const settingsFile = () => path.join(app.getPath('userData'), 'tongzip-settings.json');
const store = {
  get raw(): Settings {
    try {
      return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) } as Settings;
    } catch {
      return { ...DEFAULTS };
    }
  },
  get(key: keyof Settings): Settings[keyof Settings] {
    return store.raw[key];
  },
  set(key: keyof Settings, value: unknown): void {
    const next = { ...store.raw, [key]: value };
    try {
      fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
      fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf8');
    } catch { /* 写入失败不阻断运行 */ }
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
    const ext = args[compressAsIdx + 2] ?? '.7z';
    if (target) return { kind: 'compress', paths: [target, ext] };
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
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#17191c' : '#ffffff',
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

function send(ev: ProgressEvent): void {
  win?.webContents.send('tz:progress', ev);
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

/** 扫描常用目录中的压缩包(深度≤2,上限 120,按修改时间倒序) — 「我的压缩包」页数据源 */
function fmtMtime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function scanArchives(): Promise<ArchiveFile[]> {
  const roots = ['desktop', 'documents', 'downloads']
    .map((n) => { try { return app.getPath(n as 'desktop'); } catch { return null; } })
    .filter((p): p is string => !!p);
  const out: ArchiveFile[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 2 || out.length >= 120) return;
    let items: fs.Dirent[];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (out.length >= 120) return;
      if (it.name.startsWith('.')) continue;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) { walk(full, depth + 1); continue; }
      const dot = it.name.lastIndexOf('.');
      if (dot < 0 || !isArchiveExt(it.name.slice(dot + 1))) continue;
      try {
        const st = fs.statSync(full);
        out.push({ path: full, name: it.name, size: st.size, mtime: fmtMtime(st.mtime) });
      } catch { /* 跳过无法读取的文件 */ }
    }
  };
  for (const r of roots) walk(r, 0);
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

function installIpc(): void {
  ipcMain.handle('tz:engine-detect', wrap(() => detectEngine(store.get('enginePath') as string | null)));
  ipcMain.handle('tz:archive-list', wrap((a: { archive: string; password?: string }) => listArchive(a.archive, a.password)));
  ipcMain.handle('tz:compress', wrap(async (job: CompressJob) => {
    if (!job.output) throw new EngineError('NO_OUTPUT', '缺少输出路径。');
    return runCompress(job, send);
  }));
  ipcMain.handle('tz:extract', wrap(async (job: ExtractJob) => runExtract(job, send)));
  ipcMain.handle('tz:test', wrap((a: { archive: string; password?: string }) => runTest(a.archive, a.password, send)));
  ipcMain.handle('tz:delete-entries', wrap((a: { archive: string; entries: string[] }) => runDelete(a.archive, a.entries, send)));
  /* 重命名磁盘上的压缩包文件:保留原扩展名,校验合法名与目标冲突,成功后返回新路径 */
  ipcMain.handle('tz:archive-rename', wrap(({ archive, newName }: { archive: string; newName: string }) => {
    const name = newName.trim();
    if (!name || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') throw new EngineError('BAD_NAME', '文件名不能包含 \\ / : * ? " < > |。');
    const dir = path.dirname(archive);
    const ext = path.extname(archive);
    const finalName = ext && name.toLowerCase().endsWith(ext.toLowerCase()) ? name : `${name}${ext}`;
    const newPath = path.join(dir, finalName);
    if (path.basename(newPath).toLowerCase() !== finalName) throw new EngineError('BAD_NAME', '不允许修改压缩包扩展名。');
    if (path.normalize(archive).toLowerCase() === path.normalize(newPath).toLowerCase()) return { newPath: archive };
    if (fs.existsSync(newPath)) throw new EngineError('EXISTS', `同名文件已存在:${finalName}`);
    fs.renameSync(archive, newPath);
    return { newPath };
  }));
  ipcMain.handle('tz:task-cancel', wrap((taskId: string) => cancelTask(taskId)));
  ipcMain.handle('tz:task-pause', wrap((taskId: string) => pauseTask(taskId)));
  ipcMain.handle('tz:preview-entry', wrap((a: { archive: string; entry: string; password?: string }) =>
    previewEntry(a.archive, a.entry, a.password)));
  ipcMain.handle('tz:total-size', wrap((paths: string[]) => totalSize(paths)));
  ipcMain.handle('tz:extract-single', wrap((a: { archive: string; entry: string; password?: string }) =>
    extractSingleToTemp(a.archive, a.entry, a.password)));

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
  ipcMain.handle('tz:open-external', wrap(async (url: string) => { await shell.openExternal(url); }));

  ipcMain.handle('tz:settings-get', () => store.raw);
  ipcMain.handle('tz:settings-set', (_e, patch: Partial<Settings>) => {
    for (const [k, v] of Object.entries(patch)) store.set(k as keyof Settings, v);
    if (patch.theme && patch.theme !== 'auto') nativeTheme.themeSource = patch.theme;
    if (patch.theme === 'auto') nativeTheme.themeSource = 'system';
    win?.webContents.send('tz:theme-changed', nativeTheme.shouldUseDarkColors);
    if (patch.enginePath) void detectEngine(patch.enginePath).catch(() => undefined);
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
    const uris = ['ms-settings:defaultapps?registeredAppUser=TongZip', 'ms-settings:defaultapps'];
    for (const uri of uris) {
      try { await shell.openExternal(uri); return; } catch { /* 尝试下一级 */ }
    }
    // 极少数环境 ms-settings 不可用:用 start 兜底再试一次
    await new Promise<void>((resolve, reject) => {
      exec(`start "" "${uris[0]}"`, (e) => (e ? reject(e) : resolve()));
    });
  }));

  ipcMain.handle('tz:win-minimize', () => win?.minimize());
  ipcMain.handle('tz:win-maximize', () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
  });
  ipcMain.handle('tz:win-close', () => win?.close());
  ipcMain.handle('tz:get-launch-payload', () => {
    const p = pendingPayload;
    pendingPayload = null;
    return p;
  });
  ipcMain.handle('tz:default-output', (_e, sources: string[]) => defaultOutputFor(sources));
  ipcMain.handle('tz:quick-dest', (_e, archive: string) => quickExtractDest(archive));
  ipcMain.handle('tz:infer-format', (_e, output: string) => inferFormat(output));
  ipcMain.handle('tz:exists', (_e, p: string) => fs.existsSync(p));
  ipcMain.handle('tz:scan-archives', wrap(() => scanArchives()));
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    deliverPayload(parseArgv(argv));
  });

  void app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    const theme = store.get('theme') as Settings['theme'];
    nativeTheme.themeSource = theme === 'auto' ? 'system' : theme;
    installIpc();
    win = createWindow();
    win.on('closed', () => { win = null; });
    deliverPayload(parseArgv(process.argv));
    // 引擎预热(失败不阻塞 UI,渲染层会引导用户处理)
    void detectEngine(store.get('enginePath') as string | null).catch(() => undefined);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) win = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (!isWin || process.platform !== 'darwin') app.quit();
  });
}
