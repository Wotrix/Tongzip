/**
 * 独立任务窗口 — 压缩/解压启动时弹出的 frameless 小窗(?window=task 分流)。
 * 数据源:挂载时 taskSnapshot 回放已在跑的任务,再订阅 tz:progress 广播流;
 * 全部任务成功后 1.2s 自动关窗(创建完压缩包不再留窗);失败/取消保留供查看,仍可手动关闭。
 * 版式对标 Bandizip 进度窗:标题=当前任务状态 / 每任务「%+已用时间+进度条」
 * / 多任务时追加总进度 / 当前文件行 / 底部工具条(打开位置·暂停·停止)。
 * 标题栏除拖拽区与窗控外另有「置顶」图钉钮:长解压时把小窗挂在最前,不抢焦点也能盯进度。
 */
import { useEffect, useRef, useState } from 'react';
import type { JobKind, ProgressEvent } from '@shared/types';
import {
  IconClose, IconCompress, IconExtract, IconTest, IconDelete, IconFolderOpen, IconMax,
  IconPause, IconPin, IconPinOff, IconPlay, IconReveal, IconStop, IconMore, IconMin,
} from './icons';
import AppLogo from './AppLogo';
import { ContextMenu, type CtxItem } from './ui';
import { cn } from '@/lib/utils';

const KIND: Record<JobKind, { run: string; done: string }> = {
  compress: { run: '正在压缩', done: '已压缩' },
  extract: { run: '正在解压', done: '已解压' },
  test: { run: '正在测试', done: '已测试' },
  delete: { run: '正在删除', done: '已删除' },
};

/** 成功完成态停留时长：让成功动画可见，然后自动关窗 */
const AUTO_CLOSE_MS = 2400;

/** 秒 → h:mm:ss / m:ss(Bandizip 式用时) */
function fmtElapsed(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

export default function TaskWindow() {
  const [jobs, setJobs] = useState<ProgressEvent[]>([]);
  /** taskId → 源包/输出/解压目标(「打开位置」两钮数据源,挂载拉取+终态补拉) */
  const [paths, setPaths] = useState<Record<string, { archive?: string; output?: string; dest?: string }>>({});
  /** 暂停态是渲染本地概念:引擎 pauseTask 返回切换后的状态 */
  const [paused, setPaused] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** 置顶状态镜像主进程回读的真实值(只活在窗口生命周期内,关窗即复位) */
  const [pinned, setPinned] = useState(false);
  /** 首见时刻:已用时间基准;每秒 tick 刷新显示 */
  const startedAt = useRef(new Map<string, number>());
  const [, setTick] = useState(0);

  /* 快照回放 + 订阅实时进度流(主进程广播到所有窗口) */
  useEffect(() => {
    const upsert = (ev: ProgressEvent) => setJobs((prev) => {
      if (!startedAt.current.has(ev.taskId)) startedAt.current.set(ev.taskId, Date.now());
      const i = prev.findIndex((j) => j.taskId === ev.taskId);
      if (i < 0) return [...prev, ev];
      const next = [...prev];
      next[i] = ev;
      return next;
    });
    void window.tz.taskSnapshot().then((snap) => snap.forEach(upsert));
    void window.tz.taskPaths().then(setPaths);
    return window.tz.onProgress(upsert);
  }, []);

  const running = jobs.filter((j) => j.status === 'running');
  /* 有活干才 tick,全部终态后停表省电 */
  useEffect(() => {
    if (!running.length) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running.length]);

  /* 路径登记表由渲染层在 invoke 返回后才写入,可能晚于首事件:每次有任务落定补拉一次 */
  const settledN = jobs.length - running.length;
  useEffect(() => { if (settledN > 0) void window.tz.taskPaths().then(setPaths); }, [settledN]);

  /* 终态卡保留在 jobs 里;全部成功自动关窗,失败/取消由用户手动关 */
  const allSettled = jobs.length > 0 && running.length === 0;
  const allDone = allSettled && jobs.every((j) => j.status === 'done');
  /* 全部任务成功 → 展示成功动画后自动关窗(创建完压缩包不再留窗) */
  useEffect(() => {
    if (!allDone) return;
    const t = window.setTimeout(() => { void window.tz.winClose(); }, AUTO_CLOSE_MS);
    return () => window.clearTimeout(t);
  }, [allDone]);
  /* 成功卡文案/产物名:压缩完成展示输出文件名,多任务展示总数 */
  const doneJob = allDone ? jobs[jobs.length - 1] : null;
  const donePath = doneJob
    ? paths[doneJob.taskId]?.output ?? paths[doneJob.taskId]?.archive ?? paths[doneJob.taskId]?.dest
    : undefined;
  const doneName = donePath ? donePath.split(/[\\/]/).pop() : doneJob?.file;
  const doneText = doneJob
    ? (jobs.length > 1 ? '全部任务已完成' : `${KIND[doneJob.kind].done.slice(1)}操作已成功完成`)
    : '';
  /* 标题 = 当前任务(首个运行中,无则最后一个)状态;多任务加计数角标 */
  const focusEv = running[0] ?? jobs[jobs.length - 1];
  const title = !focusEv ? '任务'
    : focusEv.status === 'running' ? KIND[focusEv.kind].run
      : focusEv.status === 'done' ? KIND[focusEv.kind].done
        : focusEv.status === 'cancelled' ? '任务已取消' : '任务失败';
  /* 总进度:各任务百分比(不确定/未开始按 0 计)均值,仅多任务时展示 */
  const totalPct = Math.floor(jobs.reduce((s, j) => s + Math.max(0, j.percent), 0) / Math.max(1, jobs.length));

  /* 底部工具条目标任务:优先运行中首个,否则最后一张终态卡 */
  const target = focusEv;
  const targetPaths = target ? paths[target.taskId] ?? {} : {};
  const srcPath = targetPaths.archive || targetPaths.output;           // 打开文件位置(源包/产物)
  const destPath = targetPaths.dest || (targetPaths.output ? targetPaths.output.replace(/\/[^/]+$/, '') : undefined); // 打开目标文件夹

  const togglePause = async () => {
    const j = running[0];
    if (!j) return;
    const r = await window.tz.taskPause(j.taskId);
    if (r.ok) setPaused((p) => { const s = new Set(p); if (r.data) s.add(j.taskId); else s.delete(j.taskId); return s; });
  };
  const stopAll = () => running.forEach((j) => void window.tz.cancelTask(j.taskId));
  const togglePin = () => void window.tz.winPin().then(setPinned);

  const menuItems: CtxItem[] = [
    { label: '打开文件位置', icon: <IconReveal />, disabled: !srcPath, onClick: () => srcPath && void window.tz.revealInExplorer(srcPath) },
    { label: '打开目标文件夹', icon: <IconFolderOpen />, disabled: !destPath, onClick: () => destPath && void window.tz.openPath(destPath) },
    { sep: true, label: '' },
    { label: pinned ? '取消置顶' : '保持置顶', icon: pinned ? <IconPinOff /> : <IconPin />, onClick: togglePin },
    { label: '最小化', icon: <IconMin />, onClick: () => window.tz.winMinimize() },
    { label: '关闭任务窗口', icon: <IconClose />, onClick: () => window.tz.winClose() },
  ];

  return (
    <div className="flex h-screen select-none flex-col overflow-hidden bg-background text-foreground">
      {/* 迷你标题栏:拖拽区 + 当前任务状态标题 + 最小化/最大化/关闭(窗控 IPC 按 sender 定位) */}
      <header className="app-drag flex h-[38px] shrink-0 items-center gap-2 bg-secondary pl-3 text-[12.5px] font-semibold">
        <span className="flex size-[18px] shrink-0 items-center justify-center">
          <AppLogo className="size-[18px]" />
        </span>
        {title}
        {running.length > 1 && (
          <span className="rounded-full bg-primary/10 px-2 py-px text-[10.5px] font-medium tabular-nums text-primary">
            {running.length} 个进行中
          </span>
        )}
        <div className="app-nodrag ml-auto flex items-center">
          {/* 置顶图钉:未置顶描边灰、置顶染品牌色并打底,状态一眼可读 */}
          <button className={cn(
            'inline-flex h-[38px] w-[40px] items-center justify-center transition-colors hover:bg-accent active:bg-[var(--bg-active)]',
            pinned ? 'bg-primary/10 text-primary hover:bg-accent/60' : 'text-muted-foreground hover:text-foreground',
          )}
            title={pinned ? '取消置顶' : '置顶窗口'} onClick={togglePin}>
            {pinned ? <IconPin className="size-[15px]" /> : <IconPinOff className="size-[15px]" />}
          </button>
          <button className="inline-flex h-[38px] w-[40px] items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-[var(--bg-active)]"
            title="最小化" onClick={() => window.tz.winMinimize()}><IconMin className="size-3" /></button>
          <button className="inline-flex h-[38px] w-[44px] items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-[var(--bg-active)]"
            title="最大化" onClick={() => window.tz.winMaximize()}><IconMax className="size-3" /></button>
          <button className="inline-flex h-[38px] w-[44px] items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
            title="关闭" onClick={() => window.tz.winClose()}><IconClose className="size-3" /></button>
        </div>
      </header>

      {/* 任务区:每任务一行(% + 已用时间 + 进度条 + 当前文件);多任务追加总进度 */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 pb-2 pt-3.5">
        {jobs.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2.5 text-muted-foreground">
            <AppLogo className="size-10" />
            <span className="text-[12px]">等待任务…</span>
          </div>
        )}
        {jobs.map((j) => (
          <TaskRow key={j.taskId} ev={j}
            elapsed={Math.max(0, (Date.now() - (startedAt.current.get(j.taskId) ?? Date.now())) / 1000)}
            paused={paused.has(j.taskId)} />
        ))}
        {jobs.length > 1 && (
          <div className="border-t border-border/60 pt-2.5">
            <div className="mb-1 flex items-baseline justify-between text-[11.5px]">
              <span className="font-semibold">总进度 {totalPct}%</span>
              <span className="tabular-nums text-muted-foreground">{jobs.filter((j) => j.status === 'done').length}/{jobs.length} 个完成</span>
            </div>
            <div className="h-[10px] overflow-hidden rounded-full bg-muted">
              <i className={cn('block h-full rounded-full transition-[width] duration-300 ease-out',
                allDone ? 'bg-emerald-500' : 'bg-[linear-gradient(90deg,var(--accent-hover),var(--accent))]')}
                style={{ width: `${totalPct}%` }} />
            </div>
          </div>
        )}
        {allDone && (
          <div className="tw-done-in mt-auto flex flex-col items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/[.06] px-4 py-4 text-center">
            <div className="tw-check-pop grid size-11 place-items-center rounded-full bg-emerald-500 text-white shadow-[0_6px_16px_rgba(16,185,129,.35)]">
              <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path className="tw-check-path" d="M5.5 12.5l4.2 4.2L18.5 8" />
              </svg>
            </div>
            <div className="text-[13px] font-semibold text-emerald-700 dark:text-emerald-300">{doneText}</div>
            {doneName && (
              <div className="max-w-full truncate text-[11.5px] text-muted-foreground" title={doneName}>{doneName}</div>
            )}
            <div className="mt-1 h-[5px] w-full overflow-hidden rounded-full bg-emerald-500/15">
              <i className="tw-done-countdown block h-full rounded-full bg-emerald-500" />
            </div>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>窗口即将自动关闭…</span>
              <button className="rounded-md border border-border/70 bg-background px-2.5 py-1 text-[11.5px] text-foreground transition-colors hover:bg-accent active:bg-[var(--bg-active)]"
                onClick={() => window.tz.winClose()}>关闭</button>
            </div>
          </div>
        )}
      </div>

      {/* 底部工具条(Bandizip 式):左=打开位置/目标夹/更多,右=暂停/停止 */}
      <footer className="flex h-[46px] shrink-0 items-center gap-1 border-t border-border bg-secondary px-3">
        <FtBtn title="打开文件位置" disabled={!srcPath} onClick={() => srcPath && void window.tz.revealInExplorer(srcPath)}><IconReveal className="size-4" /></FtBtn>
        <FtBtn title="打开目标文件夹" disabled={!destPath} onClick={() => destPath && void window.tz.openPath(destPath)}><IconFolderOpen className="size-4" /></FtBtn>
        <FtBtn title="任务菜单" onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setMenu({ x: r.left, y: r.top - 130 });
        }}><IconMore className="size-4" /></FtBtn>
        <div className="ml-auto flex items-center gap-2">
          <button
            className={cn('inline-flex h-[30px] min-w-[74px] items-center justify-center gap-1.5 rounded-lg border border-border/70 bg-background px-3 text-[12px] transition-colors',
              running.length ? 'text-foreground hover:bg-accent active:bg-[var(--bg-active)]' : 'text-muted-foreground opacity-50',
              paused.has(running[0]?.taskId ?? '') && 'border-primary/50 text-primary')}
            title={paused.has(running[0]?.taskId ?? '') ? '恢复任务' : '暂停任务'}
            disabled={!running.length} onClick={() => void togglePause()}>
            {paused.has(running[0]?.taskId ?? '') ? <IconPlay className="size-3" /> : <IconPause className="size-3" />}
            {paused.has(running[0]?.taskId ?? '') ? '恢复' : '暂停'}
          </button>
          <button
            className={cn('inline-flex h-[30px] min-w-[74px] items-center justify-center gap-1.5 rounded-lg border px-3 text-[12px] font-semibold transition-colors',
              running.length
                ? 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20 active:bg-destructive/30'
                : 'border-border/70 text-muted-foreground opacity-50')}
            title="停止全部任务" disabled={!running.length} onClick={stopAll}>
            <IconStop className="size-3" /> 停止
          </button>
        </div>
      </footer>
      {/* 终态提示:成功时短暂显示后自动关窗;失败/取消保留 */}
      <div className="h-[22px] shrink-0 bg-secondary pb-1 text-center text-[11.5px] leading-none text-muted-foreground">
        {allSettled && !allDone ? '全部任务已结束' : ''}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** 底部图标按钮:ghost 方块,禁用半透 */
function FtBtn({ title, disabled, onClick, children }: {
  title: string; disabled?: boolean; onClick(e: React.MouseEvent): void; children: React.ReactNode;
}) {
  return (
    <button className="inline-flex size-[30px] items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-[var(--bg-active)] disabled:pointer-events-none disabled:opacity-40"
      title={title} disabled={disabled} onClick={onClick}>{children}</button>
  );
}

/** 单任务行:上=「% + 已用时间」,中=通长进度条,下=当前文件;终态换状态文案 */
function TaskRow({ ev, elapsed, paused }: { ev: ProgressEvent; elapsed: number; paused: boolean }) {
  const meta = KIND[ev.kind];
  const running = ev.status === 'running';
  const done = ev.status === 'done';
  const failed = !running && !done;
  const indet = running && ev.percent < 0;
  const p = done ? 100 : ev.percent >= 0 ? Math.min(100, ev.percent) : 0;
  const pctText = !running ? (done ? '100%' : ev.status === 'cancelled' ? '已取消' : '失败') : indet ? '—' : `${p}%`;
  const fill = done ? 'bg-emerald-500'
    : failed ? 'bg-destructive'
      : 'bg-[linear-gradient(90deg,var(--accent-hover),var(--accent))]';
  const fileLine = running ? (ev.file || `${meta.run.replace('正在', '')}准备中…`)
    : done ? (ev.message || `${meta.done}完成`)
      : (ev.message || (ev.status === 'cancelled' ? '任务已取消' : '任务失败'));
  return (
    <div className={cn('leading-tight', failed && 'text-destructive')}>
      <div className="mb-1 flex items-baseline justify-between text-[12px]">
        <span className={cn('font-semibold tabular-nums', running && 'text-primary', done && 'text-emerald-600 dark:text-emerald-400')}>{pctText}{running && paused && <span className="ml-1.5 rounded bg-[var(--warn-soft)] px-1.5 py-px text-[10px] font-medium text-[color:var(--warn)]">已暂停</span>}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">已用 {fmtElapsed(elapsed)}</span>
      </div>
      <div className="relative h-[12px] overflow-hidden rounded-full bg-muted">
        {indet ? (
          <i className="absolute inset-y-0 left-[-34%] h-full w-[34%] rounded-full bg-primary/30 animate-[tw-indet_1.4s_ease-in-out_infinite]" />
        ) : (
          <i className={cn('relative block h-full rounded-full transition-[width] duration-300 ease-out', fill)}
            style={{ width: `${p}%` }}>
            {running && !paused && <i className="tw-shimmer pointer-events-none absolute inset-0" />}
          </i>
        )}
      </div>
      <div className="mt-1 truncate text-[11.5px] text-muted-foreground" title={fileLine}>{fileLine}</div>
    </div>
  );
}
