/**
 * 压缩包浏览 — 参考图形态:
 * 导航行:返回/前进 + 面包屑 + 搜索
 * 动作行:解压到(主按钮+下拉) · 添加文件 · 新建压缩包 · 右侧删除/更多
 * 右侧常显面板:压缩包属性(存储位置可复制) / 选中单文件时切文件详情+预览
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ArchiveEntry, ArchiveInfo, EntryPreview } from '@shared/types';
import {
  IconAdd, IconArchive, IconBack, IconChevronDown, IconForward, IconChevronRight, IconCopy,
  IconDelete, IconExtract, IconFolder, IconInfo, IconMore, IconOpen, IconRename, IconSearch,
  IconClose, IconReveal, IconTest, IconPanel, IconTree, IconSidebar,
} from '../components/icons';
import FileGlyph, { EntryGlyph } from '../components/FileGlyph';
import { ContextMenu, useToast, type CtxItem } from '../components/ui';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { cn } from '@/lib/utils';
import { fmtBytes, fmtRatio, basename, parentDir, FORMAT_LABEL } from '../lib/format';

/* ---------- T11 版式令牌:导航行 / 动作行 / 状态栏(平移自 app.css 同名区块) ---------- */

/** 返回/前进/侧栏开关箭头:30px 方形 ghost 图标钮,.on 态用 accent 单点提示 */
const ARROW_CLS = cn(
  'inline-flex size-[30px] shrink-0 items-center justify-center rounded-md',
  'text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
  'disabled:opacity-50 disabled:hover:bg-transparent',
);
/** 面包屑段落:悬停浅底、超宽省略(旧 .crumb) */
const CRUMB_CLS = cn(
  'block max-w-[260px] shrink-0 truncate rounded-md px-2 py-1 text-[13px]',
  'text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
);
/** 工具栏按钮皮肤(旧 .tbtn:32px 高 / 12.5px 字 / 15px 图标),与 shadcn Button 尺寸类同层级覆盖 */
const TB_CLS = cn(
  'h-8 shrink-0 gap-[7px] rounded-md px-3 text-[12.5px] font-normal whitespace-nowrap',
  /* button 基座带 [&_svg:not([class*=size-])]:size-4(选择器多一层 :not, specificity 更高),
     所以图标尺寸必须带 ! 才能压住它 — 否则全部沦为 16px */
  'has-[>svg]:px-3 shadow-none [&_svg]:size-[15px]!',
);
/** 描边按钮(旧 .tbtn.bordered):暗色下沿用页面底,不吃 shadcn 的 input/30 灰底 */
const TB_OUTLINE_CLS = cn(TB_CLS, 'border-border bg-background dark:bg-background dark:hover:bg-accent');

/** 浏览导航状态(由 App 上提历史,Browser 导航行消费) */
export interface NavState {
  archive: string;
  prefix: string;
  canBack: boolean;
  canForward: boolean;
  onBack(): void;
  onForward(): void;
  onGoto(prefix: string): void;
}

export interface BrowserActions {
  onNew(): void;
  onOpenArchive(): void;
  onAdd(): void;
  /** 弹出解压对话框(空数组=全部) */
  onExtract(entries: string[]): void;
  /** 快速解压到同名文件夹 */
  onExtractHere(entries: string[]): void;
  onTest(): void;
  onDelete(entries: string[]): void;
  onOpenFile(entry: ArchiveEntry): void;
  onPreview(entry: ArchiveEntry): void;
  /** 拖条目出窗口 → 解压到桌面级拖拽 */
  onDragOut(entry: ArchiveEntry): void;
  onReveal(): void;
  onCompressAgain(): void;
  /** 重命名磁盘上的压缩包文件 */
  onRenameArchive(): void;
  /** 显示/隐藏左侧导航栏 */
  onToggleSidebar(): void;
}

type SortKey = 'name' | 'type' | 'size' | 'time';

export default function Browser({ info, archive, query, onSearch, actions, nav, sidebarHidden }: {
  info: ArchiveInfo;
  archive: string;
  query: string;
  onSearch: (v: string) => void;
  actions: BrowserActions;
  nav: NavState;
  sidebarHidden: boolean;
}) {
  const prefix = nav.prefix;

  const [sel, setSel] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [asc, setAsc] = useState(true);
  const [menu, setMenu] = useState<{ x: number; y: number; row: ArchiveEntry | null } | null>(null);
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  /* 「解压到」下拉与面板「更多」菜单(复用 ContextMenu 定位) */
  const [extractMenu, setExtractMenu] = useState<{ x: number; y: number } | null>(null);
  const [panelMenu, setPanelMenu] = useState<{ x: number; y: number } | null>(null);
  const [showDetails, setShowDetails] = useState(true);
  /* 目录树:full=200px 面板 / rail=36px 图标窄条 */
  const [treeMode, setTreeMode] = useState<'full' | 'rail'>('full');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [treeMenu, setTreeMenu] = useState<{ x: number; y: number; node: TreeDir } | null>(null);
  const treeRef = useRef<HTMLElement | null>(null);
  const [pv, setPv] = useState<{ entry: ArchiveEntry; data: EntryPreview } | null>(null);
  const [pvBusy, setPvBusy] = useState(false);
  const lastClick = useRef<string | null>(null);
  const dragging = useRef(false);

  /* 搜索时清空选中 */
  useEffect(() => { setSel(new Set()); }, [query]);
  useEffect(() => { setSel(new Set()); }, [prefix]);

  /* 目录树:显式目录条目与文件隐式祖先合并;仅文件夹节点 */
  const treeRoot = useMemo<TreeDir>(() => {
    const root: TreeDir = { name: basename(archive), path: '', kids: [] };
    const index = new Map<string, TreeDir>([['', root]]);
    const dirs = new Set<string>();
    for (const e of info.entries) {
      const p = (e.isDir ? e.path : e.dir).replace(/\/+$/, '');
      let acc = '';
      for (const seg of p.split('/').filter(Boolean)) {
        acc = acc ? `${acc}/${seg}` : seg;
        dirs.add(`${acc}/`);
      }
    }
    /* 浅层先建,保证父节点必已在 index 中;加/删条目后 info 刷新自动重建,展开集按路径保留 */
    for (const p of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) {
      const cut = p.lastIndexOf('/', p.length - 2);
      const parent = index.get(cut < 0 ? '' : p.slice(0, cut + 1)) ?? root;
      const node: TreeDir = { name: p.slice(cut + 1, -1), path: p, kids: [] };
      parent.kids.push(node);
      index.set(p, node);
    }
    const sortKids = (d: TreeDir) => { d.kids.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })); d.kids.forEach(sortKids); };
    sortKids(root);
    return root;
  }, [info, archive]);

  /* 面包屑/双击/历史导航时自动展开当前路径的各级祖先 */
  useEffect(() => {
    setExpanded((prev) => {
      const s = new Set(prev);
      let acc = '';
      for (const seg of prefix.split('/').filter(Boolean)) {
        acc += `${seg}/`;
        s.add(acc);
      }
      return s;
    });
  }, [prefix]);

  /* 可见行拉平序列:渲染与键盘导航共用单一真相 */
  const visibleRows = useMemo(() => {
    const out: { node: TreeDir; depth: number }[] = [];
    const walk = (d: TreeDir, depth: number) => {
      out.push({ node: d, depth });
      if (depth === 0 || expanded.has(d.path)) d.kids.forEach((k) => walk(k, depth + 1));
    };
    walk(treeRoot, 0);
    return out;
  }, [treeRoot, expanded]);

  /* 导航后高亮行自动滚入视口 */
  useEffect(() => {
    if (treeMode !== 'full') return;
    treeRef.current?.querySelector('.bt-row.on')?.scrollIntoView({ block: 'nearest' });
  }, [prefix, treeMode, visibleRows]);

  /* 键盘焦点行跟随 focusPath 真实 DOM focus */
  useEffect(() => {
    if (treeMode !== 'full' || focusPath === null) return;
    const esc = focusPath.replace(/"/g, '\\"');
    const el = treeRef.current?.querySelector<HTMLElement>(`.bt-row[data-path="${esc}"]`);
    el?.focus();
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusPath, treeMode]);

  /* 搜索模式:跨目录按文件名匹配 */
  const searching = query.trim().length > 0;

  const rows = useMemo(() => {
    let list: ArchiveEntry[];
    if (searching) {
      const q = query.trim().toLowerCase();
      list = info.entries.filter((e) => !e.isDir && e.name.toLowerCase().includes(q));
    } else {
      /* 直接子级:显式条目 + 从无目录条目的包合成隐式目录(与树口径一致)
         7za 对 zip 目录条目不置 Folder 标志,只以尾斜杠结尾,这里统一归一 isDir */
      const norm = (e: ArchiveEntry): ArchiveEntry =>
        (e.isDir || e.path.endsWith('/')) && !e.isDir ? { ...e, isDir: true } : e;
      const kids = info.entries.map(norm).filter((e) => {
        if (!e.path.startsWith(prefix)) return false;
        const rest = e.path.slice(prefix.length);
        return rest.length > 0 && rest !== '/';
      });
      list = kids.filter((e) => {
        const rest = e.path.slice(prefix.length);
        return !rest.slice(0, -1).includes('/'); // 除末尾斜杠外无更深一层 = 直接子级
      });
      /* 仅从各级「祖先目录」合成(不含文件自身段),尾斜杠=目录约定 */
      const own = new Set(kids.map((e) => e.path));
      const synth = new Map<string, ArchiveEntry>();
      for (const e of kids) {
        const segs = e.path.slice(prefix.length).split('/').filter(Boolean);
        let acc = prefix;
        for (let i = 0; i < segs.length - 1; i++) {
          acc = acc ? `${acc}${segs[i]}/` : `${segs[i]}/`;
          if (!own.has(acc) && !synth.has(acc)) {
            synth.set(acc, { path: acc, dir: acc.slice(0, acc.lastIndexOf('/', acc.length - 2) + 1), name: segs[i], isDir: true, size: 0, packed: 0, mtime: '', encrypted: false });
          }
        }
      }
      list = [...list, ...synth.values()];
    }
    const dirRank = (e: ArchiveEntry) => (e.isDir ? 0 : 1);
    const typeOf = (e: ArchiveEntry) => typeLabel(e).toLowerCase();
    const cmp = (a: ArchiveEntry, b: ArchiveEntry) => {
      const d = dirRank(a) - dirRank(b);
      if (d && sortKey === 'name') return d;
      let r = 0;
      if (sortKey === 'name') r = a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
      else if (sortKey === 'type') r = typeOf(a).localeCompare(typeOf(b)) || a.name.localeCompare(b.name, 'zh-Hans-CN');
      else if (sortKey === 'size') r = a.size - b.size;
      else r = a.mtime.localeCompare(b.mtime);
      return asc ? r : -r;
    };
    return [...list].sort(cmp);
  }, [info, prefix, sortKey, asc, query, searching]);

  /* Delete / Enter / Ctrl+A / Ctrl+E 等快捷键(与菜单项 kbd 标注一致) */
  const stateRef = useRef({ sel: new Set<string>(), rows: [] as ArchiveEntry[] });
  stateRef.current = { sel, rows };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const { sel: s, rows: r } = stateRef.current;
      if (e.key === 'Delete' && s.size) actions.onDelete([...s]);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSel(new Set(r.map((x) => x.path)));
      }
      /* Enter = 打开唯一选中项(文件夹进目录,文件外部打开) */
      if (e.key === 'Enter' && !e.ctrlKey && !e.altKey) {
        const one = r.filter((x) => s.has(x.path));
        if (one.length === 1) { e.preventDefault(); openRow(one[0]); }
      }
      /* Ctrl+E = 解压选中(无选中=解压全部) */
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        actions.onExtract([...s]);
      }
      if (e.altKey && e.key === 'ArrowLeft') nav.onBack();
      if (e.altKey && e.key === 'ArrowRight') nav.onForward();
      if (e.altKey && e.key.toLowerCase() === 'd') { e.preventDefault(); setShowDetails((v) => !v); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const clickRow = (e: ArchiveEntry, ev: React.MouseEvent) => {
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
  const targets = (row: ArchiveEntry | null): string[] =>
    row && !sel.has(row.path) ? [row.path] : (selEntries.length ? selEntries : []);

  /* 目录判定双保险:zip 目录条目常无 Folder 标志,以尾斜杠为准;前缀约定 = 带尾斜杠路径 */
  const openRow = (r: ArchiveEntry) =>
    (r.isDir || r.path.endsWith('/')) ? nav.onGoto(r.path.endsWith('/') ? r.path : `${r.path}/`) : actions.onOpenFile(r);

  /* 详情预览:单选非目录文件时自动加载(搜索模式下条目带路径,预览同样可用) */
  const loadPreview = async (r: ArchiveEntry) => {
    setPvBusy(true);
    const res = await window.tz.previewEntry(archive, r.path);
    if (res.ok) setPv({ entry: r, data: res.data });
    else { setPv(null); if (r.encrypted) actions.onPreview(r); }
    setPvBusy(false);
  };
  const selFiles = rows.filter((x) => sel.has(x.path));
  useEffect(() => {
    if (!showDetails) return;
    if (selFiles.length === 1 && !selFiles[0].isDir) void loadPreview(selFiles[0]);
    else setPv(null);
  }, [showDetails, sel, rows, prefix]); // eslint-disable-line react-hooks/exhaustive-deps

  /* 右键菜单项 */
  const menuItems = (row: ArchiveEntry | null): CtxItem[] => {
    const t = targets(row);
    const items: CtxItem[] = [];
    if (row) {
      items.push({ label: '打开', icon: <IconOpen />, kbd: 'Enter', onClick: () => openRow(row) });
      if (!row.isDir && t.length === 1) {
        items.push({ label: '复制文件名', onClick: () => void copyName(row.name) });
      }
      items.push({ sep: true, label: '' });
    }
    items.push({ label: t.length ? `解压选中 (${t.length} 项)…` : '解压全部…', icon: <IconExtract />, kbd: 'Ctrl+E', onClick: () => actions.onExtract(t) });
    if (t.length) {
      items.push({ label: '解压到同名文件夹', icon: <IconArchive />, onClick: () => actions.onExtractHere(t) });
    }
    items.push({ sep: true, label: '' });
    items.push({ label: '添加到压缩包…', icon: <IconAdd />, disabled: searching, onClick: actions.onAdd });
    items.push({ label: '测试压缩包', icon: <IconTest />, onClick: actions.onTest });
    items.push({ label: '再压缩一份', icon: <IconArchive />, onClick: actions.onCompressAgain });
    items.push({ label: '在资源管理器中显示', icon: <IconReveal />, onClick: actions.onReveal });
    if (t.length && !searching) {
      items.push({ sep: true, label: '' });
      items.push({ label: `删除 ${t.length} 项`, icon: <IconDelete />, danger: true, kbd: 'Del', onClick: () => actions.onDelete(t) });
    }
    return items;
  };

  const onContextMenu = (e: React.MouseEvent, row: ArchiveEntry | null) => {
    e.preventDefault();
    if (row && !sel.has(row.path)) setSel(new Set([row.path]));
    setMenu({ x: e.clientX, y: e.clientY, row });
  };

  /* 复制文件名到剪贴板(带降级路径,反馈用 toast) */
  const toast = useToast();
  const copyName = async (name: string) => {
    try {
      await navigator.clipboard.writeText(name);
      toast(`已复制「${name}」`);
    } catch {
      toast('复制失败', 'err');
    }
  };

  /* 复制压缩包磁盘路径(反馈用 toast) */
  const copyPath = async (p: string) => {
    try {
      await navigator.clipboard.writeText(p);
      toast('已复制到剪贴板');
    } catch {
      toast('复制失败', 'err');
    }
  };

  const sortHead = (k: SortKey, label: string, right = false) => (
    <button onClick={() => { if (sortKey === k) setAsc(!asc); else { setSortKey(k); setAsc(k === 'name'); } }}
      className={`${sortKey === k ? 'active' : ''} ${right ? 'r' : ''}`}>
      {label}{sortKey === k ? (asc ? ' ↑' : ' ↓') : ''}
    </button>
  );

  const selSize = info.entries.filter((e) => sel.has(e.path)).reduce((s, e) => s + e.size, 0);
  const detail = selFiles.length === 1 ? selFiles[0] : null;

  /* ---------- 目录树交互 ---------- */
  const toggleExpand = (path: string) => {
    setExpanded((prev) => { const s = new Set(prev); if (s.has(path)) s.delete(path); else s.add(path); return s; });
  };

  /* 树容器键盘导航:↑↓移动 / →展开或跳子 / ←折叠或跳父 / Enter进入 */
  const onTreeKey = (e: React.KeyboardEvent) => {
    const cur = focusPath ?? prefix;
    const idx = Math.max(0, visibleRows.findIndex((r) => r.node.path === cur));
    const { node } = visibleRows[idx];
    const parentPath = node.path ? (node.path.lastIndexOf('/') === 0 ? '' : node.path.slice(0, node.path.lastIndexOf('/', node.path.length - 2) + 1)) : '';
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusPath(visibleRows[e.key === 'ArrowDown' ? Math.min(visibleRows.length - 1, idx + 1) : Math.max(0, idx - 1)].node.path);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (node.kids.length) {
        if (node.path && !expanded.has(node.path)) setExpanded((p) => new Set(p).add(node.path));
        else setFocusPath(node.kids[0].path);
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (node.path && node.kids.length && expanded.has(node.path)) toggleExpand(node.path);
      else if (node.path) setFocusPath(parentPath);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      nav.onGoto(node.path);
    }
  };

  /* 树节点右键菜单:根=整包,子目录=按条目路径解压该目录 */
  const treeMenuItems = (node: TreeDir): CtxItem[] => {
    const isRoot = node.path === '';
    const items: CtxItem[] = [
      { label: '打开', icon: <IconOpen />, onClick: () => nav.onGoto(node.path) },
      { sep: true, label: '' },
      { label: isRoot ? '解压全部…' : `解压「${node.name}」…`, icon: <IconExtract />, kbd: 'Ctrl+E', onClick: () => actions.onExtract(isRoot ? [] : [node.path]) },
    ];
    if (!isRoot) {
      items.push({ label: '解压到同名文件夹', icon: <IconArchive />, onClick: () => actions.onExtractHere([node.path]) });
    }
    items.push({ sep: true, label: '' });
    items.push({ label: '复制路径', onClick: () => void copyName(isRoot ? archive : node.path.replace(/\/$/, '')) });
    return items;
  };

  const moreItems: CtxItem[] = [
    { label: '打开其他压缩包…', icon: <IconArchive />, onClick: actions.onOpenArchive },
    { label: '测试压缩包', icon: <IconTest />, onClick: actions.onTest },
    { label: '再压缩一份', icon: <IconArchive />, onClick: actions.onCompressAgain },
    { label: '重命名压缩包…', icon: <IconRename />, onClick: actions.onRenameArchive },
    { sep: true, label: '' },
    { label: treeMode === 'full' ? '收起目录树' : '展开目录树', icon: <IconTree />, onClick: () => setTreeMode((m) => (m === 'full' ? 'rail' : 'full')) },
    { label: showDetails ? '隐藏详细信息面板' : '显示详细信息面板', kbd: 'Alt+D', icon: <IconPanel />, onClick: () => setShowDetails((v) => !v) },
    { label: sidebarHidden ? '显示侧边栏' : '隐藏侧边栏', kbd: 'Alt+B', icon: <IconSidebar />, onClick: actions.onToggleSidebar },
    { label: '在资源管理器中显示', icon: <IconReveal />, onClick: actions.onReveal },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {/* 导航行:箭头 + 面包屑 + 搜索 */}
      <div className="flex flex-none items-center gap-1.5 bg-background px-4 py-2">
        <button className={cn(ARROW_CLS, !sidebarHidden && 'text-primary hover:text-primary')}
          title={`${sidebarHidden ? '显示' : '隐藏'}侧边栏 (Alt+B)`}
          onClick={actions.onToggleSidebar}><IconSidebar className="size-4" /></button>
        <button className={ARROW_CLS} title="返回 (Alt+←)" disabled={!nav.canBack} onClick={() => nav.onBack()}><IconBack className="size-4" /></button>
        <button className={ARROW_CLS} title="前进 (Alt+→)" disabled={!nav.canForward} onClick={() => nav.onForward()}><IconForward className="size-4" /></button>
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-[13px]">
          <button className={cn(CRUMB_CLS, 'inline-flex items-center gap-1.5 [&>span]:min-w-0 [&>span]:truncate', !nav.prefix && 'font-semibold text-foreground')}
            title={nav.archive} onClick={() => nav.onGoto('')}>
            <IconFolder className="size-3.5 shrink-0 text-primary" /><span>{basename(nav.archive)}</span>
          </button>
          {nav.prefix.split('/').filter(Boolean).map((c, i, arr) => {
            const p = arr.slice(0, i + 1).join('/') + '/';
            const last = i === arr.length - 1;
            return (
              <span key={p} className="inline-flex min-w-0 items-center">
                <span className="inline-flex text-muted-foreground"><IconChevronRight className="size-3.5" /></span>
                <button className={cn(CRUMB_CLS, last && 'font-semibold text-foreground')} onClick={() => nav.onGoto(p)}>{c}</button>
              </span>
            );
          })}
        </div>
        {/* tb-search 类名 = App.tsx Ctrl+F 聚焦选择器钩子,不承载样式 */}
        <div className="tb-search ml-auto flex h-7 w-[260px] flex-none items-center gap-[7px] rounded-[14px] border border-transparent bg-background px-2.5 text-muted-foreground transition-[border-color,box-shadow] focus-within:border-primary focus-within:shadow-[0_0_0_3px_var(--ring)]" title="搜索压缩包内全部条目 (Ctrl+F)">
          <IconSearch className="size-3.5 shrink-0" />
          <Input
            value={query}
            placeholder="搜索当前压缩包中的文件…"
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') onSearch(''); }}
            className="h-auto w-auto min-w-0 flex-1 border-0 bg-transparent px-0 py-0 text-[12.5px] md:text-[12.5px] text-foreground shadow-none outline-none focus-visible:border-transparent focus-visible:ring-0"
          />
        </div>
      </div>

      {/* 动作行:解压到(主按钮+下拉) · 添加文件 · 新建压缩包 · 右侧删除/更多 */}
      <div className="flex flex-none items-center gap-2 border-b border-border bg-background px-4 py-2">
        <div className="inline-flex items-stretch">
          <Button className={cn(TB_CLS, 'rounded-r-none font-semibold')} onClick={() => actions.onExtract(selEntries)} title="解压 (Ctrl+E)"><IconExtract /> 解压到</Button>
          <Button className={cn(TB_CLS, 'w-auto gap-0 rounded-l-none border-l border-primary-foreground/30 px-[7px] has-[>svg]:px-[7px] [&_svg]:size-[13px]!')}
            title="解压选项" aria-label="解压选项"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setExtractMenu({ x: Math.max(8, r.left - 8), y: r.bottom + 4 });
            }}><IconChevronDown /></Button>
        </div>
        <Button variant="outline" className={TB_OUTLINE_CLS} onClick={actions.onAdd} title="将文件添加进当前压缩包"><IconAdd /> 添加文件</Button>
        <Button variant="outline" className={TB_OUTLINE_CLS} onClick={actions.onNew} title="新建压缩包 (Ctrl+N)"><IconArchive /> 新建压缩包</Button>
        <Button variant="ghost" className={cn(TB_CLS, 'ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive')} onClick={() => actions.onDelete(selEntries)} disabled={!selEntries.length} title="删除选中条目 (Del)"><IconDelete /> 删除</Button>
        <Button variant="ghost" className={TB_CLS} onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setMoreMenu({ x: r.right - 200, y: r.bottom + 4 });
        }} title="更多操作"><IconMore /></Button>
      </div>

      {/* 目录树 + 文件列表 + 详情面板 */}
      <div className="flex min-h-0 flex-1">
        {treeMode === 'rail' ? (
          <aside className="br-tree rail" title="展开目录树">
            <button className="bt-rail-btn" onClick={() => setTreeMode('full')}><IconTree /></button>
          </aside>
        ) : (
          <aside className="br-tree" ref={treeRef} tabIndex={0} aria-label="压缩包目录树" onKeyDown={onTreeKey}>
            {visibleRows.map(({ node, depth }) => {
              const open = depth === 0 || expanded.has(node.path);
              return (
                <div key={node.path}
                  className={`bt-row ${prefix === node.path ? 'on' : ''}`}
                  data-path={node.path}
                  tabIndex={-1}
                  style={{ paddingLeft: 6 + depth * 14 }}
                  title={node.path === '' ? archive : node.path}
                  onClick={() => { setFocusPath(node.path); nav.onGoto(node.path); }}
                  onContextMenu={(e) => { e.preventDefault(); setTreeMenu({ x: e.clientX, y: e.clientY, node }); }}>
                  <span className={`bt-chev ${open ? 'open' : ''} ${node.kids.length ? '' : 'leaf'}`}
                    onClick={(e) => { e.stopPropagation(); if (node.kids.length) toggleExpand(node.path); }}>
                    {node.kids.length > 0 && <IconChevronRight />}
                  </span>
                  <IconFolder className="bt-ico" />
                  <span className="bt-name ellipsis">{node.name}</span>
                </div>
              );
            })}
          </aside>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="list-head">
            <label className="ck-box head-ck" title={allChecked ? '取消全选' : '全选'} onClick={toggleAll}>
              <input type="checkbox" checked={allChecked} readOnly />
            </label>
            {sortHead('name', '名称')}
            {sortHead('type', '类型')}
            {sortHead('size', '大小', true)}
            {sortHead('time', '修改时间', true)}
          </div>
          <div className="entry-list" onContextMenu={(e) => onContextMenu(e, null)}>
            {rows.length === 0 && (
              <div className="empty-note">{searching ? `没有匹配 “${query.trim()}” 的文件` : '空文件夹'}</div>
            )}
            {rows.map((r) => (
              <Row
                key={r.path} r={r} selected={sel.has(r.path)}
                onCheck={() => toggleOne(r.path)}
                onMouseDown={() => { dragging.current = false; }}
                onClick={(e) => clickRow(r, e)}
                onDouble={() => openRow(r)}
                /* 阻止冒泡:否则 entry-list 的空白区 handler 会随后把菜单覆盖成无行版 */
                onContextMenu={(e) => { e.stopPropagation(); onContextMenu(e, r); }}
                onDragStart={(e) => {
                  if (r.isDir || searching) { e.preventDefault(); return; }
                  e.preventDefault(); // 交出 HTML5 拖拽,由主进程 startDrag 接管
                  if (!dragging.current) {
                    dragging.current = true;
                    actions.onDragOut(r);
                    window.setTimeout(() => { dragging.current = false; }, 1200);
                  }
                }}
                onDragEnd={() => { dragging.current = false; }}
              />
            ))}
          </div>
        </div>

        {showDetails && (
          <aside className="detail-pane">
            <button className="icon-btn dp-close" title="关闭面板 (Alt+D)" onClick={() => setShowDetails(false)}><IconClose style={{ width: 12, height: 12 }} /></button>
            {detail ? (
              <>
                <div className="dp-hero">
                  <span className="dp-glyph"><FileGlyph name={detail.name} isDir={detail.isDir} encrypted={detail.encrypted} size={40} /></span>
                  <b className="dp-name" title={detail.path}>{detail.name}</b>
                  <span className="dp-sub">{typeLabel(detail)} · {detail.isDir ? '' : fmtBytes(detail.size)}</span>
                </div>
                <div className="dp-acts">
                  {!detail.isDir && <DpAct icon={<IconOpen />} label="打开" onClick={() => actions.onOpenFile(detail)} />}
                  <DpAct icon={<IconExtract />} label="解压" onClick={() => actions.onExtract([detail.path])} />
                  {!searching && <DpAct icon={<IconDelete />} label="删除" danger onClick={() => actions.onDelete([detail.path])} />}
                  <DpAct icon={<IconMore />} label="更多" onClick={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setPanelMenu({ x: Math.max(8, r.right - 190), y: r.bottom + 4 });
                  }} />
                </div>
                <div className="dp-info">
                  <div className="dp-row"><span>类型</span><b>{detail.isDir ? '文件夹' : typeLabel(detail)}</b></div>
                  <div className="dp-row"><span>大小</span><b>{detail.isDir ? '-' : fmtBytes(detail.size)}</b></div>
                  {!!detail.packed && !detail.isDir && <div className="dp-row"><span>压缩后</span><b>{fmtBytes(detail.packed)} ({fmtRatio(detail.size, detail.packed)})</b></div>}
                  <div className="dp-row"><span>修改时间</span><b>{detail.mtime || '-'}</b></div>
                  <div className="dp-row"><span>位置</span><b className="ellipsis" title={`${archive}/${detail.path}`}>{detail.path}</b></div>
                  {detail.encrypted && <div className="dp-row"><span>加密</span><b style={{ color: 'var(--warn)' }}>已加密</b></div>}
                </div>
                <div className="dp-preview">
                  {pvBusy && <div className="empty-note">正在提取预览…</div>}
                  {!pvBusy && detail.isDir && <div className="empty-note">文件夹不支持预览</div>}
                  {!pvBusy && !detail.isDir && !pv && <div className="empty-note">该文件暂无可用预览</div>}
                  {!pvBusy && pv?.entry.path === detail.path && pv.data.kind === 'text' && (
                    <pre className="pv-text">{pv.data.text}{pv.data.truncated ? '\n…(内容过大,已截断)' : ''}</pre>
                  )}
                  {!pvBusy && pv?.entry.path === detail.path && pv.data.kind === 'image' && (
                    <img className="pv-img" src={pv.data.dataUrl} alt={pv.data.name} />
                  )}
                </div>
              </>
            ) : selFiles.length > 1 ? (
              <>
                <div className="dp-hero">
                  <b className="dp-name">已选中 {selFiles.length} 项</b>
                  <span className="dp-sub">合计 {fmtBytes(selSize)}</span>
                </div>
                <div className="dp-acts">
                  <DpAct icon={<IconExtract />} label="解压" onClick={() => actions.onExtract(selEntries)} />
                  <DpAct icon={<IconDelete />} label="删除" danger onClick={() => actions.onDelete(selEntries)} />
                </div>
                <div className="dp-info">
                  {selFiles.slice(0, 8).map((e) => (
                    <div className="dp-row" key={e.path}><span title={e.name} className="ellipsis">{e.name}</span><b>{fmtBytes(e.size)}</b></div>
                  ))}
                  {selFiles.length > 8 && <div className="dp-row"><span className="muted">其余 {selFiles.length - 8} 项…</span><b /></div>}
                </div>
              </>
            ) : (
              <>
                <div className="dp-hero">
                  <span className="dp-glyph"><FileGlyph name={basename(archive)} isDir={false} size={40} /></span>
                  <b className="dp-name" title={archive}>{basename(archive)}</b>
                  <span className="dp-sub">{FORMAT_LABEL[info.type] ?? `${info.type.toUpperCase()} 压缩包`} · {fmtBytes(info.physSize)}</span>
                </div>
                <div className="dp-acts">
                  <DpAct icon={<IconExtract />} label="解压到" onClick={() => actions.onExtract([])} />
                  <DpAct icon={<IconAdd />} label="添加文件" onClick={actions.onAdd} />
                  <DpAct icon={<IconRename />} label="重命名" onClick={actions.onRenameArchive} />
                  <DpAct icon={<IconMore />} label="更多" onClick={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setPanelMenu({ x: Math.max(8, r.right - 190), y: r.bottom + 4 });
                  }} />
                </div>
                <div className="dp-sec-title">文件信息</div>
                <div className="dp-info">
                  <div className="dp-row"><span>格式</span><b>{info.type.toUpperCase()}</b></div>
                  <div className="dp-row"><span>项目数</span><b>{info.entries.filter((e) => !e.isDir && !e.path.endsWith('/')).length}</b></div>
                  <div className="dp-row"><span>原始大小</span><b>{fmtBytes(info.entries.reduce((s, e) => s + (e.isDir ? 0 : e.size), 0))}</b></div>
                  <div className="dp-row"><span>压缩大小</span><b>{fmtBytes(info.entries.reduce((s, e) => s + (e.isDir ? 0 : (e.packed || e.size)), 0))}</b></div>
                  <div className="dp-row"><span>加密状态</span><b style={info.hasEncrypted ? { color: 'var(--warn)' } : undefined}>{info.hasEncrypted ? '包含加密内容' : '无'}</b></div>
                  <div className="dp-row">
                    <span>存储位置</span>
                    <b className="ellipsis" title={archive}>{parentDir(archive)}</b>
                    <button className="dp-copy" title="复制存储位置" onClick={() => void copyPath(parentDir(archive))}><IconCopy /></button>
                  </div>
                </div>
                <div className={`dp-note ${info.hasEncrypted ? 'warn' : ''}`}>
                  <IconInfo style={{ width: 14, height: 14, flex: 'none' }} />
                  <span>{info.hasEncrypted
                    ? '这个压缩包包含加密内容，解压时需要输入密码。'
                    : '这是一个文件压缩包，可以解压查看其中的内容。'}</span>
                </div>
              </>
            )}
          </aside>
        )}
      </div>

      {/* 状态栏:左侧计数,中部显示压缩包磁盘路径(过长省略,悬停看全) */}
      <div className="flex h-[30px] flex-none items-center gap-[18px] border-t border-border bg-secondary px-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center"><i className="mr-[7px] inline-block size-1.5 shrink-0 rounded-full bg-primary align-[1px]" />{rows.length} 个项目{selEntries.length > 0 && ` · 已选中 ${selEntries.length} 个 (${fmtBytes(selSize)})`}</span>
        {info.hasEncrypted && <span className="text-[color:var(--warn)]">包含加密内容</span>}
        <span className="min-w-0 flex-1 truncate font-mono" title={archive}>{archive}</span>
        <span className="ml-auto font-mono">
          {searching ? `搜索: ${query.trim()}` : `${info.type.toUpperCase()} · ${fmtBytes(info.physSize)}`}
        </span>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.row)} onClose={() => setMenu(null)} />}
      {moreMenu && <ContextMenu x={moreMenu.x} y={moreMenu.y} items={moreItems} onClose={() => setMoreMenu(null)} />}
      {extractMenu && <ContextMenu x={extractMenu.x} y={extractMenu.y} onClose={() => setExtractMenu(null)} items={[
        { label: selEntries.length ? `解压选中 (${selEntries.length} 项)…` : '解压全部…', icon: <IconExtract />, kbd: 'Ctrl+E', onClick: () => actions.onExtract(selEntries) },
        { label: '解压到同名文件夹', icon: <IconArchive />, disabled: !selEntries.length, onClick: () => actions.onExtractHere(selEntries) },
      ]} />}
      {panelMenu && <ContextMenu x={panelMenu.x} y={panelMenu.y} onClose={() => setPanelMenu(null)} items={[
        ...(detail && !detail.isDir
          ? [
            { label: '复制文件名', onClick: () => void copyName(detail.name) },
            { label: '复制所在路径', onClick: () => void copyPath(archive) },
            { sep: true, label: '' },
            { label: '在资源管理器中显示压缩包', icon: <IconReveal />, onClick: actions.onReveal },
            { label: '删除此条目', icon: <IconDelete />, danger: true, disabled: searching, onClick: () => actions.onDelete([detail.path]) },
          ]
          : [
            { label: '测试压缩包', icon: <IconTest />, onClick: actions.onTest },
            { label: '在资源管理器中显示', icon: <IconReveal />, onClick: actions.onReveal },
            { label: '打开其他压缩包…', icon: <IconArchive />, onClick: actions.onOpenArchive },
          ]),
      ]} />}
      {treeMenu && <ContextMenu x={treeMenu.x} y={treeMenu.y} items={treeMenuItems(treeMenu.node)} onClose={() => setTreeMenu(null)} />}
    </div>
  );
}

/** 面板动作按钮:上图标下文字,与设计稿一致 */
function DpAct({ icon, label, danger, onClick }: {
  icon: React.ReactNode; label: string; danger?: boolean; onClick(e: React.MouseEvent): void;
}) {
  return (
    <button className={`dp-act-btn ${danger ? 'danger' : ''}`} onClick={onClick}>
      {icon}<span>{label}</span>
    </button>
  );
}

function Row({ r, selected, onCheck, onMouseDown, onClick, onDouble, onContextMenu, onDragStart, onDragEnd }: {
  r: ArchiveEntry; selected: boolean;
  onCheck(): void;
  onMouseDown(e: React.MouseEvent): void;
  onClick(e: React.MouseEvent): void;
  onDouble(): void;
  onContextMenu(e: React.MouseEvent): void;
  onDragStart(e: React.DragEvent): void;
  onDragEnd(): void;
}) {
  return (
    <div
      className={`row ${selected ? 'sel' : ''}`}
      data-path={r.path}
      title={r.path}
      draggable={!r.isDir}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onDoubleClick={onDouble}
      onContextMenu={onContextMenu}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <label className="ck-box" onClick={(e) => { e.stopPropagation(); onCheck(); }}>
        <input type="checkbox" checked={selected} readOnly />
      </label>
      <div className="name">
        <EntryGlyph entry={r} size={18} />
        <span title={r.path}>{r.name}</span>
      </div>
      <div className="type">{typeLabel(r)}</div>
      <div className="size" title={r.packed ? `压缩后 ${fmtBytes(r.packed)}` : undefined}>
        {r.isDir ? '' : fmtBytes(r.size)}
      </div>
      <div className="time">{r.mtime}</div>
    </div>
  );
}

/** 目录树节点(path 为带尾斜杠的前缀,根为 '') */
interface TreeDir { name: string; path: string; kids: TreeDir[] }

function typeLabel(e: ArchiveEntry): string {
  if (e.isDir) return '文件夹';
  const m = e.name.match(/\.([A-Za-z0-9]{1,6})$/);
  return m ? `${m[1].toUpperCase()} 文件` : '文件';
}
