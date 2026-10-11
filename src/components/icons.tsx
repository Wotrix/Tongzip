/** TongZip 图标集 — lucide-react 再导出(保留旧导出名,统一 16px/stroke 1.75 视觉重量)
 *  尺寸策略:lucide 自带 width/height 属性,旧 app.css `.xxx svg{width:..}` 仍可覆盖,迁移期两栈都不破 */
import {
  AppWindow, Archive, Bell, BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, CircleCheck, Clock, Code, Copy,
  Disc3, Eye, ExternalLink, File, FileAudio, FileVideo, FileSpreadsheet, FileText, FileType, Folder, FolderDown, FolderOpen, FolderTree, FolderUp,
  Home, Image, ListChecks, Lock, Minus, Monitor, Moon, MoreHorizontal, OctagonX, PanelLeft, PanelRight,
  Pause, Pencil, Pin, PinOff, Play, Plus, Presentation, RefreshCw, Search, Settings, Shrink, SlidersHorizontal, Square, Sun,
  Trash2, TriangleAlert, LoaderCircle, X,
  type LucideIcon,
} from 'lucide-react';
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

/** 统一封装:默认 16px、stroke 1.75(贴近原手绘粗细),props 可覆盖 */
const mk = (Icon: LucideIcon) =>
  (p: P) => <Icon size={16} strokeWidth={1.75} {...p} />;

/* ---------- 品牌标识(手绘保留,lucide 无对应概念) ---------- */

const base = (p: P) => ({
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, ...p,
});

/** 品牌标识:竹节构成的「T」形印记 */
export function Logo(p: P) {
  return (
    <svg {...base(p)} strokeWidth={1.5}>
      <path d="M9 3.5v17" />
      <path d="M15 3.5v17" />
      <path d="M9 8h6M9 13h6M9 17.5h6" strokeWidth={2.1} />
      <path d="M6.2 5.5c1.6.4 2.9 1.4 3.6 2.8" opacity={0.6} />
      <path d="M17.8 5.5c-1.6.4-2.9 1.4-3.6 2.8" opacity={0.6} />
    </svg>
  );
}

/** 落地页大字标:竹与风结合 */
export function BrandMark(p: P) {
  return (
    <svg {...base(p)} strokeWidth={1.3}>
      <path d="M12 21V4" />
      <path d="M12 8c-2.6-.3-4.7-2-5.7-4.4 2.9-.3 5 1.2 5.7 4.4Z" fill="currentColor" fillOpacity={0.14} />
      <path d="M12 8c2.6-.3 4.7-2 5.7-4.4-2.9-.3-5 1.2-5.7 4.4Z" fill="currentColor" fillOpacity={0.14} />
      <path d="M12 13c-2.6-.3-4.7-2-5.7-4.4 2.9-.3 5 1.2 5.7 4.4Z" fill="currentColor" fillOpacity={0.1} />
      <path d="M12 13c2.6-.3 4.7-2 5.7-4.4-2.9-.3-5 1.2-5.7 4.4Z" fill="currentColor" fillOpacity={0.1} />
      <path d="M7.5 3.5h9" strokeWidth={2} />
    </svg>
  );
}

/* ---------- 功能图标:lucide 映射 ---------- */

export const IconCompress = mk(Shrink);
export const IconPause = mk(Pause);
export const IconPlay = mk(Play);
export const IconEye = mk(Eye);
/** 详情面板切换 */
export const IconPanel = mk(PanelRight);
/** 侧边栏切换 */
export const IconSidebar = mk(PanelLeft);
/** 目录树切换 */
export const IconTree = mk(FolderTree);
/** 解压(落folder+下箭头) */
export const IconExtract = mk(FolderDown);
export const IconAdd = mk(Plus);
export const IconTest = mk(Check);
export const IconDelete = mk(Trash2);
export const IconInfo = mk(FileText);
export const IconWarn = mk(TriangleAlert);
export const IconClose = mk(X);
export const IconMin = mk(Minus);
export const IconMax = mk(Square);
export const IconBack = mk(ChevronLeft);
/** 返回上级目录 */
export const IconUp = mk(FolderUp);
export const IconFolder = mk(Folder);
export const IconFile = mk(File);
export const IconLock = mk(Lock);
export const IconSettings = mk(Settings);
export const IconSearch = mk(Search);
/** 在资源管理器中显示 */
export const IconReveal = mk(FolderOpen);
export const IconOpen = mk(ExternalLink);
export const IconSpinner = mk(LoaderCircle);
export const IconSun = mk(Sun);
export const IconMoon = mk(Moon);
/** 主题跟随系统 */
export const IconAuto = mk(Monitor);
export const IconArchive = mk(Archive);
export const IconForward = mk(ChevronRight);
export const IconChevronRight = mk(ChevronRight);
export const IconChevronDown = mk(ChevronDown);
export const IconClock = mk(Clock);
/** 任务中心入口 */
export const IconTasks = mk(ListChecks);
export const IconFolderOpen = mk(FolderOpen);
export const IconCheckCircle = mk(CircleCheck);
export const IconMinus = mk(Minus);
/** 属性/详细信息 */
export const IconProperties = mk(SlidersHorizontal);
/** 重命名 */
export const IconRename = mk(Pencil);
export const IconCopy = mk(Copy);
export const IconHome = mk(Home);
export const IconBell = mk(Bell);
/** 更多(···) */
export const IconMore = mk(MoreHorizontal);
/** 代码/终端类文件 */
export const IconCode = mk(Code);
/** 图片类文件 */
export const IconImage = mk(Image);
/** 文档类文件(pdf/word/文本共用形,靠色区分) */
export const IconFileText = mk(FileText);
/** 音频文件 */
export const IconFileAudio = mk(FileAudio);
/** 视频文件 */
export const IconFileVideo = mk(FileVideo);
/** 表格文件 */
export const IconSheet = mk(FileSpreadsheet);
/** 演示文稿 */
export const IconSlide = mk(Presentation);
/** 电子书 */
export const IconBook = mk(BookOpen);
/** 可执行/安装包 */
export const IconApp = mk(AppWindow);
/** 字体文件 */
export const IconFont = mk(FileType);
/** 光盘/镜像文件 */
export const IconDisc = mk(Disc3);
/** 停止任务(Bandizip 式红叉钮) */
export const IconStop = mk(OctagonX);
/** 窗口置顶(图钉) */
export const IconPin = mk(Pin);
/** 取消置顶 */
export const IconPinOff = mk(PinOff);
/** 刷新目录 */
export const IconRefresh = mk(RefreshCw);
