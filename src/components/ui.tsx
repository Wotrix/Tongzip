/**
 * 基础 UI 层:Modal、Toast、任务中枢(TaskHub)、右键菜单、可拖面板手柄
 * 任务中心浮层不在此渲染 — 由 TitleBar/TaskCenter 消费 hub。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { JobKind, ProgressEvent } from '@shared/types';
import { IconClose, IconInfo, IconWarn } from './icons';
import { cn } from '@/lib/utils';

/* ---------------- Modal ---------------- */

/** 关闭信号:对话框内所有「取消/完成/关闭」统一走它(而非直接 onClose),
   以便播放退场动画并清除焦点残留。 */
const ModalCloseCtx = createContext<() => void>(() => undefined);
export const useModalClose = () => useContext(ModalCloseCtx);

export function Modal({ title, icon, onClose, children, width }: {
  title: string; icon?: ReactNode; onClose: () => void; children: ReactNode; width?: number;
}) {
  // 关闭:先清焦点(消除输入框 ring / :focus-visible 描边 / 按压面残留高亮),
  // 再同步卸载对话框 — 不设延迟/退场态,任何路径的关闭都是一击即关,绝不会被卡住。
  const close = useCallback(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    onClose();
  }, [onClose]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [close]);

  return (
    <ModalCloseCtx.Provider value={close}>
      <div
        className="app-nodrag fixed inset-0 z-90 flex items-center justify-center bg-black/45 backdrop-blur-[3px] animate-[dlg-in-backdrop_.2s_ease-out]"
        onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
      >
        <div
          className={cn(
            'flex max-h-[calc(100vh-70px)] w-[min(640px,calc(100vw-60px))] flex-col overflow-hidden',
            'rounded-[16px] border border-border/50 bg-card/95 text-card-foreground shadow-[var(--shadow-modal)] backdrop-blur-md',
            'animate-[dlg-in-panel_.24s_cubic-bezier(.22,1,.36,1)]',
          )}
          style={width ? { width: `min(${width}px, calc(100vw - 60px))` } : undefined}
        >
          <header className="flex shrink-0 items-center gap-2.5 px-6 pb-3 pt-5">
            {icon && <span className="[&_svg]:size-[18px] [&_svg]:text-primary">{icon}</span>}
            <h2 className="text-[15px] font-semibold">{title}</h2>
            <button
              type="button" onClick={close} aria-label="关闭"
              className="ml-auto -mr-2 flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-[background,color,transform] hover:bg-accent hover:text-foreground active:scale-90 focus-visible:outline-none"
            >
              <IconClose className="size-[15px]" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-auto px-6 pb-5">{children}</div>
        </div>
      </div>
    </ModalCloseCtx.Provider>
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
  /** interrupted=上次会话运行中被中断(3.4 恢复状态机标记,绝不按成功/失败猜);
   *  retryable=上次排队任务重启且源文件校验通过,等待手动重发 */
  status: 'done' | 'error' | 'cancelled' | 'interrupted' | 'retryable';
  message?: string;
  /** 机读错误码,同 TrackedJob.code */
  code?: string;
  at: number;
  /** 3.4:中断任务的归档曾被事务 journal 回滚(结果由事务判定,非引擎完成) */
  txnRolledBack?: boolean;
}

interface TaskHubValue {
  jobs: TrackedJob[];
  history: DoneJob[];
  track(taskId: string, kind: JobKind, onSettled?: (j: TrackedJob) => void, meta?: { label?: string; path?: string; totalBytes?: number }): void;
  clearHistory(): void;
  removeHistory(taskId: string): void;
}
const TaskHubCtx = createContext<TaskHubValue>({ jobs: [], history: [], track: () => undefined, clearHistory: () => undefined, removeHistory: () => undefined });
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
    /* 跨会话历史 hydrate(3.4):主进程已完成恢复状态机映射(running→interrupted 等),
     * 渲染层只展示不判定;同 taskId 以本会话事件为准,持久化记录补缺 */
    void window.tz.historyGet?.().then((list) => {
      if (!list?.length) return;
      setHistory((prev) => {
        const restored: DoneJob[] = list.map((t) => ({
          taskId: t.id, kind: t.kind,
          label: t.label || (t.src || t.out || '').replace(/^.*[\\/]/, ''),
          /* 压缩任务没有 src(源清单在主进程不掌握),产物在 out;恢复时取 src ?? out,
             否则重启后「最近任务」缺 path,悬停打开位置图标不渲染、右键项被禁用 */
          path: t.src ?? t.out, status: t.status === 'retryable' || t.status === 'interrupted' ? t.status
            : t.status === 'done' ? 'done' as const : 'error' as const,
          code: t.errCode, at: t.finishedAt ?? t.createdAt, txnRolledBack: t.txnRolledBack,
        })).filter((h) => !prev.some((p) => p.taskId === h.taskId));
        return [...prev, ...restored].sort((a, b) => b.at - a.at).slice(0, 14);
      });
    });
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

  /* 清空渲染层历史同时清主进程持久化历史(3.4),否则重启后旧记录复活 */
  const clearHistory = useCallback(() => {
    setHistory([]);
    void window.tz.historyClear?.();
  }, []);

  /* 单条历史移除:渲染层即时收起,主进程同步落盘,避免重启后复活 */
  const removeHistory = useCallback((taskId: string) => {
    setHistory((prev) => prev.filter((h) => h.taskId !== taskId));
    void window.tz.historyRemove?.(taskId);
  }, []);

  return (
    <TaskHubCtx.Provider value={{ jobs, history, track, clearHistory, removeHistory }}>
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

/* ---------------- 可拖面板手柄 ---------------- */

/**
 * 越界橡皮筋钳位:界内 1:1 完全跟手;越界后按 0.2 阻尼递减,
 * 手感是“有弹性的软边界”而非撞墙卡死;提交前上层再硬钳回界内。
 */
export function rubberClamp(w: number, min: number, max: number): number {
  if (w < min) return min - (min - w) * 0.2;
  if (w > max) return max + (w - max) * 0.2;
  return w;
}

/**
 * 拖宽手势:监听挂在 window 而非手柄元素——收起↔展开分支切换会替换手柄 DOM,
 * 元素级 setPointerCapture 会随手柄卸载丢手势(表现为“拖不动”);
 * 拖动中每帧回写本地 dragW(宽度实时跟手,越界走橡皮筋),松手才 commit 交给上层持久化。
 * min 取收起阈值以下的地板(如竖条 36),是否收起由 commit 自己判断。
 */
export function usePanelDrag(opt: { min: number; max: number; base: () => number; commit: (w: number) => void }) {
  const ref = useRef(opt);
  ref.current = opt; // 始终读最新闭包,监听器无需随 props 变化重建
  const [dragW, setDragW] = useState<number | null>(null);
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const base0 = ref.current.base();
    const at = (cx: number) => {
      const { min, max } = ref.current;
      return Math.round(rubberClamp(base0 + cx - startX, min, max)) || min;
    };
    const move = (ev: PointerEvent) => setDragW(at(ev.clientX));
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setDragW(null);
      ref.current.commit(at(ev.clientX));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    setDragW(at(e.clientX));
  };
  return { dragW, start };
}

/**
 * 面板右缘拖宽手柄:12px 命中区(够宽才瞄得准)
 * 静止时不留常驻把手(避免成杂点标志),仅 hover/拖动时显一条通长高亮线作反馈;live=拖动中。
 */
export function PanelHandle({ onPointerDown, onDoubleClick, live, title }: {
  onPointerDown: (e: React.PointerEvent) => void;
  onDoubleClick?: () => void;
  live?: boolean;
  title?: string;
}) {
  return (
    <span aria-hidden
      title={title ?? '拖拽调整宽度(拖到最小可收起) · 双击恢复默认'}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      className="panel-handle group absolute inset-y-0 right-0 z-20 w-[12px] cursor-col-resize touch-none">
      <i className={cn('pointer-events-none absolute inset-y-0 right-0 w-[3px] rounded-full transition-opacity duration-150',
        live ? 'bg-primary/70 opacity-100' : 'opacity-0')} />
    </span>
  );
}
