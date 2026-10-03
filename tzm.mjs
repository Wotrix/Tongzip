// T4 图标验证:尺寸受 CSS 控制、无固有 300x150 巨型 svg、颜色继承
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
await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', altKey: true, bubbles: true })); return 1;`);
await sleep(700);
const r = await ev(`
  const svgs = [...document.querySelectorAll('svg')];
  const bad = svgs.filter(s => s.getBoundingClientRect().width > 40).map(s => (s.parentElement?.className || '?') + ':' + Math.round(s.getBoundingClientRect().width));
  const w = (sel) => { const s = document.querySelector(sel); return s ? Math.round(s.getBoundingClientRect().width) : null; };
  return {
    total: svgs.length, oversized: bad,
    sidebarIcon: w('.sb-item svg'), toolbarIcon: w('.tbtn svg'), rowGlyph: w('.row .fx'),
    dpActIcon: w('.dp-act-btn svg'), winBtn: w('.win-btn svg'),
    strokeColor: (() => { const s = document.querySelector('.sb-item svg'); return s ? getComputedStyle(s).color : null; })(),
  };
`);
console.log('browse:', JSON.stringify(r));
await ev(`const it=[...document.querySelectorAll('.sb-item')].find(x=>x.textContent.includes('首页')); it.dispatchEvent(new MouseEvent('click',{bubbles:true})); return 1;`);
await sleep(600);
const r2 = await ev(`
  const svgs = [...document.querySelectorAll('svg')];
  const bad = svgs.filter(s => s.getBoundingClientRect().width > 40).map(s => (s.parentElement?.className || '?') + ':' + Math.round(s.getBoundingClientRect().width));
  return { total: svgs.length, oversized: bad, homeCardIcon: (() => { const s = document.querySelector('[class*=card] svg, .hc svg'); return s ? Math.round(s.getBoundingClientRect().width) : null; })() };
`);
console.log('home:', JSON.stringify(r2));
ws.close();
process.exit(0);
