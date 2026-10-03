import { useState } from 'react';
import type { ReactNode } from 'react';
import { Modal } from './ui';
import { IconLock } from './icons';

/** 密码请求对话框;error 非空时保持打开并提示 */
export default function PasswordDialog({ target, error, onSubmit, onClose }: {
  target: string;
  error?: string | null;
  onSubmit: (password: string) => void;
  onClose: () => void;
}) {
  const [pw, setPw] = useState('');
  return (
    <Modal title="需要密码" icon={<IconLock />} onClose={onClose} width={400}>
      <div className="stack">
        <div className="note" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }} title={target}>{target}</div>
        <form
          onSubmit={(e) => { e.preventDefault(); if (pw) onSubmit(pw); }}
          style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          <input
            className="input" type="password" autoFocus placeholder="输入密码…"
            value={pw} onChange={(e) => setPw(e.target.value)}
          />
          {error && <div style={{ color: 'var(--danger)', fontSize: 12.5 }}>{error}</div>}
          <div className="foot" style={{ margin: 0 }}>
            <button type="button" className="tbtn" onClick={onClose}>取消</button>
            <button type="submit" className="tbtn primary" disabled={!pw}>确定</button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

export function ConfirmDialog({ title, body, danger, onOk, onClose }: {
  title: string; body: ReactNode; danger?: boolean; onOk: () => void; onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose} width={380}>
      <div className="stack">
        <div style={{ color: 'var(--ink-2)', fontSize: 13 }}>{body}</div>
        <div className="foot">
          <button className="tbtn" onClick={onClose}>取消</button>
          <button className={`tbtn ${danger ? 'danger primary' : 'primary'}`} onClick={() => { onOk(); onClose(); }}>
            {danger ? '删除' : '确定'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
