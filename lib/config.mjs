// Where Clippit keeps its files on each OS, its settings, and the connection file that tells the
// Claude Code hook which local port and token to use.

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function configDir(env = process.env, platform = process.platform) {
  if (env.CLIPPIT_HOME) return env.CLIPPIT_HOME;
  if (platform === 'win32') return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Clippit');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Clippit');
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'clippit');
}

export const DEFAULTS = {
  quietWhenFocused: true,         // say nothing about a session whose terminal you are looking at
  sounds: true,
  systemNotifications: 'hidden',  // 'never' | 'hidden' (when Clippit is hidden or in Do Not Disturb) | 'always'
  announceStarts: false,          // a balloon when a new session starts
  ignoreHeadless: true,           // skip `claude -p` / SDK runs (no terminal to come back to)
  toolAnimations: true,           // act out what Claude is doing (writing, searching, running commands)
  doneSeconds: 30,                // how long a "finished" balloon stays up
  dndUntil: 0,                    // Do Not Disturb until this time (ms since epoch)
  position: null,                 // {x, y} of the window, remembered after a drag
  hidden: false,
  askedHooks: false,              // an installed Clippit asked once to connect itself to Claude Code
};

function writeJSON(file, data, mode) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  renameSync(tmp, file);
  if (mode) { try { chmodSync(file, mode); } catch { /* not supported on this filesystem */ } }
}

export function loadSettings(dir = configDir()) {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings, dir = configDir()) {
  writeJSON(path.join(dir, 'settings.json'), settings);
}

// The hook reads {port, token, pid} from here. The file is private (0600) and rewritten on each start.
export function writeConnection(port, dir = configDir()) {
  const token = randomBytes(24).toString('hex');
  writeJSON(path.join(dir, 'connection.json'), { port, token, pid: process.pid, started: Date.now() }, 0o600);
  return token;
}

export function readConnection(dir = configDir()) {
  const file = path.join(dir, 'connection.json');
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
