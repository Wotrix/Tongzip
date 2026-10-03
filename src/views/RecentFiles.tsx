/**
 * 最近文件页 — 最近打开过的压缩包(真实记录),带体积与存在校验
 */
import { useEffect, useState } from 'react';
import FileGlyph from '../components/FileGlyph';
import { basename, parentDir, fmtBytes } from '../lib/format';

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
    <div className="page">
      <div className="page-head">
        <h2>最近文件</h2>
        <p className="page-sub">最近打开过的压缩包，按时间由新到旧排列。</p>
      </div>
      {recents.length === 0 ? (
        <div className="pg-empty">
          <FileGlyph name="a.7z" isDir={false} size={34} />
          <div>还没有打开过压缩包</div>
          <small>从首页「打开压缩包」或直接把文件拖进窗口</small>
        </div>
      ) : (
        <div className="pg-list">
          {recents.map((p) => (
            <div key={p} className={`pg-row ${alive.has(p) ? '' : 'missing'}`} title={p}
              onClick={() => alive.has(p) && onOpen(p)}>
              <FileGlyph name={basename(p)} isDir={false} size={22} />
              <span className="pg-main">
                <span className="pg-name">{basename(p)}</span>
                <span className="pg-path">{parentDir(p)}</span>
              </span>
              <span className="pg-size">{alive.has(p) ? fmtBytes(sizes.get(p) ?? 0) : '文件已移除'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
