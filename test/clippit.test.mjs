// Tests for everything outside Electron: transcript reading, the event reducer, the local server,
// the hook script end to end, the settings.json installer and the character file decompressor.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeConnection } from '../lib/config.mjs';
import { startServer } from '../lib/server.mjs';
import { Sessions, describeTool } from '../lib/sessions.mjs';
import { gist, readTranscript } from '../lib/transcript.mjs';
import { addHooks, hasHooks, hookEntry, hooksCurrent, removeHooks, EVENTS } from '../install/install.mjs';
import { decompress } from '../install/acs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'clippit-test-'));

function transcript() {
  const f = path.join(tmp, 's1.jsonl');
  const lines = [
    { type: 'user', entrypoint: 'cli', cwd: '/home/u/code/shop', gitBranch: 'main', message: { role: 'user', content: 'Add a cart page' } },
    { type: 'ai-title', aiTitle: 'Shop cart page', sessionId: 's1' },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [
      { type: 'tool_use', name: 'Edit', input: { file_path: '/home/u/code/shop/cart.js' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'cost-state', totalCostUSD: 0.42, totalLinesAdded: 30, totalLinesRemoved: 4 },
    'not json at all',
  ];
  writeFileSync(f, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return f;
}

test('transcript: title, project facts and what the last turn did', () => {
  const t = readTranscript(transcript());
  assert.equal(t.title, 'Shop cart page');
  assert.equal(t.entrypoint, 'cli');
  assert.equal(t.branch, 'main');
  assert.equal(t.cost, 0.42);
  assert.deepEqual(t.turn.files, ['/home/u/code/shop/cart.js']);
  assert.deepEqual(t.turn.commands, ['npm test']);
  assert.equal(readTranscript(path.join(tmp, 'missing.jsonl')).title, undefined);
  assert.equal(gist('Done. I added the cart page and wired the route. Tests pass. More text follows here.', 60),
    'Done. I added the cart page and wired the route.');
});

test('sessions: a turn from prompt to finished, with who, where and what', () => {
  let now = 1000;
  const s = new Sessions({ now: () => now });
  const base = { session_id: 's1', transcript_path: transcript(), cwd: '/home/u/code/shop' };
  s.handle({ ...base, hook_event_name: 'SessionStart', source: 'startup' });
  s.handle({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'Add a cart page' });
  assert.equal(s.get('s1').status, 'working');
  const act = s.handle({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/x/cart.js' } });
  assert.equal(act.activity.animation, 'Writing');
  const perm = s.handle({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'git push' } });
  assert.equal(perm.announcement.kind, 'attention');
  assert.match(perm.announcement.body, /run “git push”/);
  const dup = s.handle({ ...base, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'needs permission' });
  assert.equal(dup.announcement, undefined, 'the matching Notification is not announced twice');
  now += 134000;
  const done = s.handle({ ...base, hook_event_name: 'Stop', last_assistant_message: 'Added the cart page. Tests pass.' });
  const a = done.announcement;
  assert.equal(a.kind, 'done');
  assert.equal(a.title, 'Shop cart page');
  assert.equal(a.where, 'shop · main');
  assert.equal(a.stats.duration, '2m 14s');
  assert.deepEqual(a.stats.files, ['cart.js']);
  assert.equal(a.body, 'Added the cart page. Tests pass.');
  assert.equal(s.get('s1').status, 'idle');
  assert.equal(s.handle({ ...base, hook_event_name: 'Stop', stop_hook_active: true }).announcement, undefined);
  const err = s.handle({ ...base, hook_event_name: 'StopFailure', error: 'rate_limit' });
  assert.equal(err.announcement.headline, 'hit a rate limit');
  assert.equal(describeTool('mcp__github__create_issue'), 'use github › create_issue');
});

test('server + hook: only the token holder gets in, and the hook delivers the event', async () => {
  const got = [];
  const home = mkdtempSync(path.join(tmp, 'home-'));
  let token = '';
  const srv = await startServer({ onEvent: p => got.push(p), token: () => token, port: 0 });
  token = writeConnection(srv.port, home);
  const post = (headers, body = '{}') => fetch(`http://127.0.0.1:${srv.port}/hook`, { method: 'POST', headers, body }).then(r => r.status);
  assert.equal(await post({ 'content-type': 'application/json' }), 401);
  assert.equal(await post({ 'content-type': 'application/json', 'x-clippit-token': token, origin: 'https://evil.example' }), 403);
  assert.equal(await post({ 'content-type': 'application/json', 'x-clippit-token': token }, '{"ok":1}'), 204);
  const event = { session_id: 'h1', hook_event_name: 'Stop', cwd: '/tmp' };
  const r = spawnSync(process.execPath, [path.join(root, 'hook', 'clippit-hook.mjs')], {
    input: JSON.stringify(event), env: { ...process.env, CLIPPIT_HOME: home, TMUX_PANE: '%3' }, timeout: 5000 });
  assert.equal(r.status, 0);
  assert.equal(String(r.stdout), '', 'the hook prints nothing');
  await new Promise(res => setTimeout(res, 100));
  const last = got[got.length - 1];
  assert.equal(last.event.session_id, 'h1');
  assert.equal(last.origin.env.TMUX_PANE, '%3');
  if (process.platform === 'linux') assert.ok(last.origin.pids.some(p => p.pid === process.pid), 'process chain reaches the caller');
  srv.close();
  const offline = spawnSync(process.execPath, [path.join(root, 'hook', 'clippit-hook.mjs')], {
    input: JSON.stringify(event), env: { ...process.env, CLIPPIT_HOME: home }, timeout: 5000 });
  assert.equal(offline.status, 0, 'exits 0 when Clippit is not running');
});

test('installer: merges with existing hooks, is idempotent, uninstalls only its own', () => {
  const mine = { type: 'command', command: 'prettier --write' };
  const s = { model: 'opus', hooks: { Stop: [{ hooks: [mine] }] } };
  addHooks(s, { node: '/usr/bin/node', hook: '/opt/clippit/hook/clippit-hook.mjs' });
  addHooks(s, { node: '/usr/bin/node', hook: '/opt/clippit/hook/clippit-hook.mjs' });
  assert.equal(Object.keys(s.hooks).length, EVENTS.length);
  assert.equal(s.hooks.Stop.length, 2, 'existing Stop hook kept, ours added once');
  const ours = s.hooks.PreToolUse[0].hooks[0];
  assert.deepEqual(ours, { type: 'command', command: '/usr/bin/node', args: ['/opt/clippit/hook/clippit-hook.mjs'], async: true, timeout: 10 });
  removeHooks(s);
  assert.deepEqual(s, { model: 'opus', hooks: { Stop: [{ hooks: [mine] }] } });
});

test('installer: an installed Clippit runs the hook with its own executable as Node', () => {
  const linux = { node: "/home/o'neil/Clippit.AppImage", hook: '/home/o\'neil/.config/clippit/runtime/hook/clippit-hook.mjs', electron: true };
  assert.equal(hookEntry({ ...linux, platform: 'linux' }).command,
    `ELECTRON_RUN_AS_NODE=1 exec '/home/o'\\''neil/Clippit.AppImage' '/home/o'\\''neil/.config/clippit/runtime/hook/clippit-hook.mjs'`);
  const win = hookEntry({ node: "C:\\Users\\O'Neil\\Clippit.exe", hook: 'C:\\Users\\O\'Neil\\clippit-hook.mjs', electron: true, platform: 'win32' });
  assert.equal(win.shell, 'powershell');
  assert.equal(win.command, `$env:ELECTRON_RUN_AS_NODE='1'; & 'C:\\Users\\O''Neil\\Clippit.exe' 'C:\\Users\\O''Neil\\clippit-hook.mjs'`);

  const s = { hooks: {} };
  addHooks(s, { ...linux, platform: 'linux' });
  assert.ok(hasHooks(s));
  assert.ok(hooksCurrent(s, { ...linux, platform: 'linux' }));
  assert.ok(!hooksCurrent(s, { ...linux, node: '/elsewhere/Clippit.AppImage', platform: 'linux' }), 'a moved AppImage is noticed');
  removeHooks(s);
  assert.deepEqual(s, {}, 'shell-form entries are recognised as ours');

  if (process.platform !== 'win32') {
    // The shell form really starts the hook (Node ignores ELECTRON_RUN_AS_NODE), and the hook exits 0 with no Clippit running.
    const { command } = hookEntry({ node: process.execPath, hook: path.join(root, 'hook', 'clippit-hook.mjs'), electron: true });
    const r = spawnSync('sh', ['-c', command], { input: '{}', env: { ...process.env, CLIPPIT_HOME: mkdtempSync(path.join(tmp, 'home-')) }, timeout: 5000 });
    assert.equal(r.status, 0, String(r.stderr));
  }
});

test('decompress: Agent literals, an overlapping match and the end marker', () => {
  const bits = [];
  const put = (v, n) => { for (let i = 0; i < n; i++) bits.push(v >> i & 1); };
  const literal = ch => { put(0, 1); put(ch.charCodeAt(0), 8); };
  literal('A');
  literal('B');
  put(1, 1); put(0, 1); put(2 - 1, 6);            // match, short offset 2
  put(1, 1); put(0, 1); put(0, 1);                // length 1 + 0 + 2^1 = 3: copies A, B, A
  put(0xf, 4); put(0xfffff, 20);                  // end of data
  const body = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((bit, i) => { body[i >> 3] |= bit << (i & 7); });
  const block = Buffer.concat([Buffer.from([0]), body, Buffer.alloc(6, 0xff)]);
  assert.equal(decompress(block, 5).toString('latin1'), 'ABABA');
  assert.throws(() => decompress(block, 4), /past the end|out of range/);
  assert.throws(() => decompress(Buffer.from('not compressed!'), 10), /not an Agent-compressed block/);
});
