# TongZip UI 迁移 shadcn-ui 设计文档

日期：2026-09-29 状态：已获用户批准（动机=喜欢 shadcn 颜值；范围=整体换装；路线=方案 B 真迁移；图标=换 Lucide；右键菜单=本期保留 Mica、风格后续再定）

## 目标

将 TongZip（Electron 33 + React 19 + Vite 6，现自绘 app.css 设计系统）整体迁移到 Tailwind CSS 4 + shadcn/ui 组件体系，视觉对齐 shadcn 官方风格，行为与现有功能完全保持一致。

## 技术底座

- 依赖：`tailwindcss@4` + `@tailwindcss/vite`、`clsx`、`tailwind-merge`、`class-variance-authority`、按需 `@radix-ui/react-*`（dropdown-menu / dialog / alert-dialog / tooltip / switch / tabs / select / context-menu）、`lucide-react`、`sonner`。
- 工程文件：`components.json`、`src/lib/utils.ts`（cn()）、`src/index.css`（Tailwind 入口 + shadcn CSS 变量）。
- 主题：沿用 shadcn CSS Variables 模式。
  - 三档主题（浅色/深色/跟随系统）保留现有 `data-theme` 机制，映射 shadcn light/dark 变量组（OKLCH）。
  - 六色 accent 预设改为 `data-accent` 属性切换六套 `--primary/--ring` 变量（深浅各一组），设置页现有 UI 与存储字段不变。
- 共存策略：迁移期 Tailwind 与旧 app.css 并存，用 `@layer` 隔离优先级；全部视图迁完后删除 app.css 死样式。
- 基线保护：迁移开始前已 `git init` 并提交现状基线（已完成，commit 见仓库首条）。

## 组件对账

| 现有实现 | 迁移目标 |
| --- | --- |
| 自绘按钮/输入框/徽章/分隔线 | shadcn `button` `input` `badge` `separator` |
| 设置页开关、标签页 | shadcn `switch` `tabs` |
| 解压下拉、「更多」菜单 | shadcn `dropdown-menu` |
| 解压到/新建压缩包/确认对话框 | shadcn `dialog` + `alert-dialog` |
| 自绘 toast | `sonner` |
| 右键菜单（ContextMenu 组件） | 皮肤用 Tailwind 重写，视觉保留 Win11 Mica 观感与 --mica 令牌；是否换 shadcn 风后续由用户拍板 |
| 文件行/目录树/详情面板/标签栏 | 无现成 shadcn 对应，用 Tailwind 布局 + shadcn 令牌手工构建 |
| src/components/icons.tsx 手绘 SVG | 全部替换为 lucide-react 对应图标 |

组件源码获取：优先 `npx shadcn@latest add`；registry 网络不可达时按官方源码手工拷贝（组件即复制代码，结果一致）。

## 迁移阶段（每阶段独立验收）

1. **地基**：依赖安装、vite 配置、components.json、cn()、全局 CSS 变量与主题映射（含六色 accent、深浅色）跑通构建。
2. **骨架**：TopBar（拖拽区/任务铃铛/窗口控制）、Sidebar、TabBar 多标签栏。
3. **简单页面**：首页（三快捷卡+最近板块）→ 最近文件 / 我的压缩包 → 任务中心 → 设置页。
4. **浏览视图**（最大块）：导航行+工具栏、目录树、文件列表、右侧详情面板。必须原样保留：列排序、多选/区间选、Ctrl+F 搜索、Alt+B 专注模式与外部打开自动隐藏、详情面板 clamp 响应宽度、重命名交互。
5. **对话框与收尾**：解压/压缩相关对话框、sonner 接线、删除 app.css 残余、全量回归。

## 验收标准

- 每阶段：`npm run typecheck && npm run build` 通过。
- 每阶段用 CDP 调试实例截图对照（既有配方：--remote-debugging-port + --open 测试 zip；注意沙箱需提权启动 Electron）。
- 功能回归重点：外部打开压缩包自动隐藏侧边栏、压缩/解压全流程、右键菜单注册表集成设置、多标签切换。
- 深浅色 + 六色 accent 全矩阵抽查无破图。

## 风险与约束

1. 无边框窗口 `-webkit-app-region: drag` 与 Radix Portal 浮层交互：TopBar 下拉/菜单需验证点击不被拖拽区吞掉（浮层容器设 no-drag）。
2. shadcn 视觉与本仓库既有「克制设计」「现代文件管理器」规范记忆冲突：以本次用户决策为准，迁移完成后更新相关规范记忆。
3. 无 git 历史回滚 → 已建仓库；每阶段完成即 commit，问题可二分。
4. Tailwind 4 与 Vite 6 兼容良好，但 `@tailwind` 指令改为 `@import "tailwindcss"`；注意 .npmrc 已配镜像源。

## 不做的事（YAGNI）

- 不引入 shadcn 中本项目用不到的组件（carousel/chart/data-table 等）。
- 不重构任何业务逻辑/IPC/引擎代码；本次仅 UI 层。
- 不改窗口管理、托盘、注册表集成等行为代码。
