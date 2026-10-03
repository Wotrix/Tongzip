/**
 * 设置页 — 参考图布局:左侧分类标签 · 右侧内容
 * 主题三卡片预览 + Accent 色块(即时生效并持久化)、压缩默认值、资源管理器集成、引擎
 */
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { AccentKey, ArchiveFormat, ContextMenuSettings, EngineInfo, Settings } from '@shared/types';
import { useToast } from '../components/ui';
import { IconAuto, IconSun, IconMoon, IconWarn } from '../components/icons';

const TABS = ['通用', '压缩设置', '外观', '集成', '高级'] as const;
type Tab = typeof TABS[number];

const ACCENTS: { v: AccentKey; label: string; color: string }[] = [
  { v: 'blue', label: '品牌蓝', color: '#2b6ef4' },
  { v: 'purple', label: '紫罗兰', color: '#7c5cf0' },
  { v: 'orange', label: '活力橙', color: '#f0862b' },
  { v: 'cyan', label: '青碧', color: '#14b0c4' },
  { v: 'green', label: '翠绿', color: '#2fa466' },
  { v: 'indigo', label: '靛青', color: '#4f5ff0' },
];

const FORMATS: { v: ArchiveFormat; label: string }[] = [
  { v: '7z', label: '7Z — 压缩率最高' },
  { v: 'zip', label: 'ZIP — 兼容性最好' },
  { v: 'tar.gz', label: 'TAR.GZ — Linux/macOS 通用' },
  { v: 'tar.xz', label: 'TAR.XZ — 更高压缩率' },
  { v: 'tar', label: 'TAR — 仅打包' },
];

const LEVELS = [
  { v: 0, label: '仅存储' }, { v: 1, label: '最快' }, { v: 3, label: '快速' },
  { v: 5, label: '标准(推荐)' }, { v: 7, label: '较高' }, { v: 9, label: '极限' },
];

/** 右键菜单自定义项(参考 Bandizip):[设置键, 菜单里显示的名称, 补充说明] */
const CM_EXTRACT: [keyof ContextMenuSettings, string, string][] = [
  ['open', '打开', '浏览压缩包内容'],
  ['extractTo', '解压到同名文件夹', '一键解压,自动建目录'],
  ['extractHere', '解压到当前文件夹', '文件直接铺在压缩包所在目录'],
  ['extractDialog', '解压到…', '弹出对话框选择去向'],
  ['openWith', '加入压缩包「打开方式」', '双击 .7z 等无默认程序的压缩包时用 TongZip 打开'],
];
const CM_COMPRESS: [keyof ContextMenuSettings, string, string][] = [
  ['compress7z', '压缩为 7z', ''],
  ['compressZip', '压缩为 ZIP', ''],
  ['compressTarGz', '压缩为 tar.gz', ''],
  ['compressDialog', '压缩选项…', '打开对话框,可选格式/等级/密码'],
];

export default function SettingsPage() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('通用');
  const [s, setS] = useState<Settings | null>(null);
  const [shellOn, setShellOn] = useState(false);
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [engineErr, setEngineErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setS(await window.tz.getSettings());
      setShellOn((await window.tz.shellStatus()).installed);
      const r = await window.tz.detectEngine();
      if (r.ok) setEngine(r.data); else setEngineErr(r.message);
    })();
  }, []);

  if (!s) return null;
  const patch = (p: Partial<Settings>) => {
    void window.tz.setSettings(p).then((v) => {
      setS(v);
      if (p.accent) {
        if (p.accent === 'blue') delete document.documentElement.dataset.accent;
        else document.documentElement.dataset.accent = p.accent;
      }
    });
  };

  const toggleShell = async () => {
    const r = shellOn ? await window.tz.shellUninstall() : await window.tz.shellInstall();
    if (!r.ok) { toast(r.message, 'err'); return; }
    setShellOn(!shellOn);
    toast(shellOn ? '已移除右键菜单' : '已接入资源管理器右键菜单');
  };

  /** 勾选菜单项 → 存设置 → 已集成时立即重写注册表 */
  const setCmItem = async (k: keyof ContextMenuSettings, v: boolean) => {
    const next = { ...s.contextMenu, [k]: v };
    setS(await window.tz.setSettings({ contextMenu: next }));
    if (shellOn) {
      const r = await window.tz.shellRefresh();
      if (!r.ok) toast(r.message, 'err');
    }
  };
  const reRegister = async () => {
    const r = await window.tz.shellRefresh();
    if (!r.ok) toast(r.message, 'err'); else toast('右键菜单已按当前选项重新注册');
  };

  /** 跳到 Windows 设置▸默认应用,引导用户把压缩包关联给 TongZip */
  const openDefaultApps = async () => {
    const r = await window.tz.openDefaultApps();
    if (!r.ok) toast(r.message, 'err');
    else toast('在「默认应用」页选中 TongZip,再将压缩包扩展名指定为它');
  };

  return (
    <div className="page settings-page">
      <div className="page-head">
        <h2>设置</h2>
        <p className="page-sub">所有选项即时保存并生效。</p>
      </div>
      <div className="settings-layout">
        <aside className="stabs">
          {TABS.map((t) => (
            <button key={t} className={`stab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>{t}</button>
          ))}
        </aside>

        <div className="settings-body">
          {tab === '通用' && (
            <>
              <div className="set-group">
                <div className="set-label">双击压缩包时(资源管理器 / 文件关联打开)</div>
                <div className="seg">
                  {([['open', '打开发览'], ['quickExtract', '快速解压'], ['extractDialog', '询问去向']] as const).map(([v, label]) => (
                    <button key={v} type="button" className={s.dblClickAction === v ? 'on' : ''} onClick={() => patch({ dblClickAction: v })}>{label}</button>
                  ))}
                </div>
              </div>
              <div className="rowline">
                <div>
                  <div className="rl-label">记住本次会话密码</div>
                  <div className="rl-sub">用于同一压缩包的重复读取,关闭应用后清除</div>
                </div>
                <button className={`switch ${s.rememberPassword ? 'on' : ''}`} onClick={() => patch({ rememberPassword: !s.rememberPassword })} />
              </div>
              <div className="rowline">
                <div>
                  <div className="rl-label">首页显示「最近打开」</div>
                  <div className="rl-sub">在首页底部展示最近打开过的压缩包</div>
                </div>
                <button className={`switch ${s.showRecentOpen ? 'on' : ''}`} onClick={() => patch({ showRecentOpen: !s.showRecentOpen })} />
              </div>
              <div className="rowline">
                <div>
                  <div className="rl-label">首页显示「最近任务」</div>
                  <div className="rl-sub">在首页底部展示进行中与最近完成的任务</div>
                </div>
                <button className={`switch ${s.showRecentTasks ? 'on' : ''}`} onClick={() => patch({ showRecentTasks: !s.showRecentTasks })} />
              </div>
            </>
          )}

          {tab === '压缩设置' && (
            <>
              <div className="set-group">
                <div className="set-label">默认压缩格式</div>
                <select className="input" value={s.defaultFormat}
                  onChange={(e) => patch({ defaultFormat: e.target.value as ArchiveFormat })}>
                  {FORMATS.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}
                </select>
              </div>
              <div className="set-group">
                <div className="set-label">默认压缩等级</div>
                <select className="input" value={s.defaultLevel}
                  onChange={(e) => patch({ defaultLevel: Number(e.target.value) })}>
                  {LEVELS.map((l) => <option key={l.v} value={l.v}>{l.label}</option>)}
                </select>
                <div className="note">新建压缩包对话框将默认使用这两项;从右键菜单指定格式时以菜单为准。</div>
              </div>
            </>
          )}

          {tab === '外观' && (
            <>
              <div className="set-group">
                <div className="set-label">主题</div>
                <div className="theme-cards">
                  {([['light', '浅色', IconSun], ['dark', '深色', IconMoon], ['auto', '跟随系统', IconAuto]] as const).map(([v, label, Ico]) => (
                    <button key={v} type="button" className={`theme-card ${s.theme === v ? 'on' : ''}`} onClick={() => patch({ theme: v })}>
                      <span className={`tc-prev prev-${v}`}>
                        <i className="tc-bar" /><i className="tc-rail" /><i className="tc-line l1" /><i className="tc-line l2" /><i className="tc-line l3" /><i className="tc-btn" />
                      </span>
                      <span className="tc-cap"><Ico style={{ width: 13, height: 13 }} /> {label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="set-group">
                <div className="set-label">强调色</div>
                <div className="accent-row">
                  {ACCENTS.map((a) => (
                    <button key={a.v} type="button" title={a.label}
                      className={`accent-dot ${s.accent === a.v ? 'on' : ''}`}
                      style={{ '--dot': a.color } as CSSProperties}
                      onClick={() => patch({ accent: a.v })} />
                  ))}
                </div>
                <div className="note">按钮、选中行、进度条与导航高亮都会跟随强调色变化。</div>
              </div>
            </>
          )}

          {tab === '集成' && (
            <>
              <div className="rowline">
                <div>
                  <div className="rl-label">资源管理器右键菜单</div>
                  <div className="rl-sub">写入当前用户注册表(HKCU),无需管理员权限;下方选项可随时增减菜单项</div>
                </div>
                <button className={`switch ${shellOn ? 'on' : ''}`} onClick={() => void toggleShell()} />
              </div>

              <div className="set-group">
                <div className="set-label">默认应用</div>
                <div className="note" style={{ marginBottom: 8 }}>
                  Windows 限制第三方应用不能静默改默认关联。打开系统设置后选中 TongZip,
                  把 .7z/.zip 等压缩包指定为它,双击即可直接浏览。
                  下方「加入打开方式」开关会先把 TongZip 注册进可选列表。
                </div>
                <div>
                  <button className="tbtn sm" onClick={() => void openDefaultApps()}>打开系统「默认应用」设置</button>
                </div>
              </div>

              <div className="set-group cm-group" data-off={!shellOn || undefined}>
                <div className="set-label">文件与文件夹上的菜单</div>
                {CM_COMPRESS.map(([k, label, sub]) => (
                  <label className="cm-item" key={k}>
                    <input type="checkbox" checked={s.contextMenu[k]} disabled={!shellOn}
                      onChange={(e) => void setCmItem(k, e.target.checked)} />
                    <span className="cm-text"><b>{label}</b>{sub && <small>{sub}</small>}</span>
                  </label>
                ))}
                <div className="set-label">压缩包上的菜单</div>
                {CM_EXTRACT.map(([k, label, sub]) => (
                  <label className="cm-item" key={k}>
                    <input type="checkbox" checked={s.contextMenu[k]} disabled={!shellOn}
                      onChange={(e) => void setCmItem(k, e.target.checked)} />
                    <span className="cm-text"><b>{label}</b>{sub && <small>{sub}</small>}</span>
                  </label>
                ))}
                <div className="cm-foot">
                  <button className="tbtn sm" disabled={!shellOn} onClick={() => void reRegister()}>按当前选项重新注册</button>
                  <span className="note">项目移动位置或菜单没变化时,点一下刷新注册。</span>
                </div>
              </div>
            </>
          )}

          {tab === '高级' && (
            <div className="set-group">
              <div className="set-label">压缩引擎</div>
              <div className="rowline">
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13 }}>
                    {engine ? `7-Zip 内核 ${engine.version}` : '未检测到'}
                    {engine && <span style={{ color: 'var(--ink-3)', fontSize: 11.5 }}> · {engine.source === 'bundled' ? '自带' : engine.source === 'system' ? '系统' : '手动'}</span>}
                  </div>
                  {engine && <div className="note ellipsis" style={{ maxWidth: 380 }}>{engine.path}</div>}
                  {engineErr && <div style={{ color: 'var(--danger)', fontSize: 12 }}><IconWarn style={{ width: 12, height: 12, verticalAlign: -2 }} /> {engineErr}</div>}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="tbtn sm" onClick={async () => {
                    const r = await window.tz.detectEngine();
                    if (r.ok) { setEngine(r.data); setEngineErr(null); toast(`引擎就绪:${r.data.version}`); }
                    else setEngineErr(r.message);
                  }}>重新检测</button>
                  <button className="tbtn sm" onClick={async () => {
                    const r = await window.tz.pickFiles();
                    if (r.ok && r.data.length) {
                      patch({ enginePath: r.data[0] });
                      const d = await window.tz.detectEngine();
                      if (d.ok) { setEngine(d.data); setEngineErr(null); }
                    }
                  }}>手动指定</button>
                </div>
              </div>
              <div className="note">存储位置:%APPDATA% 下的 tongzip-settings.json,不写注册表(右键菜单除外)。</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
