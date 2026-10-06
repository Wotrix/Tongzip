/**
 * 独立任务窗口 — 压缩启动时由主进程弹出的 frameless 小窗(?window=task 分流)。
 * 数据源:挂载时 taskSnapshot 回放已在跑的任务,再订阅 tz:progress 广播流;
 * 不自动关闭(Bandizip 式行为)——终态任务留在卡上供回看历史,仅右上角关闭按钮手动关。
 * 卡片聚焦精致化:状态徽章 + 任务类型副标 + 信息内嵌式进度条(当前文件/百分比直接渲染在条上)。
 */
import { useEffect, useState } from 'react';
import type { JobKind, ProgressEvent } from '@shared/types';
import {
  IconClose, IconCompress, IconExtract, IconTest, IconDelete,
  IconCheckCircle, IconWarn, IconMin, Logo,
} from './icons';
import { cn } from '@/lib/utils';

const KIND: Record<JobKind, { run: string; badge: string; icon: typeof IconCompress }> = {
  compress: { run: '正在压缩', badge: '压缩任务', icon: IconCompress },
  extract: { run: '正在解压', badge: '解压任务', icon: IconExtract },
  test: { run: '正在测试', badge: '完整性测试', icon: IconTest },
  delete: { run: '正在删除', badge: '删除条目', icon: IconDelete },
};

export default function TaskWindow() {
  const [jobs, setJobs] = useState<ProgressEvent[]>([]);

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

  /* 全部终态只更新底部提示;关窗纯手动(右上角按钮),方便回看任务历史 */
  const allSettled = jobs.length > 0 && jobs.every((j) => j.status !== 'running');
  const runningN = jobs.filter((j) => j.status === 'running').length;

  return (
    <div className="flex h-screen select-none flex-col overflow-hidden bg-background text-foreground">
      {/* 迷你标题栏:拖拽区 + 最小化/关闭(无最大化和任务铃铛) */}
      <header className="app-drag flex h-[38px] shrink-0 items-center gap-2 bg-secondary pl-3 text-[12.5px] font-semibold">
        <span className="flex size-[18px] items-center justify-center rounded-[5px] bg-primary text-primary-foreground">
          <Logo className="size-[11px]" />
        </span>
        任务
        {runningN > 0 && (
          <span className="rounded-full bg-primary/10 px-2 py-px text-[10.5px] font-medium tabular-nums text-primary">
            {runningN} 个进行中
          </span>
        )}
        <div className="app-nodrag ml-auto flex items-center">
          <button className="inline-flex h-[38px] w-[40px] items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="最小化" onClick={() => window.tz.winMinimize()}><IconMin className="size-3" /></button>
          <button className="inline-flex h-[38px] w-[44px] items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
            title="关闭" onClick={() => window.tz.winClose()}><IconClose className="size-3" /></button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto p-3">
        {jobs.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2.5 text-muted-foreground">
            <span className="grid size-10 place-items-center rounded-full bg-[var(--accent-soft)]"><Logo className="size-4 text-primary" /></span>
            <span className="text-[12px]">等待任务…</span>
          </div>
        )}
        {jobs.map((j) => <TaskCard key={j.taskId} ev={j} />)}
        {allSettled && (
          <div className="pb-1 text-center text-[11.5px] text-muted-foreground">全部任务已结束</div>
        )}
      </div>
    </div>
  );
}

/** 单任务卡:状态徽章/任务类型 + 信息内嵌式进度条(左=当前文件,右=百分比,双层文字随填充精确裁切) */
function TaskCard({ ev }: { ev: ProgressEvent }) {
  const meta = KIND[ev.kind];
  const running = ev.status === 'running';
  const done = ev.status === 'done';
  const failed = !running && !done;
  const Icon = done ? IconCheckCircle : failed ? IconWarn : meta.icon;
  const indet = running && ev.percent < 0;
  const p = ev.percent >= 0 ? Math.min(100, ev.percent) : 0;
  const title = done ? `${meta.run.replace('正在', '')}完成`
    : ev.status === 'cancelled' ? '任务已取消'
      : ev.status === 'error' ? '任务失败' : meta.run;
  /* loading 条上直接承载当前任务信息 */
  const barLeft = running ? (ev.file || `${meta.badge}准备中…`) : done ? (ev.message || title) : title;
  const barRight = running ? (indet ? '—' : `${p}%`) : done ? '100%' : ev.status === 'cancelled' ? '已取消' : '失败';
  return (
    <div className="animate-[rise_.18s_ease-out] rounded-xl border border-border/60 bg-card px-3.5 pb-3 pt-3 shadow-[var(--shadow-float)]">
      <div className="flex items-center gap-2.5">
        <span className={cn('grid size-[28px] shrink-0 place-items-center rounded-lg',
          failed ? 'bg-destructive/10 text-destructive' : 'bg-[var(--accent-soft)] text-primary')}>
          <Icon className={cn('size-[15px]', running && 'animate-pulse')} />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[13px] font-semibold">{title}</div>
          <div className="mt-px text-[10.5px] text-muted-foreground">{meta.badge}</div>
        </div>
        {running && (
          <button
            className="h-[26px] shrink-0 rounded-lg border border-border/70 px-2.5 text-[11px] text-muted-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
            title="取消任务" onClick={() => void window.tz.cancelTask(ev.taskId)}>取消</button>
        )}
      </div>
      <div className="relative mt-2.5 h-[26px] overflow-hidden rounded-lg bg-muted">
        {indet ? (
          <i className="absolute inset-y-0 left-[-34%] h-full w-[34%] rounded-full bg-primary/30 animate-[tw-indet_1.4s_ease-in-out_infinite]" />
        ) : (
          <i
            className="absolute inset-y-0 left-0 h-full overflow-hidden bg-[linear-gradient(90deg,var(--accent-hover),var(--accent))] transition-[width] duration-300 ease-out"
            style={{ width: `${p}%` }}>
            {running && <i className="tw-shimmer pointer-events-none absolute inset-0" />}
          </i>
        )}
        {/* 底层轨道灰字 + 白字高层按进度宽度裁切:文字滑进填充区即刻变白,两层内容完全对齐 */}
        <div className="absolute inset-0 flex items-center justify-between gap-3 px-2.5 text-[11px]">
          <span className="truncate text-muted-foreground">{barLeft}</span>
          <span className="shrink-0 font-semibold tabular-nums text-muted-foreground">{barRight}</span>
        </div>
        {!indet && (
          <div
            className="absolute inset-0 flex items-center justify-between gap-3 px-2.5 text-[11px] text-primary-foreground transition-[clip-path] duration-300 ease-out"
            style={{ clipPath: `inset(0 ${100 - p}% 0 0)` }}>
            <span className="truncate">{barLeft}</span>
            <span className="shrink-0 font-semibold tabular-nums">{barRight}</span>
          </div>
        )}
      </div>
      {failed && ev.message && (
        <div className="mt-1.5 truncate text-[11px] text-destructive" title={ev.message}>{ev.message}</div>
      )}
    </div>
  );
}
