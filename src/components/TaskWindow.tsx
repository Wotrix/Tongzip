/**
 * 独立任务窗口 — 压缩启动时由主进程弹出的 frameless 小窗(?window=task 分流)。
 * 数据源:挂载时 taskSnapshot 回放已在跑的任务,再订阅 tz:progress 广播流;
 * 全部任务进入终态后停留 4s 自动关闭(期间来新任务则取消关闭)。
 * 卡片与主窗任务中心同一视觉语言,但更聚焦:标题/当前文件/进度/取消。
 */
import { useEffect, useRef, useState } from 'react';
import type { JobKind, ProgressEvent } from '@shared/types';
import {
  IconClose, IconCompress, IconExtract, IconTest, IconDelete,
  IconCheckCircle, IconWarn, IconMin, Logo,
} from './icons';
import { cn } from '@/lib/utils';

const KIND: Record<JobKind, { run: string; icon: typeof IconCompress }> = {
  compress: { run: '正在压缩', icon: IconCompress },
  extract: { run: '正在解压', icon: IconExtract },
  test: { run: '正在测试', icon: IconTest },
  delete: { run: '正在删除', icon: IconDelete },
};

export default function TaskWindow() {
  const [jobs, setJobs] = useState<ProgressEvent[]>([]);
  const closeTimer = useRef<number | null>(null);

  /* 快照回放 + 订阅实时进度流(主进程广播到所有窗口) */
  useEffect(() => {
    const upsert = (ev: ProgressEvent) => setJobs((prev) => {
      const i = prev.findIndex((j) => j.taskId === ev.taskId);
      if (i < 0) return [...prev, ev];
      const next = [...prev];
      next[i] = ev;
      return next;
    });
    void window.tz.taskSnapshot().then((snap) => snap.forEach(upsert));
    return window.tz.onProgress(upsert);
  }, []);

  /* 全部终态 → 4s 后自动关窗;来新任务则撤销关闭 */
  const allSettled = jobs.length > 0 && jobs.every((j) => j.status !== 'running');
  useEffect(() => {
    if (allSettled && closeTimer.current == null) {
      closeTimer.current = window.setTimeout(() => window.tz.winClose(), 4000);
    } else if (!allSettled && closeTimer.current != null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    return () => { if (!allSettled && closeTimer.current != null) { clearTimeout(closeTimer.current); closeTimer.current = null; } };
  }, [allSettled]);

  return (
    <div className="flex h-screen select-none flex-col overflow-hidden bg-background text-foreground">
      {/* 迷你标题栏:拖拽区 + 最小化/关闭(无最大化和任务铃铛) */}
      <header className="app-drag flex h-[38px] shrink-0 items-center gap-2 bg-secondary pl-3 text-[12.5px] font-semibold">
        <span className="flex size-[18px] items-center justify-center rounded-[5px] bg-primary text-primary-foreground">
          <Logo className="size-[11px]" />
        </span>
        任务
        <span className="ml-1 text-[11.5px] font-normal text-muted-foreground">
          {jobs.filter((j) => j.status === 'running').length || ''}
        </span>
        <div className="app-nodrag ml-auto flex items-center">
          <button className="inline-flex h-[38px] w-[40px] items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="最小化" onClick={() => window.tz.winMinimize()}><IconMin className="size-3" /></button>
          <button className="inline-flex h-[38px] w-[44px] items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
            title="关闭" onClick={() => window.tz.winClose()}><IconClose className="size-3" /></button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto p-3">
        {jobs.length === 0 && (
          <div className="grid flex-1 place-items-center text-[12.5px] text-muted-foreground">等待任务…</div>
        )}
        {jobs.map((j) => <TaskCard key={j.taskId} ev={j} />)}
        {allSettled && (
          <div className="pb-1 text-center text-[11.5px] text-muted-foreground">全部任务已结束,窗口即将自动关闭</div>
        )}
      </div>
    </div>
  );
}

/** 单任务卡:状态图标 + 标题 + 当前文件 + 进度条 + 百分比/取消 */
function TaskCard({ ev }: { ev: ProgressEvent }) {
  const meta = KIND[ev.kind];
  const running = ev.status === 'running';
  const done = ev.status === 'done';
  const failed = !running && !done;
  const Icon = done ? IconCheckCircle : failed ? IconWarn : meta.icon;
  const indet = running && ev.percent < 0;
  const title = done ? `${meta.run.replace('正在', '')}完成`
    : ev.status === 'cancelled' ? '任务已取消'
      : ev.status === 'error' ? '任务失败' : meta.run;
  return (
    <div className="rounded-[10px] border border-border bg-card px-3.5 pb-3 pt-2.5">
      <div className={cn('flex items-center gap-2 text-[13px] font-semibold [&_svg]:size-[15px] [&_svg]:shrink-0')}>
        <Icon className={cn(done && 'text-primary', ev.status === 'error' && 'text-destructive', !done && ev.status === 'cancelled' && 'text-destructive', running && 'text-muted-foreground')} />
        <span>{title}</span>
        {running && (
          <button
            className="ml-auto grid size-[26px] place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="取消任务" onClick={() => void window.tz.cancelTask(ev.taskId)}>
            <IconClose className="size-3" />
          </button>
        )}
      </div>
      {ev.file && running && (
        <div className="mt-[3px] truncate text-[11.5px] text-muted-foreground" title={ev.file}>{ev.file}</div>
      )}
      {ev.message && failed && (
        <div className="mt-[3px] truncate text-[11.5px] text-destructive" title={ev.message}>{ev.message}</div>
      )}
      <div className="relative mt-2 h-1 overflow-hidden rounded-[2px] bg-border">
        <i className={cn(
          'block h-full rounded-[2px] bg-primary transition-[width] duration-[250ms] ease-out',
          indet && 'w-[34%] animate-[indet_1.2s_ease-in-out_infinite]',
          failed && 'bg-destructive',
        )} style={{ width: ev.percent >= 0 ? `${ev.percent}%` : undefined }} />
      </div>
      <div className="mt-[5px] text-[11.5px] tabular-nums text-muted-foreground">
        {ev.percent >= 0 ? `${ev.percent}%` : running ? '进行中' : ''}
      </div>
    </div>
  );
}
