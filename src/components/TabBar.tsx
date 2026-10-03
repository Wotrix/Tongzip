/**
 * 多标签栏 — 顶栏下方独立一行,仅浏览视图渲染(PeaZip 式多包同开)
 * 标签 = 包名 + hover 关闭钮;尾部「+」打开新包;溢出横向滚动;中键可关闭。
 */
import { IconAdd, IconClose } from './icons';
import { basename } from '../lib/format';

export interface TabItem { id: string; archive: string }

export default function TabBar({ tabs, activeId, onSelect, onClose, onNew }: {
  tabs: TabItem[];
  activeId: string | null;
  onSelect(id: string): void;
  onClose(id: string): void;
  onNew(): void;
}) {
  return (
    <div className="tab-bar">
      <div className="tab-list">
        {tabs.map((t) => (
          <div key={t.id}
            className={`tab ${t.id === activeId ? 'on' : ''}`}
            title={t.archive}
            onClick={() => onSelect(t.id)}
            onAuxClick={(e) => { if (e.button === 1) onClose(t.id); }}>
            <span className="tab-name ellipsis">{basename(t.archive)}</span>
            <button className="tab-x" title="关闭标签 (Ctrl+W)"
              onClick={(e) => { e.stopPropagation(); onClose(t.id); }}>
              <IconClose style={{ width: 11, height: 11 }} />
            </button>
          </div>
        ))}
      </div>
      <button className="tab-add" title="打开其他压缩包 (Ctrl+T)" onClick={onNew}>
        <IconAdd style={{ width: 13, height: 13 }} />
      </button>
    </div>
  );
}
