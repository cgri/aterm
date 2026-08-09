# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language

Everything in this project is written in English: code comments, UI strings, commit
messages, documentation. German is used only in direct conversation with the repository
owner, never in artifacts.

## Commands

```powershell
npm install --ignore-scripts   # behind a proxy; plain `npm install` works otherwise
npm run setup                  # fetch the Electron binary, build node-pty against it
npm run dev                    # electron-vite dev server + app
npm run typecheck              # tsc --noEmit, the only static check in the repo
npm run build                  # NSIS installer + portable exe in dist/
npm run build:dir              # unpacked app only, much faster for smoke tests
npm run setup:force            # rebuild node-pty even if pty.node already exists
```

There is no test framework and no linter — `npm run typecheck` is the whole automated
safety net. Verify behaviour by running the app.

Windows only. `npm run dev` must not be started twice; two `electron-vite dev` processes
produce two windows and it is not obvious which one is which.

A dev run keeps its state in `%APPDATA%\aterm-dev`, separate from the installed app's
`%APPDATA%\aterm` (`app.setPath` in `main/index.ts`). Sharing it meant the dev instance
restored the installed app's tabs and started a second `claude` on a session id already in
use, which killed that session. So a dev window starts with no tabs — that is correct.

## Architecture

Electron app in three processes, no UI framework — plain TypeScript and DOM.

```
main/                      Node side: owns all processes, files and Claude Code knowledge
  pty/PtyManager.ts        one node-pty process per running tab; decides --resume vs --session-id
  pty/launchers.ts         builds the command line and the child environment
  state/SessionStore.ts    userData/state.json, debounced + flushed on quit
  claude/HistoryReader.ts  ~/.claude/history.jsonl → the session list
  claude/transcripts.ts    is a session resumable? (reads the transcript)
  claude/SessionDetector.ts which conversation is a tab in? (shell tabs, and switches)
  proc/ProcessTree.ts      one long-lived PowerShell that polls Win32_Process
  proc/orphans.ts          ends tab processes that outlived the aterm that spawned them
  ipc.ts                   every channel name, shared with preload
preload/index.ts           contextBridge → window.aterm
renderer/src/main.ts       tab lifecycle, panes, persistence — the controller
  keymap.ts                data-driven bindings, one capture-phase listener
  TerminalView.ts          one xterm.js instance per running tab
  appearance.ts            light/dark/system, applied while the module is imported
```

`shared/types.ts` is imported by all three via the `@shared` alias (configured in both
`electron.vite.config.ts` and `tsconfig.json` — change both together).

### Where decisions belong

The renderer proposes, the main process decides. `StartSpec.resume` is only a request:
`PtyManager.start` overrides it by calling `hasConversation()`, and reports what it
actually did back through `StartResult.resumed`. Never make launch decisions from
persisted flags — `TabState.everStarted` exists for placeholder wording only.

### Non-obvious behaviour worth preserving

- **Session ids are assigned, not discovered.** aterm generates a UUID and starts
  `claude --session-id <uuid>`, so the id is known before the process exists.
- **Claude Code writes no transcript until a conversation happens.** A session that was
  merely opened cannot be resumed; `--resume` fails with "No conversation found with
  session ID". `hasConversation()` requires a `type:"user"` line, not just the file.
- **A tab's conversation is not the session it was started with.** `/clear` opens a new
  transcript and `/resume` continues an existing one, while the process keeps the id it
  was launched with. Every transcript line names both: `sessionId` is the conversation the
  file holds, `session_id` is the session the writing process was started with. Trusting
  the assigned id alone is what once cost an afternoon of work — the tab was resumed to
  the state from before the `/clear`. `TabState.claudeSessionId` therefore tracks the
  *conversation* (see level 3 below), while the *launched* id lives only in
  `PtyManager`'s `Running` for as long as the process does. A new file is read from the
  front (`transcriptOrigin` — which session forked it off), an existing one from the back
  (`transcriptTail` — who is writing now).
- **Inherited session markers must be stripped.** When aterm is launched from inside a
  Claude Code session it inherits `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`,
  `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_PID`. Passing them to tabs
  makes Claude Code consider itself a subprocess and write no transcript at all — session
  handling then silently does nothing. `INHERITED_SESSION_MARKERS` in `launchers.ts`.
- **Windows PowerShell 5.1 writes a UTF-8 BOM** with `Set-Content -Encoding utf8`, and
  `JSON.parse` chokes on it while the file looks fine in any editor. All JSON reading goes
  through `util/json.ts`; the shell profile writes without a BOM via `UTF8Encoding($false)`.
- **Restore is lazy.** Restored tabs render as placeholders; the process starts on click or
  Enter, including the tab that was active last.
- **The tab label follows the terminal title, and the title carries a state marker.** A
  program naming itself through OSC 0/2 names its tab (`term.onTitleChange`). Claude Code
  puts its state in front: a Braille spinner (`U+2800`–`U+28FF`) while it works, changing
  about once a second, and `✳` (`U+2733`) while it waits for input. `readPtyTitle` in
  `renderer/src/main.ts` splits the two apart — the text becomes the label, the marker
  becomes the colour of the tab's dot (amber while waiting). Stripping the spinner is not
  cosmetic: every frame is a title change, and `TabBar.render` rebuilds the whole bar, so
  keeping the frame in the label would re-render the tab bar once a second per tab.
  ConPTY also announces the launched image (`…\powershell.exe`) as a title at startup;
  `LAUNCHED_IMAGE` drops it. The marker set was read off the wire, not from documentation —
  `[Console]::Title` in a tab reports what Claude Code currently set.
- **The waiting dot can be dismissed, and the dismissal expires by itself.** Double-clicking
  the pulsing amber dot sets `Pane.awaitingAcked`; the dot stays amber — the tab really is
  still waiting — but stops moving. `setPtyTitle` clears the flag on every state that is not
  `awaiting`, so the next wait pulses again. That is why it must not be persisted: it
  answers one wait of one process, like `ptyState` itself. Switching to the tab deliberately
  does not dismiss anything — a quick look must not cost the reminder.
- **The tab bar is the title bar.** The window uses `titleBarStyle: 'hidden'`, so Electron
  overlays the native window controls on the right. `#tabbar` is the drag region and every
  clickable child opts out again with `-webkit-app-region: no-drag`; the room left beside
  the controls comes from `env(titlebar-area-width)`. `titleBarOverlay.height` in
  `main/index.ts` and the `#tabbar` height in `theme.css` have to stay in step.
- **The palette exists three times over.** `theme.css` holds both palettes, keyed by
  `data-theme` on `<html>`; `TerminalView` holds the xterm.js themes, because xterm draws
  into a canvas and reads no CSS; `CHROME_COLORS` in `main/index.ts` holds the window
  controls and the window background, which Windows draws. They have to be changed
  together. The mode lives in localStorage so it can be applied synchronously while
  `appearance.ts` is imported — reading it from state.json would flash the wrong theme;
  `PersistedState.appearance` is written by the main process alone, only so the next
  window opens in the right colours.
- **Native dialogs are out.** `confirm()` and `alert()` draw Chromium's own dialog, which
  matches nothing else here. Ask through `ConfirmDialog`, and register any new overlay in
  `overlayOpen()` and the focus guard, or the keymap will eat its keys.
- **Keyboard handling is one capture-phase listener on `document`.** What it handles never
  reaches xterm.js. `Alt+V` is forwarded as `ESC v` so Claude Code's own image paste runs,
  and `Shift+Enter` sends `ESC CR`. There is no Electron application menu, because its
  accelerators would steal keys from the terminal.
- **Unicode 11 width tables are mandatory** (`@xterm/addon-unicode11` plus
  `term.unicode.activeVersion = '11'`). Under the xterm.js default, emoji like ✅ ❌ 📁 count
  as one column but draw as two, so the following space is covered and text sticks to the
  symbol.

### Session detection

Three layers. The first two exist because the user may type `claude` themselves in a shell
tab. Layer 1: shell tabs run `resources/aterm-profile.ps1`, which wraps `claude`, assigns a
UUID and reports it to `userData/runtime/<tabId>.json`. Layer 2: a watcher on
`~/.claude/projects` reads the first user line of any new transcript, which names
`sessionId` and `cwd`. When several candidates match equally well, nothing is assigned — do
not add guessing here.

Layer 3 answers a different question — a *Claude* tab whose conversation moved on under it.
Here nothing has to be guessed at all: the file names the launched session in `session_id`,
and `PtyManager.claudeTabs()` says which tab was launched with it, so even several tabs in
one directory stay apart. Two cheap filters keep the watcher quiet: a file that a tab is
already known to be in is skipped (it fires an event per written line), and anything else is
re-read at most every two seconds. Do not match on `cwd` here — a `--worktree` tab writes
its transcript under the worktree, not under the tab's directory.

### Processes that outlive aterm

`before-quit` kills every PTY, but an installer or a task-manager kill ends aterm with
`TerminateProcess` and it never runs. Tab processes hang off their ConPTY rather than a job
object, so they can survive, and a `claude` still holding a session while aterm resumes that
same session is what destroys a conversation. `reapOrphanTabs()` runs once at startup and
ends them. A process qualifies when it looks like a tab process (`--session-id`/`--resume`,
or `-File …aterm-profile.ps1` — matched as the argument, not as a substring, or any shell
merely mentioning the script would qualify) **and** the pid it claims as its parent is gone
or belongs to a younger process. That second half is what spares a `claude` running in some
other terminal and the tabs of every live aterm, dev or installed: their parent is still
there. It deliberately does not look at session ids, so a conversation that moved on is
covered too.

## Build environment

Versions are pinned for Node 20: Electron 39 is the newest that still runs on it, and
`node-gyp` is forced to ≥ 11 through `overrides` because older versions need `distutils`,
removed in Python 3.12. Raising any of these requires Node ≥ 22.12.

`scripts/setup-native.mjs` and `scripts/setup-builder-cache.mjs` exist because of three
hardened-Windows quirks: `NoDefaultCurrentDirectoryInExePath=1` breaks winpty's build,
missing Spectre-mitigated MSVC libraries trigger MSB8040, and electron-builder's
`winCodeSign` archive contains macOS symlinks Windows refuses to create. The build config
sets `electronDist` and `npmRebuild: false` so electron-builder neither re-downloads
Electron nor recompiles node-pty.

## Renaming caveat

The directory is still `clerminal` while the app is `aterm`; only the folder name lags.
The Electron userData directory follows `productName`, so it is `%APPDATA%\aterm`.
