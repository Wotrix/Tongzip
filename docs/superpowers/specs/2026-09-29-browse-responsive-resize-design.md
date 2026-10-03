# 浏览区响应式布局与可拖宽列表/侧边栏 — 设计规格

日期:2026-09-29 状态:已与用户逐节确认 关联:shadcn 迁移 T13(并入实施)

## 问题

1. 文件列表列宽写死(名称 1fr / 类型 110 / 大小 110 / 时间 160),窄窗时右侧三列占比过大、名称被挤瘪,且用户无法按喜好调整。
2. 表头 `.list-head` 与滚动容器 `.entry-list` 是两个平级容器:纵向滚动条一出现,行整体左移 ~17px,与表头结构性错位(窄窗放大此现象)。
3. 顶部导航行/动作行按钮全部 flex-none 不换行,窗口接近最小宽 860px 时被裁切、横向溢出。
4. 侧边栏固定 216px 留白过多,不可调宽;窄窗时挤压内容。
5. 侧边栏自动折叠(focus mode)在「应用已运行时二次双击压缩包移交」也会触发,用户要求只在冷启动(双击压缩包启动软件)时折叠;应用内打开压缩包保留侧边栏。

## 决策记录(用户确认)

- 列拖动范围:右侧三列可拖,名称自适应;双击手柄复位。
- 列宽/侧边栏宽度:**持久保存**(Settings)。
- 「菜单栏」= 表头行与顶部工具栏两行都要处理窄宽一致性。
- 折叠时机:仅冷启动载荷自动折叠;二次实例移交、应用内打开均不动侧边栏。

## 设计

### ① 列宽拖动(单一真相 = CSS 变量)

- 列表容器上以行内 style 挂 `--col-type / --col-size / --col-time`(px),表头与每一行的 `grid-template-columns` 均引用 `30px minmax(120px,1fr) var(--col-type) var(--col-size) var(--col-time)`,对齐成为结构性保证。
- 类型/大小/修改时间三列表头各右缘 7px 拖动手柄:`cursor-col-resize`,hover/拖动时高亮细线;Pointer Events + setPointerCapture,move 中 clamp 72–320px(时间列下限 110),名称列吸收差值;双击手柄恢复该列默认(110/110/160)。
- 拖动中在容器上挂 no-transition/select-none,防止橡皮筋与误选中。
- pointerup 后 `window.tz.setSettings({ listColumnWidths })`;Browser 挂载时 `getSettings()` 读回,非法值回默认。
- 容器宽度不足(各列取最小值+名称 120px 仍放不下)时,表头与行同步保持 `min-width`,列表容器横向滚动(sticky 表头随横滚同步,见②)。

### ② 表头进滚动容器

- 结构改为:单个滚动容器内 [sticky top-0 z-1 表头, 行…]。表头实心 `bg-background` + 下边框,防行穿透(padding 留缝旧坑不再存在,行与表头同容器同 padding)。
- `.list-head`/`.row`/`.ck-box`/`.entry-list` 等独占 CSS 区块随 T13 迁移删除,类名保留作选择器钩子的照旧注释。

### ③ 工具栏窄宽降级(容器查询,零 JS)

- Browser 根 div 加 `@container`。
- 动作行按钮文字包 `<span>`,容器宽 < ~640px 时 `@max-[640px]:hidden` 只留图标(tooltip/title 兜底);解压到 split 组同理。
- 导航行搜索框由 `w-[260px] flex-none` 改 `w-[260px] max-w-[260px] min-w-[140px] flex-1`,自然收缩。
- 验收基准:860×560 最小窗、侧边栏 176 + 目录树 full + 详情面板开时,两行无裁切、无横向溢出(`scrollWidth===clientWidth`)。

### ④ 侧边栏

- 默认宽 216 → **176px**;内部留白收紧一档(区块 gap / 上下 padding 减小,导航项高度微调),以「最近文件+任务角标」不截断为准。
- 右缘拖动手柄(与列手柄同款视觉),范围 156–260px,双击复位 176;pointerup 持久化 `sidebarWidth`。
- 折叠(hidden → w-0)动画与 Alt+B / 按钮 / 菜单行为不变;hidden 态手柄不可见不可用。
- 宽度状态在 App.tsx Shell(sbW state,来自 settings),经 props 注入 Sidebar;折叠切换仍用现状。

### ⑤ 自动折叠仅限冷启动

- `handlePayload(p, coldStart)`:仅 `getLaunchPayload()` 路径传 `true` 且未 `sbTouched` 时 `setSbHidden(true)`;`onLaunch` 订阅恒 `false`,不改 sbHidden。
- 应用内「打开压缩包…/新建」不经过载荷,天然保留侧边栏(现状已符合,回归确认)。

## 数据

`shared/types.ts` Settings 新增并给默认:`sidebarWidth?: number`(176)、`listColumnWidths?: { type: number; size: number; time: number }`(110/110/160);electron/main.ts DEFAULTS 同步,旧配置文件缺字段自动回默认。

## 测试与验收(CDP 探针 tzm16)

- 模拟拖动三列手柄 → 对应 CSS 变量在 min/max 内变化,表头与首行各单元格左缘逐列相等;
- 带滚动条长列表下表头/行对齐(现状 bug 的反证);
- 双击手柄复位;reload 后宽度从 settings 回读;
- 860×560:工具栏两行无溢出,动作行进入图标态,搜索框收缩;
- 侧边栏默认 176、手柄拖动 156–260 clamp、双击复位、持久化;
- 移交载荷不折叠、冷启动载荷折叠、sbTouched 后不折叠;
- 回归:tzm14(T11)/tzm15(T12)全绿;typecheck+build。

## 边界

- 仅 UI/交互层;IPC 只新增 Settings 字段,引擎与业务零改动。
- 详情面板不做拖宽(未要求,YAGNI)。
- 与 T13 文件列表/详情面板 shadcn 迁移合并实施,一次提交。
