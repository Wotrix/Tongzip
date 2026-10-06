/**
 * 独立任务窗口 — 压缩启动时由主进程弹出的 frameless 小窗(?window=task 分流)。
 * 数据源:挂载时 taskSnapshot 回放已在跑的任务,再订阅 tz:progress 广播流;
 * 不自动关闭(Bandizip 式行为)——终态任务留在卡上供回看历史,仅右上角关闭按钮手动关。
 * 版式对标 Bandizip 进度窗:标题=当前任务状态 / 每任务「%+已用时间+进度条」
 * / 多任务时追加总进度 / 当前文件行 / 底部工具条(打开位置·暂停·停止)+「全部任务已结束」。
 */
import { useEffect, useRef, useState } from 'react';
import type { JobKind, ProgressEvent } from '@shared/types';
import {
  IconClose, IconCompress, IconExtract, IconTest, IconDelete, IconFolderOpen, IconMax,
  IconPause, IconPlay, IconReveal, IconStop, IconMore, IconMin, Logo,
} from './icons';
import { ContextMenu, type CtxItem } from './ui';
import { cn } from '@/lib/utils';

const KIND: Record<JobKind, { run: string; done: string }> = {
  compress: { run: '正在压缩', done: '已压缩' },
  extract: { run: '正在解压', done: '已解压' },
  test: { run: '正在测试', done: '已测试' },
  delete: { run: '正在删除', done: '已删除' },
};

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

  /* Bandizip 式手动关闭:jobs 只增不清,终态卡留存回看;关窗仅右上角按钮 */
  const allSettled = jobs.length > 0 && running.length === 0;
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

  const menuItems: CtxItem[] = [
    { label: '打开文件位置', icon: <IconReveal />, disabled: !srcPath, onClick: () => srcPath && void window.tz.revealInExplorer(srcPath) },
    { label: '打开目标文件夹', icon: <IconFolderOpen />, disabled: !destPath, onClick: () => destPath && void window.tz.openPath(destPath) },
    { sep: true, label: '' },
    { label: '最小化', icon: <IconMin />, onClick: () => window.tz.winMinimize() },
    { label: '关闭任务窗口', icon: <IconClose />, onClick: () => window.tz.winClose() },
  ];

  return (
    <div className="flex h-screen select-none flex-col overflow-hidden bg-background text-foreground">
      {/* 迷你标题栏:拖拽区 + 当前任务状态标题 + 最小化/最大化/关闭(窗控 IPC 按 sender 定位) */}
      <header className="app-drag flex h-[38px] shrink-0 items-center gap-2 bg-secondary pl-3 text-[12.5px] font-semibold">
        <span className="flex size-[18px] items-center justify-center rounded-[5px] bg-primary text-primary-foreground">
          <Logo className="size-[11px]" />
        </span>
        {title}
        {running.length > 1 && (
          <span className="rounded-full bg-primary/10 px-2 py-px text-[10.5px] font-medium tabular-nums text-primary">
            {running.length} 个进行中
          </span>
        )}
        <div className="app-nodrag ml-auto flex items-center">
          <button className="inline-flex h-[38px] w-[40px] items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="最小化" onClick={() => window.tz.winMinimize()}><IconMin className="size-3" /></button>
          <button className="inline-flex h-[38px] w-[44px] items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="最大化" onClick={() => window.tz.winMaximize()}><IconMax className="size-3" /></button>
          <button className="inline-flex h-[38px] w-[44px] items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
            title="关闭" onClick={() => window.tz.winClose()}><IconClose className="size-3" /></button>
        </div>
      </header>

      {/* 任务区:每任务一行(% + 已用时间 + 进度条 + 当前文件);多任务追加总进度 */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 pb-2 pt-3.5">
        {jobs.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2.5 text-muted-foreground">
            <span className="grid size-10 place-items-center rounded-full bg-[var(--accent-soft)]"><Logo className="size-4 text-primary" /></span>
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
              <i className="h-full rounded-full bg-[linear-gradient(90deg,var(--accent-hover),var(--accent))] transition-[width] duration-300 ease-out"
                style={{ width: `${totalPct}%` }} />
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
              running.length ? 'text-foreground hover:bg-accent' : 'text-muted-foreground opacity-50',
              paused.has(running[0]?.taskId ?? '') && 'border-primary/50 text-primary')}
            title={paused.has(running[0]?.taskId ?? '') ? '恢复任务' : '暂停任务'}
            disabled={!running.length} onClick={() => void togglePause()}>
            {paused.has(running[0]?.taskId ?? '') ? <IconPlay className="size-3" /> : <IconPause className="size-3" />}
            {paused.has(running[0]?.taskId ?? '') ? '恢复' : '暂停'}
          </button>
          <button
            className={cn('inline-flex h-[30px] min-w-[74px] items-center justify-center gap-1.5 rounded-lg border px-3 text-[12px] font-semibold transition-colors',
              running.length
                ? 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20'
                : 'border-border/70 text-muted-foreground opacity-50')}
            title="停止全部任务" disabled={!running.length} onClick={stopAll}>
            <IconStop className="size-3" /> 停止
          </button>
        </div>
      </footer>
      {/* 终态提示常驻(探针/用户均依赖):手动关窗前明确「没有在跑的任务了」 */}
      <div className="h-[22px] shrink-0 bg-secondary pb-1 text-center text-[11.5px] leading-none text-muted-foreground">
        {allSettled ? '全部任务已结束' : ''}
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
    <button className="inline-flex size-[30px] items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
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
  const p = ev.percent >= 0 ? Math.min(100, ev.percent) : 0;
  const pctText = !running ? (done ? '100%' : ev.status === 'cancelled' ? '已取消' : '失败') : indet ? '—' : `${p}%`;
  const fileLine = running ? (ev.file || `${meta.run.replace('正在', '')}准备中…`)
    : done ? (ev.message || `${meta.done}完成`)
      : (ev.message || (ev.status === 'cancelled' ? '任务已取消' : '任务失败'));
  return (
    <div className={cn('leading-tight', failed && 'text-destructive')}>
      <div className="mb-1 flex items-baseline justify-between text-[12px]">
        <span className={cn('font-semibold tabular-nums', running && 'text-primary')}>{pctText}{running && paused && <span className="ml-1.5 rounded bg-[var(--warn-soft)] px-1.5 py-px text-[10px] font-medium text-[color:var(--warn)]">已暂停</span>}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">已用 {fmtElapsed(elapsed)}</span>
      </div>
      <div className="relative h-[12px] overflow-hidden rounded-full bg-muted">
        {indet ? (
          <i className="absolute inset-y-0 left-[-34%] h-full w-[34%] rounded-full bg-primary/30 animate-[tw-indet_1.4s_ease-in-out_infinite]" />
        ) : (
          <i className="relative h-full rounded-full bg-[linear-gradient(90deg,var(--accent-hover),var(--accent))] transition-[width] duration-300 ease-out"
            style={{ width: `${p}%` }}>
            {running && !paused && <i className="tw-shimmer pointer-events-none absolute inset-0" />}
          </i>
        )}
      </div>
      <div className="mt-1 truncate text-[11.5px] text-muted-foreground" title={fileLine}>{fileLine}</div>
    </div>
  );
}
