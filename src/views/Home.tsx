/**
 * Home 首页 — 欢迎标题 · 三快捷卡(首卡实心主色)· 最近打开(带体积)· 最近任务(带进度条)
 */
import { useEffect, useState } from 'react';
import { IconArchive, IconExtract, IconFolderOpen, IconFolder, IconOpen, IconCheckCircle, IconWarn, IconClock, IconReveal, IconCopy, IconDelete } from '../components/icons';
import FileGlyph from '../components/FileGlyph';
import { ContextMenu, useTaskHub, useToast, type DoneJob } from '../components/ui';
import { RunningCard, useDoneTaskMenu, revealArchive } from '../components/TaskCenter';
import { basename, fmtBytes, parentDir } from '../lib/format';
import { cn } from '@/lib/utils';

export default function Home({ recents, onOpen, onCompress, onCompressFolder, onNewArchive, onExtract, onOpenPick, onSeeAllTasks, onSeeRecent, onRemoveRecent }: {
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
  /** 从最近列表移除一项(右键菜单) */
  onRemoveRecent(p: string): void;
}) {
  const { jobs, history } = useTaskHub();
  const toast = useToast();
  const [alive, setAlive] = useState<Set<string>>(new Set());
  const [sizes, setSizes] = useState(new Map<string, number>());
  /** 首页板块可见性(设置页可关闭) */
  const [show, setShow] = useState({ recentOpen: true, recentTasks: true });
  /** 压缩卡的「选文件/选文件夹」菜单锚点 */
  const [pickMenu, setPickMenu] = useState<{ x: number; y: number } | null>(null);
  /** 最近打开行的右键菜单锚点 */
  const [recentMenu, setRecentMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  /* 每次进入首页重读设置,开关改动即时生效 */
  useEffect(() => {
    void window.tz.getSettings().then((v) => setShow({ recentOpen: v.showRecentOpen, recentTasks: v.showRecentTasks }));
  }, []);

  /* 校验最近记录是否存在(死链灰显)并取真实体积:并行 IPC,避免 N+1 串行卡顿 */
  useEffect(() => {
    void (async () => {
      const rows = await Promise.all(recents.map(async (p) => {
        if (!(await window.tz.exists(p))) return null;
        const s = await window.tz.totalSize([p]);
        return { p, size: s.ok ? s.data : 0 };
      }));
      const okSet = new Set<string>();
      const sizeMap = new Map<string, number>();
      for (const r of rows) {
        if (!r) continue;
        okSet.add(r.p);
        sizeMap.set(r.p, r.size);
      }
      setAlive(okSet);
      setSizes(sizeMap);
    })();
  }, [recents]);

  const recentTasks = jobs.filter((j) => j.status === 'running').slice(0, 3);
  const doneTasks = history.slice(0, Math.max(0, 3 - recentTasks.length));

  /* 两个板块都被关闭时,欢迎区与三快捷卡整体垂直居中(safe 避免小窗口裁顶) */
  const bothHidden = !show.recentOpen && !show.recentTasks;

  /* 两板块只剩一个时占满整行(旧 :only-child 规则的等价逻辑) */
  const single = show.recentOpen !== show.recentTasks;

  return (
    <div className={cn('min-h-0 flex-1 justify-center overflow-auto bg-background px-8 pt-9 pb-14 flex',
      bothHidden && '[align-items:safe_center]')}>
      <div className="mx-auto w-[880px] max-w-full">
        {/* 欢迎区无图标规范:纯文字标题块,左缘与下方快捷卡对齐 */}
        <div className="mb-[22px]">
          <h1 className="text-[22px] font-bold tracking-[.01em] text-foreground">欢迎使用 TongZip</h1>
          <p className="mt-[5px] text-[13px] text-muted-foreground">压缩、解压与文件管理,在这一处完成。</p>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <button className={cn(
            'flex flex-col gap-2.5 rounded-[16px] border border-transparent p-4 text-left',
            'bg-primary text-primary-foreground transition-[background,transform] duration-150 hover:bg-primary/90 active:scale-[.995]',
          )} onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setPickMenu({ x: r.left + 16, y: r.bottom + 4 });
          }}>
            <span className="flex size-[30px] items-center justify-center rounded-[10px] bg-white/[.18] [&_svg]:size-4 [&_svg]:text-primary-foreground"><IconArchive /></span>
            <b className="text-[13.5px] font-semibold">压缩</b>
            <small className="text-[11.5px] leading-[1.45] opacity-[.78]">选文件或文件夹即压;若选的全是压缩包则自动转为解压</small>
          </button>
          <button className={cn(
            'flex flex-col gap-2.5 rounded-[16px] border border-border bg-card p-4 text-left',
            'transition-[border-color,background,transform] duration-150 hover:border-input hover:bg-secondary active:scale-[.995]',
          )} onClick={onExtract}>
            <span className="flex size-[30px] items-center justify-center rounded-[10px] bg-primary/10 [&_svg]:size-4 [&_svg]:text-primary"><IconExtract /></span>
            <b className="text-[13.5px] font-semibold">解压</b>
            <small className="text-[11.5px] leading-[1.45] text-muted-foreground">选压缩包即解;非压缩包自动转为压缩</small>
          </button>
          <button className={cn(
            'flex flex-col gap-2.5 rounded-[16px] border border-border bg-card p-4 text-left',
            'transition-[border-color,background,transform] duration-150 hover:border-input hover:bg-secondary active:scale-[.995]',
          )} onClick={onOpenPick}>
            <span className="flex size-[30px] items-center justify-center rounded-[10px] bg-primary/10 [&_svg]:size-4 [&_svg]:text-primary"><IconFolderOpen /></span>
            <b className="text-[13.5px] font-semibold">打开压缩包</b>
            <small className="text-[11.5px] leading-[1.45] text-muted-foreground">浏览内容,挑选单个文件再解压</small>
          </button>
        </div>
        <p className="mx-0.5 mt-2.5 mb-[30px] text-center text-xs text-muted-foreground">把文件或文件夹拖到窗口任意位置 — 压缩包直接打开,文件转为压缩</p>

        {(show.recentOpen || show.recentTasks) && (
        <div className="grid grid-cols-2 gap-[26px]">
          {show.recentOpen && (
          <section className={cn('mb-0', single && 'col-span-2')}>
            <h3 className="mb-2.5 flex items-center text-xs font-semibold tracking-[.06em] text-muted-foreground uppercase">最近打开
              <button className="ml-auto rounded-[5px] px-[7px] py-0.5 text-[11.5px] font-medium tracking-normal normal-case text-primary transition-colors uppercase-none hover:bg-primary/10" onClick={onSeeRecent}>查看全部</button>
            </h3>
            {recents.length === 0 ? (
              <p className="px-3 py-1.5 text-[12.5px] text-muted-foreground">还没有记录 — 打开一个压缩包后会出现在这里。</p>
            ) : recents.slice(0, 5).map((p) => (
              <div key={p} className={cn(
                'group flex h-11 cursor-pointer items-center gap-[11px] rounded-md px-3 transition-colors hover:bg-accent active:bg-[var(--bg-active)]',
                !alive.has(p) && 'opacity-50',
              )}
                title={p} onClick={() => alive.has(p) && onOpen(p)}
                onContextMenu={(e) => { e.preventDefault(); setRecentMenu({ x: e.clientX, y: e.clientY, path: p }); }}>
                <FileGlyph name={basename(p)} isDir={false} size={22} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px]">{basename(p)}</span>
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px] text-muted-foreground">{parentDir(p)}</span>
                </span>
                <span className="shrink-0 text-[11.5px] text-muted-foreground">{alive.has(p) ? fmtBytes(sizes.get(p) ?? 0) : '已移除'}</span>
                <button className="grid size-[24px] flex-none place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-[var(--bg-active)] hover:text-foreground group-hover:opacity-100" title="打开文件位置"
                  onClick={(e) => { e.stopPropagation(); void window.tz.revealInExplorer(p); }}>
                  <IconReveal className="size-[14px]" />
                </button>
              </div>
            ))}
          </section>
          )}

          {show.recentTasks && (
          <section className={cn('mb-0', single && 'col-span-2')}>
            <h3 className="mb-2.5 flex items-center text-xs font-semibold tracking-[.06em] text-muted-foreground uppercase">最近任务
              <button className="ml-auto rounded-[5px] px-[7px] py-0.5 text-[11.5px] font-medium tracking-normal normal-case text-primary transition-colors uppercase-none hover:bg-primary/10" onClick={onSeeAllTasks}>查看全部</button>
            </h3>
            {recentTasks.length === 0 && doneTasks.length === 0 ? (
              <p className="px-3 py-1.5 text-[12.5px] text-muted-foreground">暂无任务 — 从上方卡片开始第一次压缩。</p>
            ) : (
              <>
                {recentTasks.map((j) => <RunningCard key={j.taskId} job={j} />)}
                {doneTasks.map((h) => <DoneTaskRow key={h.taskId + h.at} h={h} onOpen={onOpen} />)}
              </>
            )}
          </section>
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

      {recentMenu && (() => {
        const p = recentMenu.path, ok = alive.has(p);
        const close = () => setRecentMenu(null);
        return (
          <ContextMenu x={recentMenu.x} y={recentMenu.y} onClose={close} items={[
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

/** 最近任务的已完成行:右键菜单与「最近打开」同构 + 悬停「打开文件位置」按钮 */
function DoneTaskRow({ h, onOpen }: { h: DoneJob; onOpen: (p: string) => void }) {
  const toast = useToast();
  const { menu, bind } = useDoneTaskMenu(h, onOpen);
  return (
    <div className={cn(
      'group flex h-[34px] items-center gap-2.5 rounded-lg px-3 text-[12.5px] text-muted-foreground',
      'transition-colors hover:bg-accent active:bg-[var(--bg-active)] [&_svg]:size-[15px] [&_svg]:shrink-0',
      h.status !== 'done' && h.status !== 'interrupted' && h.status !== 'retryable' && 'text-destructive',
      h.status === 'interrupted' && 'text-[color:var(--warn)]',
    )} {...bind}>
      {menu}
      {h.status === 'done'
        ? <IconCheckCircle className="text-primary" />
        : h.status === 'interrupted' || h.status === 'retryable'
          ? <IconClock />
          : <IconWarn className="text-destructive" />}
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
        {h.kind === 'compress' ? '压缩' : h.kind === 'extract' ? '解压' : h.kind === 'test' ? '测试' : '删除'}
        {h.status === 'done' ? '完成' : h.status === 'error' ? '失败' : h.status === 'cancelled' ? '已取消'
          : h.status === 'interrupted' ? '上次运行中断' : '可重试'}
        {h.label ? ` · ${h.label}` : ''}
      </span>
      <span className="shrink-0 text-[11.5px] text-muted-foreground">{new Date(h.at).toLocaleTimeString()}</span>
      {h.path && (
        <button className="grid size-[24px] flex-none place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-[var(--bg-active)] hover:text-foreground group-hover:opacity-100" title="打开文件位置"
          onClick={(e) => { e.stopPropagation(); revealArchive(h.path!, toast); }}>
          <IconReveal className="size-[14px]" />
        </button>
      )}
    </div>
  );
}
