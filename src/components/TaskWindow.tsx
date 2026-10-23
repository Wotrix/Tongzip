/**
 * 独立任务窗口 — 压缩/解压统一进度与完成态
 * 布局参考用户提供的完成页：大标题 + 对勾/任务插图 + 通长进度条 + 信息卡 + 底部按钮。
 * 进度与完成信息来自任务进度流；任务中心仍保留，窗口只做当前批次的可视化。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { JobKind, ProgressEvent } from '@shared/types';
import AppLogo from './AppLogo';
import {
  IconArchive, IconCheckCircle, IconClock, IconClose, IconFile, IconFolderOpen,
  IconMax, IconMin, IconReveal, IconWarn,
} from './icons';
import { basename } from '../lib/format';
import { cn } from '@/lib/utils';

const LABEL: Record<JobKind, { run: string; done: string; verb: string }> = {
  compress: { run: '正在压缩', done: '压缩完成', verb: '压缩' },
  extract: { run: '正在解压', done: '解压完成', verb: '解压' },
  test: { run: '正在测试', done: '测试完成', verb: '测试' },
  delete: { run: '正在删除', done: '删除完成', verb: '删除' },
};

function fmtElapsed(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

function InfoRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3 text-[13px]">
      <span className="grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span className="w-[76px] shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={value}>{value || '—'}</span>
    </div>
  );
}

export default function TaskWindow() {
  const [jobs, setJobs] = useState<ProgressEvent[]>([]);
  const [paths, setPaths] = useState<Record<string, { archive?: string; output?: string; dest?: string }>>({});
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const startedAt = useRef(new Map<string, number>());
  const [, setTick] = useState(0);

  /* 快照回放 + 订阅实时进度流 */
  useEffect(() => {
    const upsert = (ev: ProgressEvent) => setJobs((prev) => {
      if (!startedAt.current.has(ev.taskId)) startedAt.current.set(ev.taskId, Date.now());
      /* 新一批任务:上一批已全部终态时从这条 running 重新开始 */
      if (ev.status === 'running' && prev.length > 0 && prev.every((j) => j.status !== 'running')) return [ev];
      const i = prev.findIndex((j) => j.taskId === ev.taskId);
      if (i < 0) return [...prev, ev];
      const next = [...prev];
      next[i] = ev;
      return next;
    });
    void window.tz.taskSnapshot().then((snap) => {
      const live = snap.filter((ev) => ev.status === 'running');
      (live.length ? live : snap.slice(-1)).forEach(upsert);
    });
    void window.tz.taskPaths().then(setPaths);
    /* 路径登记可能在任务启动后才写入(且不再有进度事件):轻量轮询补拉,保证完成页能显示源/目标路径 */
    const off = window.tz.onProgress(upsert);
    const t = setInterval(() => { void window.tz.taskPaths().then(setPaths); }, 600);
    return () => { clearInterval(t); off(); };
  }, []);

  const running = jobs.filter((j) => j.status === 'running');
  const allSettled = jobs.length > 0 && running.length === 0;
  const allDone = allSettled && jobs.every((j) => j.status === 'done');
  const failed = allSettled && jobs.some((j) => j.status === 'error' || j.status === 'cancelled');

  /* 运行中每秒刷新已用时间；全部终态后停表并冻结完成时间 */
  useEffect(() => {
    if (!running.length) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running.length]);
  useEffect(() => {
    if (allSettled) setFinishedAt((v) => v ?? Date.now());
    else setFinishedAt(null);
  }, [allSettled]);

  /* 路径登记可能晚于首事件:每次任务落定补拉 */
  useEffect(() => { if (jobs.length) void window.tz.taskPaths().then(setPaths); }, [jobs.length, allDone]);

  const focus = running[0] ?? jobs[jobs.length - 1];
  const kind = focus?.kind ?? 'compress';
  const target = focus ? paths[focus.taskId] ?? {} : {};
  const output = target.output;
  const archivePath = target.archive;
  const destPath = target.dest;
  const folderPath = kind === 'compress'
    ? (output ? output.replace(/\/[^/]+$/, '') : undefined)
    : (destPath || (output ? output.replace(/\/[^/]+$/, '') : undefined));
  const filePath = kind === 'compress' ? output : archivePath;
  const displayFile = filePath ? basename(filePath) : (focus?.file || '—');
  const displayPath = kind === 'compress' ? folderPath : destPath;
  const elapsed = focus ? Math.max(0, ((finishedAt ?? Date.now()) - (startedAt.current.get(focus.taskId) ?? Date.now())) / 1000) : 0;
  const pct = jobs.length === 0 ? 0
    : allDone ? 100
      : Math.floor(jobs.reduce((s, j) => s + Math.max(0, j.percent), 0) / jobs.length);
  const indet = !allDone && !failed && jobs.some((j) => j.status === 'running' && j.percent < 0);
  const statusTitle = allDone
    ? (jobs.length > 1 ? '全部任务已完成' : LABEL[kind].done)
    : failed ? '任务失败'
      : focus ? LABEL[kind].run : '等待任务…';
  const subtitle = allDone
    ? `已成功完成 ${displayFile}`
    : failed ? (focus?.message ?? '任务未完成')
      : `正在处理 ${displayFile}`;

  return (
    <div className="flex h-screen select-none flex-col overflow-hidden bg-background text-foreground">
      {/* 标题栏：品牌 + 窗控 */}
      <header className="app-drag flex h-[52px] shrink-0 items-center gap-2.5 border-b border-border/60 pl-5 text-[13px] font-semibold">
        <AppLogo className="size-[22px] shrink-0" />
        <span>TongZip</span>
        <div className="app-nodrag ml-auto flex items-center">
          <button className="inline-flex h-[52px] w-[46px] items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-[var(--bg-active)]"
            title="最小化" onClick={() => window.tz.winMinimize()}><IconMin className="size-3.5" /></button>
          <button className="inline-flex h-[52px] w-[46px] items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-[var(--bg-active)]"
            title="最大化" onClick={() => window.tz.winMaximize()}><IconMax className="size-3.5" /></button>
          <button className="inline-flex h-[52px] w-[46px] items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
            title="关闭" onClick={() => window.tz.winClose()}><IconClose className="size-3.5" /></button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-auto px-8 pt-7 pb-5">
        {/* 完成/进度标题 + 右侧插图 */}
        <div className="flex items-start justify-between gap-6">
          <div className="flex min-w-0 items-start gap-4">
            <div className={cn(
              'tw-check-pop grid size-[62px] shrink-0 place-items-center rounded-full border-[3px]',
              allDone ? 'border-emerald-500/30 text-emerald-500' : failed ? 'border-destructive/25 text-destructive' : 'border-primary/25 text-primary',
            )}>
              {allDone
                ? <IconCheckCircle className="size-9" />
                : failed ? <IconWarn className="size-8" /> : <IconArchive className="size-8" />}
            </div>
            <div className="min-w-0 pt-0.5">
              <h1 className={cn('truncate text-[24px] font-bold tracking-[-.01em]', failed && 'text-destructive')}>{statusTitle}</h1>
              <p className="mt-1.5 truncate text-[13px] text-muted-foreground">{subtitle}</p>
            </div>
          </div>

          {/* 右侧任务插图 + 完成徽标 */}
          <div className="relative hidden shrink-0 sm:block">
            <div className="grid size-[92px] place-items-center rounded-[22px] bg-primary/[.08] text-primary">
              {kind === 'extract' ? <IconFolderOpen className="size-12" /> : <IconArchive className="size-12" />}
            </div>
            <span className={cn(
              'absolute -bottom-2 -right-2 grid size-8 place-items-center rounded-full border-2 border-background text-white shadow-sm',
              failed ? 'bg-destructive' : 'bg-emerald-500',
            )}>
              {failed ? <IconClose className="size-3.5" /> : <IconCheckCircle className="size-5" />}
            </span>
          </div>
        </div>

        {/* 通长进度条 + 百分比 */}
        <div className="mt-7 flex items-center gap-4">
          <div className="relative h-[10px] flex-1 overflow-hidden rounded-full bg-secondary">
            <i
              className={cn(
                'block h-full rounded-full bg-[linear-gradient(90deg,var(--accent-hover),var(--accent))] transition-[width] duration-200 ease-linear',
                failed && 'bg-destructive',
                indet && 'w-[34%] animate-[tw-indet_1.2s_ease-in-out_infinite]',
              )}
              style={indet ? undefined : { width: `${pct}%` }}
            >
              {!allDone && !failed && <i className="tw-shimmer absolute inset-0" />}
            </i>
          </div>
          <span className="w-[44px] shrink-0 text-right text-[13px] font-semibold tabular-nums text-muted-foreground">{pct}%</span>
        </div>

        {/* 信息卡 */}
        <div className="mt-6 grid grid-cols-1 gap-0 overflow-hidden rounded-[14px] border border-border/70 bg-secondary/40 sm:grid-cols-[1fr_200px]">
          <div className="flex min-w-0 flex-col gap-3.5 px-5 py-4">
            <InfoRow icon={<IconFile />} label={kind === 'compress' ? '压缩文件' : '解压文件'} value={displayFile} />
            <InfoRow icon={<IconFolderOpen />} label={kind === 'compress' ? '保存位置' : '解压路径'} value={displayPath ?? ''} />
            <InfoRow icon={<IconClock />} label="已用时间" value={fmtElapsed(elapsed)} />
            <InfoRow icon={<IconArchive />} label="任务数" value={`${jobs.length} 个`} />
          </div>
          <div className="flex flex-col items-center justify-center gap-2 border-t border-border/70 px-5 py-5 text-center sm:border-l sm:border-t-0">
            <div className={cn(
              'grid size-10 place-items-center rounded-full text-white',
              failed ? 'bg-destructive' : allDone ? 'bg-emerald-500' : 'bg-primary',
            )}>
              {failed ? <IconWarn className="size-5" /> : <IconCheckCircle className="size-5" />}
            </div>
            <b className="text-[14px]">{failed ? '未完成' : allDone ? '全部完成' : '正在处理'}</b>
            <span className="text-[12px] leading-[1.5] text-muted-foreground">
              {failed ? (focus?.message ?? '任务未完成') : allDone ? `文件已成功${LABEL[kind].verb}到指定目录` : '请稍候，完成后会显示结果'}
            </span>
          </div>
        </div>
      </div>

      {/* 完成后底部：图标操作（打开目标文件夹 / 打开文件位置 / 完成） */}
      {allSettled && (
        <footer className="flex h-[64px] shrink-0 items-center gap-1.5 border-t border-border/70 px-5">
          <button className="grid size-9 place-items-center rounded-lg border border-border/80 bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-[var(--bg-active)] disabled:cursor-default disabled:opacity-40"
            title="打开文件夹" disabled={!folderPath} onClick={() => folderPath && void window.tz.openPath(folderPath)}>
            <IconFolderOpen className="size-[17px]" />
          </button>
          <button className="grid size-9 place-items-center rounded-lg border border-border/80 bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-[var(--bg-active)] disabled:cursor-default disabled:opacity-40"
            title="打开文件位置" disabled={!filePath} onClick={() => filePath && void window.tz.revealInExplorer(filePath)}>
            <IconReveal className="size-[17px]" />
          </button>
          <div className="ml-auto">
            <button className={cn(
              'grid size-9 place-items-center rounded-lg text-white transition-colors active:scale-[.97]',
              failed ? 'bg-destructive hover:bg-destructive/90' : 'bg-primary hover:bg-primary/90',
            )} title={failed ? '关闭' : '完成'} onClick={() => window.tz.winClose()}>
              {failed ? <IconClose className="size-[17px]" /> : <IconCheckCircle className="size-[17px]" />}
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}
