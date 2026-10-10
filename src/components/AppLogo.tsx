/**
 * 品牌图形标识 — 直接采用生成好的 logo 位图(build/icon.png:紫色 T 字拉链、透明底)。
 * 与手绘竹节 SVG(icons.tsx 的 Logo)区分:这里要还原真实品牌观感(侧栏 / 顶栏 / 各标题栏),
 * SVG 版留给需要单色跟随 currentColor 的场合。位图自带配色,故不再套紫底方块。
 */
import logoUrl from '../../build/icon.png';
import { cn } from '@/lib/utils';

export default function AppLogo({ className }: { className?: string }) {
  return (
    <img
      src={logoUrl}
      alt="TongZip"
      draggable={false}
      className={cn('shrink-0 select-none object-contain', className)}
    />
  );
}
