/**
 * 左侧导航栏 — shadcn 风:品牌块 · 主导航(active 染 primary 圆角 pill)· 底部标语
 * 折叠态:宽/内边距/右边框一并过渡归零(注意 border 宽度计入 computed width,必须显式归零)
 * 宽度可拖(156–260,双击手柄回默认 156):拖动中用本地 dragW 避免每帧写设置,松手才 onResize 持久化
 */
import { useState } from 'react';
import { Logo, IconHome, IconClock, IconArchive, IconTasks, IconSettings, IconFolderOpen } from './icons';
import { cn } from '@/lib/utils';

export type View = 'home' | 'recent' | 'archives' | 'tasks' | 'settings' | 'browse';

const NAV: { v: View; label: string; icon: typeof IconHome }[] = [
  { v: 'home', label: '首页', icon: IconHome },
  { v: 'recent', label: '最近文件', icon: IconClock },
  { v: 'archives', label: '我的压缩包', icon: IconArchive },
  { v: 'tasks', label: '任务中心', icon: IconTasks },
  { v: 'settings', label: '设置', icon: IconSettings },
];

export default function Sidebar({ view, onNav, runningCount, activeArchive, hidden = false, width = 156, onResize }: {
  view: View;
  onNav: (v: View) => void;
  runningCount: number;
  /** 已打开的压缩包名:额外渲染一个「正在浏览」入口 */
  activeArchive: string | null;
  /** 折叠态:宽度收 0,冷启动双击打开压缩包时默认隐藏,可由浏览工具栏唤回 */
  hidden?: boolean;
  /** 当前宽度(px),由 Shell 自设置持久化而来 */
  width?: number;
  /** 拖动结束/双击复位时提交新宽度(已由本组件 clamp 到 156–260) */
  onResize?: (w: number) => void;
}) {
  const clampW = (w: number) => Math.min(260, Math.max(156, Math.round(w) || 156));
  /* 拖动中的临时宽度:null=未拖,用 props.width 单一真相 */
  const [dragW, setDragW] = useState<number | null>(null);
  const startDrag = (e: React.PointerEvent) => {
    if (hidden) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = dragW ?? width;
    const move = (ev: PointerEvent) => setDragW(clampW(startW + ev.clientX - startX));
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setDragW(null);
      onResize?.(clampW(startW + ev.clientX - startX));
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const shownW = hidden ? 0 : (dragW ?? width);
  return (
    <nav
      className={cn(
        'relative flex shrink-0 flex-col gap-2.5 overflow-hidden border-border bg-secondary',
        'border-r px-2 pt-2.5 pb-2',
        /* 拖动中关掉宽度过渡,手柄才跟手;折叠动画仍走 transition */
        dragW === null && 'transition-[width,padding,border-right-width] duration-150 ease-out',
        dragW !== null && 'select-none',
        hidden && 'pointer-events-none border-r-0 px-0',
      )}
      style={{ width: shownW }}
    >
      {/* 右缘拖宽手柄:与列表列手柄同款视觉;hidden 态随 w-0 被 overflow 裁掉 */}
      <span
        aria-hidden
        title="拖拽调整宽度 · 双击恢复默认"
        onPointerDown={startDrag}
        onDoubleClick={() => { if (!hidden) onResize?.(156); }}
        className={cn(
          'absolute inset-y-0 right-0 z-20 w-[9px] cursor-col-resize touch-none',
          'after:absolute after:inset-y-2 after:right-0 after:w-[2px] after:rounded-full after:bg-transparent',
          'after:transition-colors hover:after:bg-primary/40 active:after:bg-primary/60',
        )}
      />
      <div
        className={cn('flex items-center gap-2.5 px-1.5 pt-0.5 text-[14.5px] transition-opacity duration-100',
          hidden && 'pointer-events-none opacity-0')}
        onDoubleClick={() => onNav('home')}
      >
        <span className="flex size-[28px] shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Logo className="size-[17px]" />
        </span>
        <b className="font-bold tracking-[.01em]">TongZip</b>
      </div>

      <div className={cn('flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto transition-opacity duration-100',
        hidden && 'pointer-events-none opacity-0')}>
        {NAV.map(({ v, label, icon: Ico }) => (
          <button key={v} onClick={() => onNav(v)}
            className={cn(
              'flex h-8 items-center gap-2 rounded-lg px-2 text-left text-[13px]',
              'text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
              view === v && 'bg-primary/10 font-semibold text-primary',
            )}>
            <Ico className="size-[17px] shrink-0" />
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
            {v === 'tasks' && runningCount > 0 && (
              <em className="ml-auto min-w-[17px] rounded-full bg-primary px-[5px] text-center text-[10.5px] font-bold not-italic leading-[17px] text-primary-foreground">
                {runningCount}
              </em>
            )}
          </button>
        ))}
        {activeArchive && (
          <button className={cn(
            'mt-1.5 flex h-8 items-center gap-2 rounded-lg border border-dashed border-border px-2 text-left text-xs',
            'text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
            view === 'browse' && 'border-transparent bg-primary/10 font-semibold text-primary',
          )} onClick={() => onNav('browse')} title={activeArchive}>
            <IconFolderOpen className="size-[17px] shrink-0" />
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{activeArchive}</span>
          </button>
        )}
      </div>

      <div className={cn('text-center text-[11px] tracking-[.12em] text-muted-foreground transition-opacity duration-100',
        hidden && 'pointer-events-none opacity-0')}>
        更简单 · 更高效
      </div>
    </nav>
  );
}
