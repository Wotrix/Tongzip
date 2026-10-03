/**
 * 基础 UI 层:Modal、Toast、任务中枢(TaskHub)、右键菜单
 * 任务中心浮层不在此渲染 — 由 TitleBar/TaskCenter 消费 hub。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { JobKind, ProgressEvent } from '@shared/types';
import { IconClose, IconInfo, IconWarn } from './icons';

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
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" style={width ? { width: `min(${width}px, calc(100vw - 60px))` } : undefined}>
        <h2>{icon}{title}</h2>
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
      <div className="toasts">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === 'err' ? <IconWarn className="ti" /> : <IconInfo className="ti" />}
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
  /** 展示名(压缩包/输出文件名) */
  label: string;
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
  status: 'done' | 'error' | 'cancelled';
  message?: string;
  at: number;
}

interface TaskHubValue {
  jobs: TrackedJob[];
  history: DoneJob[];
  track(taskId: string, kind: JobKind, onSettled?: (j: TrackedJob) => void, meta?: { label?: string; totalBytes?: number }): void;
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
  const meta = useRef(new Map<string, { label?: string; totalBytes?: number }>());

  useEffect(() => {
    const off = window.tz.onProgress((ev) => {
      if (ev.status === 'running') {
        setJobs((prev) => {
          const m = meta.current.get(ev.taskId) ?? {};
          const i = prev.findIndex((j) => j.taskId === ev.taskId);
          const now = Date.now();
          const job: TrackedJob = {
            taskId: ev.taskId, kind: ev.kind, percent: ev.percent, file: ev.file, status: 'running',
            label: m.label ?? ev.file ?? '', totalBytes: m.totalBytes,
            startedAt: i < 0 ? now : prev[i].startedAt, updatedAt: now,
            samples: i < 0 ? [{ t: now, p: Math.max(ev.percent, 0) }]
              : [...(prev[i].samples.at(-1)?.p !== ev.percent ? prev[i].samples : prev[i].samples.slice(0, -1)), { t: now, p: Math.max(ev.percent, 0) }].slice(-24),
          };
          if (i < 0) return [...prev, job];
          const next = [...prev];
          next[i] = job;
          return next;
        });
      } else {
        setJobs((prev) => prev.map((j) => j.taskId === ev.taskId
          ? { ...j, status: ev.status, message: ev.message ?? j.message, percent: ev.status === 'done' ? 100 : j.percent, updatedAt: Date.now() }
          : j));
        const j = { taskId: ev.taskId, kind: ev.kind, label: meta.current.get(ev.taskId)?.label ?? '' };
        settled.current.get(ev.taskId)?.({
          ...j, percent: ev.percent, file: ev.file, status: ev.status, message: ev.message,
          startedAt: 0, updatedAt: 0, samples: [],
        });
        settled.current.delete(ev.taskId);
        setHistory((prev) => [{
          ...j,
          status: ev.status === 'running' ? 'done' : ev.status,
          message: ev.message,
          at: Date.now(),
        }, ...prev].slice(0, 14));
        // 终态任务卡片 5s 后从"进行中"列表收起(历史保留)
        setTimeout(() => setJobs((prev) => prev.filter((x) => x.taskId !== ev.taskId)), 5000);
        meta.current.delete(ev.taskId);
      }
    });
    return off;
  }, []);

  const track = useCallback<TaskHubValue['track']>((taskId, kind, onSettled, m) => {
    meta.current.set(taskId, { label: m?.label, totalBytes: m?.totalBytes ?? undefined });
    if (onSettled) settled.current.set(taskId, onSettled);
    setJobs((prev) => prev.some((j) => j.taskId === taskId)
      ? prev
      : [...prev, {
        taskId, kind, percent: 0, file: '', status: 'running',
        label: m?.label ?? '', totalBytes: m?.totalBytes,
        startedAt: Date.now(), updatedAt: Date.now(), samples: [{ t: Date.now(), p: 0 }],
      }]);
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
    <div ref={ref} className="ctx-menu" style={{ left, top }}>
      {items.map((it, i) => it.sep
        ? <div key={i} className="ctx-sep" />
        : (
          <button key={i} className={`ctx-item ${it.danger ? 'danger' : ''}`} disabled={it.disabled}
            onClick={() => { onClose(); it.onClick?.(); }}>
            <span className="ctx-ico">{it.icon}</span>
            <span className="ctx-label">{it.label}</span>
            {it.kbd && <span className="ctx-kbd">{it.kbd}</span>}
          </button>
        ))}
    </div>
  );
}
