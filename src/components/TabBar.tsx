/**
 * 多标签栏 — 浏览器风格胶囊标签(用户参考图):全圆角药丸 + 左图标 + 内联关闭钮,
 * 活动标签浅强调色底;搜索框只保留页内一份(压缩包/文件夹各自上下文),尾部「+」。
 * 溢出横向滚动;中键可关闭。
 */
import { useState } from 'react';
import { IconAdd, IconArchive, IconClose, IconFolder, IconSearch } from './icons';
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
    <div className="flex h-[44px] shrink-0 items-center gap-2 bg-background px-3 pt-1">
      <div className="flex h-full min-w-0 items-center gap-[6px] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => {
          const on = t.id === activeId;
          return (
            <div key={t.id}
              className={cn(
                'group/tab relative flex h-7 w-[150px] min-w-[92px] shrink-0 cursor-pointer items-center gap-1.5 select-none rounded-full border border-border/70 pl-2.5 pr-1.5 text-xs',
                'transition-colors duration-150',
                'bg-secondary/60 text-muted-foreground hover:bg-secondary-foreground/[.09] hover:text-foreground active:bg-secondary-foreground/[.14]',
                /* 活动标签:浅强调色胶囊+明确描边,与未激活标签拉开层级 */
                on && 'border-primary/35 bg-primary/[.10] font-medium text-foreground shadow-sm hover:bg-primary/[.12] active:bg-primary/[.16]',
              )}
              title={t.archive || t.dir}
              onClick={() => onSelect(t.id)}
              onAuxClick={(e) => { if (e.button === 1) onClose(t.id); }}>
              {t.dir
                ? <IconFolder className={cn('size-[13px] shrink-0', on ? 'text-primary' : 'text-muted-foreground')} />
                : <IconSearch className="size-[13px] shrink-0 opacity-70" />}
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{basename(t.archive || t.dir || '')}</span>
              <button className="grid size-[17px] shrink-0 place-items-center rounded-full text-current opacity-0 transition-opacity duration-100 hover:bg-foreground/10 active:bg-foreground/20 focus-visible:opacity-100 group-hover/tab:opacity-100" title="关闭标签 (Ctrl+W)"
                onClick={(e) => { e.stopPropagation(); onClose(t.id); }}>
                <IconClose className="size-[11px]" />
              </button>
            </div>
          );
        })}
      </div>
      <button className="ml-auto grid size-[26px] shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground active:bg-secondary-foreground/[.14]" title="新建标签 (Ctrl+T)" onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setAddMenu({ x: r.left, y: r.bottom + 4 });
      }}>
        <IconAdd className="size-[14px]" />
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
