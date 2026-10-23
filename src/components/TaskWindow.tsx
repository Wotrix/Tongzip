/**
 * 独立任务窗口 — 现代极简进度窗
 * 只保留一条通长进度条 + 当前文件/状态；压缩/解压共用。
 * 全部成功后短暂停留自动关窗；失败/取消保留供查看，可手动关闭。
 */
import { useEffect, useState } from 'react';
import type { JobKind, ProgressEvent } from '@shared/types';
import AppLogo from './AppLogo';
import { IconClose, IconFolderOpen, IconMin } from './icons';
import { cn } from '@/lib/utils';

const AUTO_CLOSE_MS = 1200;
const LABEL: Record<JobKind, { run: string; done: string }> = {
  compress: { run: '正在压缩', done: '压缩完成' },
  extract: { run: '正在解压', done: '解压完成' },
  test: { run: '正在测试', done: '测试完成' },
  delete: { run: '正在删除', done: '删除完成' },
};

export default function TaskWindow() {
  const [jobs, setJobs] = useState<ProgressEvent[]>([]);
  const [paths, setPaths] = useState<Record<string, { archive?: string; output?: string; dest?: string }>>({});

  /* 快照回放 + 订阅实时进度流(主进程广播到所有窗口) */
  useEffect(() => {
    const upsert = (ev: ProgressEvent) => setJobs((prev) => {
      /* 新一批任务:上一批已全部终态时从这条 running 重新开始,旧失败/取消不阻止本批自动关窗 */
      if (ev.status === 'running' && prev.length > 0 && prev.every((j) => j.status !== 'running')) return [ev];
      const i = prev.findIndex((j) => j.taskId === ev.taskId);
      if (i < 0) return [...prev, ev];
      const next = [...prev];
      next[i] = ev;
      return next;
    });
    void window.tz.taskSnapshot().then((snap) => {
      /* 只回放进行中任务;没有进行中时只取最新一条终态,避免旧失败记录阻止本批自动关窗 */
      const live = snap.filter((ev) => ev.status === 'running');
      (live.length ? live : snap.slice(-1)).forEach(upsert);
    });
    void window.tz.taskPaths().then(setPaths);
    return window.tz.onProgress(upsert);
  }, []);

  const running = jobs.filter((j) => j.status === 'running');
  const allSettled = jobs.length > 0 && running.length === 0;
  const allDone = allSettled && jobs.every((j) => j.status === 'done');
  const failed = allSettled && jobs.some((j) => j.status === 'error' || j.status === 'cancelled');

  /* 全部任务成功 → 短暂停留后自动关窗 */
  useEffect(() => {
    if (!allDone) return;
    const t = window.setTimeout(() => { void window.tz.winClose(); }, AUTO_CLOSE_MS);
    return () => window.clearTimeout(t);
  }, [allDone]);

  const focus = running[0] ?? jobs[jobs.length - 1];
  const kind = focus?.kind ?? 'compress';
  const target = focus ? paths[focus.taskId] ?? {} : {};
  const destPath = target.dest || (target.output ? target.output.replace(/\/[^/]+$/, '') : undefined);
  useEffect(() => { if (jobs.length) void window.tz.taskPaths().then(setPaths); }, [jobs.length, allDone]);
  const pct = jobs.length === 0 ? 0
    : allDone ? 100
      : Math.floor(jobs.reduce((s, j) => s + Math.max(0, j.percent), 0) / jobs.length);
  const indet = !allDone && !failed && jobs.some((j) => j.status === 'running' && j.percent < 0);
  const status = allDone
    ? (jobs.length > 1 ? '全部任务已完成' : LABEL[kind].done)
    : failed ? '任务失败'
      : focus ? LABEL[kind].run : '等待任务…';
  const detail = allDone
    ? '窗口即将自动关闭…'
    : failed ? (focus?.message ?? '任务未完成')
      : (focus?.file || '准备中…');

  return (
    <div className="flex h-screen select-none flex-col overflow-hidden bg-background text-foreground">
      {/* 迷你标题栏:拖拽区 + 状态 + 最小化/关闭 */}
      <header className="app-drag flex h-[42px] shrink-0 items-center gap-2 bg-secondary pl-3 text-[12.5px] font-semibold">
        <AppLogo className="size-[18px] shrink-0" />
        <span className="min-w-0 truncate">TongZip</span>
        {jobs.length > 1 && (
          <span className="shrink-0 rounded-full bg-primary/10 px-2 py-px text-[10.5px] font-medium tabular-nums text-primary">
            {jobs.filter((j) => j.status === 'done').length}/{jobs.length}
          </span>
        )}
        <div className="app-nodrag ml-auto flex items-center">
          {destPath && (
            <button className="inline-flex h-[42px] w-[40px] items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-[var(--bg-active)]"
              title="打开目标文件夹" onClick={() => void window.tz.openPath(destPath)}><IconFolderOpen className="size-[15px]" /></button>
          )}
          <button className="inline-flex h-[42px] w-[40px] items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-[var(--bg-active)]"
            title="最小化" onClick={() => window.tz.winMinimize()}><IconMin className="size-3" /></button>
          <button className="inline-flex h-[42px] w-[44px] items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
            title="关闭" onClick={() => window.tz.winClose()}><IconClose className="size-3" /></button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col justify-center gap-3 px-6 py-5">
        <div className="flex items-baseline justify-between gap-3">
          <span className={cn('truncate text-[13px] font-semibold', failed && 'text-destructive')}>{status}</span>
          <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{pct}%</span>
        </div>

        {/* 唯一进度条:运行中流光扫过,完成绿色,失败红色 */}
        <div className="relative h-2.5 overflow-hidden rounded-full bg-secondary">
          <i
            className={cn(
              'block h-full rounded-full transition-[width] duration-300 ease-out',
              allDone ? 'bg-emerald-500' : failed ? 'bg-destructive' : 'bg-[linear-gradient(90deg,var(--accent-hover),var(--accent))]',
              indet && 'w-[34%] animate-[tw-indet_1.2s_ease-in-out_infinite]',
            )}
            style={indet ? undefined : { width: `${pct}%` }}
          >
            {!allDone && !failed && <i className="tw-shimmer absolute inset-0" />}
          </i>
        </div>

        <div className="flex min-w-0 items-center gap-2 text-[11.5px] text-muted-foreground">
          <span className={cn('min-w-0 flex-1 truncate', failed && 'text-destructive')}>{detail}</span>
          {!allDone && !failed && <span className="shrink-0">请稍候</span>}
        </div>
      </div>
    </div>
  );
}
