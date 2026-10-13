/**
 * 任务中心 — 标题栏右上角入口展开的轻量浮层
 * 进行中:进度/速度/剩余时间/暂停·继续/取消;已完成:近期历史。
 * 暂停通过主进程挂起引擎子进程实现,进度会冻结在当前百分点。
 */
import { useState, type MouseEvent } from 'react';
import type { JobKind } from '@shared/types';
import { ContextMenu, useTaskHub, useToast, type DoneJob, type TrackedJob } from './ui';
import { Button } from './ui/button';
import {
  IconClose, IconCompress, IconDelete, IconExtract, IconTest,
  IconCheckCircle, IconWarn, IconClock, IconPause, IconPlay, IconReveal,
} from './icons';
import { fmtBytes } from '../lib/format';
import { cn } from '@/lib/utils';

const KIND_LABEL: Record<JobKind, { run: string; done: string; icon: typeof IconCompress }> = {
  compress: { run: '正在压缩', done: '压缩完成', icon: IconCompress },
  extract: { run: '正在解压', done: '解压完成', icon: IconExtract },
  test: { run: '正在测试', done: '测试完成', icon: IconTest },
  delete: { run: '正在删除', done: '删除完成', icon: IconDelete },
};
export { KIND_LABEL };

/** 基于最近两次采样估算速度(每秒百分点) */
function slope(job: TrackedJob): number | null {
  const s = job.samples;
  if (s.length < 2) return null;
  const last = s[s.length - 1];
  const prev = s[Math.max(0, s.length - 4)]; // ~2s 前的采样
  const dt = (last.t - prev.t) / 1000;
  if (dt < 0.8) return null;
  const dp = last.p - prev.p;
  return dp > 0 ? dp / dt : null;
}

function fmtEta(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '计算中';
  if (sec < 60) return `约 ${Math.round(sec)} 秒`;
  if (sec < 3600) return `约 ${Math.floor(sec / 60)} 分`;
  return `约 ${(sec / 3600).toFixed(1)} 小时`;
}

function fmtAgo(at: number): string {
  const d = Math.max(0, Date.now() - at);
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return new Date(at).toLocaleDateString();
}
export { fmtAgo };

/** 先验存在性再在资源管理器中定位;死链(已删除/移走)时降级为 toast 提醒 */
export function revealArchive(path: string, toast: (text: string, kind?: 'ok' | 'err' | 'info') => void) {
  void window.tz.exists(path).then((ok) => {
    if (ok) void window.tz.revealInExplorer(path);
    else toast('文件已不存在或被移除', 'err');
  });
}

/** 任务卡右键菜单 hook:「打开文件位置」先验存在性再定位;菜单节点与 onContextMenu 绑定一起返回 */
export function useTaskMenu(path?: string) {
  const toast = useToast();
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const menu = anchor && (
    <ContextMenu x={anchor.x} y={anchor.y} onClose={() => setAnchor(null)} items={[
      { label: '打开文件位置', icon: <IconReveal />, disabled: !path, onClick: () => { if (path) revealArchive(path, toast); } },
    ]} />
  );
  const bind = {
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault(); e.stopPropagation();
      setAnchor({ x: e.clientX, y: e.clientY });
    },
  };
  return { menu, bind };
}

export function RunningCard({ job }: { job: TrackedJob }) {
  const meta = KIND_LABEL[job.kind];
  const Icon = meta.icon;
  const toast = useToast();
  const { menu, bind } = useTaskMenu(job.path);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const k = slope(job);
  const etaSec = job.percent >= 0 && k && !paused ? (100 - job.percent) / k : null;
  const speed = k && job.totalBytes && !paused ? (job.totalBytes * k) / 100 : null;
  const done = job.status === 'done';
  const failed = job.status === 'error' || job.status === 'cancelled';
  const running = job.status === 'running';
  const indet = job.percent < 0 && running;
  const togglePause = async () => {
    if (busy) return;
    setBusy(true);
    const r = await window.tz.taskPause(job.taskId);
    if (r.ok) setPaused(r.data);
    setBusy(false);
  };
  return (
    <div className="rounded-lg px-2.5 pt-2.5 pb-[11px] transition-colors hover:bg-muted" {...bind}>
      {menu}
      <div className="flex items-center gap-2 text-[12.5px] font-semibold [&_svg]:size-[15px] [&_svg]:shrink-0">
        {done
          ? <IconCheckCircle className="text-primary" />
          : failed
            ? <IconWarn className="text-destructive" />
            : <Icon className="text-muted-foreground" />}
        <span>{done ? `${meta.done.replace('完成', '')}完成` : failed ? '任务已中断' : paused ? '已暂停' : meta.run}</span>
        <span className="ml-auto flex gap-0.5">
          {/* 终态卡的「打开文件位置」图标钮:运行中不显(压缩输出尚未落盘,点了只会误报不存在) */}
          {!running && job.path && (
            <Button variant="ghost" size="icon-xs" className="size-[26px] rounded-md text-muted-foreground hover:bg-[var(--bg-active)]"
              title="打开文件位置" onClick={() => revealArchive(job.path!, toast)}>
              <IconReveal className="size-3" />
            </Button>
          )}
          {running && (
            <Button variant="ghost" size="icon-xs" className="size-[26px] rounded-md text-muted-foreground" disabled={busy}
              title={paused ? '继续任务' : '暂停任务'} onClick={() => void togglePause()}>
              {paused ? <IconPlay className="size-3" /> : <IconPause className="size-3" />}
            </Button>
          )}
          {running && (
            <Button variant="ghost" size="icon-xs" className="size-[26px] rounded-md text-muted-foreground" title="取消任务"
              onClick={() => void window.tz.cancelTask(job.taskId)}>
              <IconClose className="size-3" />
            </Button>
          )}
        </span>
      </div>
      <div className="mt-[3px] overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px] text-muted-foreground" title={job.label || job.file}>{job.label || job.file}</div>
      {job.message && failed && <div className="mt-[3px] overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px] text-destructive">{job.message}</div>}
      <div className="relative mt-2 h-1 overflow-hidden rounded-[2px] bg-border">
        <i className={cn(
          'block h-full rounded-[2px] bg-primary transition-[width] duration-[250ms] ease-out',
          indet && 'w-[34%] animate-[indet_1.2s_ease-in-out_infinite]',
          failed && 'bg-destructive',
        )} style={{ width: job.percent >= 0 ? `${job.percent}%` : undefined }} />
      </div>
      {/* 数据行:相邻单元格搭配(紫=体量/进度,灰=速率/时间),单元格间 1px 分隔线,对齐用户参考图 */}
      <div className="mt-[6px] flex w-fit divide-x divide-border overflow-hidden rounded-[6px] text-[11.5px] tabular-nums [&>span]:px-2 [&>span]:py-[3px]">
        <span className="bg-primary/[.13] text-foreground">{job.percent >= 0 ? `${job.percent}%` : running ? '进行中' : ''}</span>
        {speed != null && running && <span className="bg-muted text-foreground">{fmtBytes(speed)}/秒</span>}
        {running && !paused && <span className="bg-muted text-foreground">{fmtEta(etaSec)}</span>}
        {paused && running && <span className="bg-primary/[.13] text-[color:var(--warn)]">进度已冻结</span>}
        {job.totalBytes != null && <span className="bg-primary/[.13] text-foreground">{fmtBytes(job.totalBytes)}</span>}
      </div>
    </div>
  );
}

export function HistoryRow({ h, onOpen }: { h: DoneJob; onOpen?: (path: string) => void }) {
  const meta = KIND_LABEL[h.kind];
  /* 3.4 恢复态:中断/可重试不并入失败红——中断结果未知(不假定成败),可重试等待手动重发 */
  const interrupted = h.status === 'interrupted';
  const retryable = h.status === 'retryable';
  const failed = h.status === 'error' || h.status === 'cancelled';
  const Icon = h.status === 'done' ? IconCheckCircle : interrupted || retryable ? IconClock : IconWarn;
  const toast = useToast();
  const { menu, bind } = useTaskMenu(h.path);
  /* 点击行:先验存在性再在标签中打开压缩包(删除类任务的目标已消失,自然降级为 toast) */
  const openable = h.status === 'done' && !!h.path && !!onOpen;
  const openIt = () => {
    if (!openable) return;
    const p = h.path!;
    void window.tz.exists(p).then((ok) => ok ? onOpen!(p) : toast('文件已不存在或被移除', 'err'));
  };
  return (
    <div className={cn(
      'group flex h-[34px] items-center gap-2.5 rounded-lg px-3 text-[12.5px] text-muted-foreground',
      'transition-colors hover:bg-accent active:bg-[var(--bg-active)] [&_svg]:size-[15px] [&_svg]:shrink-0',
      openable && 'cursor-pointer',
      failed && 'text-destructive',
      interrupted && 'text-[color:var(--warn)]',
    )} onClick={openIt} {...bind}
      title={interrupted && h.txnRolledBack ? '上次运行中断;该归档已由事务 journal 回滚到任务前状态' : undefined}>
      {menu}
      <Icon className={h.status === 'done' ? 'text-primary' : failed ? 'text-destructive' : undefined} />
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
        {interrupted ? '上次运行中断' : retryable ? `可重试 · ${meta.done}` : h.label ? `${meta.done} · ${h.label}` : meta.done}
      </span>
      <span className="shrink-0 text-[11.5px] text-muted-foreground group-hover:invisible">{fmtAgo(h.at)}</span>
      {/* 悬停 reveal:行右缘浮现「打开文件位置」图标钮(时间戳隐身让位),内嵌钮悬停面用深一档 --bg-active */}
      {h.path && (
        <button className={cn(
          'hidden h-[22px] w-[24px] shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-muted-foreground',
          'group-hover:flex hover:bg-[var(--bg-active)] hover:text-foreground [&_svg]:size-[13px]',
        )} title="打开文件位置" onClick={(e) => { e.stopPropagation(); revealArchive(h.path!, toast); }}>
          <IconReveal />
        </button>
      )}
    </div>
  );
}

export default function TaskCenter({ onClose, openArchive }: { onClose: () => void; openArchive?: (path: string) => void }) {
  const { jobs, history, clearHistory } = useTaskHub();
  return (
    <>
      <div className="fixed inset-0 z-70" onMouseDown={onClose} />
      <div className="absolute top-[46px] right-[130px] z-80 flex max-h-[calc(100vh-70px)] w-[380px] flex-col overflow-hidden rounded-[10px] border border-border bg-popover text-popover-foreground shadow-[var(--shadow-sheet)]">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3.5 text-[12.5px] font-semibold">
          <IconClock className="size-[15px] text-muted-foreground" />
          任务中心
          <span className="ml-auto text-[11.5px] font-normal text-muted-foreground">{jobs.length ? `${jobs.length} 个进行中` : '无进行中任务'}</span>
        </div>
        <div className="flex flex-col gap-0.5 overflow-auto p-1.5">
          {jobs.length === 0 && history.length === 0 && (
            <div className="py-[26px] text-center text-[12.5px] text-muted-foreground">暂无任务<br />拖入文件即可开始</div>
          )}
          {jobs.length > 0 && <div className="px-2 pt-2 pb-1 text-[11px] uppercase tracking-[.05em] text-muted-foreground">进行中</div>}
          {jobs.map((j) => <RunningCard key={j.taskId} job={j} />)}
          {history.length > 0 && (
            <>
              <div className="flex items-center px-2 pt-2 pb-1 text-[11px] uppercase tracking-[.05em] text-muted-foreground">
                <span className="flex-1">最近完成</span>
                <Button variant="ghost" size="xs" className="h-[22px] px-1.5 text-[11px] font-normal" onClick={clearHistory}>清空</Button>
              </div>
              {/* 打开后收起浮层,焦点交给新标签 */}
              {history.map((h) => <HistoryRow key={h.taskId + h.at} h={h} onOpen={openArchive && ((p) => { openArchive(p); onClose(); })} />)}
            </>
          )}
        </div>
      </div>
    </>
  );
}
