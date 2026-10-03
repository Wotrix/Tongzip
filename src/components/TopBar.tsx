/**
 * 顶栏 — 只承载拖拽区 + 任务铃铛 + 窗口控制。
 * 返回/前进箭头、面包屑、搜索框已搬入浏览视图自身的导航行(Browser .br-nav),
 * 顶栏在所有视图下形态一致、不再占用内容空间,也不画底部分隔线。
 */
import { useState } from 'react';
import TaskCenter from './TaskCenter';
import { IconMin, IconMax, IconClose, IconBell } from './icons';
import { useTaskHub } from './ui';

export default function TopBar() {
  const { jobs } = useTaskHub();
  const running = jobs.filter((j) => j.status === 'running').length;
  const [tcOpen, setTcOpen] = useState(false);

  return (
    <header className="topbar">
      <div className="tb-spacer" />
      <div className="tb-actions">
        <button className={`icon-btn ${tcOpen ? 'on' : ''}`} title="任务通知" onClick={() => setTcOpen((v) => !v)}>
          <BellGlyph running={running > 0} />
          {running > 0 && <span className="task-badge">{running}</span>}
        </button>
        <span style={{ width: 6 }} />
        <button className="win-btn" title="最小化" onClick={() => window.tz.winMinimize()}><IconMin /></button>
        <button className="win-btn" title="最大化 / 还原" onClick={() => window.tz.winMaximize()}><IconMax /></button>
        <button className="win-btn close" title="关闭" onClick={() => window.tz.winClose()}><IconClose /></button>
      </div>

      {tcOpen && <TaskCenter onClose={() => setTcOpen(false)} />}
    </header>
  );
}

/** 铃铛入口:有进行中任务时轻微脉动 */
function BellGlyph({ running }: { running: boolean }) {
  return (
    <span style={running ? { animation: 'tcbreathe 1.6s ease-in-out infinite', display: 'inline-flex' } : { display: 'inline-flex' }}>
      <IconBell />
      <style>{`@keyframes tcbreathe { 0%,100%{opacity:1} 50%{opacity:.55} }`}</style>
    </span>
  );
}
