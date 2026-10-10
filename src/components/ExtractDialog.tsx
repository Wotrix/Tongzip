import { useRef, useState } from 'react';
import type { ExtractJob } from '@shared/types';
import { ERR } from '@shared/types';
import { Modal, useToast } from './ui';
import { IconExtract } from './icons';
import { basename, parentDir } from '../lib/format';
import type { AppApi } from '../App';

/** 解压到指定目录对话框 */
export default function ExtractDialog({ archive, entries, api, totalBytes, onClose }: {
  archive: string;
  /** 要解压的归档内条目;空表示全部 */
  entries: string[];
  api: AppApi;
  totalBytes?: number;
  onClose: () => void;
}) {
  const toast = useToast();
  const [dest, setDest] = useState(() => `${parentDir(archive).replace(/\//g, '\\')}\\${basename(archive).replace(/(\.tar)?\.[^.]+$/i, '')}`);
  const [overwrite, setOverwrite] = useState<ExtractJob['overwrite']>('ask');
  const [busy, setBusy] = useState(false);
  /* ask 预检发现的同名条目:非空时展示决策条,用户选完模式后重发 */
  const [conflicts, setConflicts] = useState<string[] | null>(null);
  /* 条目落地重命名: entry → 新名;editing 为正在行内编辑的 entry */
  const [renames, setRenames] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [editVal, setEditVal] = useState('');
  const escRef = useRef(false);

  /* 目录条目(尾部斜杠)无扩展名概念;文件只输主名时自动保留原扩展名 */
  const extOf = (entry: string) => {
    if (/\/+\s*$/.test(entry)) return '';
    const n = basename(entry);
    const dot = n.lastIndexOf('.');
    return dot > 0 ? n.slice(dot) : '';
  };

  const commitRename = (entry: string) => {
    let clean = editVal.trim().replace(/[\\/:*?"<>|]/g, '');
    const ext = extOf(entry);
    if (clean && ext && !clean.includes('.')) clean += ext;
    const orig = basename(entry);
    setRenames((m) => {
      const n = { ...m };
      if (clean && clean !== orig) n[entry] = clean; else delete n[entry];
      return n;
    });
    setEditing(null);
  };

  /* 进入编辑时只选中主名,扩展名不选 — 直接打字即可换名不换格式 */
  const selectStem = (el: HTMLInputElement, entry: string) => {
    const ext = extOf(entry);
    const stemLen = ext && el.value.toLowerCase().endsWith(ext.toLowerCase())
      ? el.value.length - ext.length
      : el.value.length;
    el.setSelectionRange(0, stemLen > 0 ? stemLen : el.value.length);
  };

  const start = async (password?: string, ov: ExtractJob['overwrite'] = overwrite) => {
    setBusy(true);
    const job: ExtractJob = { archive, dest, entries, overwrite: ov, password, renames: Object.keys(renames).length ? renames : undefined };
    const r = await window.tz.extract(job);
    if (!r.ok) { setBusy(false); toast(r.message, 'err'); return; }
    if (r.data.conflicts?.length) { setBusy(false); setConflicts(r.data.conflicts); return; }
    if (!r.data.taskId) { setBusy(false); return; }
    // 路径登记:任务窗「打开位置」双钮数据源(目标夹=dest,源包=archive)
    void window.tz.taskPathSet(r.data.taskId, { archive, dest: dest.replace(/\\/g, '/') });
    api.trackTask(r.data.taskId, 'extract', async (j) => {
      setBusy(false);
      if (j.status === 'done') { toast(`已解压到 ${dest}`); onClose(); }
      else if (j.status === 'error') {
        /* 机读码优先;includes 兜底兼容第三方引擎把密码错误写进自由文案的场景 */
        if (j.code === ERR.NEED_PASSWORD || j.message?.includes('密码')) {
          api.askPassword(archive, async (pw) => {
            api.cachePassword(archive, pw); // 记住密码开启时,重试成功后缓存到会话
            await start(pw, ov);
            return true;
          });
        } else toast(j.message ?? '解压失败', 'err');
      }
    }, { label: basename(archive), path: archive, totalBytes });
  };

  return (
    <Modal title="解压到…" icon={<IconExtract />} onClose={onClose} width={480}>
      <div className="stack">
        <div className="note" title={archive}>{basename(archive)}</div>
        <div className="field">
          <label>目标文件夹</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input" value={dest} onChange={(e) => setDest(e.target.value)} />
            <button type="button" className="tbtn" onClick={async () => {
              const r = await window.tz.pickFolder();
              if (r.ok && r.data) {
                const sub = entries.length === 1 ? '' : basename(archive).replace(/(\.tar)?\.[^.]+$/i, '');
                setDest(sub ? `${r.data}\\${sub}` : r.data);
              }
            }}>浏览…</button>
          </div>
        </div>
        <div className="field">
          <label>重名处理</label>
          <div className="seg">
            {([['ask', '询问'], ['overwrite', '覆盖'], ['skip', '跳过'], ['rename', '重命名']] as const).map(([v, label]) => (
              <button key={v} type="button" className={overwrite === v ? 'on' : ''} onClick={() => setOverwrite(v)}>{label}</button>
            ))}
          </div>
        </div>
        {entries.length > 0 && (
          <div className="chips">
            {entries.map((e) => editing === e ? (
              <span className="chip editing" key={e}>
                <input
                  className="chip-input"
                  autoFocus
                  value={editVal}
                  onFocus={(ev) => selectStem(ev.currentTarget, e)}
                  onChange={(ev) => setEditVal(ev.target.value)}
                  onKeyDown={(ev) => {
                    if (ev.nativeEvent.isComposing) return; /* 中文输入法合成中不提交/不取消 */
                    if (ev.key === 'Enter') { ev.preventDefault(); commitRename(e); }
                    else if (ev.key === 'Escape') { escRef.current = true; (ev.currentTarget as HTMLInputElement).blur(); }
                  }}
                  onBlur={() => { if (escRef.current) { escRef.current = false; setEditing(null); } else commitRename(e); }}
                />
              </span>
            ) : (
              <span key={e}
                className={`chip clickable ${renames[e] ? 'renamed' : ''}`}
                title={renames[e] ? `${e}\n将解压为「${renames[e]}」,点击可再次修改` : `${e}\n点击可修改解压后的名字`}
                onClick={() => { setEditing(e); setEditVal(basename(e)); }}>
                <span>{renames[e] ?? basename(e)}</span>
                {renames[e] && <em className="chip-mark">✎</em>}
              </span>
            ))}
          </div>
        )}
        {conflicts && (
          <div className="field">
            <label>目标已存在 {conflicts.length} 个同名文件,请选择处理方式</label>
            <div className="seg">
              {([['overwrite', '覆盖'], ['skip', '跳过已有'], ['rename', '自动重命名']] as const).map(([v, label]) => (
                <button key={v} type="button" onClick={() => { setConflicts(null); void start(api.lastPassword(archive), v); }}>{label}</button>
              ))}
            </div>
          </div>
        )}
        <div className="foot">
          <button type="button" className="tbtn" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className="tbtn primary" disabled={busy || !dest} onClick={() => void start(api.lastPassword(archive) ?? undefined)}>
            {busy ? '解压中…' : '解压'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
