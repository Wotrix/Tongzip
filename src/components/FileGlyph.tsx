/**
 * 文件类型彩色图标 — 参考图体系:文件夹黄 / 归档蓝 / 代码青 / 图片粉 / 文档紫 / 文本灰
 */
import type { ArchiveEntry } from '@shared/types';
import { isArchiveExt } from '@shared/types';
import { IconArchive, IconCode, IconFile, IconFolder, IconImage, IconLock, IconProperties } from './icons';

const CODE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'py', 'c', 'cpp', 'h', 'hpp', 'java', 'go', 'rs', 'json', 'xml', 'html', 'css', 'scss', 'sh', 'bat', 'ps1', 'vue', 'sql']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'heic', 'psd', 'ai']);
const DOC_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'epub', 'odt']);
const TEXT_EXT = new Set(['txt', 'md', 'log', 'ini', 'csv', 'yaml', 'yml', 'toml', 'conf']);

function extOf(name: string): string {
  const dot = name.toLowerCase().lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export default function FileGlyph({ name, isDir, encrypted, size = 18 }: {
  name: string; isDir: boolean; encrypted?: boolean; size?: number;
}) {
  const style = { width: size, height: size };
  if (isDir) return <IconFolder className="fx fx-folder" style={style} />;
  if (encrypted) return <IconLock className="fx fx-enc" style={style} />;
  const e = extOf(name);
  if (isArchiveExt(e)) return <IconArchive className="fx fx-archive" style={style} />;
  if (CODE_EXT.has(e)) return <IconCode className="fx fx-code" style={style} />;
  if (IMAGE_EXT.has(e)) return <IconImage className="fx fx-image" style={style} />;
  if (DOC_EXT.has(e)) return <IconProperties className="fx fx-doc" style={style} />;
  if (TEXT_EXT.has(e)) return <IconFile className="fx fx-text" style={style} />;
  return <IconFile className="fx fx-plain" style={style} />;
}

/** 列表行便捷入口:直接吃 ArchiveEntry */
export function EntryGlyph({ entry, size }: { entry: ArchiveEntry; size?: number }) {
  return <FileGlyph name={entry.name} isDir={entry.isDir} encrypted={entry.encrypted} size={size} />;
}
