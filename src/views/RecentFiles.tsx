/**
 * 最近文件页 — 最近打开过的压缩包(真实记录),带体积与存在校验
 */
import { useEffect, useState } from 'react';
import FileGlyph from '../components/FileGlyph';
import { basename, parentDir, fmtBytes } from '../lib/format';
import { cn } from '@/lib/utils';

export default function RecentFiles({ recents, onOpen }: {
  recents: string[];
  onOpen(p: string): void;
}) {
  const [sizes, setSizes] = useState(new Map<string, number>());
  const [alive, setAlive] = useState<Set<string>>(new Set());

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
              'grid h-[42px] cursor-pointer grid-cols-[30px_minmax(0,1fr)_90px] items-center gap-2.5',
              'rounded-lg px-2.5 transition-colors hover:bg-accent',
              !alive.has(p) && 'cursor-default opacity-50',
            )} title={p}
              onClick={() => alive.has(p) && onOpen(p)}>
              <FileGlyph name={basename(p)} isDir={false} size={22} />
              <span className="flex min-w-0 flex-col">
                <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-medium">{basename(p)}</span>
                <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px] text-muted-foreground">{parentDir(p)}</span>
              </span>
              <span className="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground tabular-nums">{alive.has(p) ? fmtBytes(sizes.get(p) ?? 0) : '文件已移除'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
