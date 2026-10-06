/**
 * 列表视图共享版式令牌 — Browser(压缩包)与 FolderView(磁盘目录)同一设计系统:
 * 导航箭头 / 面包屑 / 工具栏按钮皮肤 / 列网格 / 复选框 / 文本测量。
 * (自 Browser.tsx 平移,类名钩子 list-head/entry-list/row/ck-box/tab-slot 被 CDP 探针依赖,勿改)
 */
import { cn } from '@/lib/utils';

/** 返回/前进/侧栏开关箭头:30px 方形 ghost 图标钮,.on 态用 accent 单点提示 */
export const ARROW_CLS = cn(
  'inline-flex size-[30px] shrink-0 items-center justify-center rounded-md',
  'text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
  'disabled:opacity-50 disabled:hover:bg-transparent',
);
/** 面包屑段落:悬停浅底、超宽省略(旧 .crumb) */
export const CRUMB_CLS = cn(
  'block max-w-[260px] shrink-0 truncate rounded-md px-2 py-1 text-[13px]',
  'text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
);
/** 工具栏按钮皮肤(旧 .tbtn:32px 高 / 12.5px 字 / 15px 图标),与 shadcn Button 尺寸类同层级覆盖 */
export const TB_CLS = cn(
  'h-8 shrink-0 gap-[7px] rounded-md px-3 text-[12.5px] font-normal whitespace-nowrap',
  /* button 基座带 [&_svg:not([class*=size-])]:size-4(选择器多一层 :not, specificity 更高),
     所以图标尺寸必须带 ! 才能压住它 — 否则全部沦为 16px */
  'has-[>svg]:px-3 shadow-none [&_svg]:size-[15px]!',
);
/** 描边按钮(旧 .tbtn.bordered):暗色下沿用页面底,不吃 shadcn 的 input/30 灰底 */
export const TB_OUTLINE_CLS = cn(TB_CLS, 'border-border bg-background dark:bg-background dark:hover:bg-accent');

/** 列宽兜底(测量不可用时) */
export const COL_DEFAULTS = { type: 72, size: 72, time: 130 } as const;
export type ColKey = keyof typeof COL_DEFAULTS;
export type AnyColKey = ColKey | 'name';
/** 每列拖动范围 [下限, 上限];时间列下限要容得下完整时间戳 */
export const COL_LIMITS: Record<ColKey, [number, number]> = { type: [72, 320], size: [72, 320], time: [110, 320] };
export const NAME_RANGE: [number, number] = [120, 600];
export const clampCol = (k: ColKey, w: number) => Math.min(COL_LIMITS[k][1], Math.max(COL_LIMITS[k][0], Math.round(w) || COL_DEFAULTS[k]));
export const clampName = (w: number) => Math.min(NAME_RANGE[1], Math.max(NAME_RANGE[0], Math.round(w) || 200));

/* canvas 文本测量:默认列宽按当前目录最长内容收紧(尽量小且完整) */
export const _mctx = document.createElement('canvas').getContext('2d');
export const measure = (txt: string, font: string) => { if (!_mctx) return txt.length * 7; _mctx.font = font; return _mctx.measureText(txt).width; };
export const CELL_FONT = '12.5px "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif';
/** 表头按 semibold 量:激活列加粗/箭头都不致裁切 */
export const HEAD_FONT = '600 12px "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif';

/** 表头/行共用网格模板:名称列未定宽时弹性保底 120px,窄容不下时溢出→横滚,表头随行对齐 */
export const LIST_GRID = cn(
  'grid grid-cols-[30px_var(--col-name,minmax(120px,1fr))_var(--col-type)_var(--col-size)_var(--col-time)] items-center pl-3 pr-4',
  'min-w-[calc(30px_+_max(120px,var(--col-name,120px))_+_var(--col-type)_+_var(--col-size)_+_var(--col-time)_+_28px)]',
);

/** 自绘对勾的原生复选框 */
export const CK_CLS = cn(
  'relative size-[15px] shrink-0 cursor-pointer appearance-none rounded-[4px] border-[1.5px] border-input bg-background',
  'transition-[background,border-color] duration-100 hover:border-primary',
  'checked:border-primary checked:bg-primary',
  "after:absolute after:left-[4px] after:top-[1px] after:h-[9px] after:w-[5px] after:rotate-45 after:content-['']",
  'after:border-b-[1.8px] after:border-r-[1.8px] after:border-[color:var(--accent-ink)] after:opacity-0 checked:after:opacity-100',
);

/** 列宽设置(listColumnWidths)读取:Browser 与 FolderView 共用同一份持久化 */
export async function loadColWidths(setCols: (fn: (p: Partial<Record<ColKey, number> & { name?: number }>) => Partial<Record<ColKey, number> & { name?: number }>) => void) {
  const s = await window.tz.getSettings();
  const c = s.listColumnWidths;
  if (!c) return;
  setCols((p) => ({
    type: typeof c.type === 'number' ? clampCol('type', c.type) : p.type,
    size: typeof c.size === 'number' ? clampCol('size', c.size) : p.size,
    time: typeof c.time === 'number' ? clampCol('time', c.time) : p.time,
    name: typeof c.name === 'number' ? clampName(c.name) : undefined,
  }));
}
