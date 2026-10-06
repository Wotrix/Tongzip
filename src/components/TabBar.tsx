/**
 * 多标签栏 — 顶栏下方独立一行,仅浏览视图渲染(PeaZip 式多包同开)
 * 标签 = 包名/目录名 + hover 关闭钮;尾部「+」新标签菜单(压缩包/文件夹);溢出横向滚动;中键可关闭。
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
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-secondary px-2.5">
      <div className="flex h-full min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => (
          <div key={t.id}
            className={cn(
              'group/tab flex h-8 shrink-0 cursor-pointer items-center gap-1.5 select-none rounded-md pr-1.5 pl-2.5 text-xs',
              'max-w-[190px] transition-colors duration-150',
              'text-muted-foreground hover:bg-accent hover:text-foreground active:bg-[var(--bg-active)]',
              t.id === activeId && 'border border-primary/35 bg-card font-semibold text-primary shadow-sm hover:bg-card active:bg-primary/[.09]',
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
        ))}
      </div>
      <button className="grid size-[23px] shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-[var(--bg-active)]" title="新建标签 (Ctrl+T)" onClick={(e) => {
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
