// Registers Clippit's hook with Claude Code (user settings), or removes it with --uninstall.
//
//   node install/install.mjs [--uninstall] [--settings <path>] [--no-link]
//
// Every hook is async (it can never block or change Claude). From a checkout it runs the hook with Node in
// exec form (no shell); an installed Clippit runs it with its own Electron as Node, which takes a shell to set
// ELECTRON_RUN_AS_NODE. Existing hooks are kept; Clippit's own entries are recognised by the hook script path,
// so running this again changes nothing and --uninstall removes only what it added. settings.json is backed up first.

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ready } from './setup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOOK = path.join(root, 'hook', 'clippit-hook.mjs');
export const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Notification', 'Stop',
  'StopFailure', 'SubagentStart', 'PreCompact', 'SessionEnd'];

const isOurs = h => h && h.type === 'command' && [h.command, ...(h.args || [])].some(a => String(a).includes('clippit-hook.mjs'));

export const settingsFile = (env = process.env) =>
  path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');

export const hasHooks = settings => Object.values(settings.hooks || {}).some(groups =>
  groups.some(g => (g.hooks || []).some(isOurs)));

// One hook entry. `electron` runs `node` (then Clippit's own executable) as Node through the shell.
export function hookEntry({ node = process.execPath, hook = HOOK, electron = false, platform = process.platform } = {}) {
  const base = { type: 'command', async: true, timeout: 10 };
  if (!electron) return { ...base, command: node, args: [hook] };
  if (platform === 'win32') {
    const q = a => `'${a.replace(/'/g, "''")}'`;
    return { ...base, shell: 'powershell', command: `$env:ELECTRON_RUN_AS_NODE='1'; & ${q(node)} ${q(hook)}` };
  }
  const q = a => `'${a.replace(/'/g, "'\\''")}'`;
  return { ...base, command: `ELECTRON_RUN_AS_NODE=1 exec ${q(node)} ${q(hook)}` };
}

// True when every event already has exactly this entry.
export const hooksCurrent = (settings, opts) => {
  const want = JSON.stringify(hookEntry(opts));
  return EVENTS.every(ev => (settings.hooks?.[ev] || []).some(g => (g.hooks || []).some(h => JSON.stringify(h) === want)));
};

export function removeHooks(settings) {
  const hooks = settings.hooks || {};
  for (const ev of Object.keys(hooks)) {
    hooks[ev] = hooks[ev]
      .map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isOurs(h)) }))
      .filter(g => g.hooks.length);
    if (!hooks[ev].length) delete hooks[ev];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  return settings;
}

export function addHooks(settings, opts = {}) {
  removeHooks(settings);
  settings.hooks = settings.hooks || {};
  for (const ev of EVENTS) (settings.hooks[ev] = settings.hooks[ev] || []).push({ hooks: [hookEntry(opts)] });
  return settings;
}

export function readSettings(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};   // throws on invalid JSON
}

// Adds Clippit's hooks to a Claude Code settings file (or removes them), after backing the file up.
// Returns the backup's path, or null when there was no file yet.
export function writeHooks(file, { uninstall = false, ...opts } = {}) {
  const settings = readSettings(file);
  let backup = null;
  if (existsSync(file)) {
    backup = `${file}.clippit-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(file, backup);
  }
  if (uninstall) removeHooks(settings); else addHooks(settings, opts);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.clippit-tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, file);
  return backup;
}

function linkLauncher(uninstall) {
  if (process.platform === 'win32') return null;
  const link = path.join(os.homedir(), '.local', 'bin', 'clippit');
  let current = null;
  try { current = lstatSync(link); } catch { /* none yet */ }
  if (uninstall) {
    if (current && current.isSymbolicLink()) rmSync(link);
    return null;
  }
  if (current) return current.isSymbolicLink() ? link : null;     // never replace a file we didn't make
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(path.join(root, 'bin', 'clippit'), link);
  return link;
}

function main(argv) {
  const uninstall = argv.includes('--uninstall');
  const at = argv.indexOf('--settings');
  const file = at >= 0 ? path.resolve(argv[at + 1]) : settingsFile();
  let backup;
  try { backup = writeHooks(file, { uninstall }); } catch (e) {
    console.error(`clippit: couldn't update ${file} (${e.message}); fix that first, nothing was changed.`);
    process.exit(1);
  }
  if (backup) console.log(`backed up ${file} → ${backup}`);
  console.log(uninstall ? `removed Clippit's hooks from ${file}` : `added Clippit's hook for ${EVENTS.length} events to ${file}`);
  if (!argv.includes('--no-link')) {
    const link = linkLauncher(uninstall);
    if (link) console.log(`launcher: ${link}`);
  }
  if (!uninstall) {
    if (!ready()) console.log('\nClippit still needs his frames and sounds: run `npm run setup` once.');
    console.log('\nStart Clippit with `clippit` (Linux/macOS) or bin\\clippit.cmd (Windows).');
    console.log('Running Claude Code sessions pick up the hooks after /hooks or a restart.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
