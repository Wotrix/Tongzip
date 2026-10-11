/**
 * 设置页 — 参考图布局:左侧分类标签 · 右侧内容
 * 主题三卡片预览 + Accent 色块(即时生效并持久化)、压缩默认值、资源管理器集成、引擎
 */
import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { AccentKey, AppAbout, ArchiveFormat, ContextMenuSettings, EngineInfo, Settings, UpdateCheck } from '@shared/types';
import { useToast } from '../components/ui';
import { IconAuto, IconSun, IconMoon, IconWarn, IconLock, IconHome, IconClock, IconArchive, IconFolderOpen, IconExtract, IconRefresh, IconInfo, IconCode, IconSettings, IconProperties, IconFile } from '../components/icons';
import AppLogo from '../components/AppLogo';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import { Switch } from '../components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../components/ui/select';
import { cn } from '@/lib/utils';

const TABS = ['通用', '压缩设置', '外观', '集成', '高级', '关于'] as const;
type Tab = typeof TABS[number];

const ACCENTS: { v: AccentKey; label: string; color: string }[] = [
  { v: 'violet', label: '竹影紫', color: '#5a36de' },
  { v: 'blue', label: '品牌蓝', color: '#2b6ef4' },
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

/* —— 关于页常量:仓库名以远程 origin 为准,邮箱是对外唯一反馈地址 —— */
const REPO_URL = 'https://github.com/Wotrix/Tongzip';
const ISSUES_URL = `${REPO_URL}/issues`;
const EMAIL = 'wotrix@foxmail.com';

/* —— 设置页版式令牌(参考图:整组设置装进一个大圆角卡片,行内左图标 + 行间分隔线) —— */
/** 每个标签页一个外框卡片:大圆角、overflow 裁角、行间细分隔线 */
const CARD_CLS = 'flex min-w-0 max-w-[720px] flex-col divide-y divide-border overflow-hidden rounded-[18px] border border-border bg-card';
const GROUP_LABEL_CLS = 'text-xs font-semibold tracking-[.02em] text-muted-foreground';
const SEC_TITLE = 'text-[13.5px] font-medium leading-[1.35] text-foreground';
const SEC_SUB = 'mt-[3px] text-[12px] leading-[1.55] text-muted-foreground';
/** 设置行:左描边图标 + 标题/描述 + 右控件;stack=true 时控件另起一行左对齐到文字基线 */
function Row({ icon, title, sub, right, stack }: {
  icon: ReactNode; title: string; sub?: ReactNode; right?: ReactNode; stack?: boolean;
}) {
  return (
    <div className="px-[24px] py-[18px]">
      <div className="flex items-center gap-[15px]">
        <span className="grid size-[20px] shrink-0 place-items-center text-muted-foreground [&_svg]:size-[19px]">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className={SEC_TITLE}>{title}</div>
          {sub && <div className={SEC_SUB}>{sub}</div>}
        </div>
        {!stack && right}
      </div>
      {stack && <div className="mt-[14px] pl-[35px]">{right}</div>}
    </div>
  );
}
/** 纵向 Tabs 触发器:覆盖组件默认的「胶囊阴影 + dark 下 input 底色」,保持原柔和高亮 */
const TAB_CLS = cn(
  'h-[34px] w-full flex-none justify-start gap-[7px] rounded-lg px-[11px] py-0 text-left relative',
  'text-[12.5px] font-normal text-muted-foreground transition-colors',
  'hover:bg-accent hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground',
  'active:bg-[var(--bg-active)]',
  'data-[state=active]:bg-primary/[.12] data-[state=active]:font-semibold data-[state=active]:text-primary',
  'data-[state=active]:hover:bg-primary/[.12] data-[state=active]:active:bg-primary/20',
  'dark:data-[state=active]:hover:bg-primary/[.12] dark:data-[state=active]:active:bg-primary/20',
  'data-[state=active]:before:absolute data-[state=active]:before:left-0 data-[state=active]:before:top-1/2 data-[state=active]:before:h-4 data-[state=active]:before:w-[3px] data-[state=active]:before:-translate-y-1/2 data-[state=active]:before:rounded-r-full data-[state=active]:before:bg-primary',
  'data-[state=active]:shadow-none! dark:data-[state=active]:border-transparent',
  'dark:data-[state=active]:bg-primary/[.12] dark:data-[state=active]:text-primary',
);
/** 主题预览迷你窗口:中性内容线 + 单点 accent 强调 */
const PREV_BASE_CLS = 'relative block h-[88px] overflow-hidden rounded-[8px] border border-border';
const PREV_BG: Record<'light' | 'dark' | 'auto', string> = {
  light: 'bg-[#f2f1f7]',
  dark: 'bg-[#232229]',
  auto: 'bg-[linear-gradient(105deg,#f2f1f7_0_46%,#232229_46%_100%)]',
};

export default function SettingsPage() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('通用');
  const [s, setS] = useState<Settings | null>(null);
  const [shellOn, setShellOn] = useState(false);
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [engineErr, setEngineErr] = useState<string | null>(null);
  const [about, setAbout] = useState<AppAbout | null>(null);
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [updErr, setUpdErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setS(await window.tz.getSettings());
      setShellOn((await window.tz.shellStatus()).installed);
      const r = await window.tz.detectEngine();
      if (r.ok) setEngine(r.data); else setEngineErr(r.message);
      const a = await window.tz.aboutInfo();
      if (a.ok) setAbout(a.data);
    })();
  }, []);

  if (!s) return null;
  const patch = (p: Partial<Settings>) => {
    /* 广播给 Shell:rememberPassword/dblClickAction 等开关需实时生效,不等重挂载 */
    window.dispatchEvent(new CustomEvent('tz:settings-patched', { detail: p }));
    void window.tz.setSettings(p).then((v) => {
      setS(v);
      if (p.accent) {
        if (p.accent === 'violet') delete document.documentElement.dataset.accent;
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

  /** 一键设为默认:先把 TongZip 登记进系统可选应用,再跳到默认应用页供用户确认 */
  const setAsDefault = async () => {
    const r = await window.tz.setDefaultApp();
    if (!r.ok) { toast(r.message, 'err'); return; }
    toast('已登记 TongZip,在弹出的「默认应用」页把压缩包格式选为它即可');
  };

  /** 打开外部链接/邮件:主进程白名单仅 http/https/mailto */
  const openLink = async (url: string) => {
    const r = await window.tz.openExternal(url);
    if (!r.ok) toast(r.message, 'err');
  };

  const doCheckUpdate = async () => {
    setChecking(true); setUpdErr(null); setUpdate(null);
    const r = await window.tz.checkUpdate();
    setChecking(false);
    if (r.ok) { setUpdate(r.data); if (r.data.status === 'available') toast(`发现新版本 v${r.data.latest}`, 'ok'); }
    else setUpdErr(r.message);
  };

  /** 反馈邮件预填版本与运行时信息,减少一轮往返追问 */
  const sendMail = () => {
    const body = encodeURIComponent(
      `TongZip v${about?.version ?? '?'} · Electron ${about?.electron ?? '?'} · Windows\n\n请描述你遇到的问题:\n`,
    );
    void openLink(`mailto:${EMAIL}?subject=${encodeURIComponent('TongZip 反馈')}&body=${body}`);
  };

  /** 检查更新结果的一行文案(按钮下方状态位) */
  const updateHint = checking ? '正在连接 GitHub…'
    : updErr ?? (update?.status === 'available' ? `发现新版本 v${update.latest},下载前请核对发布说明`
      : update?.status === 'latest' ? `已是最新版本${update.latest ? ` (v${update.latest})` : ''}`
        : update?.status === 'notfound' ? '发布页还没有正式版本' : '未检查');

  return (
    <div className="min-h-0 flex-1 overflow-auto px-8 pt-[26px] pb-12">
      <div className="mb-[18px]">
        <h2 className="text-[19px] font-bold">设置</h2>
        <p className="mt-1 text-[12.5px] text-muted-foreground">所有选项即时保存并生效。</p>
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} orientation="vertical"
        className="grid grid-cols-[148px_minmax(0,1fr)] items-start gap-[22px]">
        <TabsList className="sticky top-0 h-fit w-full items-stretch justify-start gap-0.5 rounded-none bg-transparent p-0">
          {TABS.map((t) => (
            <TabsTrigger key={t} value={t} className={TAB_CLS}>{t}</TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="通用" className={CARD_CLS}>
          <Row icon={<IconFolderOpen />} title="双击压缩包时" sub="选择双击压缩包后默认的操作方式(资源管理器 / 文件列表打开)。" stack
            right={
              <div className="seg">
                {([['open', '打开压缩包', IconFolderOpen], ['quickExtract', '快速解压', IconExtract], ['extractDialog', '询问去向', IconInfo]] as const).map(([v, label, Ico]) => (
                  <button key={v} type="button" className={s.dblClickAction === v ? 'on' : ''} onClick={() => patch({ dblClickAction: v })}><Ico />{label}</button>
                ))}
              </div>
            } />
          <Row icon={<IconLock />} title="记住本次会话密码" sub="用于同一压缩包的重复读取,关闭应用后清除。"
            right={<Switch checked={s.rememberPassword} onCheckedChange={() => patch({ rememberPassword: !s.rememberPassword })} />} />
          <Row icon={<IconHome />} title="首页显示「最近打开」" sub="在首页顶部展示最近打开过的压缩包。"
            right={<Switch checked={s.showRecentOpen} onCheckedChange={() => patch({ showRecentOpen: !s.showRecentOpen })} />} />
          <Row icon={<IconClock />} title="首页显示「最近任务」" sub="在首页底部展示进行中与最近完成的任务。"
            right={<Switch checked={s.showRecentTasks} onCheckedChange={() => patch({ showRecentTasks: !s.showRecentTasks })} />} />
        </TabsContent>

        <TabsContent value="压缩设置" className={CARD_CLS}>
          <Row icon={<IconArchive />} title="默认压缩格式" sub="新建压缩包对话框默认使用的格式。" stack
            right={<Select value={s.defaultFormat} onValueChange={(v) => patch({ defaultFormat: v as ArchiveFormat })}>
                        <SelectTrigger className="max-w-[320px]"><SelectValue /></SelectTrigger>
                        <SelectContent>{FORMATS.map((f) => <SelectItem key={f.v} value={f.v}>{f.label}</SelectItem>)}</SelectContent>
                      </Select>} />
          <Row icon={<IconProperties />} title="默认压缩等级" sub="从右键菜单指定格式时以菜单为准。" stack
            right={<Select value={String(s.defaultLevel)} onValueChange={(v) => patch({ defaultLevel: Number(v) })}>
                        <SelectTrigger className="max-w-[320px]"><SelectValue /></SelectTrigger>
                        <SelectContent>{LEVELS.map((l) => <SelectItem key={l.v} value={String(l.v)}>{l.label}</SelectItem>)}</SelectContent>
                      </Select>} />
        </TabsContent>

        <TabsContent value="外观" className={CARD_CLS}>
          <Row icon={<IconSun />} title="主题" sub="浅色 / 深色 / 跟随系统。" stack
            right={
              <div className="grid w-full max-w-[440px] grid-cols-3 gap-3">
                {([['light', '浅色', IconSun], ['dark', '深色', IconMoon], ['auto', '跟随系统', IconAuto]] as const).map(([v, label, Ico]) => {
                  const on = s.theme === v;
                  return (
                    <button key={v} type="button" onClick={() => patch({ theme: v })}
                      className={cn(
                        /* button 的 UA 样式带 align-items:flex-start,必须显式 items-stretch,否则预览宽度塌成边框 */
                        'relative flex flex-col items-stretch gap-2 rounded-[14px] border border-border bg-card p-[9px] text-left',
                        'transition-[border-color,background-color,transform] duration-150 ease-out',
                        'hover:-translate-y-px hover:border-input active:translate-y-0',
                        on && 'border-primary bg-primary/[.03] ring-2 ring-primary/15',
                      )}>
                      <span className={cn(PREV_BASE_CLS, PREV_BG[v])}>
                        <i className="absolute inset-x-0 top-0 h-[14px] bg-[rgba(127,127,127,.18)] before:absolute before:left-[5px] before:top-1/2 before:size-[3px] before:-translate-y-1/2 before:rounded-full before:bg-[rgba(127,127,127,.55)] before:shadow-[6px_0_0_rgba(127,127,127,.55),12px_0_0_rgba(127,127,127,.55)]" />
                        <i className="absolute bottom-0 left-0 top-[14px] w-[22%] bg-[rgba(127,127,127,.12)] before:absolute before:left-[4px] before:top-[22px] before:h-[7px] before:w-[calc(100%_-_8px)] before:rounded-[3px] before:bg-[rgba(127,127,127,.3)] before:shadow-[0_11px_0_rgba(127,127,127,.3),0_22px_0_rgba(127,127,127,.3)] after:absolute after:left-[4px] after:top-[8px] after:h-[7px] after:w-[calc(100%_-_8px)] after:rounded-[3px] after:bg-primary after:opacity-90" />
                        <i className="absolute left-[28%] top-6 h-2 w-[34%] rounded-[3px] bg-[rgba(120,128,140,.8)]" />
                        <i className="absolute left-[28%] top-10 h-1.5 w-[54%] rounded-[3px] bg-[rgba(133,141,152,.55)]" />
                        <i className="absolute left-[28%] top-[52px] h-1.5 w-[42%] rounded-[3px] bg-[rgba(133,141,152,.55)]" />
                        <i className="absolute bottom-[12px] right-[10%] h-[11px] w-[22%] rounded bg-primary" />
                      </span>
                      <span className={cn('flex items-center gap-1.5 px-px text-xs text-muted-foreground', on && 'font-semibold text-primary')}>
                        <Ico className="size-[13px]" /> {label}
                      </span>
                      {on && (
                        <span className="absolute right-[14px] top-[14px] grid size-[18px] animate-[tc-pop_.18s_ease-out] place-items-center rounded-full bg-primary text-[11px] font-bold leading-none text-primary-foreground shadow-[0_0_0_2.5px_var(--card)]">✓</span>
                      )}
                    </button>
                  );
                })}
              </div>
            } />
          <Row icon={<IconSettings />} title="强调色" sub="按钮、选中行、进度条与导航高亮都会跟随强调色变化。" stack
            right={
              <div className="flex gap-[11px]">
                {ACCENTS.map((a) => {
                  const on = s.accent === a.v;
                  return (
                    <button key={a.v} type="button" title={a.label} onClick={() => patch({ accent: a.v })}
                      className={cn(
                        'relative size-7 shrink-0 rounded-full bg-[color:var(--dot)] transition-[transform,box-shadow] duration-100 ease-out',
                        'shadow-[inset_0_0_0_2px_var(--background)] hover:scale-110',
                        on && 'shadow-[inset_0_0_0_2px_var(--background),0_0_0_2px_var(--card),0_0_0_4px_var(--dot)]',
                      )}
                      style={{ '--dot': a.color } as CSSProperties}>
                      {on && <span className="absolute inset-0 grid place-items-center text-[12.5px] font-bold leading-none text-white [text-shadow:0_1px_2px_rgba(0,0,0,.25)]">✓</span>}
                    </button>
                  );
                })}
              </div>
            } />
        </TabsContent>

        <TabsContent value="集成" className={CARD_CLS}>
          <Row icon={<IconSettings />} title="资源管理器右键菜单" sub="写入当前用户注册表(HKCU),无需管理员权限;下方选项可随时增减菜单项。"
            right={<Switch checked={shellOn} onCheckedChange={() => void toggleShell()} />} />
          <Row icon={<IconArchive />} title="默认应用" sub="Windows 限制第三方应用不能静默改默认关联。点「设为默认」会把 TongZip 登记进系统可选应用并打开设置页,把 .7z/.zip 等压缩包选为它,之后双击即可直接浏览。" stack
            right={
              <div className="flex items-center gap-2">
                <Button size="sm" className="h-[30px] px-[13px] text-xs" onClick={() => void setAsDefault()}>设为默认压缩包程序</Button>
                <Button variant="ghost" size="sm" className="h-[30px] px-[11px] text-xs font-normal" onClick={() => void openDefaultApps()}>仅打开系统设置</Button>
              </div>
            } />
          <div className={cn('px-[24px] py-[18px] transition-opacity', !shellOn && 'opacity-50')}>
            <div className={GROUP_LABEL_CLS}>文件与文件夹上的菜单</div>
            <div className="mt-[8px] flex flex-col">
              {CM_COMPRESS.map(([k, label, sub]) => (
                <div key={k} className={cn('flex items-start gap-[9px] px-[2px] py-[6px] text-[13px]', shellOn ? 'cursor-pointer' : 'cursor-default')}>
                  <Checkbox id={`cm-${k}`} checked={s.contextMenu[k]} disabled={!shellOn}
                    onCheckedChange={(v) => void setCmItem(k, v === true)}
                    className="mt-[2px] size-[15px]" />
                  <label htmlFor={`cm-${k}`} className="flex min-w-0 flex-col gap-px">
                    <b className="font-medium text-foreground">{label}</b>
                    {sub && <small className="text-[11.5px] text-muted-foreground">{sub}</small>}
                  </label>
                </div>
              ))}
            </div>
            <div className={cn(GROUP_LABEL_CLS, 'mt-[16px]')}>压缩包上的菜单</div>
            <div className="mt-[8px] flex flex-col">
              {CM_EXTRACT.map(([k, label, sub]) => (
                <div key={k} className={cn('flex items-start gap-[9px] px-[2px] py-[6px] text-[13px]', shellOn ? 'cursor-pointer' : 'cursor-default')}>
                  <Checkbox id={`cm-${k}`} checked={s.contextMenu[k]} disabled={!shellOn}
                    onCheckedChange={(v) => void setCmItem(k, v === true)}
                    className="mt-[2px] size-[15px]" />
                  <label htmlFor={`cm-${k}`} className="flex min-w-0 flex-col gap-px">
                    <b className="font-medium text-foreground">{label}</b>
                    {sub && <small className="text-[11.5px] text-muted-foreground">{sub}</small>}
                  </label>
                </div>
              ))}
            </div>
            <div className="mt-[16px] flex items-center gap-2.5">
              <Button variant="ghost" size="sm" className="h-[27px] px-[9px] text-xs font-normal" disabled={!shellOn} onClick={() => void reRegister()}>按当前选项重新注册</Button>
              <span className="note">项目移动位置或菜单没变化时,点一下刷新注册。</span>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="高级" className={CARD_CLS}>
          <Row icon={<IconCode />} title="压缩引擎" stack
            sub={engine ? <>7-Zip 内核 {engine.version} · {engine.source === 'bundled' ? '自带' : engine.source === 'system' ? '系统' : '手动'}{engine && <span className="note ellipsis block max-w-[440px]">{engine.path}</span>}{engineErr && <span className="block text-destructive"><IconWarn className="size-3 align-[-2px]" /> {engineErr}</span>}</> : '未检测到'}
            right={
              <div className="flex gap-1.5">
                <Button variant="ghost" size="sm" className="h-[27px] px-[9px] text-xs font-normal" onClick={async () => {
                  const r = await window.tz.detectEngine();
                  if (r.ok) { setEngine(r.data); setEngineErr(null); toast(`引擎就绪:${r.data.version}`); }
                  else setEngineErr(r.message);
                }}>重新检测</Button>
                <Button variant="ghost" size="sm" className="h-[27px] px-[9px] text-xs font-normal" onClick={async () => {
                  const r = await window.tz.pickFiles();
                  if (r.ok && r.data.length) {
                    patch({ enginePath: r.data[0] });
                    const d = await window.tz.detectEngine();
                    if (d.ok) { setEngine(d.data); setEngineErr(null); }
                  }
                }}>手动指定</Button>
              </div>
            } />
          <Row icon={<IconFile />} title="存储位置" sub="%APPDATA% 下的 tongzip-settings.json,不写注册表(右键菜单除外)。" />
        </TabsContent>

        <TabsContent value="关于" className={CARD_CLS}>
          {/* 品牌头部:位图 logo + 版本号胶囊,沿用首页「轻若竹风」主张 */}
          <div className="flex items-center gap-4 px-[24px] py-[22px]">
            <AppLogo className="size-[56px]" />
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="text-[17px] font-bold leading-tight">TongZip</span>
                <span className="rounded-full bg-primary/10 px-2 py-[1.5px] text-[11px] font-semibold text-primary">
                  v{about?.version ?? '—'}
                </span>
              </div>
              <div className="mt-[3px] text-[12px] text-muted-foreground">轻若竹风,简胜于形。</div>
            </div>
          </div>

          <Row icon={<IconRefresh />} title="版本更新" sub={<>当前版本 v{about?.version ?? '—'} · {updateHint}</>}
            right={
              <div className="flex items-center gap-1.5">
                {update?.status === 'available' && update.url && (
                  <Button size="sm" className="h-[27px] px-[11px] text-xs" onClick={() => void openLink(update.url!)}>前往下载</Button>
                )}
                <Button variant="ghost" size="sm" className="h-[27px] px-[9px] text-xs font-normal" disabled={checking} onClick={() => void doCheckUpdate()}>
                  {checking ? '检查中…' : '检查更新'}
                </Button>
              </div>
            } />
          <Row icon={<IconInfo />} title="Bug 反馈" sub="GitHub Issues 可跟进处理进度;涉及私密信息(路径/密码)请发邮件。"
            right={
              <div className="flex items-center gap-1.5">
                <Button variant="ghost" size="sm" className="h-[27px] px-[9px] text-xs font-normal" onClick={() => void openLink(ISSUES_URL)}>提 Issue</Button>
                <Button variant="ghost" size="sm" className="h-[27px] px-[9px] text-xs font-normal" onClick={sendMail}>发邮件</Button>
              </div>
            } />
          <Row icon={<IconCode />} title="作者" sub={`Wotrix · ${EMAIL}`}
            right={<Button variant="ghost" size="sm" className="h-[27px] px-[9px] text-xs font-normal" onClick={() => void openLink(REPO_URL)}>GitHub 仓库</Button>} />
          <Row icon={<IconFile />} title="运行时与许可" stack
            sub={<>
              Electron {about?.electron ?? '—'} · Chromium {about?.chromium ?? '—'} · Node {about?.node ?? '—'}<br />
              捆绑 7-Zip 引擎 (7za.exe) © 伊戈尔·帕夫洛维奇,遵循 GNU LGPL;Electron / React 等依赖遵循各自 MIT 许可。<br />
              TongZip 本体为闭源软件,© 2026 Wotrix,保留所有权利。
            </>}
            right={<Button variant="ghost" size="sm" className="h-[27px] px-[9px] text-xs font-normal" onClick={async () => {
              const text = `TongZip v${about?.version ?? '?'} / Electron ${about?.electron ?? '?'} / Chromium ${about?.chromium ?? '?'} / Node ${about?.node ?? '?'}`;
              try { await navigator.clipboard.writeText(text); toast('诊断信息已复制,反馈时可直接粘贴'); }
              catch { toast('复制失败,请手动记录版本号', 'err'); }
            }}>复制诊断信息</Button>} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
