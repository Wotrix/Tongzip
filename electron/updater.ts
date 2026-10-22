/**
 * 自动更新（仅安装版）：electron-updater + GitHub Releases。
 *
 * 规则：
 * - 只在打包态生效；开发态返回可读错误，不假装检查成功。
 * - 检查到新版本后自动下载；下载完成由用户点「重启并安装」或退出时自动安装。
 * - 当前构建未签名：显式跳过 electron-updater 的发布者签名校验，并在发布说明披露
 *   NotSigned 风险；未来接入签名后应删除 verifyUpdateCodeSignature 覆盖。
 */
import { app } from 'electron';
import type { BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateCheck } from '../shared/types';

const RELEASE_URL = 'https://github.com/Wotrix/Tongzip/releases/latest';
let getWin: (() => BrowserWindow | null) | null = null;
let initialized = false;

function send(ev: UpdateCheck): void {
  const w = getWin?.();
  if (!w || w.isDestroyed()) return;
  w.webContents.send('tz:update-event', ev);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 把 electron-updater / 网络错误翻成用户能读懂的一句话 */
function friendly(e: unknown): string {
  const m = errText(e);
  if (/No published versions|404/i.test(m)) return 'GitHub 上还没有正式版本';
  if (/rate limit|403/i.test(m)) return 'GitHub 连接被限流，请稍后重试';
  if (/net::|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONN|socket hang up/i.test(m)) {
    return '无法连接 GitHub，请检查网络后重试';
  }
  if (/signature|publisher/i.test(m)) return '更新包签名校验失败（当前构建未签名）';
  return `更新检查失败：${m}`;
}

export function initUpdater(getWindow: () => BrowserWindow | null): void {
  if (initialized) return;
  initialized = true;
  getWin = getWindow;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  /* 测试/自托管预留：TONGZIP_UPDATE_URL 指向 generic 静态源；默认走 app-update.yml 的 GitHub */
  const feed = process.env.TONGZIP_UPDATE_URL;
  if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed });
  /* 未签名阶段：跳过发布者签名校验（发布说明已披露 NotSigned）；签名接入后必须移除 */
  (autoUpdater as unknown as {
    verifyUpdateCodeSignature: (publisherName: string[], path: string) => Promise<string | null>;
  }).verifyUpdateCodeSignature = async () => null;

  autoUpdater.on('checking-for-update', () => send({ status: 'checking', url: RELEASE_URL }));
  autoUpdater.on('update-available', (info) =>
    send({ status: 'available', latest: info.version, url: RELEASE_URL }));
  autoUpdater.on('update-not-available', (info) =>
    send({ status: 'latest', latest: info.version, url: RELEASE_URL }));
  autoUpdater.on('download-progress', (p) =>
    send({
      status: 'downloading',
      percent: Math.max(0, Math.min(100, Math.round(p.percent))),
      transferred: p.transferred,
      total: p.total,
      url: RELEASE_URL,
    }));
  autoUpdater.on('update-downloaded', (info) =>
    send({ status: 'downloaded', latest: info.version, url: RELEASE_URL }));
  autoUpdater.on('error', (e) => send({ status: 'error', message: friendly(e), url: RELEASE_URL }));
}

/** 手动检查：返回检查结果；下载进度由 tz:update-event 推送 */
export async function checkForUpdate(): Promise<UpdateCheck> {
  if (!app.isPackaged) {
    return { status: 'error', message: '开发模式不执行自动更新检查', url: RELEASE_URL };
  }
  try {
    const r = await autoUpdater.checkForUpdates();
    if (!r) return { status: 'notfound', url: RELEASE_URL };
    const latest = r.updateInfo.version;
    if (!latest) return { status: 'notfound', url: RELEASE_URL };
    return latest !== app.getVersion()
      ? { status: 'available', latest, url: RELEASE_URL }
      : { status: 'latest', latest, url: RELEASE_URL };
  } catch (e) {
    const msg = errText(e);
    if (/No published versions|404/i.test(msg)) return { status: 'notfound', url: RELEASE_URL };
    return { status: 'error', message: friendly(e), url: RELEASE_URL };
  }
}

/** 启动后静默检查一次（仅打包态）；错误不打扰用户，设置页手动检查时再展示 */
export function scheduleStartupCheck(): void {
  if (!app.isPackaged) return;
  setTimeout(() => { void checkForUpdate().catch(() => undefined); }, 15_000);
}

/** 立即退出并安装已下载的更新 */
export function installUpdate(): void {
  autoUpdater.quitAndInstall(false, true);
}
