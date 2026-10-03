/**
 * 任务中心 — 标题栏右上角入口展开的轻量浮层
 * 进行中:进度/速度/剩余时间/暂停·继续/取消;已完成:近期历史。
 * 暂停通过主进程挂起引擎子进程实现,进度会冻结在当前百分点。
 */
import { useState } from 'react';
import type { JobKind } from '@shared/types';
import { useTaskHub, type DoneJob, type TrackedJob } from './ui';
import {
  IconClose, IconCompress, IconDelete, IconExtract, IconTest,
  IconCheckCircle, IconWarn, IconClock, IconPause, IconPlay,
} from './icons';
import { fmtBytes } from '../lib/format';

const KIND_LABEL: Record<JobKind, { run: string; done: string; icon: typeof IconCompress }> = {
  compress: { run: '正在压缩', done: '压缩完成', icon: IconCompress },
  extract: { run: '正在解压', done: '解压完成', icon: IconExtract },
  test: { run: '正在测试', done: '测试完成', icon: IconTest },
  delete: { run: '正在删除', done: '删除完成', icon: IconDelete },
};
export { KIND_LABEL };

/** 基于最近两次采样估算速度(每秒百分点) */
function slope(job: TrackedJob): number | null {
  const s = job.samples;
  if (s.length < 2) return null;
  const last = s[s.length - 1];
  const prev = s[Math.max(0, s.length - 4)]; // ~2s 前的采样
  const dt = (last.t - prev.t) / 1000;
  if (dt < 0.8) return null;
  const dp = last.p - prev.p;
  return dp > 0 ? dp / dt : null;
}

function fmtEta(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '计算中';
  if (sec < 60) return `约 ${Math.round(sec)} 秒`;
  if (sec < 3600) return `约 ${Math.floor(sec / 60)} 分`;
  return `约 ${(sec / 3600).toFixed(1)} 小时`;
}

function fmtAgo(at: number): string {
  const d = Math.max(0, Date.now() - at);
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return new Date(at).toLocaleDateString();
}
export { fmtAgo };

export function RunningCard({ job }: { job: TrackedJob }) {
  const meta = KIND_LABEL[job.kind];
  const Icon = meta.icon;
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const k = slope(job);
  const etaSec = job.percent >= 0 && k && !paused ? (100 - job.percent) / k : null;
  const speed = k && job.totalBytes && !paused ? (job.totalBytes * k) / 100 : null;
  const done = job.status === 'done';
  const failed = job.status === 'error' || job.status === 'cancelled';
  const running = job.status === 'running';
  const togglePause = async () => {
    if (busy) return;
    setBusy(true);
    const r = await window.tz.taskPause(job.taskId);
    if (r.ok) setPaused(r.data);
    setBusy(false);
  };
  return (
    <div className="tc-item">
      <div className="tc-title">
        {done
          ? <IconCheckCircle style={{ color: 'var(--accent)' }} />
          : failed
            ? <IconWarn style={{ color: 'var(--danger)' }} />
            : <Icon />}
        <span>{done ? `${meta.done.replace('完成', '')}完成` : failed ? '任务已中断' : paused ? '已暂停' : meta.run}</span>
        <span className="act">
          {running && (
            <button className="icon-btn" style={{ width: 26, height: 26 }} disabled={busy}
              title={paused ? '继续任务' : '暂停任务'} onClick={() => void togglePause()}>
              {paused ? <IconPlay style={{ width: 12, height: 12 }} /> : <IconPause style={{ width: 12, height: 12 }} />}
            </button>
          )}
          {running && (
            <button className="icon-btn" style={{ width: 26, height: 26 }} title="取消任务"
              onClick={() => void window.tz.cancelTask(job.taskId)}>
              <IconClose style={{ width: 12, height: 12 }} />
            </button>
          )}
        </span>
      </div>
      <div className="tc-file" title={job.label || job.file}>{job.label || job.file}</div>
      {job.message && failed && <div className="tc-file" style={{ color: 'var(--danger)' }}>{job.message}</div>}
      <div className={`pbar ${job.percent < 0 && job.status === 'running' ? 'indet' : ''}`}>
        <i style={{
          width: job.percent >= 0 ? `${job.percent}%` : undefined,
          background: failed ? 'var(--danger)' : undefined,
        }} />
      </div>
      <div className="tc-meta">
        <span>{job.percent >= 0 ? `${job.percent}%` : running ? '进行中' : ''}</span>
        {speed != null && running && <span>{fmtBytes(speed)}/s</span>}
        {running && !paused && <span>{fmtEta(etaSec)}</span>}
        {paused && running && <span style={{ color: 'var(--warn)' }}>进度已冻结</span>}
        {job.totalBytes != null && <span>{fmtBytes(job.totalBytes)}</span>}
      </div>
    </div>
  );
}

export function HistoryRow({ h }: { h: DoneJob }) {
  const meta = KIND_LABEL[h.kind];
  const Icon = h.status === 'done' ? IconCheckCircle : IconWarn;
  return (
    <div className={`hist-item ${h.status === 'done' ? '' : 'err'}`}>
      <Icon style={{ color: h.status === 'done' ? 'var(--accent)' : 'var(--danger)' }} />
      <span className="h-name">{h.label ? `${meta.done} · ${h.label}` : meta.done}</span>
      <span className="h-time">{fmtAgo(h.at)}</span>
    </div>
  );
}

export default function TaskCenter({ onClose }: { onClose: () => void }) {
  const { jobs, history, clearHistory } = useTaskHub();
  return (
    <>
      <div className="pop-scrim" onMouseDown={onClose} />
      <div className="tc-pop">
        <div className="tc-head">
          <IconClock style={{ width: 15, height: 15, color: 'var(--ink-2)' }} />
          任务中心
          <span className="muted">{jobs.length ? `${jobs.length} 个进行中` : '无进行中任务'}</span>
        </div>
        <div className="tc-body">
          {jobs.length === 0 && history.length === 0 && (
            <div className="tc-empty">暂无任务<br />拖入文件即可开始</div>
          )}
          {jobs.length > 0 && <div className="tc-group">进行中</div>}
          {jobs.map((j) => <RunningCard key={j.taskId} job={j} />)}
          {history.length > 0 && (
            <>
              <div className="tc-group" style={{ display: 'flex', alignItems: 'center' }}>
                <span style={{ flex: 1 }}>最近完成</span>
                <button className="tbtn sm" style={{ height: 22, fontSize: 11 }} onClick={clearHistory}>清空</button>
              </div>
              {history.map((h) => <HistoryRow key={h.taskId + h.at} h={h} />)}
            </>
          )}
        </div>
      </div>
    </>
  );
}
