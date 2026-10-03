/**
 * 左侧导航栏 — shadcn 风:品牌块 · 主导航(active 染 primary 圆角 pill)· 底部标语
 * 折叠态:宽/内边距/右边框一并过渡归零(注意 border 宽度计入 computed width,必须显式归零)
 */
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

export default function Sidebar({ view, onNav, runningCount, activeArchive, hidden = false }: {
  view: View;
  onNav: (v: View) => void;
  runningCount: number;
  /** 已打开的压缩包名:额外渲染一个「正在浏览」入口 */
  activeArchive: string | null;
  /** 折叠态:宽度收 0,外部双击打开压缩包时默认隐藏,可由浏览工具栏唤回 */
  hidden?: boolean;
}) {
  return (
    <nav
      className={cn(
        'flex shrink-0 flex-col gap-3.5 overflow-hidden border-border bg-secondary',
        'transition-[width,padding,border-right-width] duration-150 ease-out',
        hidden
          ? 'w-0 border-r-0 px-0'
          : 'w-[216px] border-r px-2.5 pt-3.5 pb-3',
      )}
    >
      <div
        className={cn('flex items-center gap-2.5 px-1.5 pt-0.5 text-[14.5px] transition-opacity duration-100',
          hidden && 'pointer-events-none opacity-0')}
        onDoubleClick={() => onNav('home')}
      >
        <span className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Logo className="size-[18px]" />
        </span>
        <b className="font-bold tracking-[.01em]">TongZip</b>
      </div>

      <div className={cn('flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto transition-opacity duration-100',
        hidden && 'pointer-events-none opacity-0')}>
        {NAV.map(({ v, label, icon: Ico }) => (
          <button key={v} onClick={() => onNav(v)}
            className={cn(
              'flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px]',
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
            'mt-1.5 flex h-8 items-center gap-2.5 rounded-lg border border-dashed border-border px-2.5 text-left text-xs',
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
