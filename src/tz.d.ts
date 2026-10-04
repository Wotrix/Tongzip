/// <reference types="vite/client" />

import type {
  ArchiveFile, ArchiveInfo, CompressJob, EngineInfo, EntryPreview, ExtractJob, IpcResult,
  LaunchPayload, ProgressEvent, Settings, ShellState,
} from '@shared/types';

declare global {
  interface Window {
    tz: {
      detectEngine(): Promise<IpcResult<EngineInfo>>;
      listArchive(archive: string, password?: string): Promise<IpcResult<ArchiveInfo>>;
      scanArchives(): Promise<IpcResult<ArchiveFile[]>>;
      compress(job: CompressJob): Promise<IpcResult<{ taskId: string }>>;
      extract(job: ExtractJob): Promise<IpcResult<{ taskId: string }>>;
      test(archive: string, password?: string): Promise<IpcResult<{ taskId: string }>>;
      deleteEntries(archive: string, entries: string[]): Promise<IpcResult<{ taskId: string }>>;
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
      winMinimize(): void;
      winMaximize(): void;
      winClose(): void;
      taskWindowOpen(): Promise<boolean>;
      taskSnapshot(): Promise<ProgressEvent[]>;
      getLaunchPayload(): Promise<LaunchPayload | null>;
      onLaunch(fn: (p: LaunchPayload) => void): () => void;
      onProgress(fn: (ev: ProgressEvent) => void): () => void;
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
