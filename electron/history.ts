/**
 * 任务历史持久化与重启恢复(阶段 3.4)
 *
 * 原则:恢复任务状态,不盲目重放任务。
 * - 历史落 userData/tongzip-history.json,版本化结构,与 settings/txn journal 分离;
 * - 记录只含状态与路径:密码、错误文案、引擎日志一律不入库(验收红线);
 * - 启动恢复必须在事务 journal 恢复(recoverStaleTransactions)之后执行——
 *   提交阶段崩溃的任务结果由事务判定,历史侧只标记 txnRolledBack;
 * - applyRestoreRules 是幂等纯函数:重复启动/重复恢复不产生二次变更。
 *
 * 与 configureTxnJournal 同形状:文件路径注入,便于 selftest 在临时目录全链验证。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PersistedTask, ProgressEvent, TaskHistoryFile } from '../shared/types';

/* ---------------- 存储配置(主进程启动时注入) ---------------- */

let historyFile: string | null = null;
let cache: PersistedTask[] = [];
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

/** 历史上限:超出丢弃最旧记录(滚动窗口,不做分页) */
const HISTORY_LIMIT = 200;

export function configureTaskHistory(file: string): void {
  historyFile = file;
}

function scheduleWrite(): void {
  dirty = true;
  if (!writeTimer) writeTimer = setTimeout(() => { writeTimer = null; flushTaskHistory(); }, 400);
}

/** 同步落盘(去抖窗口内的最后一笔靠它兜底;写失败丢弃脏标记,不阻断运行) */
export function flushTaskHistory(): void {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  if (!dirty || !historyFile) return;
  const data = JSON.stringify({ version: 1, tasks: cache.slice(0, HISTORY_LIMIT) } as TaskHistoryFile, null, 2);
  try {
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    /* 原子替换:消除直写 truncate 窗口被强杀命中致历史撕裂的同类隐患(CI 崩溃演练在 journal 上实测到) */
    const swap = `${historyFile}.swap`;
    try {
      fs.writeFileSync(swap, data, 'utf8');
      fs.renameSync(swap, historyFile);
      dirty = false;
      return;
    } catch { /* rename 被占用:回落直写 */ }
    fs.writeFileSync(historyFile, data, 'utf8');
    dirty = false;
  } catch { /* 磁盘满/无权限:内存状态保持,下次再试;绝不抛出打断任务链 */ }
}

export function getTaskHistory(): PersistedTask[] {
  return cache.slice(0, HISTORY_LIMIT);
}

export function clearTaskHistory(): void {
  cache = [];
  scheduleWrite();
}

/** 移除单条历史(最近任务右键「从最近列表移除」);taskId 唯一,找不到返回 false */
export function removeTaskHistory(taskId: string): boolean {
  const i = cache.findIndex((t) => t.id === taskId);
  if (i < 0) return false;
  cache.splice(i, 1);
  scheduleWrite();
  return true;
}

/* ---------------- 版本化解析 ---------------- */

const KINDS = new Set(['compress', 'extract', 'test', 'delete']);
const STATUSES = new Set(['running', 'queued', 'done', 'error', 'cancelled', 'interrupted', 'retryable']);

/** 结构级校验:只接受字段类型正确的记录;label/path 截断防御异常膨胀 */
function asPersistedTask(x: unknown): PersistedTask | null {
  if (typeof x !== 'object' || x === null) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.kind !== 'string' || !KINDS.has(o.kind)) return null;
  if (typeof o.status !== 'string' || !STATUSES.has(o.status) || typeof o.createdAt !== 'number') return null;
  const t: PersistedTask = { id: o.id.slice(0, 128), kind: o.kind as PersistedTask['kind'], status: o.status as PersistedTask['status'], createdAt: o.createdAt, label: '' };
  if (typeof o.label === 'string') t.label = o.label.slice(0, 512);
  if (typeof o.src === 'string') t.src = o.src.slice(0, 4096);
  if (typeof o.out === 'string') t.out = o.out.slice(0, 4096);
  if (typeof o.finishedAt === 'number') t.finishedAt = o.finishedAt;
  if (typeof o.errCode === 'string') t.errCode = o.errCode.slice(0, 64);
  if (typeof o.percent === 'number' && Number.isFinite(o.percent)) t.percent = Math.max(-1, Math.min(100, o.percent));
  if (o.txnRolledBack === true) t.txnRolledBack = true;
  return t;
}

/**
 * 解析历史文件文本:JSON 损坏/version 未知 → ok:false(调用方隔离整文件);
 * JSON 合法但个别记录坏 → 过滤坏记录,好记录照常恢复(尽量保留)
 */
export function parseHistoryText(text: string): { tasks: PersistedTask[]; ok: boolean } {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return { tasks: [], ok: false }; }
  if (typeof data !== 'object' || data === null) return { tasks: [], ok: false };
  const o = data as Record<string, unknown>;
  if (o.version !== 1 || !Array.isArray(o.tasks)) return { tasks: [], ok: false };
  return { tasks: o.tasks.map(asPersistedTask).filter((t): t is PersistedTask => t !== null), ok: true };
}

/* ---------------- 恢复状态机(幂等纯函数) ---------------- */

/**
 * 崩溃遗留任务 → 恢复状态。规则(说明书 3.4.2/3.4.3 + 场景表):
 * - done/error/cancelled:原始终态保留,不重放;
 * - interrupted/retryable:上次启动已映射过,保持(幂等:重复恢复零变更);
 * - running:标记 interrupted,绝不猜成功/失败;其归档若出现在事务恢复清单中
 *   (提交阶段崩溃,journal 已回滚)→ 置 txnRolledBack,结果由事务判定;
 * - queued:重新校验输入文件——存在 → retryable(允许用户手动重排,不自动执行);
 *   缺失 → interrupted(源都没了,无重放对象)。
 * exists 注入便于测试;生产传 fs.existsSync。
 */
export function applyRestoreRules(
  tasks: PersistedTask[],
  journalRestored: ReadonlySet<string>,
  exists: (p: string) => boolean = fs.existsSync,
): PersistedTask[] {
  return tasks.map((t) => {
    if (t.status === 'running') {
      const hit = t.src !== undefined && journalRestored.has(t.src);
      return { ...t, status: 'interrupted' as const, ...(hit ? { txnRolledBack: true } : {}) };
    }
    if (t.status === 'queued') {
      const ok = t.src !== undefined && exists(t.src);
      return ok ? { ...t, status: 'retryable' as const } : { ...t, status: 'interrupted' as const };
    }
    return t; // 其余状态原样透传:终态保留 + 幂等
  });
}

/* ---------------- 启动加载(main.ts 在 recoverStaleTransactions 之后调用) ---------------- */

export interface HistoryRestoreReport {
  tasks: PersistedTask[];
  /** 损坏文件被隔离后的改名去向;无损坏为 null */
  quarantined: string | null;
}

export function loadTaskHistory(journalRestored: ReadonlySet<string> = new Set()): HistoryRestoreReport {
  let quarantined: string | null = null;
  let tasks: PersistedTask[] = [];
  if (historyFile) {
    try {
      const parsed = parseHistoryText(fs.readFileSync(historyFile, 'utf8'));
      if (parsed.ok) {
        tasks = parsed.tasks;
      } else {
        /* 整文件不可信(截断/乱码/未来版本):隔离原件,从空历史开始——坏数据留证据不猜测 */
        quarantined = `${historyFile}.corrupt-${Date.now()}`;
        fs.renameSync(historyFile, quarantined);
      }
    } catch { /* 文件不存在=首次运行 */ }
  }
  cache = applyRestoreRules(tasks, journalRestored);
  /* 恢复结果立即落盘:running→interrupted 的映射只发生一次,
   * 即便再次崩溃也不会带着旧瞬态重复走恢复 */
  dirty = true;
  flushTaskHistory();
  return { tasks: cache.slice(), quarantined };
}

/* ---------------- 事件观察(send() 咽喉点调用) ---------------- */

export interface ObservePaths { archive?: string; output?: string; dest?: string }

/**
 * 从进度事件流维护历史:首次见 taskId 建 running 记录,终态定格。
 * 只读取 ev 的 kind/status/percent/code 与 paths——log/message 永不入库(脱敏)。
 * 路径竞态:渲染层经 tz:task-path-set 登记晚于首个事件,终态时补最新。
 */
export function observeTaskEvent(ev: ProgressEvent, paths?: ObservePaths): void {
  /* 语义:src=源压缩包(解压/测试/删除),out=产物或目标目录(压缩输出/解压 dest)。
   * 压缩任务主进程不掌握 sources 清单,out 兼作打开位置,记入 out */
  const src = paths?.archive;
  const out = paths?.dest ?? paths?.output;
  const idx = cache.findIndex((t) => t.id === ev.taskId);
  if (ev.status === 'running') {
    if (idx < 0) {
      cache.unshift({
        id: ev.taskId, kind: ev.kind,
        label: (paths?.archive || paths?.output || paths?.dest || '').replace(/^.*[\\/]/, ''),
        src, out, createdAt: Date.now(), status: 'running', percent: ev.percent,
      });
      cache = cache.slice(0, HISTORY_LIMIT);
      /* 任务开始必须立即落盘:秒级任务可能在去抖窗口内崩溃(真实演练实测全程仅 303ms),
         磁盘无记录则重启后无从标记"上次运行中断"——开始事件低频,同步写代价可接受 */
      scheduleWrite();
      flushTaskHistory();
      return;
    }
    if (cache[idx].percent !== ev.percent) {
      cache[idx] = { ...cache[idx], percent: ev.percent };
    } else {
      return; // 心跳同值事件:不标脏不写盘
    }
    scheduleWrite();
    return;
  }
  /* 终态:done/error/cancelled 定格;快任务终态先于建记录也要补全记录(竞态经验 3.x) */
  const base = idx >= 0 ? cache[idx] : {
    id: ev.taskId, kind: ev.kind, label: (paths?.archive || paths?.output || paths?.dest || '').replace(/^.*[\\/]/, ''),
    src, out, createdAt: Date.now(), status: 'running' as const,
  };
  const settled: PersistedTask = {
    ...base, src: src ?? base.src, out: out ?? base.out,
    status: ev.status, finishedAt: Date.now(),
    percent: ev.status === 'done' ? 100 : base.percent,
    ...(ev.code !== undefined ? { errCode: ev.code } : {}),
  };
  if (idx >= 0) cache[idx] = settled;
  else cache = [settled, ...cache].slice(0, HISTORY_LIMIT);
  scheduleWrite();
}

/**
 * 路径回填:快任务的终态可能早于渲染层 tz:task-path-set 到达,
 * 登记到达时补写既有记录的 src/out/label(不新建记录)
 */
export function backfillTaskPaths(taskId: string, p: ObservePaths): void {
  const i = cache.findIndex((t) => t.id === taskId);
  if (i < 0) return;
  const t = cache[i];
  const src = p.archive ?? t.src;
  const out = p.dest ?? p.output ?? t.out;
  const label = t.label || (p.archive || p.output || p.dest || '').replace(/^.*[\\/]/, '');
  if (src !== t.src || out !== t.out || label !== t.label) {
    cache[i] = { ...t, src, out, label };
    scheduleWrite();
  }
}
