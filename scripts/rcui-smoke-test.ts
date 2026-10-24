/**
 * RC-C3/C4/C9(+C10 收尾)— 真实发布候选 UI 冒烟探针
 * 从 release/win-unpacked/TongZip.exe(冻结提交产物,启动时核对哈希对应关系)冷启动,
 * 走真实 shell 命令路由(--compress-as / --extract-here)驱动 React UI,断言:
 *  - RC-C4:预设 tar.zst 打开对话框 → 明示回退 7Z,引擎不被调起,零落盘
 *  - RC-C3:ZIP 中文密码 → 行内即时警示 + 提交拦截 toast + 无半成品;正证:ASCII 密码可正常完成
 *  - RC-C9:恶意路径包 --extract-here → 熔断错误码 UNSAFE_PATH + 可读 toast + 目录内外一字不写
 *  - RC-C10:全程密码哨兵词在 userData/工作目录零泄漏 grep
 * 每步截图留痕 docs/phase4/rcui-shots/;判定只用三态,截图只是辅助证据。
 * 纪律:纯测试新增,不改产品代码;发现缺陷只登记不定改。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assert, mkTemp, rmRecursive, killTree, pickFreePort, runProbe, sha256, writeOutJson,
  waitReady, installEventCollector, q,
  type ProbeApp,
} from './probe-lib';

const EXE = path.resolve('release/win-unpacked/TongZip.exe');
const SHOTDIR = path.resolve('docs/phase4/rcui-shots');
const PW_SENTINEL = 'Sentinel-Pw-9x!@'; // ASCII(ZIP 正证用),C10 全文扫描哨兵
const CN_PW = '中文密码#1';

interface Rec { id: string; item: string; expect: string; actual: string; verdict: 'ok' | 'mismatch' | 'pending-real' | 'note'; detail: string }
const records: Rec[] = [];
const shotsFailed: string[] = [];
function record(r: Rec): void { records.push(r); console.log(`[${r.verdict}] ${r.id} ${r.item}: ${r.actual}`); }

/* ---------------- 固定主页 target 的 CDP 通道 ----------------
   成功压缩会触发 taskWindowOpen 开出第二个 page target;probe-lib 的 cdpEval 每次动态解析,
   断言可能落错页面。本探针在单页时刻钉死主窗口 ws 地址,后续全部走固定通道。 */
const pins = new Map<number, string>();

function cdpRpc<T = unknown>(wsUrl: string, method: string, params: unknown, timeoutMs = 20000): Promise<T> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch { /* noop */ } rej(new Error(`CDP ${method} 超时`)); }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data)) as { id?: number; result?: T; error?: { message?: string } };
      if (d.id === 1) {
        clearTimeout(timer); try { ws.close(); } catch { /* noop */ }
        if (d.error) return rej(new Error(`${method}: ${d.error.message}`));
        res(d.result as T);
      }
    };
    ws.onerror = () => { clearTimeout(timer); rej(new Error('CDP 连接失败')); };
  });
}

async function ev(app: ProbeApp, expr: string, timeoutMs = 20000): Promise<unknown> {
  const wsUrl = pins.get(app.port) ?? await pageWsUrl(app.port);
  const r = await cdpRpc<{ result?: { value?: unknown } }>(wsUrl, 'Runtime.evaluate',
    { expression: expr, awaitPromise: true, returnByValue: true }, timeoutMs);
  return r?.result?.value;
}

async function collectEvents(app: ProbeApp): Promise<{ status: string }[]> {
  const v = await ev(app, `(() => { const a = window.__probe || []; window.__probe = []; return JSON.stringify(a); })()`);
  try { return JSON.parse(String(v)) as { status: string }[]; } catch { return []; }
}

/* ---------------- 应用生命周期(带自定义命令行) ---------------- */

async function withApp(fn: (app: ProbeApp, deliver: (args: string[]) => Promise<void>) => Promise<void>): Promise<void> {
  const ud = mkTemp('tz-rcui-');
  const port = await pickFreePort();
  const proc = spawn(EXE, [`--user-data-dir=${ud}`, `--remote-debugging-port=${port}`, '--no-first-run'],
    { stdio: 'ignore', windowsHide: true });
  const app: ProbeApp = { proc, ud, port, exe: EXE };
  /* 载荷注入走真实 second-instance 移交(与资源管理器双击/菜单同链路),
     且保证发生在观察器安装后 —— 消除冷启动 toast 竞态 */
  const deliver = async (args: string[]): Promise<void> => {
    const p = spawn(EXE, [`--user-data-dir=${ud}`, ...args], { stdio: 'ignore', windowsHide: true });
    await new Promise<void>((res) => { p.on('exit', () => res()); setTimeout(res, 8000); });
  };
  try {
    await waitReady(app);
    await installEventCollector(app);
    await installToastRecorder(app);
    pins.set(port, await pageWsUrl(port)); // 此刻仅主窗口,钉死之
    await fn(app, deliver);
  } finally {
    pins.delete(port);
    if (proc.pid) killTree(proc.pid);
    await new Promise((r) => setTimeout(r, 600));
    try { rmRecursive(ud); } catch { /* 占用则留给 cleanupAll */ }
  }
}

/* ---------------- DOM 断言辅助 ---------------- */

/** 页面内挂 toast 收集器(ToastHost 的 toast 节点带 bg-popover/rounded-lg;err 态带 text-destructive),
    4.2s 自动消失,肉眼会错过,收集器保证断言稳定 */
async function installToastRecorder(app: ProbeApp): Promise<void> {
  await ev(app, `(() => {
    window.__toasts = [];
    const hit = (n) => {
      if (n.nodeType !== 1) return;
      const c = String(n.className || '');
      if (c.includes('bg-popover') && c.includes('rounded-lg'))
        window.__toasts.push({ text: n.textContent, err: c.includes('text-destructive') });
    };
    // 种子:安装瞬间仍可见的 toast(冷启动载荷可能在安装前已弹出)
    for (const d of document.querySelectorAll('div')) hit(d);
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) hit(n); })
      .observe(document.body, { childList: true, subtree: true });
    return 'ok';
  })()`);
}

const hasDialogExpr = (title: string) =>
  `(() => [...document.querySelectorAll('h2')].some(h => h.textContent === ${q(title)}))()`;

async function waitForDialog(app: ProbeApp, title = '创建压缩包'): Promise<void> {
  // cdpEval 是异步的,waitFor 判据须同步 —— 自轮询
  const t0 = Date.now();
  for (;;) {
    const v = await ev(app, hasDialogExpr(title));
    if (v === true) return;
    if (Date.now() - t0 > 30_000) throw new Error(`对话框等待超时:${title}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function waitForDialogGone(app: ProbeApp, title = '创建压缩包'): Promise<void> {
  const t0 = Date.now();
  let escalated = 0;
  for (;;) {
    const v = await ev(app, hasDialogExpr(title));
    if (v === false) { if (escalated) console.log(`(关窗经 ${escalated} 号兜底路径成功)`); return; }
    if (Date.now() - t0 > 4000 && escalated === 0) {
      // 兜底 1:CDP 真实鼠标事件点「取消」(React 合成事件对 .click() 偶发不敏感时的可信路径)
      const rect = await ev(app, `(() => { const b = [...document.querySelectorAll('.foot button')].find(x => !String(x.className).includes('primary')); if (!b) return ''; const r = b.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`) as string;
      if (rect) {
        const { x, y } = JSON.parse(rect) as { x: number; y: number };
        const wsUrl = pins.get(app.port)!;
        for (const type of ['mousePressed', 'mouseReleased'] as const) {
          await cdpRpc(wsUrl, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
        }
        escalated = 1;
      }
    }
    if (Date.now() - t0 > 7000 && escalated === 1) {
      // 兜底 2:可信 ESC 按键(App 全局 Escape 关对话框)
      const wsUrl = pins.get(app.port)!;
      await cdpRpc(wsUrl, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await cdpRpc(wsUrl, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      escalated = 2;
    }
    if (Date.now() - t0 > 12_000) throw new Error(`对话框关闭等待超时:${title}(escalated=${escalated})`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function domTexts(app: ProbeApp, sel: string): Promise<string[]> {
  const v = await ev(app, `(() => JSON.stringify([...document.querySelectorAll(${q(sel)})].map(n => n.textContent)))()`) as string;
  try { return JSON.parse(v) as string[]; } catch { return []; }
}

async function getToasts(app: ProbeApp): Promise<{ text: string; err: boolean }[]> {
  const v = await ev(app, `(() => JSON.stringify(window.__toasts || []))()`) as string;
  try { return JSON.parse(v) as { text: string; err: boolean }[]; } catch { return []; }
}
async function waitErrToast(app: ProbeApp, needle: string, timeoutMs = 8000): Promise<string | null> {
  const t0 = Date.now();
  for (;;) {
    const ts = await getToasts(app);
    const hit = ts.find((x) => x.err && (x.text ?? '').includes(needle));
    if (hit) return hit.text ?? '';
    if (Date.now() - t0 > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/* ---------------- 截图(CDP Page.captureScreenshot,自管,不动共用基建) ---------------- */

async function pageWsUrl(port: number): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; url?: string; webSocketDebuggerUrl?: string }[];
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !(t.url ?? '').includes('window=folder') && !(t.url ?? '').includes('window=task'));
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch { /* 未就绪 */ }
    if (Date.now() - t0 > 15000) throw new Error('截图目标等待超时');
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function shot(app: ProbeApp, name: string): Promise<string | null> {
  fs.mkdirSync(SHOTDIR, { recursive: true });
  const file = path.join(SHOTDIR, name);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const wsUrl = pins.get(app.port) ?? await pageWsUrl(app.port);
      const r = await cdpRpc<{ data?: string }>(wsUrl, 'Page.captureScreenshot', { format: 'png' }, 12000);
      if (r?.data) {
        fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
        console.log('shot:', path.relative(process.cwd(), file));
        return file;
      }
    } catch (e) {
      console.log(`shot 尝试 ${attempt + 1} 失败(${name}):`, (e as Error).message);
      await new Promise((rr) => setTimeout(rr, 800));
    }
  }
  shotsFailed.push(name);
  return null; // 截图是辅助证据,失败不阻断判定主链
}

/* ---------------- 恶意 tar 构造(与 selftest G1 同规制,POSIX ustar 手写字节) ---------------- */

function tarHeader(o: { name: string; size: number; typeflag?: string; linkname?: string }): Buffer {
  const b = Buffer.alloc(512);
  b.write(o.name.slice(0, 99), 0, 'latin1');
  b.write('0000644 ', 100); b.write('0000000 ', 108); b.write('0000000 ', 116);
  b.write(o.size.toString(8).padStart(11, '0') + ' ', 124);
  b.write('00000000000 ', 136); b.write('        ', 148);
  b.write(o.typeflag ?? '0', 156);
  if (o.linkname) b.write(o.linkname.slice(0, 99), 157, 'latin1');
  b.write('ustar\x0000', 257);
  let sum = 0; for (const c of b) sum += c;
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return b;
}
function makeTar(items: Array<{ name: string; data?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const it of items) {
    const data = it.data ? Buffer.from(it.data, 'utf8') : Buffer.alloc(0);
    blocks.push(tarHeader({ name: it.name, size: data.length }));
    if (data.length) { const pad = Buffer.alloc(Math.ceil(data.length / 512) * 512); data.copy(pad); blocks.push(pad); }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/* ---------------- C10:哨兵词全文扫描 ---------------- */

function grepSentinel(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (/\.(zip|7z|tar|gz|png|ico)$/.test(e.name)) continue;
      try {
        const buf = fs.readFileSync(f);
        if (buf.includes(needle)) hits.push(f);
      } catch { /* 占用/无权限:跳过但登记 */ }
    }
  };
  try { walk(dir); } catch { /* 目录已删 */ }
  return hits;
}

/* ---------------- 场景 ---------------- */

async function scenarioC4(work: string): Promise<void> {
  const src = path.join(work, 'payload.txt');
  fs.writeFileSync(src, 'tongzip rc ui smoke payload');
  const ARCH_RE = /\.(7z|zip|tar(\.(gz|bz2|xz|zst))?|tgz|txz)$/i;
  const archivesIn = (d: string) => fs.readdirSync(d).filter((f) => ARCH_RE.test(f));
  let dialogSeen = false, noteHit = '', fmt7z = false, evs = -1, spill1 = 'n/a';
  let gzFmt = '', gzNote = false;
  let genName = '', magicOk = false, doneToast = '';
  let badToast = '', badDialog = true;
  const triggerTextExpr = `(() => {
    const lab = [...document.querySelectorAll('label')].find(l => (l.textContent || '').trim() === '格式');
    const f = lab && lab.parentElement ? lab.parentElement.querySelector('button') : null;
    return f ? String(f.textContent || '') : 'NOBTN';
  })()`;
  await withApp(async (app, deliver) => {
    /* ① 不可创建格式 .tar.zst:必须明示回退(ISS-02 fmtNote 路径),引擎不被调起 */
    await deliver(['--compress-as', src, '.tar.zst']);
    await waitForDialog(app);
    dialogSeen = true;
    const t0 = Date.now();
    for (;;) {
      const notes = await domTexts(app, '.note');
      noteHit = notes.find((t) => (t ?? '').includes('不支持创建 TAR.ZST') && (t ?? '').includes('回退为 7Z')) ?? '';
      if (noteHit) break;
      if (Date.now() - t0 > 8000) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    fmt7z = await ev(app, `(() => {
      const lab = [...document.querySelectorAll('label')].find(l => (l.textContent || '').trim() === '格式');
      const f = lab && lab.parentElement ? lab.parentElement.querySelector('button') : null;
      return !!f && /7Z/.test(f.textContent || '');
    })()`) === true;
    await shot(app, 'rc-c4-tarzst-fallback-note.png');
    await new Promise((r) => setTimeout(r, 1200));
    evs = (await collectEvents(app)).length;
    spill1 = archivesIn(work).join(',') || '无';
    await waitForDialogGone(app);
    /* ② 已发货菜单真实 token .tar.gz:必须正确预设为 TAR.GZ(ISS-11 修复断言,不得静默降 7Z) */
    await deliver(['--compress-as', src, '.tar.gz']);
    await waitForDialog(app);
    gzNote = (await domTexts(app, '.note')).some((t) => /回退/.test(t ?? ''));
    gzFmt = String(await ev(app, triggerTextExpr) ?? '');
    await shot(app, 'rc-c4-targz-menu-token-actual.png');
    /* ③ 真实链路提交:核验实际生成文件的格式(gzip magic 字节),不只查 UI 文案 */
    await ev(app, `(() => { const b = [...document.querySelectorAll('.foot button')].find(x => x.className.includes('primary')); if (b && !b.disabled) b.click(); return b ? (b.disabled ? 'DISABLED' : 'clicked') : 'NOBTN'; })()`);
    const g0 = Date.now();
    for (;;) {
      const outs = archivesIn(work);
      if (outs.length) { genName = outs[0]; break; }
      if (Date.now() - g0 > 45_000) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (genName) {
      const fd = fs.openSync(path.join(work, genName), 'r');
      const buf = Buffer.alloc(2); fs.readSync(fd, buf, 0, 2, 0); fs.closeSync(fd);
      magicOk = buf[0] === 0x1f && buf[1] === 0x8b; // gzip 魔数:证明确为 TAR.GZ 而非 7Z
      doneToast = ((await getToasts(app)).find((x) => !x.err && (x.text ?? '').includes('已生成'))?.text) ?? '';
    }
    await waitForDialogGone(app); // 任务 done 后对话框自动关闭
    /* ④ 未知显式格式 token:必须明确报错、不开对话框、不执行任何操作(禁止静默回退) */
    await deliver(['--compress-as', src, '.tar.lz5']);
    const b0 = Date.now();
    for (;;) {
      const ts = await getToasts(app);
      const hit = ts.find((x) => x.err && (x.text ?? '').includes('无法识别'));
      if (hit) { badToast = hit.text ?? ''; break; }
      if (Date.now() - b0 > 8000) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    await new Promise((r) => setTimeout(r, 1500)); // 复核窗口期:报错后不应有任何对话框补开
    badDialog = await ev(app, hasDialogExpr('创建压缩包')) === true;
    await shot(app, 'rc-c4-unknown-token-error-toast.png');
  });
  const finalSpill = archivesIn(work);
  assert(dialogSeen && noteHit !== '' && fmt7z && evs === 0 && spill1 === '无',
    'RC-C4:tar.zst 预设打开即明示回退 7Z(不静默),引擎未被调起、零落盘');
  record({ id: 'UI-C4-01', item: '预设不支持格式的 UI 明示回退', expect: '回退提示在场+格式=7Z+无任务', actual: `note=${noteHit ? '有' : '无'}, 7Z=${fmt7z}, 事件=${evs}, 落盘=${spill1}`, verdict: dialogSeen && noteHit && fmt7z && evs === 0 && spill1 === '无' ? 'ok' : 'mismatch', detail: '截图 rc-c4-tarzst-fallback-note.png' });
  assert(!gzNote && /TAR\.GZ/i.test(gzFmt), 'RC-C4/ISS-11:已发货菜单 token .tar.gz 正确预设为 TAR.GZ(不静默降 7Z、无回退提示)');
  record({ id: 'UI-C4-02', item: '真实菜单 token ".tar.gz" 预设链路(ISS-11 修复断言)', expect: '预设 TAR.GZ 且无回退提示', actual: `格式按钮="${gzFmt.trim()}", 回退提示=${gzNote}`, verdict: !gzNote && /TAR\.GZ/i.test(gzFmt) ? 'ok' : 'mismatch', detail: '截图 rc-c4-targz-menu-token-actual.png' });
  assert(genName.endsWith('.tar.gz') && magicOk && !doneToast.startsWith('ERR') && doneToast.includes('已生成'),
    `RC-C4/ISS-11 真实链路:菜单命令实际生成的文件确为 gzip 格式(魔数核验,gen=${genName || '无'})`);
  record({ id: 'UI-C4-03', item: 'second-instance 真实链路实际生成格式核验(ISS-11)', expect: '落盘 .tar.gz+gzip 魔数+完成 toast', actual: `file=${genName || '无'}, gzipMagic=${magicOk}, toast="${doneToast.slice(0, 40)}"`, verdict: genName.endsWith('.tar.gz') && magicOk && doneToast.includes('已生成') ? 'ok' : 'mismatch', detail: '格式化意图=最终产物格式的直接证据(不依赖 UI 文案)' });
  assert(badToast !== '' && !badDialog && finalSpill.length === 1,
    'RC-C4/ISS-11:未知格式 token 明确报错,不开对话框、不执行任何操作');
  record({ id: 'UI-C4-04', item: '未知显式格式 token 的拒绝呈现(ISS-11)', expect: 'err toast+对话框不开+零新增落盘', actual: `toast="${badToast.slice(0, 46)}", 对话框=${badDialog}, 归档数=${finalSpill.length}`, verdict: badToast !== '' && !badDialog && finalSpill.length === 1 ? 'ok' : 'mismatch', detail: '截图 rc-c4-unknown-token-error-toast.png' });
}

async function scenarioC3(work: string): Promise<void> {
  const src = path.join(work, 'notes.txt');
  fs.writeFileSync(src, 'compress dialog smoke note ' + 'x'.repeat(256));
  let inlineSeen = false, blockToast = '', posToast = '', outZip = '', evStatus = '';
  await withApp(async (app, deliver) => {
    await deliver(['--compress-as', src, '.zip']);
    await waitForDialog(app);
    // 勾选「添加密码」
    await ev(app, `(() => { const cb = document.querySelector('.field input[type=checkbox]'); if (!cb) return 'NOCB'; cb.click(); return 'CLICKED'; })()`);
    const t0 = Date.now();
    let pwReady = false;
    for (;;) {
      pwReady = await ev(app, `(() => !!document.querySelector('input[type=password]'))()`) === true;
      if (pwReady) break;
      if (Date.now() - t0 > 8000) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert(pwReady, 'RC-C3:ZIP 勾选后密码框在场');
    // 输入中文密码(React 受控输入走原生 setter + input 事件)
    await ev(app, `(() => {
      const inp = document.querySelector('input[type=password]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(inp, ${q(CN_PW)});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return 'typed';
    })()`);
    const tn0 = Date.now();
    for (;;) {
      const notes = await domTexts(app, '.note');
      inlineSeen = notes.some((t) => (t ?? '').includes('检测到非 ASCII 字符'));
      if (inlineSeen || Date.now() - tn0 > 6000) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    await shot(app, 'rc-c3-inline-nonascii-warning.png');
    assert(inlineSeen, 'RC-C3:中文密码行内即时警示(不等提交/引擎报错)');
    // 提交被 UI 预检拦截(先等输出路径异步推导完成、按钮解禁)
    const e0 = Date.now();
    for (;;) {
      const st = await ev(app, `(() => { const b = [...document.querySelectorAll('.foot button')].find(x => x.className.includes('primary')); return b ? (b.disabled ? 'DISABLED' : 'READY') : 'NOBTN'; })()`);
      if (st === 'READY' || st === 'NOBTN' || Date.now() - e0 > 10_000) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await ev(app, `(() => { const b = [...document.querySelectorAll('.foot button')].find(x => x.className.includes('primary')); if (b) b.click(); return b ? 'clicked' : 'NOBTN'; })()`);
    blockToast = (await waitErrToast(app, 'ASCII')) ?? '';
    await shot(app, 'rc-c3-submit-blocked-toast.png');
    assert(blockToast.includes('ASCII') && blockToast.includes('7Z'), 'RC-C3:提交预检 toast 给出原因与出路');
    await new Promise((r) => setTimeout(r, 1500));
    const early = fs.readdirSync(work).filter((f) => /\.zip$/i.test(f));
    assert(early.length === 0, 'RC-C3:拦截后无半成品 zip 落盘');
    // 正证:换成 ASCII 哨兵密码,同一对话框应能正常完成(守卫不误伤合法路径)
    await ev(app, `(() => {
      const inp = document.querySelector('input[type=password]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(inp, ${q(PW_SENTINEL)});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return 'typed';
    })()`);
    await ev(app, `(() => { const b = [...document.querySelectorAll('.foot button')].find(x => x.className.includes('primary')); if (b && !b.disabled) b.click(); return b ? (b.disabled ? 'DISABLED' : 'clicked') : 'NOBTN'; })()`);
    const p0 = Date.now();
    for (;;) {
      const ts = await getToasts(app);
      const done = ts.find((x) => !x.err && (x.text ?? '').includes('已生成'));
      if (done) { posToast = done.text ?? ''; break; }
      const bad = ts.find((x) => x.err && !(x.text ?? '').includes('ASCII'));
      if (bad) { posToast = 'ERR:' + (bad.text ?? ''); break; }
      if (Date.now() - p0 > 45_000) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    const evs = await collectEvents(app);
    evStatus = evs.map((e) => e.status).join(',');
    await shot(app, 'rc-c3-ascii-password-done.png');
    outZip = fs.readdirSync(work).filter((f) => /\.zip$/i.test(f)).join(',') || '无';
  });
  assert(!posToast.startsWith('ERR:') && posToast.includes('已生成'), 'RC-C3 正证:ASCII 密码正常完成压缩');
  assert(outZip !== '无', 'RC-C3 正证:合法路径产物落盘');
  record({ id: 'UI-C3-01', item: 'ZIP 中文密码行内警示+提交拦截+ASCII 出路', expect: '警示在场,拦截 toast,无半成品;ASCII 正证完成', actual: `inline=${inlineSeen}, block="${blockToast.slice(0, 40)}", pos="${posToast.slice(0, 30)}", out=${outZip}`, verdict: inlineSeen && blockToast && !posToast.startsWith('ERR:') && outZip !== '无' ? 'ok' : 'mismatch', detail: `任务终态事件=${evStatus};截图三张 rc-c3-*.png` });
}

async function scenarioC9(work: string): Promise<void> {
  const evil = path.join(work, 'evil.tar');
  fs.writeFileSync(evil, makeTar([
    { name: '../escape_g1.txt', data: 'ESCAPED' },
    { name: 'C:/evil_abs.txt', data: 'ABS' },
    { name: '/abs/evil_g1.txt', data: 'ROOTABS' },
    { name: 'sub/../../escape_g1b.txt', data: 'E2' },
    { name: 'CON.dat', data: 'RESERVED' },
    { name: 'legit.txt', data: 'fine' },
  ]));
  const victim = path.join(work, 'victim.txt');
  fs.writeFileSync(victim, 'must-not-touch');
  let guardToast = '', ipcCode = '', ipcMsg = '';
  await withApp(async (app, deliver) => {
    await deliver(['--extract-here', evil]);
    const t0 = Date.now();
    for (;;) {
      const ts = await getToasts(app);
      const hit = ts.find((x) => x.err && (x.text ?? '').length > 4);
      if (hit) { guardToast = hit.text ?? ''; break; }
      if (Date.now() - t0 > 30_000) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await shot(app, 'rc-c9-guard-toast.png');
    /* 机读交叉核验:UNSAFE_PATH 是任务级终态事件码(守卫在列表预检后经事件流报错),
       不是 invoke 级拒绝 —— 复算必须走「发起任务→轮询终态事件」同构链路 */
    const v = await ev(app, `window.tz.extract({ archive: ${q(evil)}, dest: ${q(work)}, entries: [], overwrite: 'ask' })
      .then(r => r.ok ? r.data.taskId : 'IPCERR:' + JSON.stringify({ code: r.code, message: r.message }))`, 30000) as string;
    if (typeof v !== 'string') ipcCode = 'CDP_NULL';
    else if (v.startsWith('IPCERR:')) { const j = JSON.parse(v.slice(7)) as { code: string; message: string }; ipcCode = j.code; ipcMsg = j.message; }
    else {
      const e0 = Date.now();
      for (;;) {
        const evs = await ev(app, `(() => { const a = (window.__probe || []).filter(e => e.taskId === ${q(v)} && e.status !== 'running'); return JSON.stringify(a); })()`) as string;
        const arr = JSON.parse(evs || '[]') as { status: string; code: string | null; message: string | null }[];
        if (arr.length) { ipcCode = arr[0].code ?? arr[0].status; ipcMsg = arr[0].message ?? ''; break; }
        if (Date.now() - e0 > 30_000) { ipcCode = 'NO_TERMINAL_EVENT'; break; }
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  });
  const escapes = [path.join(os.tmpdir(), 'escape_g1.txt'), path.join(os.tmpdir(), 'escape_g1b.txt'), 'C:\\evil_abs.txt', path.join(os.tmpdir(), 'evil_g1.txt')];
  const landed = escapes.filter((p) => fs.existsSync(p));
  const insideStray = ['legit.txt', 'CON.dat'].filter((f) => fs.existsSync(path.join(work, f)));
  assert(guardToast !== '' && ipcCode === 'UNSAFE_PATH', `RC-C9:UI 熔断提示在场且错误码=UNSAFE_PATH(code=${ipcCode})`);
  assert(landed.length === 0 && insideStray.length === 0, 'RC-C9:目录内外一字不写(逃逸/合法条目全未落地)');
  assert(fs.readFileSync(victim, 'utf8') === 'must-not-touch', 'RC-C9:既有文件未被触碰');
  record({ id: 'UI-C9-01', item: '恶意路径包经真实解压命令链的熔断呈现', expect: 'err toast + UNSAFE_PATH + 零落地', actual: `toast="${guardToast.slice(0, 46)}", code=${ipcCode}, 逃逸落地=${landed.length}, 目录内杂项=${insideStray.length}`, verdict: guardToast && ipcCode === 'UNSAFE_PATH' && landed.length === 0 && insideStray.length === 0 ? 'ok' : 'mismatch', detail: `toast 与 IPC message 一致=${guardToast === ipcMsg};截图 rc-c9-guard-toast.png` });
}

function scanC10(): void {
  // 扫描面 = 本探针留下的全部临时域(工作目录残余 + 未删净的隔离 userData) + 证据目录
  const roots: string[] = [path.resolve('docs/phase4')];
  for (const e of fs.readdirSync(os.tmpdir())) {
    if (e.startsWith('tz-rcui-')) roots.push(path.join(os.tmpdir(), e));
  }
  const hits: string[] = [];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    try { hits.push(...grepSentinel(r, PW_SENTINEL)); } catch { /* noop */ }
  }
  assert(hits.length === 0, `RC-C10:密码哨兵词在本探针全部临时域(含残余 userData)/证据目录零泄漏(命中 ${hits.length} 处)`);
  record({ id: 'UI-C10-01', item: '真实 UI 操作后密码零泄漏', expect: '全扫描 0 命中', actual: `命中=${hits.length}${hits.length ? ':' + hits[0] : ''}`, verdict: hits.length === 0 ? 'ok' : 'mismatch', detail: `扫描根=${roots.length} 处(全部 tz-rcui-* 临时域+docs/phase4)` });
}

/* ---------------- 主流程 ---------------- */

void runProbe(async () => {
  if (!fs.existsSync(EXE)) throw new Error(`缺少发布候选产物:${EXE}(先 npm run dist)`);
  fs.mkdirSync(SHOTDIR, { recursive: true });
  const exeHash = sha256(EXE);
  const freezeManifest = fs.existsSync(path.resolve('docs/phase4/rc-freeze.json'))
    ? fs.readFileSync(path.resolve('docs/phase4/rc-freeze.json'), 'utf8') : '';
  const corresponds = freezeManifest.includes(exeHash);
  record({ id: 'UI-C00-00', item: '被测产物与冻结提交对应关系', expect: 'win-unpacked exe 哈希在 rc-freeze.json 清单内', actual: `sha256=${exeHash.slice(0, 16)}…, 清单位命中=${corresponds}`, verdict: corresponds ? 'ok' : 'note', detail: corresponds ? '与权威清单吻合' : '本地 release/ 与权威清单不同步:结果按对照登记,不外推' });
  assert(corresponds, 'UI 冒烟被测产物哈希与 rc-freeze.json 权威清单吻合');

  // C10 前置准备:场景临时目录在 os.tmpdir 下,结束后残留的 tz-rcui-* 供统一扫描
  const c4 = mkTemp('tz-rcui-c4-');
  await scenarioC4(c4);
  const c3 = mkTemp('tz-rcui-c3-');
  await scenarioC3(c3);
  const c9 = mkTemp('tz-rcui-c9-');
  await scenarioC9(c9);
  scanC10();

  for (const d of [c4, c3, c9]) { try { rmRecursive(d); } catch { /* noop */ } }
  writeOutJson('rcui-smoke.json', {
    probedAt: new Date().toISOString(),
    exe: { path: EXE, sha256: exeHash, inFreezeManifest: corresponds },
    screenshots: { dir: 'docs/phase4/rcui-shots', files: fs.readdirSync(SHOTDIR).filter((f) => f.endsWith('.png')), failed: shotsFailed },
    records,
  });
});
