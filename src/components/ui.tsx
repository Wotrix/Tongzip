/**
 * 基础 UI 层:Modal、Toast、任务中枢(TaskHub)、右键菜单
 * 任务中心浮层不在此渲染 — 由 TitleBar/TaskCenter 消费 hub。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { JobKind, ProgressEvent } from '@shared/types';
import { IconClose, IconInfo, IconWarn } from './icons';
import { cn } from '@/lib/utils';

/* ---------------- Modal ---------------- */

export function Modal({ title, icon, onClose, children, width }: {
  title: string; icon?: ReactNode; onClose: () => void; children: ReactNode; width?: number;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="app-nodrag fixed inset-0 z-90 flex items-center justify-center bg-[rgba(24,28,32,.32)] animate-[fadein_.12s_ease-out] dark:bg-[rgba(0,0,0,.5)]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="max-h-[calc(100vh-70px)] w-[min(640px,calc(100vw-60px))] overflow-auto rounded-xl border border-border bg-popover p-[22px_24px] text-popover-foreground shadow-[var(--shadow-sheet)] animate-[rise_.14s_ease-out]" style={width ? { width: `min(${width}px, calc(100vw - 60px))` } : undefined}>
        <h2 className="mb-[18px] flex items-center gap-2.5 text-[15px] font-semibold [&_svg]:size-[18px] [&_svg]:text-primary">{icon}{title}</h2>
        {children}
      </div>
    </div>
  );
}

/* ---------------- Toast ---------------- */

export interface ToastItem { id: number; text: string; kind: 'ok' | 'err' | 'info'; }
type PushToast = (text: string, kind?: ToastItem['kind']) => void;

const ToastCtx = createContext<PushToast>(() => undefined);
export const useToast = (): PushToast => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback<PushToast>((text, kind = 'ok') => {
    const id = ++seq.current;
    setItems((v) => [...v, { id, text, kind }]);
    setTimeout(() => setItems((v) => v.filter((t) => t.id !== id)), kind === 'err' ? 4200 : 2600);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="app-nodrag pointer-events-none fixed bottom-[26px] left-1/2 z-120 flex -translate-x-1/2 flex-col items-center gap-2">
        {items.map((t) => (
          <div key={t.id} className={cn(
            'flex max-w-[520px] items-center gap-[9px] rounded-lg border border-border bg-popover px-[15px] py-[9px] text-xs text-popover-foreground shadow-[var(--shadow-float)] animate-[rise_.16s_ease-out]',
            '[&_svg]:size-[15px] [&_svg]:shrink-0',
            t.kind === 'ok' && '[&_svg]:text-primary',
            t.kind === 'err' && 'border-[color-mix(in_srgb,var(--destructive)_45%,var(--border))] [&_svg]:text-destructive',
            t.kind === 'info' && '[&_svg]:text-muted-foreground',
          )}>
            {t.kind === 'err' ? <IconWarn /> : <IconInfo />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------------- 任务中枢 ---------------- */

export interface TrackedJob {
  taskId: string;
  kind: JobKind;
  percent: number;
  file: string;
  status: ProgressEvent['status'];
  message?: string;
  /** 机读错误码(ERR.*),供 UI 精确判断 NEED_PASSWORD 等场景,不依赖文案 */
  code?: string;
  /** 展示名(压缩包/输出文件名) */
  label: string;
  /** 压缩包完整路径(压缩=输出,解压/测试/删除=源包),供「打开文件位置」定位 */
  path?: string;
  /** 换算速度用的总字节提示(如压缩包物理大小) */
  totalBytes?: number;
  startedAt: number;
  updatedAt: number;
  /** 采样序列,用于速度/剩余时间估算 */
  samples: { t: number; p: number }[];
}

export interface DoneJob {
  taskId: string;
  kind: JobKind;
  label: string;
  /** 压缩包完整路径,同 TrackedJob.path */
  path?: string;
  status: 'done' | 'error' | 'cancelled';
  message?: string;
  /** 机读错误码,同 TrackedJob.code */
  code?: string;
  at: number;
}

interface TaskHubValue {
  jobs: TrackedJob[];
  history: DoneJob[];
  track(taskId: string, kind: JobKind, onSettled?: (j: TrackedJob) => void, meta?: { label?: string; path?: string; totalBytes?: number }): void;
  clearHistory(): void;
}
const TaskHubCtx = createContext<TaskHubValue>({ jobs: [], history: [], track: () => undefined, clearHistory: () => undefined });
export const useTaskHub = () => useContext(TaskHubCtx);

/** @deprecated 旧命名兼容 */
export const useProgressHub = useTaskHub;

export function TaskHubProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<TrackedJob[]>([]);
  const [history, setHistory] = useState<DoneJob[]>([]);
  const settled = useRef(new Map<string, (j: TrackedJob) => void>());
  const meta = useRef(new Map<string, { label?: string; path?: string; totalBytes?: number }>());
  /* 终态事件比 track() 先到(快任务的竞态):暂存事件,track 注册 meta 后补处理,否则 label/path/回调全丢 */
  const deferred = useRef(new Map<string, ProgressEvent>());

  /** 终态统一处理:更新卡、回调、写历史、5s 后收起。只依赖 setState/ref,可被 effect 与 track 共用 */
  const finalize = (ev: ProgressEvent) => {
    setJobs((prev) => prev.map((j) => j.taskId === ev.taskId
      ? { ...j, status: ev.status, message: ev.message ?? j.message, code: ev.code ?? j.code, percent: ev.status === 'done' ? 100 : j.percent, updatedAt: Date.now() }
      : j));
    const m = meta.current.get(ev.taskId);
    const j = { taskId: ev.taskId, kind: ev.kind, label: m?.label ?? '', path: m?.path };
    settled.current.get(ev.taskId)?.({
      ...j, percent: ev.percent, file: ev.file, status: ev.status, message: ev.message, code: ev.code,
      startedAt: 0, updatedAt: 0, samples: [],
    });
    settled.current.delete(ev.taskId);
    setHistory((prev) => [{
      ...j,
      status: ev.status === 'running' ? 'done' : ev.status,
      message: ev.message,
      code: ev.code,
      at: Date.now(),
    }, ...prev].slice(0, 14));
    // 终态任务卡片 5s 后从"进行中"列表收起(历史保留)
    setTimeout(() => setJobs((prev) => prev.filter((x) => x.taskId !== ev.taskId)), 5000);
    meta.current.delete(ev.taskId);
  };
  const finalizeRef = useRef(finalize);
  finalizeRef.current = finalize;

  useEffect(() => {
    const off = window.tz.onProgress((ev) => {
      if (ev.status === 'running') {
        setJobs((prev) => {
          const m = meta.current.get(ev.taskId) ?? {};
          const i = prev.findIndex((j) => j.taskId === ev.taskId);
          const now = Date.now();
          const job: TrackedJob = {
            taskId: ev.taskId, kind: ev.kind, percent: ev.percent, file: ev.file, status: 'running',
            label: m.label ?? ev.file ?? '', path: m.path, totalBytes: m.totalBytes,
            startedAt: i < 0 ? now : prev[i].startedAt, updatedAt: now,
            samples: i < 0 ? [{ t: now, p: Math.max(ev.percent, 0) }]
              : [...(prev[i].samples.at(-1)?.p !== ev.percent ? prev[i].samples : prev[i].samples.slice(0, -1)), { t: now, p: Math.max(ev.percent, 0) }].slice(-24),
          };
          if (i < 0) return [...prev, job];
          const next = [...prev];
          next[i] = job;
          return next;
        });
      } else if (!meta.current.has(ev.taskId) && !settled.current.has(ev.taskId)) {
        // track() 尚未注册这个任务:暂存终态事件,等 track 里补账;2s 内没等到则照常收尾(防卡片永挂)
        deferred.current.set(ev.taskId, ev);
        setTimeout(() => {
          if (deferred.current.get(ev.taskId) === ev) { deferred.current.delete(ev.taskId); finalizeRef.current(ev); }
        }, 2000);
      } else {
        finalizeRef.current(ev);
      }
    });
    return off;
  }, []);

  const track = useCallback<TaskHubValue['track']>((taskId, kind, onSettled, m) => {
    meta.current.set(taskId, { label: m?.label, path: m?.path, totalBytes: m?.totalBytes ?? undefined });
    if (onSettled) settled.current.set(taskId, onSettled);
    setJobs((prev) => prev.some((j) => j.taskId === taskId)
      ? prev
      : [...prev, {
        taskId, kind, percent: 0, file: '', status: 'running',
        label: m?.label ?? '', path: m?.path, totalBytes: m?.totalBytes,
        startedAt: Date.now(), updatedAt: Date.now(), samples: [{ t: Date.now(), p: 0 }],
      }]);
    // 补账:终态事件先到的快任务,现在 meta/回调已就位,重新走一遍收尾
    const d = deferred.current.get(taskId);
    if (d) { deferred.current.delete(taskId); finalizeRef.current(d); }
  }, []);

  const clearHistory = useCallback(() => setHistory([]), []);

  return (
    <TaskHubCtx.Provider value={{ jobs, history, track, clearHistory }}>
      {children}
    </TaskHubCtx.Provider>
  );
}

/* ---------------- 右键菜单 ---------------- */

export interface CtxItem {
  label: string;
  icon?: ReactNode;
  kbd?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick?(): void;
  /** 分隔线用:只渲染 sep */
  sep?: boolean;
}

export function ContextMenu({ x, y, items, onClose }: {
  x: number; y: number; items: CtxItem[]; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', h, true);
    window.addEventListener('keydown', k);
    return () => { window.removeEventListener('mousedown', h, true); window.removeEventListener('keydown', k); };
  }, [onClose]);
  // 防溢出:贴近视口时回拉
  const left = Math.min(x, window.innerWidth - 210);
  const top = Math.min(y, window.innerHeight - items.length * 33 - 20);
  return (
    <div ref={ref} className={cn(
      'app-nodrag fixed z-80 min-w-[202px] rounded-lg border p-[5px]',
      'border-[var(--mica-line)] bg-[var(--mica-bg)] shadow-[var(--shadow-mica)]',
      'backdrop-blur-[30px] [backdrop-filter:blur(30px)_saturate(1.6)]',
    )} style={{ left, top }}>
      {items.map((it, i) => it.sep
        ? <div key={i} className="mx-2 my-[5px] h-px bg-border" />
        : (
          <button key={i} disabled={it.disabled}
            className={cn(
              'flex h-8 w-full items-center gap-2.5 rounded px-2.5 pr-2.5 text-left text-[12.5px] text-popover-foreground',
              'hover:bg-accent active:bg-primary/10 disabled:cursor-default disabled:text-muted-foreground disabled:hover:bg-transparent',
              it.danger && 'text-destructive hover:bg-[#fbeeec] dark:hover:bg-[#3a2622]',
            )}
            onClick={() => { onClose(); it.onClick?.(); }}>
            <span className={cn('inline-flex size-4 shrink-0 items-center justify-center [&_svg]:size-4 [&_svg]:opacity-90', it.danger ? 'text-destructive [&_svg]:opacity-100' : 'text-muted-foreground')}>{it.icon}</span>
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{it.label}</span>
            {it.kbd && <span className="ml-auto pl-[18px] text-[11.5px] text-muted-foreground">{it.kbd}</span>}
          </button>
        ))}
    </div>
  );
}
