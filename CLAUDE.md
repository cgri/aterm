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
  cli.ts                   the directory a launch names (--open-dir), Explorer's entry
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
  session ID". `hasConversation()` requires a `type:"user"` line, not just the file. The
  file itself may well exist — a session opens it with a `type:"mode"` line — so an id
  that owns a transcript but no conversation must not be handed to `--session-id` either.
  `PtyManager.start` swaps in a fresh UUID for that case and reports it back through
  `StartResult.claudeSessionId`; that is why the renderer must not assume it gets back the
  id it asked for.
- **A tab's conversation is not the session it was started with.** `/clear` opens a new
  transcript and `/resume` continues an existing one, while the process keeps the id it
  was launched with. Every transcript line names both: `sessionId` is the conversation the
  file holds, `session_id` is the session the writing process was started with. Trusting
  the assigned id alone is what once cost an afternoon of work — the tab was resumed to
  the state from before the `/clear`. `TabState.claudeSessionId` therefore tracks the
  *conversation* (see levels 3 and 4 below), while the *launched* id lives only in
  `PtyManager`'s `Running` for as long as the process does. A new file is read from the
  front (`transcriptOrigin` — which session forked it off), an existing one from the back
  (`transcriptTail` — who is writing now).
- **`session_id` only appears once the model has answered.** The lines a fresh transcript
  starts with — `mode`, `file-history-snapshot`, the `user` prompt, `system` — name the
  conversation in `sessionId` and nothing else; the first line carrying `session_id` too is
  the first `assistant` line. So the transcript cannot say which tab a `/clear` belongs to
  until a reply exists, and a `/clear` the user never followed up on stays invisible there
  for good. That is what layer 4 is for. Measured off the wire, not documented — check with
  a fresh transcript before trusting any line type here.
- **Inherited session markers must be stripped.** When aterm is launched from inside a
  Claude Code session it inherits `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`,
  `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_PID`. Passing them to tabs
  makes Claude Code consider itself a subprocess and write no transcript at all — session
  handling then silently does nothing. `INHERITED_SESSION_MARKERS` in `launchers.ts`.
- **Windows PowerShell 5.1 writes a UTF-8 BOM** with `Set-Content -Encoding utf8`, and
  `JSON.parse` chokes on it while the file looks fine in any editor. All JSON reading goes
  through `util/json.ts`; the shell profile writes without a BOM via `UTF8Encoding($false)`.
- **Restore is lazy.** Restored tabs render as placeholders; the process starts on click or
  Enter, including the tab that was active last. The one exception is a directory the
  launch itself named — that tab is started and made active, because that is what
  clicking the Explorer entry asked for.
- **There is one aterm per userData directory.** The Explorer context menu runs the exe
  again for every click, and a second aterm on the same `state.json` is the disaster the
  dev-userData comment describes: it restores the tabs that are already open and starts a
  second `claude` on a session id that is in use. So `app.requestSingleInstanceLock()`
  guards it — *after* the `userData` redirect, never before, because the lock is keyed by
  that path and it is what lets a `npm run dev` window and the installed app hold one
  each. A launch that loses the lock quits, and its command line arrives in the first
  instance as `second-instance`.
- **A launch can name a directory, and only in the `=` form.** `--open-dir=<path>` opens a
  Claude Code tab there; `cli.ts` reads it. The attached form is not cosmetic: the argv a
  `second-instance` event carries is Chromium's *re-serialised* command line, which sorts
  every switch ahead of the bare arguments — `--open-dir <path>` arrives with some other
  switch where the path used to be, and the cold start (which reads the untouched
  `process.argv`) would keep working while the hand-over silently did nothing. Measured,
  not documented. The separate form is still accepted for a launch by hand, but never
  reads a value that starts with `-`.
- **Explorer mangles a drive root.** `%V` expands inside quotes, so `--open-dir="C:\"`
  reaches `CommandLineToArgvW` with `\"` looking like an escaped quote and the value
  arrives as `C:"`. `repairDriveRoot` turns a trailing `"` back into `\`. Only a root ends
  in a backslash, so nothing else is affected.
- **A directory is handed to the renderer, not turned into a tab.** Tabs belong to the
  renderer, so main only ever passes the path along — but `send` drops anything the
  renderer has not subscribed to yet, and a cold start from Explorer is exactly that.
  So it is buffered in `pendingOpenDirs` until the renderer asks once
  (`app:take-pending-dirs`, which is also what marks it ready), and sent straight through
  after that. There is no other ready handshake in the app.
- **A tab that ends cleanly closes itself, and the exit code alone cannot decide that.**
  `exit` or `/exit` should not leave a dead tab behind, so `onExit` calls `removeTab` when
  the process ended with code 0 — `closeTab` keeps the confirmation dialog, `removeTab` is
  the teardown both share. Any other code keeps the tab with its "Process exited" bar, so
  the error stays readable. But a *killed* process reports an exit code too, and it is not
  ours to predict: `kill()` closes the pseudoconsole *and* terminates the console process
  list, so what the program reports is a race. PowerShell was measured at `0xC000013A`
  (`-1073741510`, `STATUS_CONTROL_C_EXIT`), but a program that shuts down cleanly when its
  console goes away reports 0 — and the one place that must never be wrong is
  `before-quit` → `killAll()`: auto-closing every tab while aterm is going down would let
  `persist()` write an empty tab list, and the whole session would be gone on the next
  start. So the decision does not rest on the code at all: `PtyManager.kill` marks the
  process (`Running.killed`) and the exit event carries `PtyExitEvent.killed`. The flag
  lives on the record of one process, so the defensive `kill` at the top of `start()`
  marks only the process being replaced, never its successor.
- **A tab is called `<folder> - <summary>`, and only the summary changes.** The folder comes
  from the tab's `cwd` at render time, the summary from `TabState.summary` — or, while a
  process is running, from the title it set for itself. A tab without a summary is named by
  the folder alone, which is all a shell tab ever gets. `paneTitle` in
  `renderer/src/main.ts` composes both; `TabBar` draws them as two elements so the folder
  can be stepped back, and a tab whose folder is its whole name keeps it at full strength
  (`.folder:not(:only-child)` in `theme.css`).
- **A worktree belongs to its project, in the tab name and in the session list.**
  `claude --worktree` creates `<project>\.claude\worktrees\<name>`, and a session reopened
  from the picker carries *that* as its `cwd`, because `RecentSession.cwd` comes from
  `history.jsonl` — which records where Claude Code ran, not where aterm started it.
  `renderer/src/paths.ts` splits the two apart: `projectDir` is what a tab is named after
  and what the picker groups by, `worktreeName` is what the picker puts on the row to tell
  two sessions of one project apart. Both are string rules on purpose — they are used while
  rendering and must not touch the disk, so a worktree added by hand somewhere else counts
  as its own project.
- **The terminal title carries a state marker.** A program naming itself through OSC 0/2
  names its tab (`term.onTitleChange`). Claude Code
  puts its state in front: a spinner while it works, changing about once a second, and
  `✳` (`U+2733`) while it waits for input. `readPtyTitle` in `renderer/src/main.ts` splits
  the two apart — the text becomes the summary, the marker becomes the tab's dot (amber
  and pulsing while waiting, breathing while working). Stripping the spinner is not
  cosmetic: every frame is a title change, and `TabBar.render` rebuilds the whole bar, so
  keeping the frame in the label would re-render the tab bar once a second per tab — which
  is also why the working dot is a CSS animation and not a glyph.
  **The spinner glyphs are not stable across Claude Code versions.** They were `U+2800`–
  `U+28FF` (Braille) up to some version before 2.1.247, and are `◐`/`◑` (`U+25D0`/`U+25D1`,
  alternating every 960 ms) in 2.1.247. `SPINNER_MARKER` matches both, so an older `claude`
  on PATH keeps working; the waiting `✳` has not changed. Claude Code sets the title through
  `process.title`, which ConPTY turns into OSC 0, and it can be switched off entirely with
  `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`.
  ConPTY also announces the launched image (`…\powershell.exe`) as a title at startup;
  `LAUNCHED_IMAGE` drops it. The marker set was read off the wire, not from documentation —
  `[Console]::Title` in a tab reports what Claude Code currently set, and the frame list
  itself is greppable in the `claude` binary. Re-measure it before trusting this paragraph.
- **A wait is answered by looking at it, and the answer expires by itself.** `Pane.awaitingSeen`
  says the user has had that tab on screen since it started waiting — active tab *and* window
  focused, which is what `isOnScreen` checks; a tab switched to while aterm sits behind
  something else answers nothing. It is set from `activate`, from the window's `focus` event,
  and at the moment the wait begins if the tab is already in front. `setPtyTitle` only touches
  it on the way into and out of `awaiting`: leaving clears it, so the next wait is news again.
  Re-deciding it on every title would be wrong — Claude Code keeps rewriting the text while it
  waits, which would un-see a tab the user has meanwhile left. Not persisted: it answers one
  wait of one process, like `ptyState` itself.
- **An unseen wait flashes the taskbar button.** `updateAttention` (renderer) sends
  `app:set-attention` whenever *any* tab is waiting unseen, deduplicated because a working tab
  re-renders about once a second; `main/index.ts` turns it into `win.flashFrame`. Two rules
  there: never flash while the window is in the foreground — the user is already here and the
  pulsing dot says the rest — and re-evaluate on `focus` *and* `blur`, because Windows stops a
  flash by itself the moment the window comes forward, whether or not the tab that asked was
  ever looked at. So the flash comes back on the next blur until the last unseen wait is seen.
  A `setOverlayIcon` badge was tried as a second marker, for the stretch the flash cannot cover
  — while aterm itself is in the foreground — and taken out again because it could not be made
  unobtrusive. Windows normalises an overlay icon to a slot of its own: discs of 9, 13, 15, 18,
  22 and 26 in the canvas all rendered at exactly 11px on a 24px taskbar button, and transparent
  padding does not shrink it because the crop goes to the *opaque* bounds. Only a visibly opaque
  ring around the dot makes the coloured part smaller, and no ring colour works both over the
  icon and over the taskbar it overhangs. Measured off screenshots, not documented anywhere.
- **The pulse ring must not fade while it grows.** The amber dot's `dot-pulse` interpolated
  from `var(--warn)` straight to `transparent`, which couples the alpha to the radius: measured
  off the computed style, it was down to 20% at 4px and gone at 5px, so all that ever reached
  the screen was a 1px shimmer on a 7px dot and the pulse read as broken. The alpha lives in
  `--warn-ring` and holds until 55% of the cycle. Both palettes carry the token. Worth
  re-measuring rather than eyeballing: `getComputedStyle(dot).boxShadow` sampled across one
  cycle says exactly what is drawn, and a static ring of the target size next to it says what
  is visible.
- **The tab bar is the title bar.** The window uses `titleBarStyle: 'hidden'`, so Electron
  overlays the native window controls on the right. `#tabbar` is the drag region and every
  clickable child opts out again with `-webkit-app-region: no-drag`; the room left beside
  the controls comes from `env(titlebar-area-width)`. `titleBarOverlay.height` in
  `main/index.ts` and the `#tabbar` height in `theme.css` have to stay in step.
  **Some of the bar has to stay free, or the window cannot be moved at all.** Only
  `#tabstrip` clips, and `#draghandle` after it keeps a minimum width the tabs cannot
  shrink into, so there is always a stretch left to grab — and `#newtab` and the trailing
  buttons can no longer be pushed out of the window either. Anything added to the bar
  belongs before the handle or into `TabBar`'s `trailing`, never in the handle's place.
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

Four layers. The first two exist because the user may type `claude` themselves in a shell
tab. Layer 1: shell tabs run `resources/aterm-profile.ps1`, which wraps `claude`, assigns a
UUID and reports it to `userData/runtime/<tabId>.json`. Layer 2: a watcher on
`~/.claude/projects` reads the first user line of any new transcript, which names
`sessionId` and `cwd`. When several candidates match equally well, nothing is assigned — do
not add guessing here.

Layers 3 and 4 answer a different question — a *Claude* tab whose conversation moved on
under it — and neither of them guesses.

Layer 3 reads it from the transcript: the file names the launched session in `session_id`,
and `PtyManager.claudeTabs()` says which tab was launched with it, so even several tabs in
one directory stay apart. Two cheap filters keep the watcher quiet: a file that a tab is
already known to be in is skipped (it fires an event per written line), and anything else is
re-read at most every two seconds. Do not match on `cwd` here — a `--worktree` tab writes
its transcript under the worktree, not under the tab's directory.

Layer 4 asks Claude Code, and it is the one that arrives in time. `~/.claude/sessions/`
holds one file per running session, named after its pid and rewritten as the session goes
on: `{pid, sessionId, cwd, status, …}`. `sessionId` is the conversation the process is in
*now*, so a `/clear` shows up there the moment it happens — which is what layer 3 cannot do
(see the `session_id` note above). `sessionRegistry.ts` reads it, `applyLiveSession` matches
it to a tab: by the pty's own pid, which is `claude.exe` itself unless it had to be started
through `cmd.exe`; otherwise by the launched session, which is how that tab's `claude` pid
gets learned and keeps answering afterwards. A learned pid is dropped when the tab's pty
changes, because Windows hands pids out again. Not by `cwd`, for the same reason as layer 3.

Whatever any layer detects is written to `state.json` by the main process itself
(`rememberConversation`), not only through the renderer — the renderer is told too, but its
answer comes back through `state:save`, and an event arriving while the window is going away
would never get one.

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

`build/installer.nsh` is pulled in through `nsis.include` and writes the Explorer
context-menu entry. It uses `SHCTX`, electron-builder's hive macro, which is HKCU here
because `perMachine: false` means the installer never elevates and an HKLM write would
fail; and `$INSTDIR`, because the install directory is the user's to choose. Only the
NSIS target runs it — the portable exe registers nothing. `build:dir` does not build an
installer, so a change here has to be checked with the full `npm run build`.

## Releases

A release is a commit on `main` that changes nothing but the version, a tag, and a GitHub
release with both binaries attached. There is no changelog file in the repository — the
notes on the GitHub release are the only place they live, so they have to be written there.

```powershell
npm version 1.4.0 --no-git-tag-version    # package.json and package-lock.json together
git commit -am "Release 1.4.0"
git tag -a v1.4.0 -m "Release 1.4.0"
git push origin main --follow-tags
npm run build                             # ~5 min, writes both .exe into dist/
gh release create v1.4.0 --title "aterm 1.4.0" --notes-file <notes.md> `
  "dist/aterm Setup 1.4.0.exe" "dist/aterm 1.4.0.exe"
```

- **Cut from `main` after the PRs are merged.** Patch for a fix, minor for anything a user
  would notice as new; `npm version` alone, never an edit by hand, because the version sits
  in `package-lock.json` twice as well.
- **The tag carries the `v`, the release title does not**: `v1.4.0` and `aterm 1.4.0`.
  It has to be annotated: `--follow-tags` pushes no lightweight tag, so `git tag v1.5.0`
  let the release commit go out on its own and the tag stayed behind, unnoticed until
  `git ls-remote --tags` was asked. Every tag before it is annotated too.
- **`npm run build` produces two artifacts**, both unsigned: `aterm Setup <version>.exe`
  (NSIS, per user, directory selectable) and `aterm <version>.exe` (portable). It also
  leaves a `.blockmap` next to the installer, which is not part of the release. `dist/`
  keeps every version ever built and is not cleaned.
- **The notes follow the shape of the previous releases**: one sentence saying what the
  release is about, then `## Added` / `## Changed` / `## Fixed` with a bolded lead sentence
  per entry, then a `## Downloads` block naming both binaries and closing with the note that
  they are unsigned, so SmartScreen warns on first start.

## Renaming caveat

The directory is still `clerminal` while the app is `aterm`; only the folder name lags.
The Electron userData directory follows `productName`, so it is `%APPDATA%\aterm`.
