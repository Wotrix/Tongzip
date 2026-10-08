/**
 * 左侧导航栏 — shadcn 风:品牌块 · 主导航(active 染 primary 圆角 pill)· 底部版本号
 * 折叠态:宽/内边距/右边框一并过渡归零(注意 border 宽度计入 computed width,必须显式归零)
 * 宽度可自由拖动(SB_MIN–SB_MAX,双击手柄回默认 SB_DEFAULT 156):
 *   拖动中本地 dragW 每帧跟手(实时变宽,不弹回、不钳成下限),松手才 onResize 持久化
 * 拖到最小(松手 <SB_MIN=132px)不弹回原形,而是收起为 36px 竖条(collapsed):可点按唤回,
 *   也可从竖条手柄继续拖——拖程中实时预览面板宽度,拖过 96px 即拉回完整侧栏
 * 手柄:12px 命中区 + 常驻可见分隔线(hover/拖动染品牌色),不再只在 hover 才显形
 */
import { useRef } from 'react';
import { IconHome, IconClock, IconArchive, IconTasks, IconSettings, IconFolderOpen, IconChevronRight } from './icons';
import AppLogo from './AppLogo';
import { PanelHandle, usePanelDrag } from './ui';
import { cn } from '@/lib/utils';
import { version as appVersion } from '../../package.json';

export type View = 'home' | 'recent' | 'archives' | 'tasks' | 'settings' | 'browse';

const NAV: { v: View; label: string; icon: typeof IconHome }[] = [
  { v: 'home', label: '首页', icon: IconHome },
  { v: 'recent', label: '最近文件', icon: IconClock },
  { v: 'archives', label: '我的压缩包', icon: IconArchive },
  { v: 'tasks', label: '任务中心', icon: IconTasks },
  { v: 'settings', label: '设置', icon: IconSettings },
];

/** 可拖宽度:默认/双击复位值(取下限档)、下限=收起阈值、上限给足自由拖的空间(旧 260 太局促) */
export const SB_DEFAULT = 156;
export const SB_MIN = 132;
export const SB_MAX = 480;
/** 收起态竖条宽 */
const RAIL_W = 36;
/** 从竖条往回拖时,预览为完整面板的宽度门槛(低于此只显示竖条) */
const PULL_BACK_W = 96;

const clampW = (w: number) => Math.min(SB_MAX, Math.max(SB_MIN, Math.round(w) || SB_MIN));

export default function Sidebar({ view, onNav, runningCount, activeArchive, hidden = false, collapsed = false, onExpand, width = SB_DEFAULT, onResize, onCollapse }: {
  view: View;
  onNav: (v: View) => void;
  runningCount: number;
  /** 已打开的压缩包名:额外渲染一个「正在浏览」入口 */
  activeArchive: string | null;
  /** 冷启动专注隐藏:宽度收 0(由浏览工具栏唤回);与 collapsed 同真时退化为竖条(保恢复入口) */
  hidden?: boolean;
  /** 拖到最小后的收起态:36px 竖条 */
  collapsed?: boolean;
  /** 竖条点按唤回 */
  onExpand?: () => void;
  /** 当前宽度(px),由 Shell 自设置持久化而来 */
  width?: number;
  /** 拖动结束/双击复位时提交新宽度(已由本组件 clamp 到 SB_MIN–SB_MAX) */
  onResize?: (w: number) => void;
  /** 松手宽度低于收起阈值 */
  onCollapse?: () => void;
}) {
  /* 拖动中的实时宽度:null=未拖,用 props.width 单一真相;
     window 级监听(见 usePanelDrag)保证竖条→面板分支切换时手势不断,拖程中宽度实时跟手 */
  const fromRail = useRef(false); // 竖条手柄起拖:基准宽=36;面板手柄:基准宽=当前持久宽
  const { dragW, start } = usePanelDrag({
    min: RAIL_W,
    max: SB_MAX,
    base: () => (fromRail.current ? RAIL_W : width),
    commit: (w) => {
      fromRail.current = false;
      /* 拖到最小不弹回原形:低于阈值直接收起为竖条 */
      if (w < SB_MIN) { if (!collapsed) onCollapse?.(); return; }
      if (collapsed) onExpand?.(); // 从竖条拖回:先展开再落地新宽
      onResize?.(clampW(w));
    },
  });
  const dragging = dragW !== null;
  const shownW = dragW ?? width;
  const startPanel = (e: React.PointerEvent) => { if (hidden) return; fromRail.current = false; start(e); };
  const startRail = (e: React.PointerEvent) => { fromRail.current = true; start(e); };
  /* 收起态:未拖或还没拖过预览门槛时只显示 36px 竖条;拖过门槛则落到下方面板实时预览宽度 */
  if (collapsed && (!dragging || shownW < PULL_BACK_W)) {
    return (
      <nav className="relative flex w-9 shrink-0 flex-col items-center border-r border-border bg-secondary py-1.5">
        <button className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-[var(--bg-active)]"
          title="展开侧边栏 (Alt+B)" onClick={() => onExpand?.()}>
          <IconChevronRight className="size-[15px]" />
        </button>
        <PanelHandle title="拖拽唤回侧边栏 · 双击展开" onPointerDown={startRail} onDoubleClick={() => onExpand?.()} live={dragging} />
      </nav>
    );
  }
  return (
    <nav
      className={cn(
        'relative flex shrink-0 flex-col gap-2.5 overflow-hidden border-border bg-secondary',
        'border-r px-2 pt-2.5 pb-2',
        /* 拖动中关掉宽度过渡,手柄才跟手;折叠动画仍走 transition */
        !dragging && 'transition-[width,padding,border-right-width] duration-150 ease-out',
        dragging && 'select-none',
        hidden && 'pointer-events-none border-r-0 px-0',
      )}
      style={{ width: hidden ? 0 : shownW }}
    >
      {/* 右缘拖宽手柄:常驻可见把手 + 12px 命中区;hidden 态随 w-0 被 overflow 裁掉 */}
      <PanelHandle onPointerDown={startPanel} live={dragging}
        onDoubleClick={() => { if (!hidden) onResize?.(SB_DEFAULT); }} />
      <div
        className={cn('flex items-center gap-2.5 px-1.5 pt-0.5 text-[14.5px] transition-opacity duration-100',
          hidden && 'pointer-events-none opacity-0')}
        onDoubleClick={() => onNav('home')}
      >
        <AppLogo className="size-[30px]" />
        <b className="font-bold tracking-[.01em]">TongZip</b>
      </div>

      <div className={cn('flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto transition-opacity duration-100',
        hidden && 'pointer-events-none opacity-0')}>
        {NAV.map(({ v, label, icon: Ico }) => (
          <button key={v} onClick={() => onNav(v)}
            className={cn(
              'flex h-8 items-center gap-2 rounded-lg px-2 text-left text-[13px]',
              'text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-[var(--bg-active)]',
              view === v && 'relative bg-primary/[.12] font-semibold text-primary hover:bg-primary/[.12] active:bg-primary/20 before:absolute before:left-0 before:top-1/2 before:h-4 before:w-[3px] before:-translate-y-1/2 before:rounded-r-full before:bg-primary',
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
            'text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-[var(--bg-active)]',
            view === 'browse' && 'relative border-transparent bg-primary/[.12] font-semibold text-primary hover:bg-primary/[.12] active:bg-primary/20 before:absolute before:left-0 before:top-1/2 before:h-4 before:w-[3px] before:-translate-y-1/2 before:rounded-r-full before:bg-primary',
          )} onClick={() => onNav('browse')} title={activeArchive}>
            <IconFolderOpen className="size-[17px] shrink-0" />
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{activeArchive}</span>
          </button>
        )}
      </div>

      <div className={cn('text-center text-[11px] tracking-[.12em] text-muted-foreground transition-opacity duration-100',
        hidden && 'pointer-events-none opacity-0')}>
        v{appVersion}
      </div>
    </nav>
  );
}
