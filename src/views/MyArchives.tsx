/**
 * 我的压缩包页 — 扫描桌面/文档/下载中的压缩包(真实磁盘数据)
 */
import { useCallback, useEffect, useState } from 'react';
import type { ArchiveFile, ScanProgress } from '@shared/types';
import FileGlyph from '../components/FileGlyph';
import { ContextMenu, useToast } from '../components/ui';
import { IconReveal, IconSpinner, IconFolderOpen, IconCopy } from '../components/icons';
import { Button } from '../components/ui/button';
import { fmtBytes, parentDir } from '../lib/format';

/** 模块级扫描缓存:再次进入页面时直接渲染上次结果,
 *  后台静默刷新 — 避免整页加载图标闪现又消失的闪烁 */
let scanCache: ArchiveFile[] | null = null;

export default function MyArchives({ onOpen, onNew }: {
  onOpen(p: string): void;
  onNew(): void;
}) {
  const toast = useToast();
  const [files, setFiles] = useState<ArchiveFile[] | null>(scanCache);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** 行的右键菜单锚点(磁盘扫描结果,无"移除"项) */
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  const rescan = useCallback(() => {
    setScanning(true); setErr(null); setProgress(null);
    void window.tz.scanArchives().then((r) => {
      setScanning(false); setProgress(null);
      if (r.ok) { scanCache = r.data; setFiles(r.data); }
      else { setErr(r.message); setFiles(scanCache ?? []); }
    });
  }, []);
  useEffect(rescan, [rescan]);

  /* 订阅主进程扫描进度流(逐目录推进 + 实时发现数) */
  useEffect(() => {
    const off = window.tz.onScanProgress?.((p) => setProgress(p));
    return () => off?.();
  }, []);

  return (
    <div className="min-h-0 flex-1 overflow-auto px-8 pt-[26px] pb-12">
      <div className="mb-[18px] flex items-end justify-between gap-4">
        <div>
          <h2 className="text-[19px] font-bold">我的压缩包</h2>
          <p className="mt-1 text-[12.5px] text-muted-foreground">来自桌面、文档、下载文件夹(两层深度,按修改时间排序)。</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" size="sm" className="h-[27px] gap-[7px] px-[9px] text-xs font-normal" disabled={scanning} onClick={rescan}>{scanning ? '扫描中…' : '重新扫描'}</Button>
          <Button size="sm" className="h-[27px] gap-[7px] px-[9px] text-xs font-semibold" onClick={onNew}>新建压缩包</Button>
        </div>
      </div>

      {scanning && (
        /* 扫描动画 + 进度条:冷启动与刷新都显示;刷新时旧列表仍在下方,顶部推进条给实时反馈 */
        <div className="mb-4">
          <div className="mb-2 flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <IconSpinner className="spin size-[15px]" />
            <span>{progress?.current ? `正在扫描「${progress.current}」…` : '扫描本地压缩包…'}</span>
            {!!progress && progress.found > 0 && (
              <span className="tabular-nums">已发现 {progress.found} 个</span>
            )}
          </div>
          <div className="h-[3px] w-full overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
              style={{ width: `${progress && progress.rootsTotal ? Math.max(10, Math.round((progress.rootsDone / progress.rootsTotal) * 100)) : 10}%` }}
            />
          </div>
        </div>
      )}
      {!scanning && files && !files.length && (
        <div className="flex flex-col items-center gap-2.5 py-16 text-center text-[13px] text-muted-foreground">
          <FileGlyph name="a.7z" isDir={false} size={34} />
          <div>常用目录里还没有压缩包</div>
          <small className="text-[11.5px]">也可以把文件拖到窗口任意位置直接创建</small>
        </div>
      )}
      {err && <div className="text-xs text-destructive">{err}</div>}

      {!!files?.length && (
        <div className="flex flex-col gap-0.5">
          <div className="sticky -top-[26px] z-[1] grid h-[30px] grid-cols-[30px_minmax(0,1fr)_90px_150px_minmax(0,1.4fr)_34px] items-center gap-2.5 border-b border-border bg-background px-2.5 text-[11.5px] text-muted-foreground">
            <span /><span>名称</span><span>大小</span><span>修改时间</span><span>位置</span><span />
          </div>
          {files.map((f) => (
            <div key={f.path} className="grid h-[42px] cursor-pointer grid-cols-[30px_minmax(0,1fr)_90px_150px_minmax(0,1.4fr)_34px] items-center gap-2.5 rounded-lg px-2.5 transition-colors hover:bg-accent active:bg-[var(--bg-active)]" title={f.path} onClick={() => onOpen(f.path)}
              onContextMenu={(e) => { e.preventDefault(); setRowMenu({ x: e.clientX, y: e.clientY, path: f.path }); }}>
              <FileGlyph name={f.name} isDir={false} size={22} />
              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-medium">{f.name}</span>
              <span className="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground tabular-nums">{fmtBytes(f.size)}</span>
              <span className="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground tabular-nums">{f.mtime}</span>
              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px] text-muted-foreground">{parentDir(f.path)}</span>
              <Button variant="ghost" size="icon-xs" className="size-[26px] rounded-md text-muted-foreground hover:bg-[var(--bg-active)]" title="在资源管理器中显示"
                onClick={(e) => { e.stopPropagation(); void window.tz.revealInExplorer(f.path); }}>
                <IconReveal className="size-[14px]" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {rowMenu && (() => {
        const p = rowMenu.path;
        const close = () => setRowMenu(null);
        return (
          <ContextMenu x={rowMenu.x} y={rowMenu.y} onClose={close} items={[
            { label: '打开', icon: <IconFolderOpen />, onClick: () => { close(); onOpen(p); } },
            { label: '打开文件位置', icon: <IconReveal />, onClick: () => { close(); void window.tz.revealInExplorer(p); } },
            { label: '复制文件路径', icon: <IconCopy />, onClick: () => { close(); void navigator.clipboard.writeText(p).then(() => toast('已复制到剪贴板')).catch(() => toast('复制失败', 'err')); } },
          ]} />
        );
      })()}
    </div>
  );
}
