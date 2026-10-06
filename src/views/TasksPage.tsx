/**
 * 任务中心页 — 左侧「正在进行/已完成」标签,右侧任务卡片列表(复用浮层卡片)
 */
import { useState } from 'react';
import { useTaskHub } from '../components/ui';
import { RunningCard, HistoryRow } from '../components/TaskCenter';
import { Button } from '../components/ui/button';
import { cn } from '@/lib/utils';

export default function TasksPage() {
  const { jobs, history, clearHistory } = useTaskHub();
  const [tab, setTab] = useState<'running' | 'done'>('running');

  const tabCls = (on: boolean) => cn(
    'relative flex h-[34px] items-center gap-[7px] rounded-lg px-[11px] text-left text-[12.5px]',
    'text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-[var(--bg-active)]',
    on && 'bg-primary/[.12] font-semibold text-primary hover:bg-primary/[.12] active:bg-primary/20 [&_em]:text-primary before:absolute before:left-0 before:top-1/2 before:h-4 before:w-[3px] before:-translate-y-1/2 before:rounded-r-full before:bg-primary',
  );

  return (
    <div className="min-h-0 flex-1 overflow-auto px-8 pt-[26px] pb-12">
      <div className="mb-[18px]">
        <h2 className="text-[19px] font-bold">任务中心</h2>
        <p className="mt-1 text-[12.5px] text-muted-foreground">压缩 · 解压 · 测试 · 删除任务都在这里跟踪,可随时暂停或取消。</p>
      </div>
      <div className="grid grid-cols-[148px_minmax(0,1fr)] items-start gap-[22px]">
        <aside className="sticky top-0 flex flex-col gap-0.5">
          <button className={tabCls(tab === 'running')} onClick={() => setTab('running')}>
            正在进行 <em className="ml-auto text-[11px] not-italic tabular-nums text-muted-foreground">{jobs.length}</em>
          </button>
          <button className={tabCls(tab === 'done')} onClick={() => setTab('done')}>
            已完成 <em className="ml-auto text-[11px] not-italic tabular-nums text-muted-foreground">{history.length}</em>
          </button>
        </aside>
        <div className="flex min-w-0 flex-col gap-1.5">
          {tab === 'running' && (jobs.length === 0
            ? <div className="flex flex-col items-center gap-2.5 py-16 text-center text-[13px] text-muted-foreground">当前没有进行中的任务<br /><small className="text-[11.5px]">从首页或浏览页发起的压缩/解压会出现在这里</small></div>
            : jobs.map((j) => (
              <div key={j.taskId} className="overflow-hidden rounded-[10px] border border-border bg-card">
                <RunningCard job={j} />
              </div>
            )))}
          {tab === 'done' && (history.length === 0
            ? <div className="flex flex-col items-center gap-2.5 py-16 text-center text-[13px] text-muted-foreground">还没有已完成的任务</div>
            : (
              <div className="flex flex-col gap-0.5">
                <div className="mb-1.5 flex items-center justify-between gap-3 text-[11.5px] text-muted-foreground">
                  <span>最近 {history.length} 条记录(仅本次会话)</span>
                  <Button variant="ghost" size="sm" className="h-[27px] gap-[7px] px-[9px] text-xs font-normal" onClick={clearHistory}>清空</Button>
                </div>
                {history.map((h) => <HistoryRow key={h.taskId + h.at} h={h} />)}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
