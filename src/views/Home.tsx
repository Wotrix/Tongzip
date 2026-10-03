/**
 * Home 首页 — 参考图布局:欢迎标题 · 三快捷卡(首卡实心主色)· 最近打开(带体积)· 最近任务(带进度条)
 */
import { useEffect, useState } from 'react';
import { IconArchive, IconExtract, IconFolderOpen, IconFolder, IconOpen, IconCheckCircle, IconWarn } from '../components/icons';
import FileGlyph from '../components/FileGlyph';
import { ContextMenu, useTaskHub } from '../components/ui';
import { RunningCard } from '../components/TaskCenter';
import { basename, fmtBytes, parentDir } from '../lib/format';

export default function Home({ recents, onOpen, onCompress, onCompressFolder, onNewArchive, onExtract, onOpenPick, onSeeAllTasks, onSeeRecent }: {
  recents: string[];
  onOpen(p: string): void;
  /** 选文件→压缩;若全是压缩包自动转解压 */
  onCompress(): void;
  /** 选文件夹→直接进压缩流程 */
  onCompressFolder(): void;
  /** 空白新建压缩包(直接进保存对话框) */
  onNewArchive(): void;
  /** 选压缩包→解压;非压缩包自动转压缩 */
  onExtract(): void;
  onOpenPick(): void;
  onSeeAllTasks(): void;
  onSeeRecent(): void;
}) {
  const { jobs, history } = useTaskHub();
  const [alive, setAlive] = useState<Set<string>>(new Set());
  const [sizes, setSizes] = useState(new Map<string, number>());
  /** 首页板块可见性(设置页可关闭) */
  const [show, setShow] = useState({ recentOpen: true, recentTasks: true });
  /** 压缩卡的「选文件/选文件夹」菜单锚点 */
  const [pickMenu, setPickMenu] = useState<{ x: number; y: number } | null>(null);

  /* 每次进入首页重读设置,开关改动即时生效 */
  useEffect(() => {
    void window.tz.getSettings().then((v) => setShow({ recentOpen: v.showRecentOpen, recentTasks: v.showRecentTasks }));
  }, []);

  /* 校验最近记录是否存在(死链灰显)并取真实体积 */
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

  const recentTasks = jobs.filter((j) => j.status === 'running').slice(0, 3);
  const doneTasks = history.slice(0, Math.max(0, 3 - recentTasks.length));

  /* 两个板块都被关闭时,欢迎区与三快捷卡整体垂直居中 */
  const bothHidden = !show.recentOpen && !show.recentTasks;

  return (
    <div className={`home ${bothHidden ? 'centered' : ''}`}>
      <div className="home-inner">
        <div className="welcome">
          <h1>欢迎使用 TongZip</h1>
          <p>压缩、解压与文件管理,在这一处完成。</p>
        </div>

        <div className="qrow">
          <button className="qcard primary" onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setPickMenu({ x: r.left + 16, y: r.bottom + 4 });
          }}>
            <span className="qc-ico"><IconArchive /></span>
            <b>压缩</b>
            <small>选文件或文件夹即压;若选的全是压缩包则自动转为解压</small>
          </button>
          <button className="qcard" onClick={onExtract}>
            <span className="qc-ico"><IconExtract /></span>
            <b>解压</b>
            <small>选压缩包即解;非压缩包自动转为压缩</small>
          </button>
          <button className="qcard" onClick={onOpenPick}>
            <span className="qc-ico"><IconFolderOpen /></span>
            <b>打开压缩包</b>
            <small>浏览内容,挑选单个文件再解压</small>
          </button>
        </div>
        <p className="drop-hint">把文件或文件夹拖到窗口任意位置 — 压缩包直接打开,文件转为压缩</p>

        {(show.recentOpen || show.recentTasks) && (
        <div className="home-cols">
          {show.recentOpen && (
          <div className="home-section">
            <h3>最近打开 <button className="link-btn" onClick={onSeeRecent}>查看全部</button></h3>
            {recents.length === 0 ? (
              <p className="home-empty">还没有记录 — 打开一个压缩包后会出现在这里。</p>
            ) : recents.slice(0, 5).map((p) => (
              <div key={p} className={`recent-item ${alive.has(p) ? '' : 'missing'}`}
                title={p} onClick={() => alive.has(p) && onOpen(p)}>
                <FileGlyph name={basename(p)} isDir={false} size={22} />
                <span className="ri-main">
                  <span className="ri-name">{basename(p)}</span>
                  <span className="ri-path">{parentDir(p)}</span>
                </span>
                <span className="ri-meta">{alive.has(p) ? fmtBytes(sizes.get(p) ?? 0) : '已移除'}</span>
              </div>
            ))}
          </div>
          )}

          {show.recentTasks && (
          <div className="home-section">
            <h3>最近任务 <button className="link-btn" onClick={onSeeAllTasks}>查看全部</button></h3>
            {recentTasks.length === 0 && doneTasks.length === 0 ? (
              <p className="home-empty">暂无任务 — 从上方卡片开始第一次压缩。</p>
            ) : (
              <>
                {recentTasks.map((j) => <RunningCard key={j.taskId} job={j} />)}
                {doneTasks.map((h) => (
                  <div key={h.taskId + h.at} className={`hist-item ${h.status === 'done' ? '' : 'err'}`}>
                    {h.status === 'done'
                      ? <IconCheckCircle style={{ color: 'var(--accent)' }} />
                      : <IconWarn style={{ color: 'var(--danger)' }} />}
                    <span className="h-name">
                      {h.kind === 'compress' ? '压缩' : h.kind === 'extract' ? '解压' : h.kind === 'test' ? '测试' : '删除'}
                      {h.status === 'done' ? '完成' : h.status === 'error' ? '失败' : '已取消'}
                      {h.label ? ` · ${h.label}` : ''}
                    </span>
                    <span className="h-time">{new Date(h.at).toLocaleTimeString()}</span>
                  </div>
                ))}
              </>
            )}
          </div>
          )}
        </div>
        )}
      </div>

      {pickMenu && (
        <ContextMenu x={pickMenu.x} y={pickMenu.y} onClose={() => setPickMenu(null)} items={[
          { label: '新建压缩包…', icon: <IconArchive />, onClick: () => { setPickMenu(null); onNewArchive(); } },
          { label: '选择文件…', icon: <IconOpen />, onClick: () => { setPickMenu(null); onCompress(); } },
          { label: '选择文件夹…', icon: <IconFolder />, onClick: () => { setPickMenu(null); onCompressFolder(); } },
        ]} />
      )}
    </div>
  );
}
