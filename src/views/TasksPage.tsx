/**
 * 任务中心页 — 左侧「正在进行/已完成」标签,右侧任务卡片列表(复用浮层卡片)
 */
import { useState } from 'react';
import { useTaskHub } from '../components/ui';
import { RunningCard, HistoryRow } from '../components/TaskCenter';

export default function TasksPage() {
  const { jobs, history, clearHistory } = useTaskHub();
  const [tab, setTab] = useState<'running' | 'done'>('running');

  return (
    <div className="page tasks-page">
      <div className="page-head">
        <h2>任务中心</h2>
        <p className="page-sub">压缩 · 解压 · 测试 · 删除任务都在这里跟踪,可随时暂停或取消。</p>
      </div>
      <div className="tasks-layout">
        <aside className="tasks-tabs">
          <button className={`ttab ${tab === 'running' ? 'on' : ''}`} onClick={() => setTab('running')}>
            正在进行 <em>{jobs.length}</em>
          </button>
          <button className={`ttab ${tab === 'done' ? 'on' : ''}`} onClick={() => setTab('done')}>
            已完成 <em>{history.length}</em>
          </button>
        </aside>
        <div className="tasks-body">
          {tab === 'running' && (jobs.length === 0
            ? <div className="pg-empty">当前没有进行中的任务<br /><small>从首页或浏览页发起的压缩/解压会出现在这里</small></div>
            : jobs.map((j) => <RunningCard key={j.taskId} job={j} />))}
          {tab === 'done' && (history.length === 0
            ? <div className="pg-empty">还没有已完成的任务</div>
            : (
              <div className="done-wrap">
                <div className="done-bar">
                  <span>最近 {history.length} 条记录(仅本次会话)</span>
                  <button className="tbtn sm" onClick={clearHistory}>清空</button>
                </div>
                {history.map((h) => <HistoryRow key={h.taskId + h.at} h={h} />)}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
