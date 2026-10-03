/**
 * 左侧导航栏 — 参考图布局:品牌块 · 主导航(active 浅蓝圆角 pill)· 底部标语
 */
import { Logo, IconHome, IconClock, IconArchive, IconTasks, IconSettings, IconFolderOpen } from './icons';

export type View = 'home' | 'recent' | 'archives' | 'tasks' | 'settings' | 'browse';

const NAV: { v: View; label: string; icon: typeof IconHome }[] = [
  { v: 'home', label: '首页', icon: IconHome },
  { v: 'recent', label: '最近文件', icon: IconClock },
  { v: 'archives', label: '我的压缩包', icon: IconArchive },
  { v: 'tasks', label: '任务中心', icon: IconTasks },
  { v: 'settings', label: '设置', icon: IconSettings },
];

export default function Sidebar({ view, onNav, runningCount, activeArchive, hidden = false }: {
  view: View;
  onNav: (v: View) => void;
  runningCount: number;
  /** 已打开的压缩包名:额外渲染一个「正在浏览」入口 */
  activeArchive: string | null;
  /** 折叠态:宽度收 0,外部双击打开压缩包时默认隐藏,可由浏览工具栏唤回 */
  hidden?: boolean;
}) {
  return (
    <nav className={`sidebar ${hidden ? 'collapsed' : ''}`}>
      <div className="sb-brand" onDoubleClick={() => onNav('home')}>
        <span className="sb-logo"><Logo /></span>
        <b>TongZip</b>
      </div>
      <div className="sb-nav">
        {NAV.map(({ v, label, icon: Ico }) => (
          <button key={v} className={`sb-item ${view === v ? 'on' : ''}`} onClick={() => onNav(v)}>
            <Ico />
            <span>{label}</span>
            {v === 'tasks' && runningCount > 0 && <em className="sb-badge">{runningCount}</em>}
          </button>
        ))}
        {activeArchive && (
          <button className={`sb-item browse ${view === 'browse' ? 'on' : ''}`} onClick={() => onNav('browse')}
            title={activeArchive}>
            <IconFolderOpen />
            <span className="ellipsis">{activeArchive}</span>
          </button>
        )}
      </div>
      <div className="sb-foot">更简单 · 更高效</div>
    </nav>
  );
}
