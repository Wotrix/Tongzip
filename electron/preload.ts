/**
 * TongZip 预加载脚本 — 以安全的方式把主进程能力暴露给渲染层
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  ArchiveFile, ArchiveInfo, CompressJob, EngineInfo, EntryPreview, ExtractJob, FolderEntry,
  IpcResult, LaunchPayload, ProgressEvent, Settings, ShellState,
} from '../shared/types';

type Unsub = () => void;

const api = {
  /* 引擎 */
  detectEngine: (): Promise<IpcResult<EngineInfo>> => ipcRenderer.invoke('tz:engine-detect'),

  /* 压缩包 */
  listArchive: (archive: string, password?: string): Promise<IpcResult<ArchiveInfo>> =>
    ipcRenderer.invoke('tz:archive-list', { archive, password }),
  scanArchives: (): Promise<IpcResult<ArchiveFile[]>> => ipcRenderer.invoke('tz:scan-archives'),
  compress: (job: CompressJob): Promise<IpcResult<{ taskId: string }>> =>
    ipcRenderer.invoke('tz:compress', job),
  extract: (job: ExtractJob): Promise<IpcResult<{ taskId: string }>> =>
    ipcRenderer.invoke('tz:extract', job),
  test: (archive: string, password?: string): Promise<IpcResult<{ taskId: string }>> =>
    ipcRenderer.invoke('tz:test', { archive, password }),
  deleteEntries: (archive: string, entries: string[]): Promise<IpcResult<{ taskId: string }>> =>
    ipcRenderer.invoke('tz:delete-entries', { archive, entries }),
  renameArchive: (archive: string, newName: string): Promise<IpcResult<{ newPath: string }>> =>
    ipcRenderer.invoke('tz:archive-rename', { archive, newName }),
  cancelTask: (taskId: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('tz:task-cancel', taskId),
  taskPause: (taskId: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('tz:task-pause', taskId),
  previewEntry: (archive: string, entry: string, password?: string): Promise<IpcResult<EntryPreview>> =>
    ipcRenderer.invoke('tz:preview-entry', { archive, entry, password }),
  totalSize: (paths: string[]): Promise<IpcResult<number>> =>
    ipcRenderer.invoke('tz:total-size', paths),
  extractSingleToTemp: (archive: string, entry: string, password?: string): Promise<IpcResult<string>> =>
    ipcRenderer.invoke('tz:extract-single', { archive, entry, password }),
  dragEntry: (archive: string, entry: string, password?: string): Promise<IpcResult<string>> =>
    ipcRenderer.invoke('tz:drag-entry', { archive, entry, password }),

  /* 系统对话 */
  pickFiles: (): Promise<IpcResult<string[]>> => ipcRenderer.invoke('tz:pick-files'),
  pickFolder: (): Promise<IpcResult<string | null>> => ipcRenderer.invoke('tz:pick-folder'),
  saveAs: (defaultPath: string, filters: { name: string; extensions: string[] }[]): Promise<IpcResult<string | null>> =>
    ipcRenderer.invoke('tz:save-as', { defaultPath, filters }),

  /* 外壳 */
  revealInExplorer: (p: string): Promise<IpcResult<void>> => ipcRenderer.invoke('tz:reveal', p),
  openExternal: (url: string): Promise<IpcResult<void>> => ipcRenderer.invoke('tz:open-external', url),

  /* 设置与集成 */
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('tz:settings-get'),
  setSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('tz:settings-set', patch),
  shellStatus: (): Promise<ShellState> => ipcRenderer.invoke('tz:shell-status'),
  shellInstall: (): Promise<IpcResult<void>> => ipcRenderer.invoke('tz:shell-install'),
  shellUninstall: (): Promise<IpcResult<void>> => ipcRenderer.invoke('tz:shell-uninstall'),
  shellRefresh: (): Promise<IpcResult<void>> => ipcRenderer.invoke('tz:shell-refresh'),
  openDefaultApps: (): Promise<IpcResult<void>> => ipcRenderer.invoke('tz:open-default-apps'),

  /* 窗口 */
  winMinimize: () => ipcRenderer.invoke('tz:win-minimize'),
  winMaximize: () => ipcRenderer.invoke('tz:win-maximize'),
  winClose: () => ipcRenderer.invoke('tz:win-close'),

  /* 任务窗口:压缩启动时打开/唤回;晚开窗口用快照回放进行中任务 */
  taskWindowOpen: (): Promise<boolean> => ipcRenderer.invoke('tz:task-window-open'),
  taskSnapshot: (): Promise<ProgressEvent[]> => ipcRenderer.invoke('tz:task-snapshot'),
  /** 任务路径登记表快照:taskId → {archive输出/解压目标}(任务窗「打开位置」数据源) */
  taskPaths: (): Promise<Record<string, { archive?: string; output?: string; dest?: string }>> =>
    ipcRenderer.invoke('tz:task-paths'),
  /** 渲染层启动任务后登记路径(invoke 返回时才知道 taskId) */
  taskPathSet: (taskId: string, p: { archive?: string; output?: string; dest?: string }): Promise<boolean> =>
    ipcRenderer.invoke('tz:task-path-set', taskId, p),

  /* 文件夹浏览 */
  listDir: (dir: string): Promise<IpcResult<FolderEntry[]>> => ipcRenderer.invoke('tz:dir-list', dir),
  /** 用系统默认程序打开文件/文件夹(区别于 openExternal 只处理 URL) */
  openPath: (p: string): Promise<IpcResult<void>> => ipcRenderer.invoke('tz:open-path', p),
  /** 移入回收站(非永久删除) */
  trash: (paths: string[]): Promise<IpcResult<void>> => ipcRenderer.invoke('tz:trash', paths),
  /** 新开独立文件夹浏览窗口 */
  browseWindowOpen: (dir: string): Promise<boolean> => ipcRenderer.invoke('tz:browse-window-open', dir),

  /* 启动事件(shell/双击传入的目标) */
  getLaunchPayload: (): Promise<LaunchPayload | null> => ipcRenderer.invoke('tz:get-launch-payload'),
  onLaunch: (fn: (p: LaunchPayload) => void): Unsub => {
    const h = (_e: unknown, p: LaunchPayload) => fn(p);
    ipcRenderer.on('tz:launch-event', h);
    return () => ipcRenderer.off('tz:launch-event', h);
  },

  /* 进度流 */
  onProgress: (fn: (ev: ProgressEvent) => void): Unsub => {
    const h = (_e: unknown, ev: ProgressEvent) => fn(ev);
    ipcRenderer.on('tz:progress', h);
    return () => ipcRenderer.off('tz:progress', h);
  },

  /* 拖拽文件 → 绝对路径 */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  /* 辅助桥接 */
  defaultOutput: (sources: string[]): Promise<string> => ipcRenderer.invoke('tz:default-output', sources),
  quickDest: (archive: string): Promise<string> => ipcRenderer.invoke('tz:quick-dest', archive),
  inferFormat: (output: string): Promise<string> => ipcRenderer.invoke('tz:infer-format', output),
  exists: (p: string): Promise<boolean> => ipcRenderer.invoke('tz:exists', p),
  onThemeChanged: (fn: (dark: boolean) => void): Unsub => {
    const h = (_e: unknown, dark: boolean) => fn(dark);
    ipcRenderer.on('tz:theme-changed', h);
    return () => ipcRenderer.off('tz:theme-changed', h);
  },
};

contextBridge.exposeInMainWorld('tz', api);

export type TongZipApi = typeof api;
