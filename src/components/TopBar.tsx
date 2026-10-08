/**
 * 顶栏 — 只承载拖拽区 + 任务铃铛 + 窗口控制。
 * 返回/前进箭头、面包屑、搜索框已搬入浏览视图自身的导航行(Browser .br-nav),
 * 顶栏在所有视图下形态一致、不再占用内容空间,也不画底部分隔线。
 * 侧栏隐藏时左空白区按竞品标题栏形态显示「图标 + 压缩包名 - TongZip」(纯展示,不带菜单)。
 */
import { useState } from 'react';
import TaskCenter from './TaskCenter';
import { IconMin, IconMax, IconClose, IconBell } from './icons';
import AppLogo from './AppLogo';
import { useTaskHub } from './ui';
import { cn } from '@/lib/utils';

export default function TopBar({ archiveLabel = null }: { archiveLabel?: string | null }) {
  const { jobs } = useTaskHub();
  const running = jobs.filter((j) => j.status === 'running').length;
  const [tcOpen, setTcOpen] = useState(false);

  return (
    <header className="app-drag relative flex h-[42px] shrink-0 items-center pl-2.5 bg-secondary">
      {/* 标题位:侧栏隐藏后品牌锚点消失,这里补上「文件名 - TongZip」(截屏形态,无菜单栏) */}
      <div className="flex min-w-0 flex-1 items-center">
        {archiveLabel && (
          <span className="flex min-w-0 items-center gap-2 pl-1.5 text-[12.5px]">
            <AppLogo className="size-[22px]" />
            <span className="truncate font-semibold text-foreground" title={archiveLabel}>{archiveLabel}</span>
            <span className="shrink-0 text-muted-foreground">- TongZip</span>
          </span>
        )}
      </div>
      <div className="app-nodrag ml-auto flex items-center gap-0.5">
        <button
          title="任务通知"
          onClick={() => setTcOpen((v) => !v)}
          className={cn(
            'relative inline-flex size-[34px] items-center justify-center rounded-md',
            'text-muted-foreground transition-colors',
            'hover:text-foreground hover:bg-accent active:bg-[var(--bg-active)]',
            tcOpen && 'bg-primary/10 text-primary hover:bg-primary/10 active:bg-primary/20',
          )}
        >
          <BellGlyph running={running > 0} />
          {running > 0 && (
            <span className="absolute right-[3px] top-[3px] min-w-[15px] rounded-full bg-primary px-1 text-center text-[10px] font-bold leading-[15px] text-primary-foreground ring-2 ring-secondary">
              {running}
            </span>
          )}
        </button>
        <span style={{ width: 6 }} />
        <button className="app-nodrag inline-flex h-[42px] w-[46px] items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title="最小化" onClick={() => window.tz.winMinimize()}><IconMin className="size-3.5" /></button>
        <button className="app-nodrag inline-flex h-[42px] w-[46px] items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title="最大化 / 还原" onClick={() => window.tz.winMaximize()}><IconMax className="size-3.5" /></button>
        <button className="app-nodrag inline-flex h-[42px] w-[46px] items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground" title="关闭" onClick={() => window.tz.winClose()}><IconClose className="size-3.5" /></button>
      </div>

      {tcOpen && <TaskCenter onClose={() => setTcOpen(false)} />}
    </header>
  );
}

/** 铃铛入口:有进行中任务时轻微脉动 */
function BellGlyph({ running }: { running: boolean }) {
  return (
    <span style={running ? { animation: 'tcbreathe 1.6s ease-in-out infinite', display: 'inline-flex' } : { display: 'inline-flex' }}>
      <IconBell className="size-[17px]" />
      <style>{`@keyframes tcbreathe { 0%,100%{opacity:1} 50%{opacity:.55} }`}</style>
    </span>
  );
}
