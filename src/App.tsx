/**
 * TongZip 渲染中枢 — 壳布局(Sidebar + TopBar + TabBar + 视图区) · 多标签编排 · 对话框 · 全局拖放
 * 视图: home / recent / archives / tasks / settings / browse(压缩包内,多标签)
 * 每个浏览标签独立挂载 TabView(自持 info/导航历史/搜索/选中态),仅显示活动标签;
 * 对话框(压缩/解压/密码/确认)全局唯一,由 Shell 编排。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArchiveEntry, ArchiveFormat, ArchiveInfo, ExtractJob, JobKind, Settings } from '@shared/types';
import { ERR, isArchiveExt } from '@shared/types';
import Home from './views/Home';
import Browser, { type BrowserActions, type NavState } from './views/Browser';
import FolderView from './views/FolderView';
import RecentFiles from './views/RecentFiles';
import MyArchives from './views/MyArchives';
import TasksPage from './views/TasksPage';
import SettingsPage from './views/SettingsPage';
import Sidebar, { SB_DEFAULT, SB_MAX, SB_MIN, type View } from './components/Sidebar';
import TabBar from './components/TabBar';
import TopBar from './components/TopBar';
import CompressDialog from './components/CompressDialog';
import ExtractDialog from './components/ExtractDialog';
import PasswordDialog, { ConfirmDialog } from './components/PasswordDialog';
import RenameDialog from './components/RenameDialog';
import { TaskHubProvider, ToastHost, useTaskHub, useToast, Modal, type TrackedJob } from './components/ui';
import { Button } from './components/ui/button';
import { cn } from '@/lib/utils';
import { IconWarn } from './components/icons';
import { basename, parentDir } from './lib/format';

export interface AppApi {
  trackTask(taskId: string, kind: JobKind, onSettled: (j: TrackedJob) => void, meta?: { label?: string; path?: string; totalBytes?: number }): void;
  askPassword(target: string, onOk: (pw: string) => Promise<boolean>): void;
  lastPassword(key: string): string | undefined;
  /** 按「记住本次会话密码」开关决定是否写入会话缓存 */
  cachePassword(archive: string, pw: string): void;
  refreshArchive(): void;
}

interface Ctx { archive: string; info: ArchiveInfo }

/** 提示条内小按钮(旧 .tbtn.sm:27px / 9px 内边距 / 12px 字) */
const SB_BTN = 'h-[27px] gap-[7px] rounded-md px-[9px] text-xs font-normal shadow-none [&_svg]:size-[15px]';

/** 浏览标签:压缩包标签持有 archive/info;文件夹标签(dir)复用同一套标签栏与 TabView 分流 */
interface Tab extends Ctx { id: string; dir?: string }

/** Shell 注入给 TabView 的全局能力(对话框/任务/密码复用) */
interface HostApi {
  toast: ReturnType<typeof useToast>;
  hub: ReturnType<typeof useTaskHub>;
  askPassword(target: string, onOk: (pw: string) => Promise<boolean>): void;
  lastPassword(key: string): string | undefined;
  openCompress(v: { sources: string[]; format?: ArchiveFormat; appendTo?: string }): void;
  openExtract(v: { archive: string; entries: string[]; totalBytes?: number }): void;
  confirm(v: { title: string; body: string; onOk: () => void }): void;
  openRename(archive: string): void;
  toggleSidebar(): void;
  quickExtract(archive: string, intoSameDir?: boolean, entries?: string[], password?: string, totalBytes?: number,
    overwrite?: ExtractJob['overwrite']): Promise<void>;
  pickAndOpen(): Promise<void>;
  /** 主窗:在标签中打开压缩包(文件夹标签内双击条目用) */
  openInTab(archive: string): Promise<void>;
  registerReload(fn: (() => Promise<void>) | null): void;
}

function Shell() {
  const toast = useToast();
  const hub = useTaskHub();
  const [view, setView] = useState<View>('home');
  /* 多标签:每个 tab 携带打开时的 info,后续状态全部由 TabView 自管 */
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const tabSeq = useRef(0);
  /* 活动标签的重新载入句柄(压缩追加完成后由 refreshArchive 触发) */
  const reloadRef = useRef<(() => Promise<void>) | null>(null);
  const [compress, setCompress] = useState<{ sources: string[]; format?: ArchiveFormat; appendTo?: string } | null>(null);
  const [extract, setExtract] = useState<{ archive: string; entries: string[]; totalBytes?: number } | null>(null);
  const [pw, setPw] = useState<{ target: string; error?: string | null; onOk: (pw: string) => Promise<boolean> } | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; body: string; onOk: () => void } | null>(null);
  const [rename, setRename] = useState<{ archive: string; error?: string | null } | null>(null);
  /* ask 解压预检发现目标同名文件:挂起任务,由模态框让用户决策后按所选模式重发 */
  const [conflict, setConflict] = useState<{ archive: string; intoSameDir: boolean; entries: string[]; totalBytes?: number; count: number } | null>(null);
  const [engineWarn, setEngineWarn] = useState<string | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  const [glow, setGlow] = useState(false);
  const dragDepth = useRef(0);
  const pwCache = useRef(new Map<string, string>());
  /* rememberPassword 开关(设置页可实时切换):关闭时缓存只读不写并立即清空(会话内,不落盘) */
  const rememberPw = useRef(false);
  /* 双击/外部打开压缩包的动作(设置页 dblClickAction) */
  const [dblAction, setDblAction] = useState<Settings['dblClickAction']>('open');
  /* 侧边栏:仅冷启动双击压缩包打开软件时自动隐藏(移交/应用内打开不动);手动开关过一次则尊重其选择;宽度可自由拖 76–480(越界橡皮筋阻尼),默认 156 并持久化;
     拖到贴近竖条才收起为竖条(sbCollapsed,持久化),与专注隐藏(sbHidden)独立 */
  const [sbHidden, setSbHidden] = useState(false);
  const [sbCollapsed, setSbCollapsed] = useState(false);
  const [sbW, setSbW] = useState(156);
  const sbTouched = useRef(false);
  /* 手动唤回(Alt+B/工具栏)时顺带解除收起态,保证总有出路 */
  const toggleSidebar = useCallback(() => {
    sbTouched.current = true;
    setSbCollapsed(false);
    void window.tz.setSettings({ sidebarCollapsed: false });
    setSbHidden((v) => !v);
  }, []);
  const collapseSidebar = useCallback(() => {
    setSbCollapsed(true);
    setSbHidden(false); // 收起态自带竖条恢复入口,不再叠加「完全隐藏」语义
    void window.tz.setSettings({ sidebarCollapsed: true });
  }, []);
  const expandSidebar = useCallback(() => {
    setSbCollapsed(false);
    void window.tz.setSettings({ sidebarCollapsed: false });
  }, []);
  const resizeSidebar = useCallback((w: number) => {
    const nu = Math.min(SB_MAX, Math.max(SB_MIN, Math.round(w) || SB_MIN));
    setSbW(nu);
    void window.tz.setSettings({ sidebarWidth: nu });
  }, []);

  const api: AppApi = {
    trackTask: (taskId, kind, onSettled, meta) => hub.track(taskId, kind, onSettled, meta),
    askPassword: (target, onOk) => setPw({ target, onOk }),
    lastPassword: (key) => pwCache.current.get(key),
    cachePassword: (archive, pw) => { if (rememberPw.current && pw) pwCache.current.set(archive, pw); },
    refreshArchive: () => { void reloadRef.current?.(); },
  };

  /* ---------- 初始设置(最近打开 + 强调色 + 双击动作/记住密码开关) ---------- */
  useEffect(() => {
    void (async () => {
      const s = await window.tz.getSettings();
      setRecents(s.recentArchives ?? []);
      setDblAction(s.dblClickAction ?? 'open');
      rememberPw.current = !!s.rememberPassword;
      if (!s.rememberPassword) pwCache.current.clear();
      setSbCollapsed(!!s.sidebarCollapsed);
      if (typeof s.sidebarWidth === 'number' && Number.isFinite(s.sidebarWidth)) {
        setSbW(Math.min(SB_MAX, Math.max(SB_MIN, Math.round(s.sidebarWidth))));
      }
      const acc = (s.accent as string) === 'purple' ? 'violet' : s.accent;
      if (acc && acc !== 'violet') document.documentElement.dataset.accent = acc;
    })();
    /* 设置页实时切换时同步开关;关掉瞬间清空已缓存密码,兑现「关闭应用后清除/仅本会话」承诺 */
    const onPatched = (e: Event) => {
      const p = (e as CustomEvent<Partial<Settings>>).detail;
      if ('rememberPassword' in p) {
        rememberPw.current = !!p.rememberPassword;
        if (!p.rememberPassword) pwCache.current.clear();
      }
      if ('dblClickAction' in p && p.dblClickAction) setDblAction(p.dblClickAction);
    };
    window.addEventListener('tz:settings-patched', onPatched);
    return () => window.removeEventListener('tz:settings-patched', onPatched);
  }, []);

  const pushRecent = useCallback((archive: string) => {
    setRecents((prev) => {
      const next = [archive, ...prev.filter((p) => p !== archive)].slice(0, 8);
      void window.tz.setSettings({ recentArchives: next });
      return next;
    });
  }, []);

  /* 从最近列表移除一项(首页/最近文件页右键菜单) */
  const removeRecent = useCallback((archive: string) => {
    setRecents((prev) => {
      const next = prev.filter((p) => p !== archive);
      void window.tz.setSettings({ recentArchives: next });
      return next;
    });
  }, []);

  /* ---------- 重命名压缩包文件:成功后同步标签路径与最近记录 ---------- */
  const doRename = useCallback(async (oldPath: string, newName: string) => {
    const r = await window.tz.renameArchive(oldPath, newName);
    if (!r.ok) { setRename((s) => (s ? { ...s, error: r.message } : s)); return false; }
    const nu = r.data.newPath.replace(/\\/g, '/');
    if (nu !== oldPath) {
      setTabs((ts) => ts.map((t) => (t.archive === oldPath ? { ...t, archive: nu } : t)));
      setRecents((prev) => {
        const next = prev.map((p) => (p === oldPath ? nu : p));
        void window.tz.setSettings({ recentArchives: next });
        return next;
      });
      pwCache.current.delete(oldPath);
      if (rememberPw.current) {
        const old = pwCache.current.get(oldPath);
        if (old) pwCache.current.set(nu, old);
      }
    }
    setRename(null);
    toast(`已重命名为「${basename(nu)}」`);
    return true;
  }, [toast]);

  /* ---------- 引擎检测 ---------- */
  useEffect(() => {
    void (async () => {
      const r = await window.tz.detectEngine();
      setEngineWarn(r.ok ? null : r.message);
    })();
  }, []);

  /* ---------- 归档事务启动恢复(阶段 3.1):崩溃遗留的还原/清理对用户透明可感知 ---------- */
  useEffect(() => window.tz.onTxnRecovery((info) => {
    if (info.restored.length) {
      toast(`检测到上次异常退出,已还原 ${info.restored.length} 个压缩包(${info.restored.map((p) => p.split(/[\\/]/).pop()).join('、')})。`);
    } else if (info.cleaned.length) {
      toast(`已清理 ${info.cleaned.length} 个上次异常退出遗留的临时文件。`);
    }
  }), [toast]);

  /* ---------- 打开压缩包:已开则切换,否则新标签(含密码重试) ---------- */
  const createTab = useCallback((archive: string, info: ArchiveInfo) => {
    const id = `tab-${++tabSeq.current}`;
    setTabs((ts) => [...ts, { id, archive, info }]);
    setActiveId(id);
    setView('browse');
  }, []);

  const closeTab = useCallback((id: string) => {
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    /* 关标签即撤密:该包缓存密码随视图销毁失效(rememberPassword 开启也只服务打开中的包) */
    if (idx >= 0) pwCache.current.delete(tabs[idx].archive);
    if (!next.length) { setActiveId(null); setView('home'); }
    else if (id === activeId) setActiveId(next[Math.min(idx, next.length - 1)].id);
  }, [tabs, activeId]);

  const openInTab = useCallback(async (archiveRaw: string, password?: string): Promise<void> => {
    const archive = archiveRaw.replace(/\\/g, '/');
    const found = tabs.find((t) => t.archive === archive);
    if (found) { setActiveId(found.id); setView('browse'); return; }
    const r = await window.tz.listArchive(archive, password);
    if (r.ok) {
      createTab(archive, r.data);
      pushRecent(archive);
      if (password) api.cachePassword(archive, password);
      return;
    }
    if (r.code === ERR.NEED_PASSWORD) {
      api.askPassword(archive, async (p) => {
        const rr = await window.tz.listArchive(archive, p);
        if (rr.ok) {
          createTab(archive, rr.data);
          pushRecent(archive);
          api.cachePassword(archive, p);
          return true;
        }
        setPw((s) => (s ? { ...s, error: '密码不正确,请重试。' } : s));
        return false;
      });
      return;
    }
    if (r.code === ERR.ENGINE_MISSING) { setEngineWarn(r.message); return; }
    toast(r.message, 'err');
  }, [tabs, toast, pushRecent, createTab]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- 磁盘文件夹标签(Bandizip 式浏览):同目录已开则切换,否则新建 ---------- */
  const openFolder = useCallback((dirRaw: string) => {
    const dir = dirRaw.replace(/\\/g, '/');
    const found = tabs.find((t) => t.dir === dir);
    if (found) { setActiveId(found.id); setView('browse'); return; }
    const id = `tab-${++tabSeq.current}`;
    setTabs((ts) => [...ts, { id, archive: '', info: { type: '', entries: [], physSize: 0, hasEncrypted: false }, dir }]);
    setActiveId(id);
    setView('browse');
  }, [tabs]);

  /* ---------- 快速解压(entries 为空=全部);overwrite 默认询问,冲突时不启动任务而是弹决策框 ---------- */
  const quickExtract = useCallback(async (
    archive: string, intoSameDir = false, entries: string[] = [], password?: string, totalBytes?: number,
    overwrite: ExtractJob['overwrite'] = 'ask',
  ) => {
    const dest = intoSameDir
      ? parentDir(archive).replace(/\//g, '\\')
      : await window.tz.quickDest(archive);
    const pw2 = password ?? pwCache.current.get(archive);
    const r = await window.tz.extract({ archive, dest, entries, overwrite, password: pw2 });
    if (!r.ok) {
      if (r.code === ERR.ENGINE_MISSING) setEngineWarn(r.message);
      else toast(r.message, 'err');
      return;
    }
    if (r.data.conflicts?.length) {
      setConflict({ archive, intoSameDir, entries, totalBytes, count: r.data.conflicts.length });
      return;
    }
    if (!r.data.taskId) return;
    hub.track(r.data.taskId, 'extract', async (j) => {
      if (j.status === 'done') toast(`已解压到 ${dest}`);
      else if (j.status === 'error') {
        if (j.code === ERR.NEED_PASSWORD || j.message?.includes('密码')) {
          api.askPassword(archive, async (p) => {
            api.cachePassword(archive, p);
            await quickExtract(archive, intoSameDir, entries, p, totalBytes, overwrite);
            return true;
          });
        } else toast(j.message ?? '解压失败', 'err');
      }
    }, { label: basename(archive), path: archive, totalBytes });
    /* 路径登记供任务窗「打开位置」:invoke 返回即写,与 track 注册同时序 */
    void window.tz.taskPathSet(r.data.taskId, { archive, dest: dest.replace(/\\/g, '/') });
  }, [hub, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- shell / 双击 启动指令 ---------- */
  /* coldStart:仅冷启动载荷(getLaunchPayload)会自动折叠侧边栏;运行中二次实例移交不折叠 */
  const handlePayload = useCallback((p: { kind: 'archive' | 'compress'; paths: string[] }, coldStart = false) => {
    const flag = p.paths.find((x) => x.startsWith('--'));
    const real = p.paths.filter((x) => !x.startsWith('--'));
    if (p.kind === 'archive') {
      const archive = real[0];
      if (!archive) return;
      if (flag === '--auto-extract') void quickExtract(archive, false);
      else if (flag === '--extract-here') void quickExtract(archive, true);
      else if (flag === '--extract-dialog') setExtract({ archive, entries: [] });
      else {
        if (coldStart && !sbTouched.current) setSbHidden(true);
        /* 兑现设置项 dblClickAction:资源管理器双击/打开方式进入此分支,按用户选择路由 */
        if (dblAction === 'quickExtract') void quickExtract(archive);
        else if (dblAction === 'extractDialog') setExtract({ archive, entries: [] });
        else void openInTab(archive);
      }
    } else {
      const EXT_TOKENS = ['.7z', '.zip', '.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst', '.tar'];
      const ext = real.find((x) => EXT_TOKENS.includes(x.toLowerCase()));
      const src = real.filter((x) => x !== ext);
      setCompress({ sources: src, format: ext ? extToFormat(ext) : undefined });
    }
  }, [openInTab, quickExtract, dblAction]);

  useEffect(() => {
    void (async () => {
      const p = await window.tz.getLaunchPayload();
      if (p) handlePayload(p, true);
    })();
    return window.tz.onLaunch(handlePayload);
  }, [handlePayload]);

  /* ---------- 全局拖放 + 高亮 ---------- */
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onEnter = (e: DragEvent) => { if (!hasFiles(e)) return; dragDepth.current++; setGlow(true); };
    const onLeave = () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setGlow(false); };
    const onOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0; setGlow(false);
      const files = Array.from(e.dataTransfer?.files ?? []).map((f) => window.tz.pathForFile(f));
      if (files.length) void routeDrop(files);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const routeDrop = async (paths: string[]) => {
    const first = paths[0];
    const ext = first.slice(first.lastIndexOf('.')).toLowerCase();
    if (paths.length === 1 && isArchiveExt(ext.replace(/^\./, ''))) {
      await openInTab(first);
    } else {
      setCompress({ sources: paths });
    }
  };

  /* ---------- 打开选择器(Home/工具栏/标签栏共用,总在新标签打开) ---------- */
  const pickAndOpen = async () => {
    const r = await window.tz.pickFiles();
    if (!r.ok || !r.data.length) return;
    const p = r.data[0].replace(/\\/g, '/');
    const ext = p.slice(p.lastIndexOf('.')).toLowerCase().replace(/^\./, '');
    if (isArchiveExt(ext)) await openInTab(p);
    else toast('所选文件不是可识别的压缩包。', 'err');
  };

  /* ---------- 选一个磁盘文件夹→新标签应内浏览 ---------- */
  const pickFolderAndOpen = useCallback(async () => {
    const r = await window.tz.pickFolder();
    if (r.ok && r.data) openFolder(r.data);
  }, [openFolder]);

  /* ---------- 首页智能动作:压缩包→解压,其他文件→压缩 ---------- */
  const isArchivePath = (p: string) => {
    const dot = p.lastIndexOf('.');
    return dot > 0 && isArchiveExt(p.slice(dot + 1));
  };
  /** 1 个压缩包→弹解压对话框;多个→逐个快速解压到同名文件夹 */
  const extractArchives = (arch: string[]) => {
    if (arch.length === 1) setExtract({ archive: arch[0], entries: [] });
    else arch.forEach((a) => void quickExtract(a, false));
  };
  /** 「压缩」卡:选文件;若全是压缩包则自动转解压 */
  const pickSmartCompress = async () => {
    const r = await window.tz.pickFiles();
    if (!r.ok || !r.data.length) return;
    const paths = r.data.map((p) => p.replace(/\\/g, '/'));
    const arch = paths.filter(isArchivePath);
    if (arch.length === paths.length) {
      toast('检测到都是压缩包,已切换为解压', 'info');
      extractArchives(arch);
    } else {
      /* 混选(意图是压缩):全部进压缩对话框,压缩包作为普通文件一起打包 */
      setCompress({ sources: paths });
    }
  };
  /** 「压缩」卡菜单——选文件夹:文件夹不可能是压缩包,直接进压缩流程 */
  const pickFolderCompress = async () => {
    const r = await window.tz.pickFolder();
    if (r.ok && r.data) setCompress({ sources: [r.data.replace(/\\/g, '/')] });
  };
  /** 「解压」卡:选压缩包;混入的非压缩包忽略并提示 */
  const pickSmartExtract = async () => {
    const r = await window.tz.pickFiles();
    if (!r.ok || !r.data.length) return;
    const paths = r.data.map((p) => p.replace(/\\/g, '/'));
    const arch = paths.filter(isArchivePath);
    if (!arch.length) {
      toast('所选文件不是压缩包格式,已切换为压缩', 'info');
      setCompress({ sources: paths });
      return;
    }
    if (arch.length < paths.length) toast(`已忽略 ${paths.length - arch.length} 个非压缩包文件`);
    extractArchives(arch);
  };

  /* ---------- 全局快捷键 ---------- */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const inInput = tag === 'INPUT' || tag === 'TEXTAREA';
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); setCompress({ sources: [] }); }
      /* Ctrl+T 新标签(选包) / Ctrl+W 关当前标签 / Ctrl+Tab 循环 / Ctrl+1..9 直达 */
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't') { e.preventDefault(); void pickAndOpen(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
        if (activeId) { e.preventDefault(); closeTab(activeId); }
      }
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        if (tabs.length > 1) {
          const i = Math.max(0, tabs.findIndex((t) => t.id === activeId));
          setActiveId(tabs[(i + 1) % tabs.length].id);
          setView('browse');
        }
      }
      if ((e.ctrlKey || e.metaKey) && !inInput && /^[1-9]$/.test(e.key) && tabs[+e.key - 1]) {
        setActiveId(tabs[+e.key - 1].id);
        setView('browse');
      }
      /* Ctrl+E 已下放到 Browser(需感知选中条目:选中=解压选中,无选中=解压全部) */
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        /* 搜索只在打开压缩包后可用;其他页面不响应 */
        if (view === 'browse') {
          e.preventDefault();
          setTimeout(() => document.querySelector<HTMLInputElement>('.tab-slot:not([hidden]) .tb-search input')?.focus(), 60);
        }
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); }
      if (e.key === 'Escape' && !inInput) { setCompress(null); setExtract(null); setPw(null); setRename(null); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [tabs, activeId, view]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- 注入给各 TabView 的全局能力 ---------- */
  const host: HostApi = {
    toast, hub,
    askPassword: api.askPassword,
    lastPassword: api.lastPassword,
    openCompress: (v) => setCompress(v),
    openExtract: (v) => setExtract(v),
    confirm: (v) => setConfirm(v),
    openRename: (a) => setRename({ archive: a }),
    toggleSidebar,
    quickExtract: (a, d, e, p, tb, ov) => quickExtract(a, d ?? false, e ?? [], p, tb, ov),
    pickAndOpen,
    openInTab,
    registerReload: (fn) => { reloadRef.current = fn; },
  };

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const runningCount = hub.jobs.filter((j) => j.status === 'running').length;

  return (
    <div className="app-shell">
      <Sidebar
        view={view}
        hidden={sbHidden && view === 'browse' && !sbCollapsed}
        collapsed={sbCollapsed}
        onExpand={expandSidebar}
        width={sbW}
        onResize={resizeSidebar}
        onCollapse={collapseSidebar}
        runningCount={runningCount}
        activeArchive={activeTab ? basename(activeTab.archive || activeTab.dir || '') : null}
        onNav={(v) => { if (v !== 'browse' || tabs.length) setView(v); }}
      />

      <div className="main-col">
        {/* 侧栏隐藏的浏览视图:顶栏标题位补显示当前压缩包名(竞品标题栏形态,无菜单栏) */}
        <TopBar archiveLabel={sbHidden && view === 'browse' && activeTab ? basename(activeTab.archive || activeTab.dir || '') : null} openArchive={(p) => void openInTab(p)} />
        {engineWarn && (
          <div className="flex flex-none items-center gap-[9px] border-b border-border bg-[var(--warn-soft)] px-4 py-2 text-[12.5px] text-foreground">
            <IconWarn className="size-[15px] shrink-0 text-[color:var(--warn)]" />
            <span>{engineWarn}</span>
            <Button variant="ghost" size="sm" className={cn(SB_BTN, 'ml-auto')} onClick={() => setView('settings')}>去设置</Button>
            <Button variant="ghost" size="sm" className={SB_BTN} onClick={() => void window.tz.detectEngine().then((r) => r.ok && setEngineWarn(null))}>重试</Button>
          </div>
        )}

        <div className="content-panel">
        {view === 'browse' && tabs.length > 0 ? (
          <>
            <TabBar tabs={tabs} activeId={activeId}
              onSelect={(id) => setActiveId(id)}
              onClose={(id) => closeTab(id)}
              onNew={() => void pickAndOpen()}
              onNewFolder={() => void pickFolderAndOpen()} />
            <div className="tabs-stage">
              {tabs.map((t) => (
                <div key={t.id} className="tab-slot" hidden={t.id !== activeId}>
                  <TabView tab={t} active={t.id === activeId} host={host} sbHidden={(sbHidden && view === 'browse') || sbCollapsed} />
                </div>
              ))}
            </div>
          </>
        ) : view === 'home' ? (
          <Home
            recents={recents}
            onOpen={(p) => void openInTab(p)}
            onCompress={() => void pickSmartCompress()}
            onCompressFolder={() => void pickFolderCompress()}
            onNewArchive={() => setCompress({ sources: [] })}
            onExtract={() => void pickSmartExtract()}
            onOpenPick={() => void pickAndOpen()}
            onSeeAllTasks={() => setView('tasks')}
            onSeeRecent={() => setView('recent')}
            onRemoveRecent={removeRecent}
          />
        ) : view === 'recent' ? (
          <RecentFiles recents={recents} onOpen={(p) => void openInTab(p)} onRemoveRecent={removeRecent} />
        ) : view === 'archives' ? (
          <MyArchives
            onOpen={(p) => void openInTab(p)}
            onNew={() => setCompress({ sources: [] })}
          />
        ) : view === 'tasks' ? (
          <TasksPage openArchive={(p) => void openInTab(p)} />
        ) : (
          <SettingsPage />
        )}
        </div>
      </div>

      {glow && <div className="drop-glow">松手开始 — 压缩包将打开,文件将压缩</div>}

      {compress && (
        <CompressDialog
          sources={compress.sources}
          presetFormat={compress.format}
          appendTo={compress.appendTo}
          api={api}
          onClose={() => setCompress(null)}
        />
      )}
      {extract && (
        <ExtractDialog archive={extract.archive} entries={extract.entries} api={api} onClose={() => setExtract(null)}
          totalBytes={extract.totalBytes} />
      )}
      {pw && (
        <PasswordDialog
          target={pw.target}
          error={pw.error}
          onClose={() => setPw(null)}
          onSubmit={async (p) => { if (await pw.onOk(p)) setPw(null); }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          danger
          onOk={confirm.onOk}
          onClose={() => setConfirm(null)}
        />
      )}
      {rename && (
        <RenameDialog
          currentName={basename(rename.archive)}
          error={rename.error}
          onSubmit={(n) => void doRename(rename.archive, n)}
          onClose={() => setRename(null)}
        />
      )}
      {conflict && (
        <Modal title="目标位置已有同名文件" icon={<IconWarn />} onClose={() => setConflict(null)} width={430}>
          <p className="mb-[18px] text-[13px] leading-[1.6] text-muted-foreground">
            解压「{basename(conflict.archive)}」时,目标文件夹中已存在 {conflict.count} 个同名文件。请选择处理方式。
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setConflict(null)}>取消</Button>
            <Button variant="outline" size="sm" onClick={() => { const c = conflict; setConflict(null); void quickExtract(c.archive, c.intoSameDir, c.entries, undefined, c.totalBytes, 'skip'); }}>跳过已有</Button>
            <Button variant="outline" size="sm" onClick={() => { const c = conflict; setConflict(null); void quickExtract(c.archive, c.intoSameDir, c.entries, undefined, c.totalBytes, 'rename'); }}>自动重命名</Button>
            <Button variant="destructive" size="sm" onClick={() => { const c = conflict; setConflict(null); void quickExtract(c.archive, c.intoSameDir, c.entries, undefined, c.totalBytes, 'overwrite'); }}>全部覆盖</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/**
 * 浏览标签实例 — 自持一个压缩包的 info/导航历史/搜索词;
 * 隐藏标签不卸载,选中态/预览/滚动位置等切换后原样保留。
 */
function TabView({ tab, active, host, sbHidden }: { tab: Tab; active: boolean; host: HostApi; sbHidden: boolean }) {
  const [info, setInfo] = useState<ArchiveInfo>(tab.info);
  const [hist, setHist] = useState<string[]>(['']);
  const [hi, setHi] = useState(0);
  const [query, setQuery] = useState('');
  const { toast, hub } = host;
  const archive = tab.archive;
  /* 重命名后 tab.archive 会变:路径变化时自刷新(列表/历史/搜索回到初始态) */
  const loadedRef = useRef(archive);
  useEffect(() => {
    if (loadedRef.current === archive) return;
    loadedRef.current = archive;
    void (async () => {
      const r = await window.tz.listArchive(archive, host.lastPassword(archive));
      if (r.ok) { setInfo(r.data); setHist(['']); setHi(0); setQuery(''); }
      else toast(r.message, 'err');
    })();
  }, [archive]); // eslint-disable-line react-hooks/exhaustive-deps

  const goto = (p: string) => { setHist((h) => [...h.slice(0, hi + 1), p]); setHi(hi + 1); };
  const goBack = () => setHi((i) => Math.max(0, i - 1));
  const goForward = () => setHi((i) => Math.min(hist.length - 1, i + 1));

  /* 重新载入当前包(删除条目/追加完成后),回到包根并清搜索 */
  const reload = async () => {
    const r = await window.tz.listArchive(archive, host.lastPassword(archive));
    if (r.ok) { setInfo(r.data); setHist(['']); setHi(0); setQuery(''); }
    else toast(r.message, 'err');
  };
  /* 活动标签接管全局 refreshArchive 句柄 */
  useEffect(() => { host.registerReload(active ? reload : null); });

  const actions: BrowserActions = {
    onNew: () => host.openCompress({ sources: [] }),
    onOpenArchive: () => void host.pickAndOpen(),
    onAdd: async () => {
      const r = await window.tz.pickFiles();
      if (!r.ok || !r.data.length) return;
      host.openCompress({ sources: r.data, appendTo: archive });
    },
    onExtract: (entries: string[]) => host.openExtract({ archive, entries, totalBytes: info.physSize }),
    onExtractHere: (entries: string[]) => void host.quickExtract(archive, false, entries, undefined, info.physSize),
    onTest: async () => {
      const r = await window.tz.test(archive, host.lastPassword(archive));
      if (!r.ok) { toast(r.message, 'err'); return; }
      hub.track(r.data.taskId, 'test', (j) => {
        if (j.status === 'done') toast('压缩包完好。');
        else if (j.status === 'error') toast(j.message ?? '测试失败', 'err');
      }, { label: basename(archive), path: archive, totalBytes: info.physSize });
      void window.tz.taskPathSet(r.data.taskId, { archive });
    },
    onDelete: (entries: string[]) => {
      if (!entries.length) return;
      host.confirm({
        title: '从压缩包中删除',
        body: `确认删除选中的 ${entries.length} 项?此操作不可撤销。`,
        onOk: async () => {
          /* 密码随删除事务透传:加密头包结构操作需要;副本修改+校验失败均不触碰原包 */
          const r = await window.tz.deleteEntries(archive, entries, host.lastPassword(archive));
          if (!r.ok) { toast(r.message, 'err'); return; }
          hub.track(r.data.taskId, 'delete', async (j) => {
            if (j.status === 'done') { toast('已删除。'); await reload(); }
            else if (j.status === 'error') toast(j.message ?? '删除失败', 'err');
          }, { label: basename(archive), path: archive });
          void window.tz.taskPathSet(r.data.taskId, { archive });
        },
      });
    },
    onOpenFile: async (entry: ArchiveEntry) => {
      /* 本地文件用 shell.openPath 通道打开(open-external 已限制 http/https 协议) */
      const r = await window.tz.extractSingleToTemp(archive, entry.path, host.lastPassword(archive));
      if (!r.ok) {
        if (r.code === ERR.NEED_PASSWORD) {
          host.askPassword(archive, async (p) => {
            const rr = await window.tz.extractSingleToTemp(archive, entry.path, p);
            if (rr.ok) { const o = await window.tz.openPath(rr.data); if (!o.ok) toast(o.message, 'err'); return true; }
            return false;
          });
        } else toast(r.message, 'err');
        return;
      }
      const o = await window.tz.openPath(r.data);
      if (!o.ok) toast(o.message, 'err');
    },
    onPreview: (entry: ArchiveEntry) => {
      toast(`无法预览 ${basename(entry.path)}。`);
    },
    onDragOut: async (entry: ArchiveEntry) => {
      const r = await window.tz.dragEntry(archive, entry.path, host.lastPassword(archive));
      if (!r.ok && r.code !== 'ERROR') toast(r.message, 'err');
    },
    onReveal: () => void window.tz.revealInExplorer(archive),
    onCompressAgain: () => host.openCompress({ sources: [archive] }),
    onRenameArchive: () => host.openRename(archive),
    onToggleSidebar: () => host.toggleSidebar(),
  };

  const nav: NavState = {
    archive,
    prefix: hist[hi],
    canBack: hi > 0,
    canForward: hi < hist.length - 1,
    onBack: goBack,
    onForward: goForward,
    onGoto: goto,
  };

  /* 文件夹标签分流:TabView 钩子已全部执行,此处早退安全 */
  if (tab.dir) {
    return <FolderView dir={tab.dir}
      onOpenArchive={(p) => void host.openInTab(p)}
      onCompress={(sources) => host.openCompress({ sources })} />;
  }

  return <Browser info={info} archive={archive} query={query} onSearch={setQuery} actions={actions} nav={nav} sidebarHidden={sbHidden} />;
}

function extToFormat(ext: string): ArchiveFormat {
  switch (ext) {
    case '.zip': return 'zip';
    case '.tar': return 'tar';
    case '.gz': case '.tgz': return 'tar.gz';
    case '.bz2': return 'tar.bz2';
    case '.xz': case '.txz': return 'tar.xz';
    case '.zst': return 'tar.zst';
    default: return '7z';
  }
}

export default function App() {
  return (
    <ToastHost>
      <TaskHubProvider>
        <Shell />
      </TaskHubProvider>
    </ToastHost>
  );
}
