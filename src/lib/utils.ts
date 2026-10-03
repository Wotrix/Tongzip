import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn 标准类名合并:条件类 + tailwind 冲突消解 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
