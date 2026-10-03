# TongZip shadcn-ui 迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 TongZip 全部 UI 从自绘 app.css 迁移到 Tailwind 4 + shadcn/ui + lucide-react，视觉对齐 shadcn，行为零变化。

**Architecture:** 迁移期双栈共存：新 Tailwind 令牌与组件源码（`src/index.css` + `src/components/ui/*`）与旧 `app.css` 并行，按「地基→骨架→简单页→浏览视图→对话框」五阶段逐视图换装，每阶段删对应旧样式并提交。

**Tech Stack:** Electron 33 / React 19 / Vite 6 / Tailwind CSS 4（@tailwindcss/vite）/ shadcn/ui（Radix）/ lucide-react / sonner / CVA。

**Spec:** `docs/superpowers/specs/2026-09-29-shadcn-migration-design.md`（已批准）

## Global Constraints

- 仅 UI 层：不改业务逻辑、IPC、引擎、窗口/托盘/注册表代码。JSX 结构与事件处理保持原样，只换 className 与图标引用。
- 右键菜单本期保留 Win11 Mica 观感（`--mica-*` 令牌随迁到新样式），是否 shadcn 化待用户后续拍板。
- 主题机制沿用：`document.documentElement.dataset.theme = 'light'|'dark'`、`dataset.accent`（blue 为默认无属性，另有 purple/orange/cyan/green/indigo），main.tsx 初始化流程不动。
- 六色 accent 现值：blue `#2b6ef4`、purple `#7c5cf0`、orange `#f0862b`、cyan `#14b0c8`、green `#2fa466`、indigo `#4f5ff0`（dark 下 blue 用 `#5b8df5`，其余同色微调提亮）。
- 测试方式：项目无单测框架，不引入。每个任务的"测试循环" = `npm run typecheck` + `npm run build` + CDP 调试实例截图断言（配方见任务 11 附录）。
- 每任务结束 commit 一次；回滚点为基线 `6ae8cc9`。
- 沙箱内启动 Electron 需提权（写 %APPDATA% 单例锁）；`npm start` 才是运行应用，`npm run dev` 只是 vite。

## 文件结构总览

```
src/
  index.css                    [新建] Tailwind 入口 + shadcn 令牌 + Mica 令牌迁移
  lib/utils.ts                 [新建] cn()
  components.json              [新建] shadcn CLI 配置
  components/ui/               [新建] button input badge separator switch tabs tooltip
                               dropdown-menu dialog alert-context sonner- toaster
  components/icons.tsx         [重写] 全部改为 lucide 再导出（保留原导出名）
  components/{TopBar,Sidebar,TabBar,ui}.tsx   [改] 阶段2
  views/{Home,RecentFiles,MyArchives,TasksPage,SettingsPage}.tsx               [改] 阶段3
  views/Browser.tsx            [改] 阶段4
  components/{Compress,Extract,Rename,Password}Dialog.tsx [改] 阶段5
  styles/app.css               [逐步删除对应区块] 最终整文件删除，main.tsx 去引用
```

---

## 阶段 1 · 地基

### Task 1: 安装依赖并接入 Tailwind

**Files:**
- Modify: `package.json`（deps）
- Modify: `vite.config.ts`（plugins 加 tailwindcss()）

- [ ] **Step 1: 安装运行时依赖**

```powershell
npm i tailwindcss @tailwindcss/vite clsx tailwind-merge class-variance-authority lucide-react sonner @radix-ui/react-dropdown-menu @radix-ui/react-dialog @radix-ui/react-tooltip @radix-ui/react-switch @radix-ui/react-tabs @radix-ui/react-select
```
预期：exit 0（.npmrc 已配镜像；无网络时先确认镜像可达再继续）。

- [ ] **Step 2: vite.config.ts 接入插件**

在 `import electron ...` 后加 `import tailwindcss from '@tailwindcss/vite';`，plugins 数组 `react()` 之前插入 `tailwindcss(),`。其余不动。

- [ ] **Step 3: 验证构建**

Run: `npm run build` → Expected: vite 构建成功，日志出现 tailwind 处理 css 无报错。

- [ ] **Step 4: Commit** `build: 接入 Tailwind 4 与 shadcn 依赖`

### Task 2: cn() + components.json + 全局令牌

**Files:**
- Create: `src/lib/utils.ts`
- Create: `components.json`
- Create: `src/index.css`
- Modify: `src/main.tsx:4`（在 `import './styles/app.css'` 前加 `import './index.css'`）

- [ ] **Step 1: 写 `src/lib/utils.ts`**

```ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
```

- [ ] **Step 2: 写 `components.json`**（供后续 CLI add；手工拷贝也可用）

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york", "rsc": false, "tsx": true,
  "tailwind": { "config": "", "css": "src/index.css", "baseColor": "zinc", "cssVariables": true },
  "iconLibrary": "lucide",
  "aliases": { "components": "@/components", "utils": "@/lib/utils", "ui": "@/components/ui", "lib": "@/lib", "hooks": "@/hooks" }
}
```

- [ ] **Step 3: 写 `src/index.css`** — shadcn zinc 基线 + 六色 accent + 保留 Mica 令牌：

```css
@import "tailwindcss";

@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));

:root {
  --radius: 0.5rem;
  --background: oklch(0.985 0 0);          /* #fafafa 级 */
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.55 0.21 262);          /* blue #2b6ef4 */
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.963 0.002 197);
  --secondary-foreground: oklch(0.21 0.01 285);
  --muted: oklch(0.963 0.002 197);
  --muted-foreground: oklch(0.51 0.01 285);
  --accent: oklch(0.963 0.002 197);
  --accent-foreground: oklch(0.21 0.01 285);
  --destructive: oklch(0.58 0.22 27);
  --destructive-foreground: oklch(0.98 0.01 240);
  --border: oklch(0.915 0.003 264);          /* #e4e4e7 级 */
  --input: oklch(0.915 0.003 264);
  --ring: var(--primary);
  /* Win11 Mica 右键菜单令牌(app.css 旧值平移,菜单本期保留) */
  --mica-bg: rgba(246,247,249,.82); --mica-line: rgba(0,0,0,.08);
  --shadow-mica: 0 8px 24px rgba(20,26,32,.14), 0 2px 6px rgba(20,26,32,.08), 0 0 0 .5px rgba(0,0,0,.04);
}

[data-accent='purple'] { --primary: oklch(0.58 0.22 287); }
[data-accent='orange'] { --primary: oklch(0.71 0.16 55); }
[data-accent='cyan']   { --primary: oklch(0.72 0.13 214); }
[data-accent='green']  { --primary: oklch(0.66 0.14 152); }
[data-accent='indigo'] { --primary: oklch(0.55 0.2 274); }

[data-theme='dark'] {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.965 0.001 286);
  --card: oklch(0.19 0.003 286);
  --card-foreground: oklch(0.965 0.001 286);
  --popover: oklch(0.21 0.004 285);
  --popover-foreground: oklch(0.965 0.001 286);
  --primary: oklch(0.63 0.19 262);           /* dark blue #5b8df5 */
  --primary-foreground: oklch(0.16 0.02 265);
  --secondary: oklch(0.25 0.005 285);
  --secondary-foreground: oklch(0.965 0.001 286);
  --muted: oklch(0.25 0.005 285);
  --muted-foreground: oklch(0.68 0.01 284);
  --accent: oklch(0.25 0.005 285);
  --accent-foreground: oklch(0.965 0.001 286);
  --destructive: oklch(0.65 0.2 27);
  --destructive-foreground: oklch(0.98 0.01 240);
  --border: oklch(1 0 0 / 12%);
  --input: oklch(1 0 0 / 16%);
  --mica-bg: rgba(45,49,55,.82); --mica-line: rgba(255,255,255,.08);
  --shadow-mica: 0 8px 26px rgba(0,0,0,.5), 0 2px 6px rgba(0,0,0,.4), 0 0 0 .5px rgba(255,255,255,.06);
}
[data-theme='dark'][data-accent='purple'] { --primary: oklch(0.66 0.2 287); }
[data-theme='dark'][data-accent='orange'] { --primary: oklch(0.76 0.15 55); }
[data-theme='dark'][data-accent='cyan']   { --primary: oklch(0.77 0.12 214); }
[data-theme='dark'][data-accent='green']  { --primary: oklch(0.72 0.13 152); }
[data-theme='dark'][data-accent='indigo'] { --primary: oklch(0.62 0.19 274); }

@theme inline {
  --color-background: var(--background); --color-foreground: var(--foreground);
  --color-card: var(--card); --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover); --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary); --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary); --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted); --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent); --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive); --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border); --color-input: var(--input); --color-ring: var(--ring);
  --radius-sm: calc(var(--radius) - 4px); --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius); --radius-xl: calc(var(--radius) + 4px);
}
```

- [ ] **Step 4: 共存隔离** — 旧 app.css 的选择器都是自定义 class（.tb-btn 等），与 Tailwind preflight 冲突点仅在全局重置。在 app.css 首行前保持不动；若截图出现字体/间距漂移，在 `src/index.css` 末尾追加：

```css
@layer base { html { color: var(--ink); font-family: var(--font); } }
```
以旧 app.css 实际变量为准逐项核对（--font/--ink 仍由 app.css 提供）。

- [ ] **Step 5: 验证** — `npm run typecheck; npm run build` 预期零错误；`npm start` 后界面应与基线截图完全一致（双栈共存但尚无组件使用 Tailwind，preflight 可能引起 1px 级位移，需肉眼比对 `shot-home.png` 同屏状态，位移明显则回到 Step 4 处理 body 级冲突）。

- [ ] **Step 6: Commit** `feat: shadcn 令牌体系与 cn() 基建(双栈共存)`

### Task 3: 组件源码落地 src/components/ui/

**Files:**
- Create: `src/components/ui/{button,input,badge,separator,switch,tabs,tooltip,dropdown-menu,dialog,alert-dialog}.tsx`
- Create: `src/components/ui/sonner.tsx`（Toaster 包装）

- [ ] **Step 1:** 优先 `npx shadcn@latest add button input badge separator switch tabs tooltip dropdown-menu dialog alert-dialog sonner`；registry 失败则按官方 new-york 源码手工创建同名文件（内容以 ui.shadcn.com 文档源码为准，import `@/lib/utils` 的 cn）。
- [ ] **Step 2:** `sonner.tsx` 导出 `<Toaster />`（`theme` 跟随 `document.documentElement.dataset.theme`，位置 bottom-right，与现有 toast 一致）。
- [ ] **Step 3:** 验证 `npm run typecheck && npm run build` 零错误（组件此步仅存在未使用，允许 unused）。
- [ ] **Step 4:** Commit `feat: 引入 shadcn 组件源码(button/input/menu/dialog 等)`

### Task 4: icons.tsx 全量切换 lucide（保留导出名）

**Files:**
- Modify: `src/components/icons.tsx`（整文件重写）
- 参照: 现有导出清单（IconHome/IconClock/IconArchive/IconTasks/IconSettings/IconClose/IconChevron*/IconSidebar 等全部）

- [ ] **Step 1:** 重写为再导出映射，图标语义就近选 lucide 名，例如：

```tsx
import {
  Home, Clock, Archive, ListChecks, Settings, X, ChevronLeft, ChevronRight, ChevronDown,
  PanelLeft, Search, Plus, UnfoldVertical, /* … */
} from 'lucide-react';
export const IconHome = (p: { className?: string }) => <Home size={16} strokeWidth={1.75} {...p} />;
export const IconClose = (p: { className?: string }) => <X size={16} strokeWidth={1.75} {...p} />;
// … 每个旧导出名一行,尺寸默认 16,stroke 1.75 贴近原手绘粗细
```
对不上的概念（竹风 logo、压缩路由图标等品牌件）保留原手绘 SVG 于本文件尾部，注释标记 legacy。

- [ ] **Step 2:** `npm run typecheck` 预期零错误——若有视图引用了漏映射的旧图标名，补映射。`npm run build` + `npm start` 截图首页/浏览视图，预期图标全部正常渲染、尺寸 16px 网格不破。
- [ ] **Step 3:** Commit `feat: 图标体系切换为 lucide-react`

---

## 阶段 2 · 骨架三件

统一迁移手法（Task 5-7 通用，执行时不再重复说明）：
1. 保留组件 JSX 结构、props、事件逻辑不动；
2. 把 `className="xxx"` 换成 Tailwind 类（用 `bg-background/border-input/text-foreground/rounded-md/hover:bg-accent` 等令牌类）；能用 shadcn `Button/Tooltip` 的直接替换标签，variant/size 就近选择；
3. 从 app.css 删除该组件独占的样式区块（公共令牌类区块留到最后）；
4. `npm run typecheck && npm run build` 通过 + CDP 截图对照基线；
5. commit。

### Task 5: TopBar

**Files:** Modify `src/components/TopBar.tsx`、`src/styles/app.css`（删 .topbar 区）
- 注意：拖拽区保留 `-webkit-app-region: drag`（写成 inline style 或 index.css 里保留 `.app-drag/.app-nodrag` 两个 utility），窗口控制按钮换 shadcn Button variant="ghost" size="icon"。
- Check: 窗口可拖动、双击最大化、铃铛下拉可点（浮层容器必须 no-drag）。
- Commit `refactor(ui): TopBar 迁移 shadcn 风格`

### Task 6: Sidebar（含 collapsed 专注模式）

**Files:** Modify `src/components/Sidebar.tsx`、app.css（删 .sidebar 区）
- `hidden` prop 的折叠必须保留可过渡：用 `transition-[width] duration-150` + `w-0 !p-0 border-r-transparent overflow-hidden`；宽度归零时 border 也要归零（沿用旧坑：border-right-width 计入 width）。
- 导航项用 `Button variant="ghost"` 语义或手写 `data-active:` 类；激活态 `bg-accent text-accent-foreground`。
- Check: Alt+B 折叠动画顺滑、外部打开自动隐藏行为不变。
- Commit `refactor(ui): Sidebar 迁移`

### Task 7: TabBar + ui.tsx 浮层基础（ContextMenu/Modal 皮肤）

**Files:** Modify `src/components/TabBar.tsx`、`src/components/ui.tsx`、app.css（删 .ttab/.ctx-* 区）
- TabBar：标签 `h-8 rounded-md`，激活 `bg-card shadow-sm border`，关闭钮 ghost icon 14。
- ui.tsx 的 ContextMenu：**视觉保留 Mica**——样式改写为 Tailwind 任意值 + `--mica-*` 令牌（`backdrop-blur-[30px] bg-[var(--mica-bg)] border-[var(--mica-line)] shadow-[var(--shadow-mica)]`），条目 h-8/图标槽 w-4 结构不变；Modal 保留自绘但换令牌类。
- Check: 文件列表右键 → 菜单观感与基线一致；「更多」dropdown 正常。
- Commit `refactor(ui): TabBar 与浮层基件迁移,Mica 菜单保留`

---

## 阶段 3 · 简单页面

### Task 8: 首页 Home

**Files:** Modify `src/views/Home.tsx`、app.css（删首页卡片区）
- 三快捷卡 → shadcn Card（`bg-card border rounded-xl`）；主行动卡 `bg-primary text-primary-foreground`；最近板块行 hover 用 `hover:bg-accent`；图标换 lucide。
- Check: 压缩/解压智能路由行为不变（选压缩包→解压文案）；showRecentOpen/showRecentTasks 全关时居中。
- Commit `refactor(ui): 首页迁移 shadcn 卡片风格`

### Task 9: RecentFiles + MyArchives + TasksPage/TaskCenter

**Files:** Modify `src/views/{RecentFiles,MyArchives,TasksPage}.tsx`、`src/components/{TaskCenter}.tsx`、app.css（删对应列表区）
- 列表行统一 `group grid ... hover:bg-accent rounded-md`；空状态 `text-muted-foreground`；任务进度条 `bg-primary/15` 槽 + `bg-primary` 条。
- Check: 行右键菜单、双击打开、任务取消按钮均可用。
- Commit `refactor(ui): 最近/压缩包/任务视图迁移`

### Task 10: SettingsPage

**Files:** Modify `src/views/SettingsPage.tsx`、app.css（删设置区）
- 标签页换 shadcn `Tabs`；开关换 `Switch`；三张主题卡片保留自绘但用 Tailwind 重写（注意旧坑：button 容器显式 `items-stretch`）；六色 accent 圆点 `bg-[var(--…)]` + 选中 `ring-2 ring-ring`；集成标签勾选换 `Checkbox`（如 Task 3 未装 checkbox 则补 `npx shadcn@latest add checkbox`）。
- Check: 改主题/改 accent 即时生效；Bandizip 右键菜单勾选写注册表流程无回归（勾选后 `reg query HKCU\Software\Classes\*\shell` 验证）。
- Commit `refactor(ui): 设置页迁移 shadcn`

---

## 阶段 4 · 浏览视图（最大块）

### Task 11: Browser 导航行 + 工具栏 + 状态栏

**Files:** Modify `src/views/Browser.tsx`、app.css（删 .br-nav/.toolbar 区）
- 面包屑 → 手写 Tailwind（`Separator` 竖线分隔）；搜索框 → shadcn `Input` 保留 Ctrl+F 聚焦逻辑；导航行最左 IconSidebar 开关按钮、`.nav-arrow.on` accent 态语义保留（`text-primary`）。
- 验收附 CDP 断言（本阶段专用，后续任务复用）：
```powershell
# 起调试实例(提权):electron dist-electron/main.js --remote-debugging-port=9333 --open <test.zip>
# 断言序列: 1) .sidebar computed width===0  2) 点开关后===216  3) Alt+B 回 0
```
- Commit `refactor(ui): 浏览工具栏迁移`

### Task 12: 目录树 br-tree

**Files:** Modify Browser.tsx 树区段、app.css（删 .br-tree 区）
- 行 `h-7 rounded-md hover:bg-accent`，选中 `bg-primary/10 text-primary`；缩进竖线保留；展开箭头用 lucide ChevronRight `data-[open]:rotate-90 transition-transform`。
- Check: 双击目录展开/折叠、点目录过滤列表行为不变。
- Commit `refactor(ui): 目录树迁移`

### Task 13: 文件列表 + 详情面板（含响应式/拖宽新规格，见 specs/2026-09-29-browse-responsive-resize-design.md）

**Files:** Modify Browser.tsx 列表/面板区段、Sidebar.tsx（拖宽+收紧留白+默认 176）、App.tsx（sbWidth 状态 + 冷启动才折叠）、shared/types.ts + electron/main.ts（Settings 新增 sidebarWidth/listColumnWidths）、app.css（删 .row/.list-head/.ck-box/.entry-list/.detail-pane 区）
- 行网格列宽改 CSS 变量单源 `30px minmax(120px,1fr) var(--col-type) var(--col-size) var(--col-time)`，表头与行共用；右侧三列表头右缘拖动手柄（clamp 72–320，时间下限 110，双击复位 110/110/160），松手写 Settings；行高 `h-8`；选中 `bg-primary/10`。
- 表头挪进滚动容器内 `sticky top-0`（根治滚动条错位）；窄容不下时保持 min-width 横向滚动。
- 工具栏：Browser 根加 `@container`，动作行文字 `@max-[640px]:hidden` 图标化；搜索框改 `flex-1 min-w-[140px] max-w-[260px]`。
- 侧边栏：默认 216→176，右缘手柄 156–260 可拖、双击复位、持久化；自动折叠仅限冷启动载荷（onLaunch 移交不折）。
- 详情面板：`w-[clamp(232px,23vw,300px)]` 保留响应式；动作四按钮 `grid grid-cols-4`（ghost 小尺寸）；字段行 label `text-muted-foreground`。
- Check: CDP 探针 tzm16——拖动后变量生效且表头/行逐列对齐；带滚动条错位反证；双击复位；reload 后 settings 回读；860×560 无溢出且动作行图标态；侧边栏 176/拖动/复位/持久化；移交不折叠、冷启动折叠；排序点列头、Shift/Ctrl 多选、按选中解压路由不变。
- Commit `refactor(ui): 文件列表与详情面板迁移`(另补一个 `feat(ui): 列宽/侧边栏可拖与响应式` 逻辑提交亦可，实施时定)

---

## 阶段 5 · 对话框与收尾

### Task 14: 四个对话框 + toast 接线

**Files:** Modify `src/components/{CompressDialog,ExtractDialog,RenameDialog,PasswordDialog}.tsx`、`src/App.tsx`（toast 渲染点改 `<Toaster/>`+`toast()`）、app.css（删对话框/toast 区）
- 外壳全部换 shadcn `Dialog`（保留内部业务 state/校验逻辑）；「删除确认」类小弹窗用 `AlertDialog`；解压对话框内条目 Chip 重命名交互保留原逻辑，样式改 `border-input hover:border-primary/40`（对齐重命名克制规范）；新建压缩包主按钮 `Button`（variant=default）。
- Check: 压缩→加密→解压全流程跑通一个真实 zip（含中文名条目，验证 7za OEM 代码页旧坑无回归）；toast 出现于右下角且深浅色正确。
- Commit `refactor(ui): 对话框与 toast 迁移 shadcn`

### Task 15: 删除 app.css 与全量回归

**Files:** Delete: `src/styles/app.css`；Modify: `src/main.tsx:4`（去 import）；残留引用清零
- [ ] Step 1: `grep -rn "styles/app.css" src/` 确认仅 main.tsx 引用；把仍被依赖的杂项类（-webkit-app-region、滚动条美化、.tz-scroll 等）先平移进 `src/index.css` 再删文件。
- [ ] Step 2: `npm run typecheck && npm run build` 零错误。
- [ ] Step 3: CDP 全页面截图矩阵：首页/最近/压缩包/任务/设置 × light/dark × 6 accent 抽查 4 组；浏览视图断言序列全跑（Task 11/13 的）。
- [ ] Step 4: 外部打开 zip（`--open` 载荷）回归专注模式；关最后一个标签回首页恢复侧边栏。
- [ ] Step 5: Commit `chore(ui): 移除 app.css,shadcn 迁移完成`；更新规范记忆（现代文件管理器规范→shadcn 规范；Mica 菜单记忆标注待决）。

## 附录 · CDP 验证配方（本项目专用）

```powershell
# 1. 造测试包
Compress-Archive -Path <某文件> -DestinationPath 'E:\Development projects\TongZip\tzm.zip' -Force
# 2. 起调试实例(必须 required_permissions=all)
Start-Process -FilePath 'E:\Development projects\TongZip\node_modules\electron\dist\electron.exe' `
  -ArgumentList 'dist-electron/main.js','--remote-debugging-port=9333','--open','"E:/Development projects/TongZip/tzm.zip"' `
  -WorkingDirectory 'E:\Development projects\TongZip'
# 3. node 脚本连 http://127.0.0.1:9333/json/list 取 page target,Runtime.evaluate 断言;
#    布局视口用 Emulation.setDeviceMetricsOverride(1280x800);Page.captureScreenshot 在窗口被遮挡时会挂起,不要依赖它。
# 4. 测完杀进程、删 tzm.zip、清 recentArchives 残留、npm start 恢复正常模式
```
