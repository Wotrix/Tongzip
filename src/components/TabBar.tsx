/**
 * 多标签栏 — 白底标签条;活动标签 = 页面白 + 细描边轻影的「凸起纸片」感,非活动标签浅灰
 * (用户要求:不要顶缘紫色指示线,活动态改靠描边/阴影/加粗区分,不用品牌色)
 * 尾部「+」新标签菜单(压缩包/文件夹);溢出横向滚动;中键可关闭。
 */
import { useState } from 'react';
import { IconAdd, IconArchive, IconClose, IconFolder } from './icons';
import { basename } from '../lib/format';
import { ContextMenu } from './ui';
import { cn } from '@/lib/utils';

export interface TabItem { id: string; archive: string; dir?: string }

export default function TabBar({ tabs, activeId, onSelect, onClose, onNew, onNewFolder }: {
  tabs: TabItem[];
  activeId: string | null;
  onSelect(id: string): void;
  onClose(id: string): void;
  onNew(): void;
  /** 新标签浏览磁盘文件夹 */
  onNewFolder?(): void;
}) {
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    /* 标签条白底与其他页顶区同色;标签页用灰面(bg-secondary 浅灰 / 活动态 foreground 10% 深灰) */
    <div className="flex h-[38px] shrink-0 items-end gap-[3px] bg-background px-2">
      <div className="flex h-full min-w-0 items-end gap-[3px] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => {
          const on = t.id === activeId;
          return (
            <div key={t.id}
              className={cn(
                'group/tab relative flex h-[30px] shrink-0 cursor-pointer items-center gap-1.5 select-none rounded-t-[9px] pl-2.5 pr-1.5 text-xs',
                'max-w-[150px] transition-colors duration-150',
                'bg-secondary text-muted-foreground hover:bg-secondary-foreground/[.09] hover:text-foreground active:bg-secondary-foreground/[.14]',
                /* 活动标签:白底凸起——细描边 + 轻上影在白条上也能立住,不再压品牌色指示线;
                   底边不描(与下方内容区无缝相接),并锁住 hover/active 白底防串到灰标签的悬停规则 */
                on && 'border border-b-0 border-border bg-background font-semibold text-foreground shadow-[0_-1px_2px_rgba(20,26,32,.06)] hover:bg-background active:bg-background',
              )}
              title={t.archive || t.dir}
              onClick={() => onSelect(t.id)}
              onAuxClick={(e) => { if (e.button === 1) onClose(t.id); }}>
              {t.dir && <IconFolder className="size-[13px] shrink-0 text-primary" />}
              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{basename(t.archive || t.dir || '')}</span>
              <button className="grid size-[17px] shrink-0 place-items-center rounded-[4px] text-current opacity-0 transition-opacity duration-100 hover:bg-foreground/10 active:bg-foreground/20 focus-visible:opacity-100 group-hover/tab:opacity-100" title="关闭标签 (Ctrl+W)"
                onClick={(e) => { e.stopPropagation(); onClose(t.id); }}>
                <IconClose className="size-[11px]" />
              </button>
            </div>
          );
        })}
      </div>
      <button className="mb-[3px] grid size-[23px] shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground active:bg-secondary-foreground/[.14]" title="新建标签 (Ctrl+T)" onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setAddMenu({ x: r.left, y: r.bottom + 4 });
      }}>
        <IconAdd className="size-[13px]" />
      </button>
      {addMenu && (
        <ContextMenu x={addMenu.x} y={addMenu.y} onClose={() => setAddMenu(null)} items={[
          { label: '打开压缩包…', icon: <IconArchive />, onClick: onNew },
          ...(onNewFolder ? [{ label: '打开文件夹…', icon: <IconFolder />, onClick: onNewFolder }] : []),
        ]} />
      )}
    </div>
  );
}
