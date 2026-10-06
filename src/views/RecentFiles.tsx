/**
 * 最近文件页 — 最近打开过的压缩包(真实记录),带体积与存在校验
 */
import { useEffect, useState } from 'react';
import FileGlyph from '../components/FileGlyph';
import { ContextMenu, useToast } from '../components/ui';
import { IconFolderOpen, IconReveal, IconCopy, IconDelete } from '../components/icons';
import { basename, parentDir, fmtBytes } from '../lib/format';
import { cn } from '@/lib/utils';

export default function RecentFiles({ recents, onOpen, onRemoveRecent }: {
  recents: string[];
  onOpen(p: string): void;
  /** 从最近列表移除一项(右键菜单) */
  onRemoveRecent(p: string): void;
}) {
  const toast = useToast();
  const [sizes, setSizes] = useState(new Map<string, number>());
  const [alive, setAlive] = useState<Set<string>>(new Set());
  /** 行的右键菜单锚点 */
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const okSet = new Set<string>();
      const sizeMap = new Map<string, number>();
      for (const p of recents) {
        const a = await window.tz.exists(p);
        if (!a) continue;
        okSet.add(p);
        const s = await window.tz.totalSize([p]);
        if (s.ok) sizeMap.set(p, s.data);
        setSizes(new Map(sizeMap));
      }
      setAlive(okSet);
    })();
  }, [recents]);

  return (
    <div className="min-h-0 flex-1 overflow-auto px-8 pt-[26px] pb-12">
      <div className="mb-[18px]">
        <h2 className="text-[19px] font-bold">最近文件</h2>
        <p className="mt-1 text-[12.5px] text-muted-foreground">最近打开过的压缩包，按时间由新到旧排列。</p>
      </div>
      {recents.length === 0 ? (
        <div className="flex flex-col items-center gap-2.5 py-16 text-center text-[13px] text-muted-foreground">
          <FileGlyph name="a.7z" isDir={false} size={34} />
          <div>还没有打开过压缩包</div>
          <small className="text-[11.5px]">从首页「打开压缩包」或直接把文件拖进窗口</small>
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {recents.map((p) => (
            <div key={p} className={cn(
              'group grid h-[42px] cursor-pointer grid-cols-[30px_minmax(0,1fr)_90px_34px] items-center gap-2.5',
              'rounded-lg px-2.5 transition-colors hover:bg-accent active:bg-[var(--bg-active)]',
              !alive.has(p) && 'cursor-default opacity-50',
            )} title={p}
              onClick={() => alive.has(p) && onOpen(p)}
              onContextMenu={(e) => { e.preventDefault(); setRowMenu({ x: e.clientX, y: e.clientY, path: p }); }}>
              <FileGlyph name={basename(p)} isDir={false} size={22} />
              <span className="flex min-w-0 flex-col">
                <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-medium">{basename(p)}</span>
                <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px] text-muted-foreground">{parentDir(p)}</span>
              </span>
              <span className="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground tabular-nums">{alive.has(p) ? fmtBytes(sizes.get(p) ?? 0) : '文件已移除'}</span>
              <button className="grid size-[26px] place-items-center justify-self-end rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-[var(--bg-active)] hover:text-foreground group-hover:opacity-100" title="打开文件位置"
                onClick={(e) => { e.stopPropagation(); void window.tz.revealInExplorer(p); }}>
                <IconReveal className="size-[14px]" />
              </button>
            </div>
          ))}
        </div>
      )}

      {rowMenu && (() => {
        const p = rowMenu.path, ok = alive.has(p);
        const close = () => setRowMenu(null);
        return (
          <ContextMenu x={rowMenu.x} y={rowMenu.y} onClose={close} items={[
            { label: '打开', icon: <IconFolderOpen />, disabled: !ok, onClick: () => { close(); onOpen(p); } },
            { label: '打开文件位置', icon: <IconReveal />, disabled: !ok, onClick: () => { close(); void window.tz.revealInExplorer(p); } },
            { label: '复制文件路径', icon: <IconCopy />, onClick: () => { close(); void navigator.clipboard.writeText(p).then(() => toast('已复制到剪贴板')).catch(() => toast('复制失败', 'err')); } },
            { sep: true, label: '' },
            { label: '从最近列表移除', icon: <IconDelete />, danger: true, onClick: () => { close(); onRemoveRecent(p); } },
          ]} />
        );
      })()}
    </div>
  );
}
