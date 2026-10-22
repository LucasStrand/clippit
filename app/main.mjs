// Clippit's Electron main process: the always-on-top Clippit window, the tray, and the bridge from
// Claude Code hook events (lib/server.mjs) to what Clippit says and does.

import { app, BrowserWindow, dialog, ipcMain, Menu, net, Notification, nativeImage, protocol, screen, Tray } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hasHooks, hooksCurrent, readSettings, settingsFile, writeHooks } from '../install/install.mjs';
import { ACS_URL, decode, download, ready } from '../install/setup.mjs';
import { configDir, loadSettings, saveSettings, writeConnection } from '../lib/config.mjs';
import { focusSession, isFocused } from '../lib/platform.mjs';
import { startServer } from '../lib/server.mjs';
import { Sessions } from '../lib/sessions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WIN_W = 440, WIN_H = 420;
const IS_MAC = process.platform === 'darwin';

app.setName('Clippit');
// X11 (XWayland on Wayland desktops) lets the window shape itself, stay on top and move by drag. Chromium picks its
// display backend before this script runs, so on Linux without bin/clippit's flags (an installed Clippit, `npm start`)
// he starts himself again with them. Not with app.relaunch: an AppImage's relauncher runs from its mount, which goes
// away with this process, so the new one starts from the image itself.
const relaunch = process.platform === 'linux' && app.commandLine.getSwitchValue('ozone-platform') !== 'x11';
if (relaunch) {
  spawn(process.env.APPIMAGE || process.execPath,
    [...process.argv.slice(1), '--ozone-platform=x11', '--class=clippit', '--name=clippit', '--enable-transparent-visuals'],
    { detached: true, stdio: 'ignore' }).unref();
  app.exit(0);
}
// A second `clippit` only wakes the running one (second-instance below) and must not start anything:
// app.quit() is asynchronous, so the startup code checks `primary` too.
const primary = !relaunch && app.requestSingleInstanceLock();
if (!primary && !relaunch) {
  console.log('clippit: already running, bringing Clippit back');
  app.quit();
}
if (IS_MAC) app.dock?.hide();
// The page loads from clippit://app/ so his frames and sounds can come from wherever they were decoded (serve below).
protocol.registerSchemesAsPrivileged([{ scheme: 'clippit', privileges: { standard: true, secure: true, stream: true } }]);

const dir = configDir();
// His frames and sounds are Microsoft's artwork, decoded on each machine: into app/ by `npm run setup` in a checkout,
// into the config folder on an installed Clippit's first start (setupCharacter below).
const charDir = ready(here) ? here : path.join(dir, 'character');
const asset = name => path.join(charDir, 'assets', 'clippy', name);
let settings = loadSettings(dir);
const sessions = new Sessions();
const history = [];                 // recent announcements, newest first
let win = null, tray = null, token = '', server = null, dragStart = null, quitting = false;

const save = () => saveSettings(settings, dir);
const send = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send(channel, data); };
const dnd = () => settings.dndUntil > Date.now();
const visible = () => sessions.list().filter(s => !(settings.ignoreHeadless && s.headless));

function publicSession(s) {
  return { id: s.id, title: sessions.label(s), where: sessions.where(s), status: s.status, lastToolText: s.lastToolText,
    waitingFor: s.waitingFor, turnStarted: s.turnStarted, lastActivity: s.lastActivity };
}

function pushState() {
  const list = visible().map(publicSession);
  send('state', { sessions: list, settings, dnd: dnd() });
  updateTray(list);
}

// ---------------------------------------------------------------- the window

// The whole window starts on one screen: Hyprland's XWayland maps a window whose corner is off the X screens to
// a made-up spot (often off every monitor), and the balloon needs the room above and left of Clippy anyway. A saved
// spot goes to the screen nearest Clippy, the 124x93 sprite in the window's bottom-right corner (style.css).
function homePosition() {
  if (settings.position) {
    const { x, y } = settings.position;
    const d = screen.getDisplayNearestPoint({ x: x + WIN_W - 72, y: y + WIN_H - 52 }).workArea;
    return { x: Math.min(Math.max(x, d.x), d.x + d.width - WIN_W), y: Math.min(Math.max(y, d.y), d.y + d.height - WIN_H) };
  }
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - WIN_W - 12, y: wa.y + wa.height - WIN_H - 8 };
}

function createWindow() {
  const pos = homePosition();
  win = new BrowserWindow({
    width: WIN_W, height: WIN_H, x: pos.x, y: pos.y, show: false, frame: false, transparent: true,
    backgroundColor: '#00000000', resizable: false, movable: true, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, title: 'Clippit',
    icon: asset('icon-256.png'),
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true,
      nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required', spellcheck: false },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (IS_MAC) win.setIgnoreMouseEvents(true, { forward: true });   // the renderer turns clicks on over Clippit
  win.loadURL('clippit://app/renderer/index.html');
  win.once('ready-to-show', () => { if (!settings.hidden) win.showInactive(); });
  // A window manager's close (Super+Q and the like) hides Clippit; only Quit in his menu quits.
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault();
    setHidden(true);
  });
  win.on('closed', () => { win = null; });
}

function setHidden(hidden) {
  settings.hidden = hidden;
  save();
  if (!win) {
    if (!hidden) createWindow();
    pushState();
    return;
  }
  if (hidden) send('hide', {});
  else { win.showInactive(); send('show', {}); }
  pushState();
}

// ---------------------------------------------------------------- events from Claude Code

async function deliver(a, s) {
  history.unshift(a);
  history.length = Math.min(history.length, 30);
  if (a.quiet && !settings.announceStarts) return;
  if (settings.quietWhenFocused && a.kind !== 'error' && await isFocused(s)) return;   // you're already looking at it
  const away = settings.hidden || dnd();
  if (!away) send('announce', a);
  const wantSystem = settings.systemNotifications === 'always' || (settings.systemNotifications === 'hidden' && away);
  if (wantSystem && Notification.isSupported() && (!dnd() || a.kind === 'attention')) {
    const n = new Notification({ title: `${a.title} ${a.headline}`.trim(), body: [a.where, a.body].filter(Boolean).join('\n'),
      icon: asset('icon-256.png'), silent: !settings.sounds, urgency: a.kind === 'attention' ? 'critical' : 'normal' });
    n.on('click', () => focus(a.sessionId));
    n.show();
  }
}

function onEvent(payload) {
  const { event, origin } = payload || {};
  if (!event) return;
  if (settings.ignoreHeadless && origin && origin.env && /^sdk/i.test(origin.env.CLAUDE_CODE_ENTRYPOINT || '')) return;
  const out = sessions.handle(event, origin);
  if (!out.session) return;
  if (settings.ignoreHeadless && out.session.headless) return;
  pushState();
  if (out.activity && settings.toolAnimations) send('activity', out.activity);
  if (out.announcement) deliver(out.announcement, out.session).catch(e => console.error('clippit: deliver', e));
}

async function focus(id) {
  const s = sessions.get(id);
  if (!s) return;
  const r = await focusSession(s);
  if (!r.ok) send('announce', { id: `f${Date.now()}`, kind: 'info', sessionId: id, title: sessions.label(s),
    where: sessions.where(s), headline: '', body: `I couldn't bring that terminal forward (${r.how}).`, sticky: false });
}

// ---------------------------------------------------------------- menus

function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

const STATUS = { working: '⏳', waiting: '❗', idle: '✓', error: '⚠', ended: '·' };
const autostartFile = () => path.join(os.homedir(), '.config', 'autostart', 'clippit.desktop');

function startsAtLogin() {
  return process.platform === 'linux' ? existsSync(autostartFile()) : app.getLoginItemSettings().openAtLogin;
}

function setStartAtLogin(on) {
  if (process.platform !== 'linux') { app.setLoginItemSettings({ openAtLogin: on }); return; }
  const f = autostartFile();
  if (!on) { rmSync(f, { force: true }); return; }
  mkdirSync(path.dirname(f), { recursive: true });
  const exec = app.isPackaged ? process.env.APPIMAGE || process.execPath : path.join(here, '..', 'bin', 'clippit');
  writeFileSync(f, ['[Desktop Entry]', 'Type=Application', 'Name=Clippit', 'Comment=Clippit for Claude Code',
    `Exec="${exec}"`, `Icon=${asset('icon-256.png')}`, 'X-GNOME-Autostart-enabled=true', ''].join('\n'));
}

function menuTemplate() {
  const list = visible();
  const c = sessions.counts();
  const summary = list.length ? `${c.working} working · ${c.waiting} waiting · ${c.idle} idle` : 'no Claude Code sessions yet';
  const until = ms => ({ click: () => { settings.dndUntil = ms ? Date.now() + ms : 0; save(); pushState(); } });
  const tomorrow = () => { const d = new Date(); d.setHours(24 + 8, 0, 0, 0); return d - Date.now(); };
  return [
    { label: `Clippit — ${summary}`, enabled: false },
    ...list.slice(0, 12).map(s => ({
      label: `${STATUS[s.status] || '·'}  ${sessions.label(s)}${sessions.where(s) ? ` — ${sessions.where(s)}` : ''}`,
      sublabel: s.status === 'waiting' ? `waiting: ${s.waitingFor || 'your reply'}` : s.status === 'working' ? (s.lastToolText || 'working') : ago(s.lastActivity),
      click: () => focus(s.id),
    })),
    { type: 'separator' },
    { label: 'Recent', enabled: history.length > 0, submenu: history.slice(0, 12).map(a => ({
      label: `${a.title} ${a.headline}`.slice(0, 80), sublabel: ago(a.time), click: () => send('announce', { ...a, id: `${a.id}r` }) })) },
    { label: 'Animate!', click: () => send('animate', {}) },
    { type: 'separator' },
    { label: dnd() ? `Do Not Disturb until ${new Date(settings.dndUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Do Not Disturb',
      submenu: [{ label: 'For 30 minutes', ...until(30 * 60e3) }, { label: 'For 1 hour', ...until(60 * 60e3) },
        { label: 'Until tomorrow morning', ...until(tomorrow()) }, { type: 'separator' }, { label: 'Off', enabled: dnd(), ...until(0) }] },
    { label: 'Stay quiet while I look at that terminal', type: 'checkbox', checked: settings.quietWhenFocused,
      click: i => { settings.quietWhenFocused = i.checked; save(); } },
    { label: 'Act out what Claude is doing', type: 'checkbox', checked: settings.toolAnimations,
      click: i => { settings.toolAnimations = i.checked; save(); pushState(); } },
    { label: 'Sounds', type: 'checkbox', checked: settings.sounds, click: i => { settings.sounds = i.checked; save(); pushState(); } },
    { label: 'Tell me about new sessions', type: 'checkbox', checked: settings.announceStarts,
      click: i => { settings.announceStarts = i.checked; save(); } },
    { label: 'Desktop notifications', submenu: [['never', 'Never'], ['hidden', 'When Clippit is hidden or in Do Not Disturb'], ['always', 'Always']]
      .map(([v, label]) => ({ label, type: 'radio', checked: settings.systemNotifications === v,
        click: () => { settings.systemNotifications = v; save(); } })) },
    { label: 'Start at login', type: 'checkbox', checked: startsAtLogin(), click: i => setStartAtLogin(i.checked) },
    { label: 'Connected to Claude Code', type: 'checkbox', checked: hasHooks(claudeSettings() || {}), click: i => setHooks(i.checked) },
    { type: 'separator' },
    settings.hidden ? { label: 'Show Clippit', click: () => setHidden(false) } : { label: 'Hide Clippit', click: () => setHidden(true) },
    { label: 'Quit Clippit', click: () => app.quit() },
  ];
}

function updateTray(list) {
  if (!tray) return;
  const waiting = list.filter(s => s.status === 'waiting').length, working = list.filter(s => s.status === 'working').length;
  tray.setToolTip(`Clippit — ${working} working, ${waiting} waiting for you`);
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(asset(IS_MAC ? 'tray.png' : 'icon-32.png')));
    tray.setToolTip('Clippit');
    tray.on('click', () => setHidden(!settings.hidden));
    if (process.platform === 'linux') {
      // StatusNotifier trays only show a preset menu, so set it up front and keep it current.
      const refresh = () => tray && tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
      refresh();
      setInterval(refresh, 5000);
    } else {
      tray.on('right-click', () => tray.popUpContextMenu(Menu.buildFromTemplate(menuTemplate())));
    }
  } catch (e) {
    console.warn('clippit: no tray on this desktop:', e.message);
  }
}

// ---------------------------------------------------------------- renderer requests

ipcMain.on('ready', () => pushState());
ipcMain.on('shape', (_e, rects) => {
  if (!win || IS_MAC || !Array.isArray(rects)) return;
  try {
    win.setShape(rects.map(r => ({ x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)),
      width: Math.round(r.width), height: Math.round(r.height) })));
  } catch { /* not supported on this platform */ }
});
ipcMain.on('hit', (_e, over) => { if (win && IS_MAC) win.setIgnoreMouseEvents(!over, { forward: true }); });
ipcMain.on('drag', (_e, d) => {
  if (!win) return;
  if (!dragStart) dragStart = win.getPosition();
  win.setPosition(Math.round(dragStart[0] + d.dx), Math.round(dragStart[1] + d.dy));
});
ipcMain.on('drag-end', () => {
  if (!win || !dragStart) return;
  dragStart = null;
  const [x, y] = win.getPosition();
  settings.position = { x, y };
  save();
});
ipcMain.on('focus', (_e, id) => focus(id));
ipcMain.on('menu', () => { if (win) Menu.buildFromTemplate(menuTemplate()).popup({ window: win }); });
ipcMain.on('hide', () => setHidden(true));

// ---------------------------------------------------------------- first start

// clippit://app/<path>: the renderer from the app, his decoded frames, sounds and animation data from charDir.
function serve(req) {
  const rel = path.normalize(decodeURIComponent(new URL(req.url).pathname)).replace(/^[\\/]+/, '');
  const decoded = rel === path.join('renderer', 'agent-data.js') || rel.startsWith(path.join('assets', 'clippy') + path.sep);
  const base = decoded ? charDir : here;
  const file = path.join(base, rel);
  if (!file.startsWith(base + path.sep)) return new Response(null, { status: 404 });
  return net.fetch(pathToFileURL(file).toString());
}

// His frames and sounds can't ship with Clippit, so the first start fetches the original character file (checked
// against its sha256) or takes one the user has, and decodes it here. False when the user would rather quit.
async function setupCharacter() {
  for (;;) {
    const { response } = await dialog.showMessageBox({
      type: 'info', title: 'Clippit', buttons: ['Download', 'Choose a file…', 'Quit'], defaultId: 0, cancelId: 2,
      message: 'Clippit needs his frames and sounds',
      detail: `They're Microsoft's artwork, so they can't come with Clippit. He can download the original character file `
        + `(CLIPPIT.ACS, 2.9 MB) from ${new URL(ACS_URL).host} and decode it on this computer. Nothing in it is run.`,
    });
    if (response === 2) return false;
    try {
      let data;
      if (response === 0) data = await download();
      else {
        const r = await dialog.showOpenDialog({ title: 'Choose CLIPPIT.ACS', properties: ['openFile'],
          filters: [{ name: 'Microsoft Agent character', extensions: ['acs', 'ACS'] }] });
        if (r.canceled || !r.filePaths.length) continue;
        data = readFileSync(r.filePaths[0]);
      }
      decode(data, charDir);
      return true;
    } catch (e) {
      await dialog.showMessageBox({ type: 'error', title: 'Clippit', message: "That didn't work", detail: e.message });
    }
  }
}

// ---------------------------------------------------------------- Claude Code hooks

// The hook and the config reader it imports, copied out of the app (an AppImage's files move on every start), run by
// Clippit's own executable as Node so the machine needs no Node of its own.
function hookRunner() {
  const rt = path.join(dir, 'runtime');
  for (const f of [path.join('hook', 'clippit-hook.mjs'), path.join('lib', 'config.mjs')]) {
    mkdirSync(path.dirname(path.join(rt, f)), { recursive: true });
    writeFileSync(path.join(rt, f), readFileSync(path.join(here, '..', f)));
  }
  return { node: process.env.APPIMAGE || process.execPath, hook: path.join(rt, 'hook', 'clippit-hook.mjs'), electron: true };
}

function claudeSettings() {
  try { return readSettings(settingsFile()); } catch { return null; }   // not valid JSON: leave it alone
}

function setHooks(on) {
  try { writeHooks(settingsFile(), on ? hookRunner() : { uninstall: true }); } catch (e) {
    dialog.showErrorBox('Clippit', `Couldn't update ${settingsFile()}:\n\n${e.message}`);
  }
}

// An installed Clippit offers once to connect itself to Claude Code, and keeps its hook pointing at where it lives now.
async function checkHooks() {
  const cc = claudeSettings();
  if (!cc || !app.isPackaged) return;
  if (hasHooks(cc)) {
    if (!hooksCurrent(cc, hookRunner())) setHooks(true);
    return;
  }
  if (settings.askedHooks) return;
  settings.askedHooks = true;
  save();
  const { response } = await dialog.showMessageBox({
    type: 'question', title: 'Clippit', buttons: ['Connect', 'Not now'], defaultId: 0, cancelId: 1,
    message: 'Connect Clippit to Claude Code?',
    detail: `He adds his hook to ${settingsFile()} (backed up first) so Claude Code tells him what your sessions are doing. `
      + 'Running sessions pick it up after /hooks or a restart. "Connected to Claude Code" in his menu undoes it.',
  });
  if (response === 0) setHooks(true);
}

// ---------------------------------------------------------------- start

app.on('second-instance', () => setHidden(false));
app.on('window-all-closed', () => { /* keep running in the tray */ });
app.on('before-quit', () => { quitting = true; if (server) server.close(); });

app.whenReady().then(async () => {
  if (!primary) return;
  protocol.handle('clippit', serve);
  if (!ready(charDir) && !await setupCharacter()) {
    app.quit();
    return;
  }
  server = await startServer({ onEvent, token: () => token });
  token = writeConnection(server.port, dir);
  createWindow();
  createTray();
  screen.on('display-metrics-changed', () => {
    if (win && !settings.position) { const p = homePosition(); win.setPosition(p.x, p.y); }
  });
  console.log(`clippit: listening on 127.0.0.1:${server.port}`);
  checkHooks().catch(e => console.error('clippit: hooks', e));
});
