/** 展示层工具函数 */

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let u = -1;
  let v = n;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[u]}`;
}

export function fmtRatio(size: number, packed: number): string {
  if (!size) return '';
  const r = (packed / size) * 100;
  return `${r.toFixed(0)}%`;
}

/** 从绝对路径取文件名(兼容 / 与 \) */
export function basename(p: string): string {
  const m = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const i = m.lastIndexOf('/');
  return i >= 0 ? m.slice(i + 1) : m;
}

export function parentDir(p: string): string {
  const m = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const i = m.lastIndexOf('/');
  return i > 0 ? m.slice(0, i) : m.slice(0, 1);
}

export const FORMAT_EXT: Record<string, string> = {
  '7z': '.7z', zip: '.zip', tar: '.tar', 'tar.gz': '.tar.gz',
  'tar.bz2': '.tar.bz2', 'tar.xz': '.tar.xz', 'tar.zst': '.tar.zst',
};

export const FORMAT_LABEL: Record<string, string> = {
  '7z': '7Z 压缩包', zip: 'ZIP 压缩包', tar: 'TAR 归档', 'tar.gz': 'TAR.GZ 归档',
  'tar.bz2': 'TAR.BZ2 归档', 'tar.xz': 'TAR.XZ 归档', 'tar.zst': 'TAR.ZST 归档',
};

export const SAVE_FILTERS = [
  { name: '7Z 压缩包', extensions: ['7z'] },
  { name: 'ZIP 压缩包', extensions: ['zip'] },
  { name: 'TAR.GZ 归档', extensions: ['gz', 'tar.gz'] },
  { name: '所有文件', extensions: ['*'] },
];
