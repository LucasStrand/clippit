// Runs test/fixtures.html through a Chromium browser that has the built extension loaded and its
// DevTools port open, and checks what Clippit's own pass clicked on each page.
//
//   1. npm run build
//   2. start a Chromium browser with a throwaway profile, e.g.
//        chrome --user-data-dir=/tmp/csn --remote-debugging-port=9333 --load-extension=build/chromium
//      (Google Chrome 137+ ignores --load-extension; use Chromium, Edge or Brave)
//   3. node test/run-fixtures.mjs [port]

import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] || 9333);
const page = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures.html'));
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/cookie-policy')) { res.end('left the page'); return; }
  res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(page);
}).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://localhost:${server.address().port}/fixtures.html`;

// What each case should end with: clicks in order, and whether its box is still showing.
const EXPECT = {
  continueWithout: { clicked: ['reject'] },
  acceptingX: { clicked: [], shown: false },
  signIn: { clicked: [], shown: true },
  appRoot: { clicked: [], shown: true },
  settingsFlow: { clicked: ['settings', 'analytics-on:off', 'ads-switch', 'save'] },
  perPurpose: { clicked: ['no1', 'no2', 'save'] },
  swedish: { clicked: ['reject'] },
  german: { clicked: ['reject'] },
  noWayOut: { clicked: [], shown: false },
  newsletter: { clicked: null },        // reported, not judged
};

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map();
  ws.onmessage = m => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  return { send: (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }), close: () => ws.close() };
}

let failed = 0;
for (const [name, want] of Object.entries(EXPECT)) {
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`${base}?case=${name}`)}`, { method: 'PUT' })).json();
  const c = await cdp(t.webSocketDebuggerUrl);
  await new Promise(r => setTimeout(r, 12000));
  const r = await c.send('Runtime.evaluate', { returnByValue: true, expression: `({ clicked: window.clicked, url: location.pathname,
    shown: [...document.querySelectorAll('.bar, .modal, .app')].some(e => getComputedStyle(e).display !== 'none'),
    scroll: getComputedStyle(document.documentElement).overflowY })` });
  c.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`);
  const got = r.result.result.value;
  const okClicks = want.clicked === null || JSON.stringify(got.clicked) === JSON.stringify(want.clicked);
  const okShown = want.shown === undefined || got.shown === want.shown;
  const okPage = got.url === '/fixtures.html';
  const ok = okClicks && okShown && okPage;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: clicked ${JSON.stringify(got.clicked)}, box ${got.shown ? 'showing' : 'gone'}${okPage ? '' : `, navigated to ${got.url}`}`);
}
server.close();
process.exit(failed ? 1 : 0);
