/**
 * 文件类型彩色图标 — 「是什么文件就用什么图标」:一类一形一色。
 * 文件夹黄 / 归档紫 / 代码青 / 图片粉 / 音频玫 / 视频橙 / pdf红 / word蓝 / 表格绿
 * / 演示琥珀 / 电子书紫 / 字体堇 / 可执行teal / 镜像蓝 / 文本灰 / 加密警示黄
 */
import type { ArchiveEntry } from '@shared/types';
import { isArchiveExt } from '@shared/types';
import {
  IconApp, IconArchive, IconBook, IconCode, IconDisc, IconFile, IconFileAudio, IconFileText,
  IconFileVideo, IconFolder, IconFont, IconImage, IconLock, IconSheet, IconSlide,
} from './icons';

const CODE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'py', 'c', 'cpp', 'h', 'hpp', 'java', 'go', 'rs', 'json', 'xml', 'html', 'css', 'scss', 'sh', 'bat', 'ps1', 'vue', 'sql', 'cmd', 'lua', 'rb', 'php']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'heic', 'psd', 'ai', 'cr2', 'nef']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'amr', 'aiff', 'ape', 'mid', 'midi']);
const VIDEO_EXT = new Set(['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', '3gp', 'mpg', 'mpeg', 'rmvb', 'ogv']);
const PDF_EXT = new Set(['pdf']);
const WORD_EXT = new Set(['doc', 'docx', 'rtf', 'odt']);
const SHEET_EXT = new Set(['xls', 'xlsx', 'csv', 'ods']);
const SLIDE_EXT = new Set(['ppt', 'pptx', 'odp', 'key']);
const BOOK_EXT = new Set(['epub', 'mobi', 'azw', 'azw3', 'fb2']);
const TEXT_EXT = new Set(['txt', 'md', 'log', 'ini', 'yaml', 'yml', 'toml', 'conf', 'srt', 'ass', 'vtt']);
const EXE_EXT = new Set(['exe', 'msi', 'msix', 'apk', 'deb', 'rpm', 'jar', 'dll', 'scr']);
const FONT_EXT = new Set(['ttf', 'otf', 'woff', 'woff2', 'eot', 'fon', 'fnt']);
const DISC_EXT = new Set(['iso', 'img', 'vhd', 'wim', 'esd']);

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
  if (PDF_EXT.has(e)) return <IconFileText className="fx fx-pdf" style={style} />;
  if (WORD_EXT.has(e)) return <IconFileText className="fx fx-word" style={style} />;
  if (SHEET_EXT.has(e)) return <IconSheet className="fx fx-sheet" style={style} />;
  if (SLIDE_EXT.has(e)) return <IconSlide className="fx fx-slide" style={style} />;
  if (BOOK_EXT.has(e)) return <IconBook className="fx fx-book" style={style} />;
  if (IMAGE_EXT.has(e)) return <IconImage className="fx fx-image" style={style} />;
  if (AUDIO_EXT.has(e)) return <IconFileAudio className="fx fx-audio" style={style} />;
  if (VIDEO_EXT.has(e)) return <IconFileVideo className="fx fx-video" style={style} />;
  if (CODE_EXT.has(e)) return <IconCode className="fx fx-code" style={style} />;
  if (FONT_EXT.has(e)) return <IconFont className="fx fx-font" style={style} />;
  if (EXE_EXT.has(e)) return <IconApp className="fx fx-exe" style={style} />;
  if (DISC_EXT.has(e)) return <IconDisc className="fx fx-disc" style={style} />;
  if (TEXT_EXT.has(e)) return <IconFileText className="fx fx-text" style={style} />;
  return <IconFile className="fx fx-plain" style={style} />;
}

/** 列表行便捷入口:直接吃 ArchiveEntry */
export function EntryGlyph({ entry, size }: { entry: ArchiveEntry; size?: number }) {
  return <FileGlyph name={entry.name} isDir={entry.isDir} encrypted={entry.encrypted} size={size} />;
}
