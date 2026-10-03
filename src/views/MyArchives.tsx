/**
 * 我的压缩包页 — 扫描桌面/文档/下载中的压缩包(真实磁盘数据)
 */
import { useCallback, useEffect, useState } from 'react';
import type { ArchiveFile } from '@shared/types';
import FileGlyph from '../components/FileGlyph';
import { IconReveal, IconSpinner } from '../components/icons';
import { fmtBytes, parentDir } from '../lib/format';

/** 模块级扫描缓存:再次进入页面时直接渲染上次结果,
 *  后台静默刷新 — 避免整页加载图标闪现又消失的闪烁 */
let scanCache: ArchiveFile[] | null = null;

export default function MyArchives({ onOpen, onNew }: {
  onOpen(p: string): void;
  onNew(): void;
}) {
  const [files, setFiles] = useState<ArchiveFile[] | null>(scanCache);
  const [scanning, setScanning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const rescan = useCallback(() => {
    setScanning(true); setErr(null);
    void window.tz.scanArchives().then((r) => {
      setScanning(false);
      if (r.ok) { scanCache = r.data; setFiles(r.data); }
      else { setErr(r.message); setFiles(scanCache ?? []); }
    });
  }, []);
  useEffect(rescan, [rescan]);

  return (
    <div className="page">
      <div className="page-head row-head">
        <div>
          <h2>我的压缩包</h2>
          <p className="page-sub">来自桌面、文档、下载文件夹(两层深度,按修改时间排序)。</p>
        </div>
        <div className="head-acts">
          <button className="tbtn sm" disabled={scanning} onClick={rescan}>{scanning ? '扫描中…' : '重新扫描'}</button>
          <button className="tbtn primary sm" onClick={onNew}>新建压缩包</button>
        </div>
      </div>

      {files === null && (
        /* 紧凑行内加载态:小尺寸 spinner,避免整页大块图标闪现 */
        <div className="pg-loading">
          <IconSpinner className="spin" style={{ width: 15, height: 15 }} />
          <span>扫描本地压缩包…</span>
        </div>
      )}
      {files && !files.length && (
        <div className="pg-empty">
          <FileGlyph name="a.7z" isDir={false} size={34} />
          <div>常用目录里还没有压缩包</div>
          <small>也可以把文件拖到窗口任意位置直接创建</small>
        </div>
      )}
      {err && <div className="note" style={{ color: 'var(--danger)' }}>{err}</div>}

      {!!files?.length && (
        <div className="pg-list">
          <div className="pg-head">
            <span /><span>名称</span><span>大小</span><span>修改时间</span><span>位置</span><span />
          </div>
          {files.map((f) => (
            <div key={f.path} className="pg-row" title={f.path} onClick={() => onOpen(f.path)}>
              <FileGlyph name={f.name} isDir={false} size={22} />
              <span className="pg-name">{f.name}</span>
              <span className="pg-size">{fmtBytes(f.size)}</span>
              <span className="pg-time">{f.mtime}</span>
              <span className="pg-path">{parentDir(f.path)}</span>
              <button className="icon-btn" style={{ width: 26, height: 26 }} title="在资源管理器中显示"
                onClick={(e) => { e.stopPropagation(); void window.tz.revealInExplorer(f.path); }}>
                <IconReveal style={{ width: 14, height: 14 }} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
