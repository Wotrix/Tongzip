/// <reference types="vite/client" />

import type {
  AppAbout, ArchiveFile, ArchiveInfo, CompressJob, EngineInfo, EntryPreview, ExtractJob, ExtractStart, FolderEntry,
  IpcResult, LaunchPayload, PersistedTask, ProgressEvent, ScanProgress, Settings, ShellState, TxnRecoveryInfo, UpdateCheck,
} from '@shared/types';

declare global {
  interface Window {
    tz: {
      detectEngine(): Promise<IpcResult<EngineInfo>>;
      listArchive(archive: string, password?: string): Promise<IpcResult<ArchiveInfo>>;
      scanArchives(): Promise<IpcResult<ArchiveFile[]>>;
      compress(job: CompressJob): Promise<IpcResult<{ taskId: string }>>;
      extract(job: ExtractJob): Promise<IpcResult<ExtractStart>>;
      test(archive: string, password?: string): Promise<IpcResult<{ taskId: string }>>;
      deleteEntries(archive: string, entries: string[], password?: string): Promise<IpcResult<{ taskId: string }>>;
      renameArchive(archive: string, newName: string): Promise<IpcResult<{ newPath: string }>>;
      cancelTask(taskId: string): Promise<IpcResult<boolean>>;
      taskPause(taskId: string): Promise<IpcResult<boolean>>;
      previewEntry(archive: string, entry: string, password?: string): Promise<IpcResult<EntryPreview>>;
      totalSize(paths: string[]): Promise<IpcResult<number>>;
      extractSingleToTemp(archive: string, entry: string, password?: string): Promise<IpcResult<string>>;
      dragEntry(archive: string, entry: string, password?: string): Promise<IpcResult<string>>;
      pickFiles(): Promise<IpcResult<string[]>>;
      pickFolder(): Promise<IpcResult<string | null>>;
      saveAs(defaultPath: string, filters: { name: string; extensions: string[] }[]): Promise<IpcResult<string | null>>;
      revealInExplorer(p: string): Promise<IpcResult<void>>;
      openExternal(url: string): Promise<IpcResult<void>>;
      getSettings(): Promise<Settings>;
      setSettings(patch: Partial<Settings>): Promise<Settings>;
      shellStatus(): Promise<ShellState>;
      shellInstall(): Promise<IpcResult<void>>;
      shellUninstall(): Promise<IpcResult<void>>;
      shellRefresh(): Promise<IpcResult<void>>;
      openDefaultApps(): Promise<IpcResult<void>>;
      setDefaultApp(): Promise<IpcResult<void>>;
      aboutInfo(): Promise<IpcResult<AppAbout>>;
      checkUpdate(): Promise<IpcResult<UpdateCheck>>;
      installUpdate(): Promise<IpcResult<void>>;
      /** 自动更新事件：checking/available/downloading/downloaded/error */
      onUpdateEvent(fn: (ev: UpdateCheck) => void): () => void;
      winMinimize(): void;
      winMaximize(): void;
      winClose(): void;
      /** 切换本窗口置顶,回传切换后的状态 */
      winPin(): Promise<boolean>;
      taskWindowOpen(): Promise<boolean>;
      taskSnapshot(): Promise<ProgressEvent[]>;
      taskPaths(): Promise<Record<string, { archive?: string; output?: string; dest?: string }>>;
      taskPathSet(taskId: string, p: { archive?: string; output?: string; dest?: string }): Promise<boolean>;
      /** 持久化任务历史(已过启动恢复状态机);清空同步落盘 */
      historyGet(): Promise<PersistedTask[]>;
      historyClear(): Promise<boolean>;
      historyRemove(taskId: string): Promise<boolean>;
      listDir(dir: string): Promise<IpcResult<FolderEntry[]>>;
      openPath(p: string): Promise<IpcResult<void>>;
      trash(paths: string[]): Promise<IpcResult<void>>;
      browseWindowOpen(dir: string): Promise<boolean>;
      getLaunchPayload(): Promise<LaunchPayload | null>;
      onLaunch(fn: (p: LaunchPayload) => void): () => void;
      onProgress(fn: (ev: ProgressEvent) => void): () => void;
      onScanProgress(fn: (p: ScanProgress) => void): () => void;
      /** 归档修改事务启动恢复通知(崩溃遗留的还原/清理结果) */
      onTxnRecovery(fn: (info: TxnRecoveryInfo) => void): () => void;
      pathForFile(file: File): string;
      defaultOutput(sources: string[]): Promise<string>;
      quickDest(archive: string): Promise<string>;
      inferFormat(output: string): Promise<string>;
      exists(p: string): Promise<boolean>;
      onThemeChanged(fn: (dark: boolean) => void): () => void;
    };
  }
}

export {};
