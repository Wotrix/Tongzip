// T2 共存漂移检查:浏览视图关键计算样式 + 布局断言
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
async function ev(expr) {
  const m = await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
  if (m.result?.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails));
  return m.result?.result?.value;
}
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
for (let i = 0; i < 24; i++) {
  if (await ev(`return !!document.querySelector('.toolbar .tb-search');`)) break;
  await sleep(500);
}
const r = await ev(`
  const cs = (sel, prop) => { const el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : null; };
  const sidebar = document.querySelector('.sidebar');
  return {
    view: 'browse',
    bodyFont: getComputedStyle(document.body).fontFamily.slice(0, 30),
    btnCursor: cs('.nav-arrow', 'cursor'),
    btnBg: cs('.nav-arrow', 'backgroundColor'),
    rowH: cs('.row', 'height'),
    listHeadCols: cs('.list-head', 'gridTemplateColumns'),
    detailW: Math.round(document.querySelector('.detail-pane')?.getBoundingClientRect().width ?? -1),
    sidebarCollapsed: sidebar.className.includes('collapsed'),
    sidebarW: Math.round(sidebar.getBoundingClientRect().width),
    scrollW: document.documentElement.scrollWidth, iw: innerWidth,
    primaryVar: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
    twUtilityAlive: getComputedStyle(document.querySelector('.app-drag') || document.body) ? true : false,
    tailwindProbe: (() => { const d = document.createElement('div'); d.className = 'hidden'; document.body.appendChild(d); const h = getComputedStyle(d).display === 'none'; d.remove(); return h; })(),
  };
`);
console.log(JSON.stringify(r, null, 1));
// 唤回侧边栏再测一次布局
await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', altKey: true, bubbles: true })); return 1;`);
await sleep(700);
const r2 = await ev(`
  const sb = document.querySelector('.sidebar');
  return { w: Math.round(sb.getBoundingClientRect().width), sw: document.documentElement.scrollWidth, iw: innerWidth,
    dw: Math.round(document.querySelector('.detail-pane').getBoundingClientRect().width) };
`);
console.log('expanded:', JSON.stringify(r2));
// 回首页看导航(经 sidebar 点首页)
await ev(`const it=[...document.querySelectorAll('.sb-item')].find(x=>x.textContent.includes('首页')); it && it.dispatchEvent(new MouseEvent('click',{bubbles:true})); return 1;`);
await sleep(600);
const r3 = await ev(`return { home: !!document.querySelector('.home-body, .home, [class*=home]'), title: document.querySelector('.hc-title, h1, h2')?.textContent || null };`);
console.log('home:', JSON.stringify(r3));
ws.close();
process.exit(0);
