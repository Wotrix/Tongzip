import { useState } from 'react';
import { Modal } from './ui';
import { IconRename } from './icons';

/** 重命名压缩包文件(不含扩展名);error 非空时保持打开并提示 */
export default function RenameDialog({ currentName, error, onSubmit, onClose }: {
  currentName: string;
  error?: string | null;
  onSubmit: (newName: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(currentName);
  return (
    <Modal title="重命名压缩包" icon={<IconRename />} onClose={onClose} width={400}>
      <div className="stack">
        <form
          onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSubmit(name.trim()); }}
          style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          <input
            className="input" autoFocus value={name}
            onFocus={(e) => { const i = e.target.value.lastIndexOf('.'); e.target.setSelectionRange(0, i > 0 ? i : e.target.value.length); }}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="note">仅更改文件名,扩展名保持不变;确定后标签与最近记录同步更新。</div>
          {error && <div style={{ color: 'var(--danger)', fontSize: 12.5 }}>{error}</div>}
          <div className="foot" style={{ margin: 0 }}>
            <button type="button" className="tbtn" onClick={onClose}>取消</button>
            <button type="submit" className="tbtn primary" disabled={!name.trim()}>确定</button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
