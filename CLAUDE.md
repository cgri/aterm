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
  update/releases.ts       newer GitHub releases than the running version
  update/installer.ts      downloads, verifies and silently runs the NSIS installer
  cli.ts                   the directory a launch names (--open-dir), Explorer's entry
  ipc.ts                   every channel name, shared with preload
preload/index.ts           contextBridge → window.aterm
renderer/src/main.ts       tab lifecycle, panes, persistence — the controller
  keymap.ts                data-driven bindings, one capture-phase listener
  TerminalView.ts          one xterm.js instance per running tab
  appearance.ts            light/dark/system, applied while the module is imported
  updates.ts               update check, tab-bar button and UpdateDialog
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
- **A restart waits for the old process to be gone.** `restartTab` (renderer) kills, waits,
  and only then calls `startPane` — never `startPane` over a running process. `PtyManager.start`
  kills what it replaces without waiting, so the new `claude --resume` would open the session
  while the old one still holds it, and the old process's late exit event would flip the fresh
  tab to "Process exited". `PtyManager.kill` therefore returns a promise that settles on that
  process's exit (or `false` after a timeout), and `pty:kill` also polls the `claude` pid
  layer 4 learned, because behind `cmd.exe` the pty ending is not `claude` ending. While
  `Pane.restarting` is set, `onExit` puts up no bar and `startPane` refuses to run, so Enter
  in that gap cannot start the tab twice.
- **A tab is called `<folder> - <summary>`, and only the summary changes.** The folder comes
  from the tab's `cwd` at render time, the summary from `TabState.summary` — or, while a
  process is running, from the title it set for itself. A tab without a summary is named by
  the folder alone, which is all a shell tab ever gets. `paneTitle` in
  `renderer/src/main.ts` composes both; `TabBar` draws them as two elements so the folder
  can be stepped back, and a tab whose folder is its whole name keeps it at full strength
  (`.folder:not(:only-child)` in `theme.css`).
- **A tab group is a run in `order`, and `normalizeOrder` is the only thing that sorts.**
  `order` is the whole truth about what is drawn where; a group's members have to sit in it
  as one uninterrupted run, which is what lets `render` cut the bar into segments in a
  single pass instead of gathering each group's tabs up first. `normalizeOrder` restores
  that run after every change and renumbers `TabState.order` from the result — it is the
  one place that writes those numbers.
  **It must never be what decides membership.** It is stable, so the first member it meets
  is where the group ends up: a tab dragged out of its block would be met first and would
  pull the whole group along behind it, where the user meant to take one tab out. So
  `moveTab` reads the dropped-on group *and* the anchor while `order` still describes the
  bar that was dropped onto, writes `groupId`, and only then normalises. Group membership
  is settled before, never by, that call.
- **A group always folds, and the header speaks for the tab it hides.** `setGroupCollapsed`
  moves the active tab to the first tab right of the group (wrapping round) so the bar goes
  on showing where the user is — but when there is no tab outside the group it folds
  anyway, and the active tab stays inside it. The header then wears the active marker
  (`TabGroupViewModel.active`, `.tabgroup-head.active`), which is the whole cost: what the
  user looks at is the *pane*, and that does not go away, only the tab's button does.
  Refusing to fold in that case was the first attempt and it was wrong — two tabs in one
  group is already enough to hit it, so the feature looked broken the first time anyone
  tried it. There is no invariant that the active tab is visible in the bar, and nothing
  needs one: `awaitingSeen` asks whether the *pane* is in front, which it is.
  What does follow from that: `activate` takes a `reveal` flag, true for every caller that
  means "show me this tab" and false exactly once, when the tabs are restored — otherwise
  a group folded up before a restart would spring open on the next start. And anything
  that walks tabs by keyboard uses `reachableOrder`, which falls back to all of them when
  every tab is folded away, so Ctrl+Tab is never a dead end.
- **A group's line runs along its bottom and climbs over the tab in front.** One stroke:
  in along the bottom of the group, up the left edge of the active tab, across its top,
  down its right edge and on. Three sides and open at the foot, with rounded top corners —
  the shape every browser draws, and it was asked for by name after a full ring around the
  tab was tried and rejected as not that.
  Three pieces make it, and none of them works alone:
  **`.tabgroup::after`** is the line, absolute rather than a border so the bar keeps the
  height `titleBarOverlay` was told about. It cannot be an inset box-shadow on `.tabgroup`:
  the members paint their own backgrounds over the full height, and an inset shadow is
  drawn under its own children.
  **`.tab` carries a 2px border on every tab, transparent, with `border-bottom: none`** and
  the top corners rounded. Transparent on all of them because `box-sizing: border-box`
  would otherwise shift the label by two pixels each time the user switched tabs; no bottom
  because that open foot is what makes it a tab rather than a box. `.tab.active` only sets
  `border-color`, and only inside a group: `.tabgroup .tab.active` takes `--tab-ring`,
  which the group sets to its own colour, so line and outline are visibly one stroke.
  **A loose active tab is outlined by the bar's lower edge**, the same shape in a neutral
  1px hairline (`--edge`): along the bar, up the tab, across its top, down and on. The
  bar's edge is `#tabbar::after`, not a border, so the tab in front can stack above it and
  open into the terminal — it is the terminal's colour, and tab and pane read as one
  surface. The outline is `#tabstrip > .tab.active::before`, an overlay reaching back over
  the transparent 2px border. An accent rule across the top was tried twice before — as the
  top border (it curled down at the corners) and inset and straight — and both read as a
  lid on a box, because the bar's border still ran underneath and closed the tab off. The
  child selector is what keeps the outline off grouped tabs, where `::before` is already
  the flare — the two must never both match.
  **The stacking order is edge < group line (`z-index: 1`) < active tab (`2`).** The group's
  line has to be above the bar's edge, which would otherwise paint across its bottom pixel,
  and the active tab above both, or the stroke closes along its bottom and the whole thing
  reads as a box.
  **The flare at each foot is `.tabgroup .tab.active::before`**, a 6px strip hanging past
  both sides of the tab with four background layers: the two quarter arcs on top, the tab's
  own colour across its foot below them, and the bar's colour in the 4px each arc reaches
  into, bottom-most. The middle layer is there because a border runs the full height of its
  box — without it each side pokes a stub down past the arc it continues from. The last is
  there because the group's line would otherwise run on beneath the curve and fill it back
  in; it is 2px tall, the height of the line and no more, or it eats into the neighbouring
  tab. `border-radius` cannot do any of this: it only rounds *inward*, which bends the
  outline away from the line and leaves a notch. Measured in the window, not reasoned out —
  the offsets are against the *padding* box, since that is what an absolutely positioned
  child is placed against, and being two pixels out is the whole difference.
  Only a member tab gets a flare, never a folded group header: a folded group is nothing
  but its header, so its line lies entirely under it and a flare would curl into empty bar.
  A 2px rule along the top edge alone is what the active tab used to be, and it was far too
  easy to miss on a full bar. If this is ever reduced back to an edge, that is the
  complaint to expect.
  The group palette lives in `theme.css` **and nowhere else**: no group colour is ever
  drawn by xterm or by Windows, so "the palette exists three times over" below does not
  extend to it. `[data-group-color]` turns the stored name into `--group-color` once, for
  the line, the outline, the header chip, the menu rows and the dialog's buttons alike.
  `--on-group` is what is written on a filled chip: one value per palette carries all eight
  colours, because they are light in the dark palette and dark in the light one.
  `.tabgroup-head` also has to be in the `-webkit-app-region: no-drag` list, or clicking it
  drags the window instead of folding the group.
- **The header is the group: a filled chip with the name inside it.** Not a swatch beside a
  label — the chip *is* the colour, the way Chrome draws one, and a nameless group is the
  same chip at its `min-width` rather than a bare dot. It is `align-self: center`, so it is
  a chip sitting in the bar rather than a tab reaching the bottom of it, and the group's
  line passes under it.
- **Everything in the bar is centred on y 19, the middle of the 38px bar**, because that is
  where Windows draws the caption buttons and nothing moves those. A tab's label gets there
  through `padding-bottom: 6px`, which answers the 4px margin and 2px border above it — the
  last attempt instead pushed the chip and the buttons *down* to a label that sat 2.5px low,
  and they ended up below the caption buttons. The chip is centred with one extra pixel
  below its label (`margin-top: 1px`, `padding-bottom: 1px`), because the line box keeps
  room for descenders and capitals sat a pixel low in it otherwise. The buttons are
  full height and flex-centre an SVG from `icons.ts`. They were text glyphs, and `+ ↑ ◐ ☀ ☾`
  each come from a different fallback font with a baseline of its own, so no one padding
  could line them up. Worth measuring rather than eyeballing: with a dev run started as
  `npx electron-vite dev --remoteDebuggingPort 9229`, the page is reachable over CDP, and
  the middles of `.tab .name`, `.tabgroup-name` and each button's `svg` off
  `getBoundingClientRect` should all read 19. The caption buttons are not in a page
  screenshot — Windows draws them.
  **A folded group is the chip and nothing else**: no line (`.tabgroup[data-collapsed]::after`
  is `content: none` — a line ties members together and none are on show) and no tab count.
  The count lives in the tooltip, which is also where a folded group says what it is
  reporting.
- **A collapsed group speaks for its members**, in the same two states a tab has: it takes
  the alarm if any of them is waiting unseen, and the breath if any is working. Alarm wins,
  as it does on a tab. Its tooltip says which, because the chip has no mark of its own to
  say it — see the next entry for why there is nothing else to report.
  **What it reports is drawn behind the chip, not on it.** A folded group grows a
  tab-shaped ground in the same place a tab has one (`.tabgroup[data-collapsed]` with the
  wash on its `::before`), and that is what tints and breathes; the chip keeps the group's
  own colour. Washing the chip itself was tried first and amber over blue or green came out
  a muddy slate that read as some other group rather than as a tab asking for something.
  `awaitingSeen` and `updateAttention` are untouched by any of this: the first cannot be
  answered for a tab that is not active, which is exactly right, and the second walks
  `panes` rather than `order`, so the taskbar still flashes for a wait inside a folded
  group.
  **A dead process inside a folded group is not reported.** That state lives on the tab's
  own mark, and the header has none. A folded group reports only what moves; the rest is
  seen on opening it. Deliberate, not an oversight.
- **A group that loses its last tab stops existing**, in `pruneEmptyGroups`, called after
  every change rather than at the places a tab can leave — closing, ungrouping, dragging
  out and being moved to another group are otherwise four chances to forget it. What
  `state.json` holds is validated the same way and only in the renderer (`normalizeGroups`):
  `SessionStore` checks no more than that a tab has an id and a cwd. A colour it does not
  know becomes `grey`, which is what lets a ninth colour be added later without older
  builds choking on it; a `groupId` naming no group is dropped from the tab. A group is the
  cheaper thing to lose, so whatever does not add up costs the group and never the tab.
  `PersistedState.groups` is additive and deliberately did **not** raise `SCHEMA_VERSION` —
  a bump makes `load` set aside any state.json written by a newer aterm, so it would cost
  every tab of anyone who goes back a version, for a field that version would have ignored.
- **Dragging a whole group is a separate source, and groups do not nest.** `TabBar` reports
  a `DragSource` of `tab` or `group` and a `DropTarget` of `before` / `group` / `end`;
  what that means for membership is decided in `main.ts`, not in the bar. A block always
  lands in front of a whole unit — a loose tab, or another group entire — never inside one.
  The one rule worth knowing for a single tab: dropping it in front of a group's *first*
  member means in front of the group, not into it, unless it is already a member. Chrome
  tells those apart with a hysteresis zone that needs pointer tracking; this needs no
  geometry. The insertion marker has to be cleared on `dragend` as well as `dragleave` —
  `dragleave` does not fire when the drag ends over the element it marked.
- **A worktree belongs to its project, in the tab name and in the session list.**
  `claude --worktree` creates `<project>\.claude\worktrees\<name>`, and a session reopened
  from the picker carries *that* as its `cwd`, because `RecentSession.cwd` comes from
  `history.jsonl` — which records where Claude Code ran, not where aterm started it.
  `renderer/src/paths.ts` splits the two apart: `projectDir` is what a tab is named after
  and what the picker groups by, `worktreeName` is what the picker puts on the row to tell
  two sessions of one project apart. Both are string rules on purpose — they are used while
  rendering and must not touch the disk, so a worktree added by hand somewhere else counts
  as its own project.
  A tab started with a fresh worktree is the other way round: its `cwd` stays the project,
  while its transcript is filed under the worktree. So "is there a conversation, and where
  does `claude` resume it" is `findConversation` in `transcripts.ts`, which also looks under
  `<cwd>\.claude\worktrees\*` and returns the worktree's own `cwd` (read from the
  transcript, because the encoded directory name is lossy) for `PtyManager.start` to spawn
  in. Looking only under the project took the tab for one without a conversation and
  started it with `--session-id` on its own id, in the project, with an empty conversation.
  A worktree that has since been removed does not count; its id is still taken
  (`hasTranscript`), so the tab gets a fresh one.
- **The tab bar says three things, and only three.** What kind of tab this is (`✳` for an
  agent, `❯` for a shell — `.mark`, faint while no process runs), that something is
  happening (a breath), and whether it concerns the user (the breath is amber). That is the
  whole vocabulary. It replaced a dot in five colours with two animations, which was a lot
  of grammar for very little said, and which a folded group header then had to repeat.
  Two rules hold it together:
  **The alarm is word for word `updateAttention`'s condition** — waiting for input and not
  looked at since. The tab bar and the taskbar button say the same thing or neither does;
  if one of them ever grows a case the other lacks, that is the bug.
  **Both live states breathe, and colour is what separates them.** The alarm does not sit
  still: a still alarm beside a moving activity would put the motion on the one thing the
  user is allowed to ignore. They are told apart by colour (neutral vs `--warn`) and by
  amplitude — the alarm swings about three times as far, and both were measured against
  each other in the running window rather than picked. The wash is a `::after` over the
  tab, not a keyframe on `background`, because a tab may be active, grouped or plain and a
  keyframe would have to know which colour is underneath. Under `prefers-reduced-motion`
  the working wash goes to nothing and the alarm holds its amber — the colour was carrying
  the meaning all along.
- **The terminal title carries a state marker.** A program naming itself through OSC 0/2
  names its tab (`term.onTitleChange`). Claude Code
  puts its state in front: a spinner while it works, changing about once a second, and
  `✳` (`U+2733`) while it waits for input. `readPtyTitle` in `renderer/src/main.ts` splits
  the two apart — the text becomes the summary, the marker becomes `Pane.ptyState`, which
  is what the tab breathes with. Stripping the spinner is not cosmetic: every frame is a
  title change, and `TabBar.render` rebuilds the whole bar, so keeping the frame in the
  label would re-render the tab bar once a second per tab — which is also why the breath is
  a CSS animation and not a redrawn glyph, and why a rebuild restarts it from the
  beginning.
  **The spinner glyphs are not stable across Claude Code versions.** They were `U+2800`–
  `U+28FF` (Braille) up to some version before 2.1.247, and are `◐`/`◑` (`U+25D0`/`U+25D1`,
  alternating every 960 ms) in 2.1.247. `SPINNER_MARKER` matches both, so an older `claude`
  on PATH keeps working; the waiting `✳` has not changed. Claude Code sets the title through
  `process.title`, which ConPTY turns into OSC 0, and it can be switched off entirely with
  `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`.
  ConPTY also announces the launched image (`…\powershell.exe`) as a title at startup;
  `LAUNCHED_IMAGE` drops it. The marker set was read off the wire, not from documentation —
  spawn `claude` through `node-pty` and log every `OSC 0;` it writes. `[Console]::Title` is
  not the way to read it: the sequence is passed through ConPTY to the terminal without the
  console's own title ever changing, so a tab reports whatever last called
  `SetConsoleTitle` there. Re-measure it before trusting this paragraph.
  **A title that names Claude Code itself is not a title.** Until a conversation has a
  summary the app sits at `Claude Code`, and the launcher announces `claude` a second before
  that. Both replaced the name the tab already had - the session title that
  `refreshClaudeTitles` reads out of history.jsonl - with a word that says nothing about the
  tab, and a long-running session can stay on the placeholder indefinitely (measured in
  2.1.263: a tab that had been working for hours was still called `Claude Code`).
  `APP_TITLES` counts both as no title at all, while the state marker in front of them still
  counts.
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
  amber tab says the rest — and re-evaluate on `focus` *and* `blur`, because Windows stops a
  flash by itself the moment the window comes forward, whether or not the tab that asked was
  ever looked at. So the flash comes back on the next blur until the last unseen wait is seen.
  A `setOverlayIcon` badge was tried as a second marker, for the stretch the flash cannot cover
  — while aterm itself is in the foreground — and taken out again because it could not be made
  unobtrusive. Windows normalises an overlay icon to a slot of its own: discs of 9, 13, 15, 18,
  22 and 26 in the canvas all rendered at exactly 11px on a 24px taskbar button, and transparent
  padding does not shrink it because the crop goes to the *opaque* bounds. Only a visibly opaque
  ring around the dot makes the coloured part smaller, and no ring colour works both over the
  icon and over the taskbar it overhangs. Measured off screenshots, not documented anywhere.
- **The tab bar is the title bar.** The window uses `titleBarStyle: 'hidden'`, so Electron
  overlays the native window controls on the right. `#tabbar` is the drag region and every
  clickable child opts out again with `-webkit-app-region: no-drag`; the room left beside
  the controls comes from `env(titlebar-area-width)`. `titleBarOverlay.height` in
  `main/index.ts` is the `#tabbar` height in `theme.css` minus one, and the two have to
  stay in step: the caption buttons are opaque, and an overlay as tall as the bar covered
  its 1px lower edge, which then stopped short where the buttons begin.
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
- **An update is the NSIS installer, run silently, and nothing else.** No
  electron-updater: it needs a `latest.yml` and a blockmap on every release, and the
  release process uploads only the two exes. `update/releases.ts` asks the public
  releases API through `net.fetch`, because that is Chromium's network stack and honours
  the system proxy; Node's fetch does not. The installer is run with
  `--updated /S --force-run`, the flags electron-builder's own updater passes, read out of
  `app-builder-lib/templates/nsis`: silent, into the previous `InstallLocation` (so a
  directory the user picked is kept), `customInstall` runs again (the Explorer entry
  stays), and aterm is started once it is done. Before that the installer `taskkill`s
  every `aterm.exe` of this user — a portable one that happens to run included — so
  aterm quits by itself first, the normal way through `before-quit`, and only once the
  installer process exists: a failed spawn must not take aterm down with nothing to
  replace it.
  Nothing is run that does not match the SHA-256 GitHub lists as the asset's `digest`; a
  release without one is refused. The renderer never names a URL or a file — main
  downloads the newest release of its own last check and runs only what it verified.
  The portable exe is recognised by `PORTABLE_EXECUTABLE_FILE`, which electron-builder's
  portable launcher sets, and gets the release page instead, as does a dev run.
  `ATERM_UPDATE_FROM=1.7.0` makes aterm compare as that version, which is the only way to
  see the flow against a real release; a dev run still stops at the release page.
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
- **The app reads the release, so its shape is load-bearing.** The update check takes
  the tag as `v<x.y.z>`, skips drafts and prereleases, and finds the installer by the
  name `aterm Setup <version>.exe` (GitHub lists it as `aterm.Setup.<version>.exe`).
  The notes are shown in aterm's update dialog as written — headings, `-` lists,
  bold, emphasis, code and links are rendered, anything else arrives as plain text, and
  the `## Downloads` section is left out.
- **The notes follow the shape of the previous releases**: one sentence saying what the
  release is about, then `## Added` / `## Changed` / `## Fixed` with a bolded lead sentence
  per entry, then a `## Downloads` block naming both binaries and closing with the note that
  they are unsigned, so SmartScreen warns on first start.

## Renaming caveat

The directory is still `clerminal` while the app is `aterm`; only the folder name lags.
The Electron userData directory follows `productName`, so it is `%APPDATA%\aterm`.
