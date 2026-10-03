/** TongZip 图标集 — 现代线性风格,统一 stroke 与视觉重量 */
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
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

export const IconCompress = (p: P) => (
  <svg {...base(p)}><path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4M8 12h8" /></svg>
);
export const IconPause = (p: P) => (
  <svg {...base(p)}><path d="M9.5 5v14M14.5 5v14" /></svg>
);
export const IconPlay = (p: P) => (
  <svg {...base(p)}><path d="M7 4.8v14.4L19 12 7 4.8Z" /></svg>
);
export const IconEye = (p: P) => (
  <svg {...base(p)}><path d="M2.8 12S6.5 5.6 12 5.6 21.2 12 21.2 12 17.5 18.4 12 18.4 2.8 12 2.8 12Z" /><circle cx="12" cy="12" r="2.7" /></svg>
);
/** 详情面板切换:右侧带分隔线与条目短线的圆角矩形 */
export const IconPanel = (p: P) => (
  <svg {...base(p)}><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M14 4.5v15" /><path d="M16.5 9.5h2M16.5 12.5h2" /></svg>
);
/** 侧边栏切换:左侧带分隔线与条目短线的圆角矩形(IconPanel 镜像) */
export const IconSidebar = (p: P) => (
  <svg {...base(p)}><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M10 4.5v15" /><path d="M5.5 9.5h2M5.5 12.5h2" /></svg>
);
/** 目录树切换:左侧带分支节点的圆角矩形 */
export const IconTree = (p: P) => (
  <svg {...base(p)}><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M9 8.5h7M9 12h7M9 15.5h4" /><path d="M6.2 8.5h.01M6.2 12h.01M6.2 15.5h.01" strokeWidth={2.2} /></svg>
);
export const IconExtract = (p: P) => (
  <svg {...base(p)}><path d="M12 4v10m0 0 3.5-3.5M12 14l-3.5-3.5M5 18h14" /></svg>
);
export const IconAdd = (p: P) => (
  <svg {...base(p)}><path d="M12 6v12M6 12h12" /></svg>
);
export const IconTest = (p: P) => (
  <svg {...base(p)}><path d="m5 12 4 4 10-10" /></svg>
);
export const IconDelete = (p: P) => (
  <svg {...base(p)}><path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13M10 11v6M14 11v6" /></svg>
);
export const IconInfo = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></svg>
);
export const IconWarn = (p: P) => (
  <svg {...base(p)}><path d="M12 4 2.8 19h18.4L12 4Z" /><path d="M12 10v4M12 16.5h.01" /></svg>
);
export const IconClose = (p: P) => (
  <svg {...base(p)}><path d="M6 6l12 12M18 6 6 18" /></svg>
);
export const IconMin = (p: P) => <svg {...base(p)}><path d="M5 12h14" /></svg>;
export const IconMax = (p: P) => <svg {...base(p)}><rect x="5.5" y="5.5" width="13" height="13" rx="2" /></svg>;
export const IconBack = (p: P) => (
  <svg {...base(p)}><path d="M14 6l-6 6 6 6" /></svg>
);
export const IconUp = (p: P) => (
  <svg {...base(p)}><path d="M6 13l6-6 6 6M9 18h6" /></svg>
);
export const IconFolder = (p: P) => (
  <svg {...base(p)}><path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2.5h7a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 18 18.5H5a1.5 1.5 0 0 1-1.5-1.5v-9.5Z" /></svg>
);
export const IconFile = (p: P) => (
  <svg {...base(p)}><path d="M6.5 3.5h7l4 4v13h-11v-17Z" /><path d="M13.5 3.5v4h4" /></svg>
);
export const IconLock = (p: P) => (
  <svg {...base(p)}><rect x="6" y="10.5" width="12" height="9" rx="2" /><path d="M9 10.5V8a3 3 0 0 1 6 0v2.5" /></svg>
);
export const IconSettings = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="3.2" /><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.5 1.5M16.5 16.5 18 18M18 6l-1.5 1.5M7.5 16.5 6 18" /></svg>
);
export const IconSearch = (p: P) => (
  <svg {...base(p)}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
);
export const IconReveal = (p: P) => (
  <svg {...base(p)}><path d="M3.5 7.5h6l2 2.5h9v9a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 19v-11.5Z" /><path d="M3.5 7.5V5A1.5 1.5 0 0 1 5 3.5h4l2 2.5" /></svg>
);
export const IconOpen = (p: P) => (
  <svg {...base(p)}><path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" /></svg>
);
export const IconSpinner = (p: P) => (
  <svg {...base(p)}><path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" /></svg>
);
export const IconSun = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" /></svg>
);
export const IconMoon = (p: P) => (
  <svg {...base(p)}><path d="M19 14.5A7.5 7.5 0 0 1 9.5 5 7.5 7.5 0 1 0 19 14.5Z" /></svg>
);
export const IconAuto = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none" /></svg>
);

/* ---------- 现代文件管理器新增图标 ---------- */

/** 归档盒(新建/压缩包) */
export const IconArchive = (p: P) => (
  <svg {...base(p)}><rect x="3.5" y="4.5" width="17" height="5" rx="1.5" /><path d="M5 9.5V18a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 18V9.5M10 13h4" /></svg>
);
export const IconForward = (p: P) => (
  <svg {...base(p)}><path d="M10 6l6 6-6 6" /></svg>
);
export const IconChevronRight = (p: P) => (
  <svg {...base(p)}><path d="M9.5 6l6 6-6 6" /></svg>
);
export const IconChevronDown = (p: P) => (
  <svg {...base(p)}><path d="M6 9.5l6 6 6-6" /></svg>
);
export const IconClock = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
);
/** 任务列表(任务中心入口) */
export const IconTasks = (p: P) => (
  <svg {...base(p)}><path d="M4 7h5M15 7h5M4 12h9M17 12h3M4 17h5M14 17h6" /></svg>
);
export const IconFolderOpen = (p: P) => (
  <svg {...base(p)}><path d="M3.5 18.5V7a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h6a1.5 1.5 0 0 1 1.5 1.5V10" /><path d="M3.5 18.5 5.8 10.7A1.5 1.5 0 0 1 7.2 9.6H20.4a1 1 0 0 1 .96 1.28l-1.9 7.1a1.5 1.5 0 0 1-1.44 1.02H5a1.5 1.5 0 0 1-1.5-1.5Z" /></svg>
);
export const IconCheckCircle = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="m8.5 12 2.5 2.5 4.5-5" /></svg>
);
export const IconMinus = (p: P) => <svg {...base(p)}><path d="M6 12h12" /></svg>;
export const IconProperties = (p: P) => (
  <svg {...base(p)}><rect x="4.5" y="3.5" width="15" height="17" rx="2" /><path d="M8.5 8h7M8.5 12h7M8.5 16h4" /></svg>
);
/** 重命名(笔+下划线) */
export const IconRename = (p: P) => (
  <svg {...base(p)}><path d="M13.5 5.5 18 10 8.5 19.5H4v-4.5L13.5 5.5Z" /><path d="M4 21.5h16" /></svg>
);
/** 复制(双矩形) */
export const IconCopy = (p: P) => (
  <svg {...base(p)}><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 5.5v-.5a1.5 1.5 0 0 0-1.5-1.5H6a1.5 1.5 0 0 0-1.5 1.5V13a1.5 1.5 0 0 0 1.5 1.5h.5" /></svg>
);

/* ---------- 导航壳新增图标(参考图 Sidebar/TopBar) ---------- */

export const IconHome = (p: P) => (
  <svg {...base(p)}><path d="M4.5 10.5 12 4l7.5 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-4V20H5.5a1 1 0 0 1-1-1v-8.5Z" /></svg>
);
export const IconBell = (p: P) => (
  <svg {...base(p)}><path d="M6 16.5v-5a6 6 0 0 1 12 0v5l1.5 2h-15L6 16.5Z" /><path d="M10 19.5a2 2 0 0 0 4 0" /></svg>
);
/** 更多(···) */
export const IconMore = (p: P) => (
  <svg {...base(p)}><path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth={2.2} /></svg>
);
/** 代码/终端类文件 */
export const IconCode = (p: P) => (
  <svg {...base(p)}><path d="m8.5 9-3 3 3 3M15.5 9l3 3-3 3M13 6.5l-2 11" /></svg>
);
/** 图片类文件 */
export const IconImage = (p: P) => (
  <svg {...base(p)}><rect x="4" y="5" width="16" height="14" rx="2" /><circle cx="9" cy="10" r="1.5" /><path d="m5 17 4.5-5 3.5 4 3-3L20 17" /></svg>
);
