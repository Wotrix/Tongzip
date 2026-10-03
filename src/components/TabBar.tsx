/**
 * 多标签栏 — 顶栏下方独立一行,仅浏览视图渲染(PeaZip 式多包同开)
 * 标签 = 包名 + hover 关闭钮;尾部「+」打开新包;溢出横向滚动;中键可关闭。
 */
import { IconAdd, IconClose } from './icons';
import { basename } from '../lib/format';
import { cn } from '@/lib/utils';

export interface TabItem { id: string; archive: string }

export default function TabBar({ tabs, activeId, onSelect, onClose, onNew }: {
  tabs: TabItem[];
  activeId: string | null;
  onSelect(id: string): void;
  onClose(id: string): void;
  onNew(): void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-secondary px-2.5">
      <div className="flex h-full min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => (
          <div key={t.id}
            className={cn(
              'group/tab flex h-8 shrink-0 cursor-pointer items-center gap-1.5 select-none rounded-md pr-1.5 pl-2.5 text-xs',
              'max-w-[190px] transition-colors duration-150',
              'text-muted-foreground hover:bg-accent hover:text-foreground',
              t.id === activeId && 'border border-border bg-card font-semibold text-primary shadow-sm',
            )}
            title={t.archive}
            onClick={() => onSelect(t.id)}
            onAuxClick={(e) => { if (e.button === 1) onClose(t.id); }}>
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{basename(t.archive)}</span>
            <button className="grid size-[17px] shrink-0 place-items-center rounded-[4px] text-current opacity-0 transition-opacity duration-100 hover:bg-foreground/10 focus-visible:opacity-100 group-hover/tab:opacity-100" title="关闭标签 (Ctrl+W)"
              onClick={(e) => { e.stopPropagation(); onClose(t.id); }}>
              <IconClose className="size-[11px]" />
            </button>
          </div>
        ))}
      </div>
      <button className="grid size-[23px] shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title="打开其他压缩包 (Ctrl+T)" onClick={onNew}>
        <IconAdd className="size-[13px]" />
      </button>
    </div>
  );
}
