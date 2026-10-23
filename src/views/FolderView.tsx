/**
 * 磁盘文件夹浏览 — 应用内原生目录视图(Bandizip「解压后打开目标文件夹」的对标能力)。
 * 与 Browser 共用 listTokens 版式令牌:同一列网格/表头手柄/复选框/面包屑观感。
 * - 嵌入模式:作为主窗一个「文件夹标签」渲染(App TabView 分流到此)
 * - standalone:独立窗口渲染,自带迷你标题栏(最小化/最大化/关闭)
 * 双击:文件夹进入 / 压缩包交 onOpenArchive(新标签)/ 其他文件走系统关联程序。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FolderEntry } from '@shared/types';
import {
  IconAdd, IconArchive, IconBack, IconChevronRight, IconClose, IconDelete, IconFolder,
  IconForward, IconHome, IconMax, IconMin, IconMore, IconOpen, IconRefresh, IconReveal,
  IconSearch, IconUp, IconWarn,
} from '../components/icons';
import AppLogo from '../components/AppLogo';
import FileGlyph from '../components/FileGlyph';
import { ContextMenu, useToast, type CtxItem } from '../components/ui';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { cn } from '@/lib/utils';
import { fmtBytes } from '../lib/format';
import {
  ARROW_CLS, CRUMB_CLS, TB_CLS, TB_OUTLINE_CLS, clampCol, clampName, COL_LIMITS, measure,
  CELL_FONT, HEAD_FONT, LIST_GRID, CK_CLS, loadColWidths, loadHiddenCols, HIDEABLE_COLS, isHiddenCol,
  type ColKey, type AnyColKey,
} from './listTokens';

type SortKey = 'name' | 'type' | 'size' | 'time';

/** 路径归一:反斜杠→正斜杠、去尾斜杠(盘根保留) */
const norm = (p: string) => {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return s || '/';
};
const parentOf = (p: string) => {
  const cut = p.lastIndexOf('/');
  if (cut <= 1 && !/^[A-Za-z]:/.test(p)) return '/';
  return cut < 0 ? p : (p.slice(0, cut) || '/');
};
/** 面包屑段:盘符 + 各级目录 */
function pathSegs(p: string): { label: string; path: string }[] {
  const parts = p.split('/').filter(Boolean);
  const out: { label: string; path: string }[] = [];
  let acc = '';
  for (const s of parts) {
    acc = acc ? `${acc}/${s}` : (s.endsWith(':') ? `${s}/` : s);
    out.push({ label: s, path: norm(acc) });
  }
  return out;
}
const typeOf = (e: FolderEntry) => {
  if (e.isDir) return '文件夹';
  const m = e.name.match(/\.([A-Za-z0-9]{1,6})$/);
  return m ? `${m[1].toUpperCase()} 文件` : '文件';
};

export default function FolderView({ dir, standalone = false, query: qProp, onQuery, onOpenArchive, onCompress }: {
  /** 初始目录(独立窗口来自 URL query;标签模式来自 tab.dir) */
  dir: string;
  /** 独立浏览窗口:渲染迷你标题栏 + 窗控 */
  standalone?: boolean;
  /** 受控搜索词(标签模式下由 Shell tabQueries 提供,与胶囊标签条搜索框共用) */
  query?: string;
  onQuery?(v: string): void;
  /** 双击压缩包条目:主窗开新标签;独立窗口默认走 openPath */
  onOpenArchive?: (archivePath: string) => void;
  /** 拉起压缩对话框(添加进包/压缩选中) */
  onCompress?: (sources: string[]) => void;
}) {
  const toast = useToast();
  const [cwd, setCwd] = useState(norm(dir));
  const [entries, setEntries] = useState<FolderEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hist, setHist] = useState<string[]>([norm(dir)]);
  const [hi, setHi] = useState(0);
  /* 搜索词:传入 query 则受控(标签模式),否则自持(独立窗口) */
  const [ownQuery, setOwnQuery] = useState('');
  const query = qProp ?? ownQuery;
  const setQuery = (v: string) => { if (onQuery) onQuery(v); else setOwnQuery(v); };
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [asc, setAsc] = useState(true);
  const [menu, setMenu] = useState<{ x: number; y: number; row: FolderEntry | null } | null>(null);
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  const lastClick = useRef<string | null>(null);

  /* ---------- 目录读取 ---------- */
  const load = useCallback(async (p: string) => {
    setLoading(true);
    const r = await window.tz.listDir(p);
    if (r.ok) { setEntries(r.data); setErr(null); }
    else { setEntries([]); setErr(r.message); }
    setLoading(false);
  }, []);
  useEffect(() => { void load(cwd); setSel(new Set()); setQuery(''); }, [cwd, load]);

  /* ---------- 历史导航 ---------- */
  const goto = useCallback((p: string) => {
    const np = norm(p);
    setCwd(np);
    setHist((h) => [...h.slice(0, hi + 1), np]);
    setHi((i) => i + 1);
  }, [hi]);
  const goBack = () => { if (hi > 0) { setHi(hi - 1); setCwd(hist[hi - 1]); } };
  const goForward = () => { if (hi < hist.length - 1) { setHi(hi + 1); setCwd(hist[hi + 1]); } };

  /* ---------- 行打开语义:文件夹进入 / 压缩包交外层 / 其他走系统 ---------- */
  const openRow = useCallback((e: FolderEntry) => {
    if (e.isDir) { goto(e.path); return; }
    if (e.isArchive && onOpenArchive) { onOpenArchive(e.path); return; }
    void window.tz.openPath(e.path).then((r) => { if (!r.ok) toast(r.message, 'err'); });
  }, [goto, onOpenArchive, toast]);

  /* ---------- 删除(回收站) ---------- */
  const trashSel = (paths: string[]) => {
    if (!paths.length) return;
    setMenu(null);
    void window.tz.trash(paths).then((r) => {
      if (!r.ok) toast(r.message, 'err');
      else { toast(`已移入回收站 (${paths.length} 项)`); void load(cwd); }
    });
  };

  /* ---------- 排序 + 搜索过滤 ---------- */
  const searching = query.trim().length > 0;
  const rows = useMemo(() => {
    let list = entries;
    if (searching) {
      const q = query.trim().toLowerCase();
      list = list.filter((e) => e.name.toLowerCase().includes(q));
    }
    if (sortKey === 'name') return list; // 读取时已按 目录优先+自然序 排好
    const dirRank = (e: FolderEntry) => (e.isDir ? 0 : 1);
    const cmp = (a: FolderEntry, b: FolderEntry) => {
      const d = dirRank(a) - dirRank(b);
      if (d && sortKey === 'type') return d;
      let r = 0;
      if (sortKey === 'type') r = typeOf(a).localeCompare(typeOf(b)) || a.name.localeCompare(b.name, 'zh-Hans-CN');
      else if (sortKey === 'size') r = a.size - b.size;
      else r = a.mtime.localeCompare(b.mtime);
      return asc ? r : -r;
    };
    return [...list].sort(cmp);
  }, [entries, sortKey, asc, query, searching]);

  /* ---------- 列宽:与 Browser 同一份持久化(listColumnWidths),两视图改动互见 ---------- */
  const [cols, setCols] = useState<Partial<Record<ColKey, number>> & { name?: number }>({});
  const [colDrag, setColDrag] = useState<AnyColKey | null>(null);
  /* 被拖到下限而隐藏的辅助列(名称列恒显);与 Browser 共用 hiddenColumns 持久化 */
  const [hidden, setHidden] = useState<Set<ColKey>>(new Set());
  useEffect(() => { void (async () => { await loadColWidths(setCols); setHidden(new Set(await loadHiddenCols())); })(); }, []);
  const autoW = useMemo<Record<ColKey | 'name', number>>(() => {
    const pad = 12 + 8;
    const fit = (k: ColKey, texts: string[], head: string) => clampCol(k,
      Math.max(
        texts.reduce((m, t) => Math.max(m, measure(t, CELL_FONT)), 0),
        measure(head, HEAD_FONT) + 16,
      ) + pad,
    );
    return {
      /* 名称列按最长文件名收紧(补图标 18 + 间隙 9 + pl-1 4),不吃满剩余空间 */
      name: clampName(Math.max(
        rows.reduce((m, r) => Math.max(m, measure(r.name, CELL_FONT)), 0) + 18 + 9 + 4,
        measure('名称', HEAD_FONT) + 16,
      ) + pad),
      type: fit('type', rows.map(typeOf), '类型'),
      size: fit('size', rows.filter((r) => !r.isDir).map((r) => fmtBytes(r.size)), '大小'),
      time: fit('time', rows.map((r) => r.mtime), '修改时间'),
    };
  }, [rows]);
  const colW = (k: ColKey | 'name') => cols[k] ?? autoW[k];
  const commitCols = (next: typeof cols) => {
    setCols(next);
    void window.tz.setSettings({ listColumnWidths: next });
  };
  /* 隐藏/恢复辅助列:写回 hiddenColumns(与 Browser 共享持久化真相) */
  const setHiddenCols = (next: Set<ColKey>) => {
    setHidden(next);
    void window.tz.setSettings({ hiddenColumns: [...next] });
  };
  const toggleCol = (k: ColKey) => {
    const next = new Set(hidden);
    if (next.has(k)) next.delete(k); else next.add(k);
    setHiddenCols(next);
  };
  const startColDrag = (k: AnyColKey, e: React.PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    /* 各列未拖过时的拖动基准 = 当前自适应宽 */
    const base = cols[k] ?? autoW[k];
    const at = (ev: PointerEvent) => (k === 'name' ? clampName(base + ev.clientX - startX) : clampCol(k, base + ev.clientX - startX));
    const move = (ev: PointerEvent) => setCols((p) => ({ ...p, [k]: at(ev) }));
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setColDrag(null);
      /* 拖到最小不弹回原形:向左拖至列宽下限即把该列收起(名称列除外),从表头「更多」恢复 */
      if (k !== 'name' && ev.clientX < startX && base + ev.clientX - startX <= COL_LIMITS[k][0]) {
        toggleCol(k);
        return;
      }
      commitCols({ ...cols, [k]: at(ev) });
    };
    setColDrag(k);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  /* ---------- 选择 ---------- */
  const clickRow = (e: FolderEntry, ev: React.MouseEvent) => {
    const cur = e.path;
    if (ev.ctrlKey || ev.metaKey) {
      setSel((prev) => { const s = new Set(prev); if (s.has(cur)) s.delete(cur); else s.add(cur); return s; });
    } else if (ev.shiftKey && lastClick.current) {
      const idx = rows.map((r) => r.path);
      const a = idx.indexOf(lastClick.current);
      const b = idx.indexOf(cur);
      if (a >= 0 && b >= 0) {
        const [lo, hi2] = a < b ? [a, b] : [b, a];
        setSel(new Set(idx.slice(lo, hi2 + 1)));
      }
    } else {
      setSel(new Set([cur]));
    }
    lastClick.current = cur;
  };
  const toggleOne = (path: string) => {
    setSel((prev) => { const s = new Set(prev); if (s.has(path)) s.delete(path); else s.add(path); return s; });
  };
  const allChecked = rows.length > 0 && rows.every((r) => sel.has(r.path));
  const toggleAll = () => setSel(allChecked ? new Set() : new Set(rows.map((r) => r.path)));
  const selEntries = [...sel];
  const targets = (row: FolderEntry | null): string[] =>
    row && !sel.has(row.path) ? [row.path] : (selEntries.length ? selEntries : []);
  const selSize = entries.filter((e) => sel.has(e.path)).reduce((s, e) => s + e.size, 0);

  /* ---------- 快捷键:Enter 打开 / Del 回收站 / Ctrl+A 全选 / Alt+←→ 历史 ---------- */
  const stateRef = useRef({ sel: new Set<string>(), rows: [] as FolderEntry[] });
  stateRef.current = { sel, rows };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const { sel: s, rows: r } = stateRef.current;
      if (e.key === 'Delete' && s.size) trashSel([...s]);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSel(new Set(r.map((x) => x.path)));
      }
      if (e.key === 'Enter' && !e.ctrlKey && !e.altKey) {
        const one = r.filter((x) => s.has(x.path));
        if (one.length === 1) { e.preventDefault(); openRow(one[0]); }
      }
      if (e.altKey && e.key === 'ArrowLeft') goBack();
      if (e.altKey && e.key === 'ArrowRight') goForward();
      if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); goto(parentOf(cwd)); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- 右键菜单 ---------- */
  const menuItems = (row: FolderEntry | null): CtxItem[] => {
    const t = targets(row);
    const items: CtxItem[] = [];
    if (row) {
      items.push({ label: '打开', icon: <IconOpen />, kbd: 'Enter', onClick: () => openRow(row) });
      if (row.isDir) items.push({ label: '在新窗口浏览', icon: <IconFolder />, onClick: () => void window.tz.browseWindowOpen(row.path) });
      items.push({ sep: true, label: '' });
    }
    if (t.length) {
      items.push({ label: `压缩选中 (${t.length} 项)…`, icon: <IconArchive />, onClick: () => onCompress?.(t) });
      items.push({ sep: true, label: '' });
      items.push({ label: '在资源管理器中显示', icon: <IconReveal />, onClick: () => void window.tz.revealInExplorer(t[0]) });
      items.push({ label: '复制路径', onClick: () => void navigator.clipboard.writeText(t.join('\n')).then(() => toast('已复制到剪贴板')) });
      items.push({ sep: true, label: '' });
      items.push({ label: `移入回收站 (${t.length} 项)`, icon: <IconDelete />, danger: true, kbd: 'Del', onClick: () => trashSel(t) });
    } else {
      items.push({ label: '新建压缩包…', icon: <IconAdd />, onClick: () => onCompress?.([]) });
      items.push({ label: '刷新', icon: <IconRefresh />, onClick: () => void load(cwd) });
      items.push({ label: '在资源管理器中打开', icon: <IconReveal />, onClick: () => void window.tz.openPath(cwd) });
    }
    return items;
  };
  const onContextMenu = (e: React.MouseEvent, row: FolderEntry | null) => {
    e.preventDefault();
    if (row && !sel.has(row.path)) setSel(new Set([row.path]));
    setMenu({ x: e.clientX, y: e.clientY, row });
  };

  const sortHead = (k: SortKey, label: string) => (
    <div className="relative flex h-full min-w-0 items-center">
      <button
        onClick={() => { if (sortKey === k) setAsc(!asc); else { setSortKey(k); setAsc(k === 'name'); } }}
        className={cn(
          'flex h-full w-full items-center rounded px-1.5 text-xs transition-colors hover:bg-accent hover:text-foreground active:bg-[var(--bg-active)]',
          sortKey === k && 'font-semibold text-primary',
          colDrag === k && 'bg-[var(--accent-hover)] text-primary-foreground hover:bg-[var(--accent-hover)] hover:text-primary-foreground',
        )}>
        {label}{sortKey === k ? (asc ? ' ↑' : ' ↓') : ''}
      </button>
      <span
        aria-hidden
        title="拖拽调整列宽 · 双击恢复自动宽度"
        onPointerDown={(e) => startColDrag(k, e)}
        onDoubleClick={() => commitCols({ ...cols, [k]: undefined })}
        className={cn(
          'absolute -right-[6px] top-0 z-10 h-full w-[11px] cursor-col-resize touch-none',
          'after:absolute after:inset-y-1 after:left-[5px] after:w-px after:bg-border after:transition-all hover:after:left-[4px] hover:after:w-[3px] hover:after:bg-primary/50',
          colDrag === k && 'after:left-[4px] after:w-[3px] after:bg-primary/70',
        )}
      />
    </div>
  );

  const moreItems: CtxItem[] = [
    { label: '刷新 (F5)', icon: <IconRefresh />, onClick: () => void load(cwd) },
    { label: '新建压缩包…', icon: <IconAdd />, onClick: () => onCompress?.([]) },
    { label: '在新窗口浏览当前目录', icon: <IconFolder />, onClick: () => void window.tz.browseWindowOpen(cwd) },
    { sep: true, label: '' },
    /* 列显示/隐藏开关:拖到最小收起的列从这里恢复 */
    ...HIDEABLE_COLS.map((c) => ({ label: hidden.has(c.key) ? `显示${c.label}列` : `隐藏${c.label}列`, onClick: () => toggleCol(c.key) })),
    { sep: true, label: '' },
    { label: '在资源管理器中打开', icon: <IconReveal />, onClick: () => void window.tz.openPath(cwd) },
  ];

  const folderName = cwd.split('/').filter(Boolean).pop() ?? cwd;

  return (
    <div className="@container flex min-h-0 flex-1 flex-col bg-background">
      {/* 独立窗口迷你标题栏:Logo + 目录名 + 窗控(窗控 IPC 按 sender 定位) */}
      {standalone && (
        <header className="app-drag flex h-[38px] shrink-0 items-center gap-2 bg-secondary pl-3 text-[12.5px] font-semibold">
          <span className="flex size-[18px] shrink-0 items-center justify-center">
            <AppLogo className="size-[18px]" />
          </span>
          <span className="min-w-0 truncate" title={cwd}>{folderName} - TongZip</span>
          <div className="app-nodrag ml-auto flex items-center">
            <button className="inline-flex h-[38px] w-[40px] items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-[var(--bg-active)]"
              title="最小化" onClick={() => window.tz.winMinimize()}><IconMin className="size-3" /></button>
            <button className="inline-flex h-[38px] w-[44px] items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-[var(--bg-active)]"
              title="最大化" onClick={() => window.tz.winMaximize()}><IconMax className="size-3" /></button>
            <button className="inline-flex h-[38px] w-[44px] items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
              title="关闭" onClick={() => window.tz.winClose()}><IconClose className="size-3" /></button>
          </div>
        </header>
      )}

      {/* 导航行:返回/前进/上级/主页 + 面包屑 + 搜索 */}
      <div className="flex flex-none items-center gap-1.5 bg-background px-4 py-2">
        <button className={ARROW_CLS} title="返回 (Alt+←)" disabled={hi === 0} onClick={goBack}><IconBack className="size-4" /></button>
        <button className={ARROW_CLS} title="前进 (Alt+→)" disabled={hi >= hist.length - 1} onClick={goForward}><IconForward className="size-4" /></button>
        <button className={ARROW_CLS} title="上级目录 (Alt+↑)" onClick={() => goto(parentOf(cwd))}><IconUp className="size-4" /></button>
        <button className={ARROW_CLS} title="主目录" onClick={() => goto('C:/')}><IconHome className="size-4" /></button>
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-[13px] [scrollbar-width:none]">
          {pathSegs(cwd).map((s, i, arr) => (
            <span key={s.path} className="inline-flex min-w-0 shrink-0 items-center">
              {i > 0 && <span className="text-muted-foreground"><IconChevronRight className="size-3.5" /></span>}
              <button className={cn(CRUMB_CLS, i === arr.length - 1 && 'font-semibold text-foreground')}
                title={s.path} onClick={() => goto(s.path)}>{s.label}</button>
            </span>
          ))}
        </div>
        <div className="tb-search flex h-7 min-w-[140px] max-w-[260px] flex-1 basis-0 items-center gap-[7px] rounded-[14px] border border-border/80 bg-background px-2.5 text-muted-foreground transition-[border-color,box-shadow] hover:border-input focus-within:border-primary focus-within:shadow-[0_0_0_3px_var(--ring)]" title="搜索当前文件夹 (Ctrl+F)">
          <IconSearch className="size-3.5 shrink-0" />
          <Input value={query} placeholder="搜索当前文件夹…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
            className="h-auto w-auto min-w-0 flex-1 border-0 bg-transparent px-0 py-0 text-[12.5px] text-foreground shadow-none outline-none focus-visible:border-transparent focus-visible:ring-0" />
        </div>
      </div>

      {/* 动作行 */}
      <div className="flex flex-none items-center gap-2 border-b border-border bg-background px-4 py-2">
        <Button variant="outline" className={TB_OUTLINE_CLS} onClick={() => onCompress?.(selEntries)} title="把选中项添加进压缩包 (Ctrl+N)">
          <IconAdd /><span className="@max-[640px]:hidden">添加压缩包</span>
        </Button>
        <Button variant="outline" className={TB_OUTLINE_CLS} onClick={() => onCompress?.(selEntries)} title="压缩选中/当前目录内容">
          <IconArchive /><span className="@max-[640px]:hidden">压缩选中</span>
        </Button>
        <Button variant="ghost" className={cn(TB_CLS, 'ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive')}
          onClick={() => trashSel(targets(null))} disabled={!selEntries.length} title="移入回收站 (Del)">
          <IconDelete /><span className="@max-[640px]:hidden">删除</span>
        </Button>
        <Button variant="ghost" className={TB_CLS} onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setMoreMenu({ x: r.right - 220, y: r.bottom + 4 });
        }} title="更多操作"><IconMore /></Button>
      </div>

      {/* 列表:表头 sticky + 行网格,与压缩包浏览同款 */}
      <div className="flex min-h-0 flex-1">
        <div
          className={cn('entry-list min-h-0 flex-1 overflow-auto pb-5', colDrag && 'select-none')}
          style={{ '--col-name': `${colW('name')}px`, '--col-type': isHiddenCol(hidden, 'type') ? '0px' : `${colW('type')}px`, '--col-size': isHiddenCol(hidden, 'size') ? '0px' : `${colW('size')}px`, '--col-time': isHiddenCol(hidden, 'time') ? '0px' : `${colW('time')}px` } as React.CSSProperties}
          onContextMenu={(e) => onContextMenu(e, null)}
        >
          <div className={cn(LIST_GRID, 'list-head sticky top-0 z-[1] h-8 border-b border-border bg-background text-xs text-muted-foreground')}>
            <label className="ck-box head-ck flex h-full items-center justify-center" title={allChecked ? '取消全选' : '全选'} onClick={toggleAll}>
              <input type="checkbox" checked={allChecked} readOnly className={CK_CLS} />
            </label>
            {sortHead('name', '名称')}
            {isHiddenCol(hidden, 'type') ? <span aria-hidden /> : sortHead('type', '类型')}
            {isHiddenCol(hidden, 'size') ? <span aria-hidden /> : sortHead('size', '大小')}
            {isHiddenCol(hidden, 'time') ? <span aria-hidden /> : sortHead('time', '修改时间')}
            <span aria-hidden />
          </div>
          {err && (
            <div className="mx-4 mt-4 flex items-center gap-2.5 rounded-lg border border-border bg-secondary px-3.5 py-3 text-[12.5px]">
              <IconWarn className="size-4 shrink-0 text-[color:var(--warn)]" />
              <span className="min-w-0 flex-1">{err}</span>
              <Button variant="outline" className={TB_CLS} onClick={() => goto(parentOf(cwd))}>返回上级</Button>
            </div>
          )}
          {!err && !loading && rows.length === 0 && (
            <div className="empty-note py-16 text-center text-[13px] text-muted-foreground">
              {searching ? `没有匹配 “${query.trim()}” 的文件` : '空文件夹'}
            </div>
          )}
          {!err && rows.map((r) => (
            <div key={r.path}
              className={cn(LIST_GRID, 'row group h-8 cursor-default', sel.has(r.path) ? 'sel bg-primary/[.13] hover:bg-primary/[.13] active:bg-primary/20 shadow-[inset_0_0_0_1px_var(--ring)]' : 'hover:bg-accent active:bg-[var(--bg-active)]')}
              data-path={r.path} title={r.name}
              onClick={(e) => clickRow(r, e)}
              onDoubleClick={() => openRow(r)}
              onContextMenu={(e) => { e.stopPropagation(); onContextMenu(e, r); }}>
              <label className="ck-box flex items-center justify-center" onClick={(e) => { e.stopPropagation(); toggleOne(r.path); }}>
                <input type="checkbox" checked={sel.has(r.path)} readOnly className={CK_CLS} />
              </label>
              <div className="name flex min-w-0 items-center gap-[9px] pl-1">
                <FileGlyph name={r.name} isDir={r.isDir} size={18} />
                <span className="truncate">{r.name}</span>
              </div>
              {isHiddenCol(hidden, 'type') ? <span aria-hidden /> : <div className="type truncate px-1.5 text-[12.5px] tabular-nums text-muted-foreground">{typeOf(r)}</div>}
              {isHiddenCol(hidden, 'size') ? <span aria-hidden /> : <div className="size truncate px-1.5 text-[12.5px] tabular-nums text-secondary-foreground">{r.isDir ? '' : fmtBytes(r.size)}</div>}
              {isHiddenCol(hidden, 'time') ? <span aria-hidden /> : <div className="time truncate px-1.5 text-[12.5px] tabular-nums text-secondary-foreground">{r.mtime}</div>}
              <span aria-hidden />
            </div>
          ))}
        </div>
      </div>

      {/* 状态栏 */}
      <div className="flex h-[30px] flex-none items-center gap-[18px] border-t border-border bg-secondary px-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center">
          <i className="mr-[7px] inline-block size-1.5 shrink-0 rounded-full bg-primary align-[1px]" />
          {rows.length} 个项目{selEntries.length > 0 && ` · 已选中 ${selEntries.length} 个 (${fmtBytes(selSize)})`}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono" title={cwd}>{cwd}</span>
        <span className="ml-auto font-mono">{loading ? '读取中…' : '文件夹'}</span>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.row)} onClose={() => setMenu(null)} />}
      {moreMenu && <ContextMenu x={moreMenu.x} y={moreMenu.y} items={moreItems} onClose={() => setMoreMenu(null)} />}
    </div>
  );
}
