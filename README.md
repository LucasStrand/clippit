# Clippit for Claude Code

The Office 2000 assistant is back on your desktop, and this time he has something useful to say. Clippit
watches your Claude Code sessions and tells you:

- **which session finished**: its title, project and git branch;
- **what it did**: the gist of Claude's last message, the files it changed, the commands it ran, time and cost;
- when one **needs your OK**: the exact command or file it's waiting to touch;
- when one **is waiting for you** or **hit an error** (rate limit, overloaded).

Click **Show me** and he brings that session's terminal to the front. He stays quiet about the session you're
already looking at, has Do Not Disturb, sends desktop notifications while he's hidden, and remembers where you
put him.

## Download

Get the file for your computer from the [latest release](https://github.com/LucasStrand/clippit/releases/latest):

| | |
|---|---|
| Windows 10 and later | [`Clippit-windows-x64-setup.exe`](https://github.com/LucasStrand/clippit/releases/latest/download/Clippit-windows-x64-setup.exe) |
| macOS 12 and later (Apple silicon and Intel) | [`Clippit-mac-universal.dmg`](https://github.com/LucasStrand/clippit/releases/latest/download/Clippit-mac-universal.dmg) |
| Linux, 64-bit | [`Clippit-linux-x86_64.AppImage`](https://github.com/LucasStrand/clippit/releases/latest/download/Clippit-linux-x86_64.AppImage) (`chmod +x`, then run it) |

On his first start he downloads his frames and sounds (see [About the artwork](#about-the-artwork)) and offers to
connect himself to Claude Code: his hook goes into `~/.claude/settings.json`, backed up first, and runs on his own
bundled runtime, so you don't need Node.js. "Connected to Claude Code" in his menu turns that off and on. The
builds aren't code-signed: on Windows, SmartScreen asks first (*More info*, *Run anyway*); on macOS, choose *Open
Anyway* under *System Settings*, *Privacy & Security* after the first try.

Releases are built by `.github/workflows/release.yml` when a `v*` tag is pushed, as a draft to check and publish.

## Install from source

You need [Claude Code](https://docs.claude.com/en/docs/claude-code/overview), Node.js 18 or later, and Git.

```
git clone https://github.com/LucasStrand/clippit
cd clippit
npm install            # Electron (on Arch you can skip this and use: sudo pacman -S electron)
npm run setup          # fetches Clippit's original character file and decodes his frames and sounds
npm run install-hooks  # adds Clippit's hooks to ~/.claude/settings.json (backed up first)
npm start              # or ./bin/clippit on Linux and macOS, bin\clippit.cmd on Windows
```

Running Claude Code sessions pick up the hooks after `/hooks` or a restart. `npm run install-hooks` also links
`~/.local/bin/clippit` on Linux and macOS, so `clippit` starts him (or brings him back if he's hidden).

To remove him: `npm run uninstall-hooks` takes out only his own hooks and leaves the rest of your settings alone.

### Linux

He runs through X11 (XWayland on Wayland desktops) so his window can shape itself (clicks pass through around
him), stay on top and move by drag. "Show me" focuses the terminal window on Hyprland and on X11 desktops (with
`xdotool`), and selects the pane in tmux.

On Hyprland, give the window class `clippit` a rule: float, pin, no initial focus, and no border, shadow, blur or
animation. Don't use `nofocus`: Hyprland then drops clicks, and you couldn't answer his balloons.

### macOS and Windows

`npm install`, then the steps above. On macOS "Show me" brings the terminal app forward (the right tab in Terminal
and iTerm2); on Windows it brings the terminal's window forward. Clippit is used daily on Linux; the macOS and
Windows paths are written and tested less, so issues and fixes are welcome.

## How it works

`hook/clippit-hook.mjs` runs for each Claude Code event as an **async** hook: it can't block or change Claude, and
it always exits cleanly. It adds the process chain and terminal details and posts the event to the app on
**127.0.0.1** with a token made fresh at every start (`connection.json` in Clippit's config folder, mode 0600).
`lib/sessions.mjs` turns events into session state and announcements, and `lib/transcript.mjs` reads the
session's title, branch, cost and last turn from its transcript on your machine. That transcript format is
internal to Claude Code and undocumented, so every field is optional. Nothing leaves your computer.

```
npm test               # node --test: transcripts, the event reducer, the server + hook, the installer, the decoder
```

## About the artwork

Clippit's frames and sounds are Microsoft's, so they aren't in this repository. `npm run setup` downloads the
original Microsoft Agent character file, `CLIPPIT.ACS`, from an archive of classic Agent characters, checks its
SHA-256, and decodes it locally into `app/assets/clippy/`. Already have the file? `npm run setup -- path/to/CLIPPIT.ACS`.
The downloadable builds don't contain the artwork either: on first start they offer the same download (or a file you
choose) and decode it into Clippit's config folder. The app icon is an original drawing (`build/icon.svg`).

The decoder (`install/acs.mjs`) is a port of the image decompressor in Windows XP's `agentdpv.dll`, worked out by
reverse engineering. It plays the character the way Microsoft Agent did: frame timings, random branches, exit
paths when interrupted, and the sounds.

## License

The code is MIT licensed (see `LICENSE`). The Tahoma-compatible fonts in `app/assets/fonts/` are Wine's, under the
LGPL (`wine-COPYING.LIB`). Clippit is a fan project and is not affiliated with or endorsed by Microsoft; Clippy,
Office and Microsoft Agent are trademarks of Microsoft Corporation.
