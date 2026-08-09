# aterm

A lean terminal host for AI agents on Windows. Tabs like Windows Terminal — plus
session handling for Claude Code: tabs survive a restart, and earlier sessions can
be found again and resumed.

## What it does

- **Tabs** for Claude Code and PowerShell, with drag-to-reorder and a status dot.
- **Session handling** — saved on exit, restored on start. Restored tabs start
  *lazily*: they appear immediately, but the process only starts on click or Enter.
- **Recently opened sessions** (Ctrl+Shift+O) read from `~/.claude` — including
  sessions that were started outside of aterm.
- **Detection of manually started sessions**: type `claude` yourself in a PowerShell
  tab and aterm records the session ID, then offers to resume it on the next start.

## Key bindings

| Key | Effect |
|---|---|
| `Ctrl+V` | Paste — text directly, images as a file in the temp directory (the path is pasted) |
| `Alt+V` | Passed through as `ESC v` → Claude Code's own image paste |
| `Shift+Enter` | Newline in the prompt (`ESC CR`) |
| `Ctrl+C` | Copy when there is a selection, interrupt when there is none |
| `Ctrl+Shift+C/V` | Explicit copy / paste |
| `Ctrl+T` / `Ctrl+Shift+T` | New Claude tab / new PowerShell tab |
| `Ctrl+W` | Close tab |
| `Ctrl+Tab`, `Ctrl+1…9` | Switch tabs |
| `Ctrl+Shift+O` | Session picker |
| `Ctrl+Shift+F` | Search the scrollback |
| `Ctrl++` / `Ctrl+-` / `Ctrl+0` | Font size |
| `Ctrl+Wheel` | Font size, one step per wheel notch (not rebindable) |
| `Enter` | On a tab that has not started yet: open it |

Rebind via `%APPDATA%\aterm\keymap.json`. An entry replaces the default for that
action entirely; an empty array disables it:

```json
{
  "newClaudeTab": ["Ctrl+N"],
  "sessionPicker": ["Ctrl+P", "Ctrl+Shift+O"],
  "search": []
}
```

Actions: `newClaudeTab`, `newShellTab`, `closeTab`, `nextTab`, `previousTab`,
`sessionPicker`, `search`, `paste`, `copy`, `pasteImage`, `newline`, `fontLarger`,
`fontSmaller`, `fontReset`. `Ctrl+C` (context dependent) and `Ctrl+1…9` are fixed.

## Development

```powershell
npm install --ignore-scripts   # the more reliable path behind a proxy
npm run setup                  # fetch the Electron binary, build node-pty against it
npm run dev
npm run build                  # NSIS installer and portable exe under dist/
```

Without a proxy, plain `npm install` is enough — `postinstall` calls `npm run setup`
itself.

Requirements: Node ≥ 20.15, Visual Studio 2022 with the C++ tools, Python 3.

`scripts/setup-native.mjs` works around three quirks of hardened Windows machines:

- **`NoDefaultCurrentDirectoryInExePath=1`** — otherwise cmd cannot find winpty's
  `GetCommitHash.bat` script and the gyp configure step fails.
- **Missing Spectre-mitigated MSVC libraries** (MSB8040) — the build then proceeds
  without them and says so clearly. For a mitigated build, install
  *MSVC v143 – VS 2022 C++ x64/x86 Spectre-mitigated libs* in the Visual Studio
  Installer.
- **Proxy** — the Electron download falls back to `curl`, which honours the system
  proxy.

Versions are pinned deliberately: Electron 39 is the newest release that still runs
on Node 20, and `node-gyp` is forced to ≥ 11 through `overrides` because older
versions need `distutils`, which Python 3.12 removed. With Node ≥ 22.12, Electron,
`electron-vite` and `electron-builder` can all be raised again.

### Packaging

`npm run build` runs `scripts/setup-builder-cache.mjs` first. The reason:
electron-builder's `winCodeSign` vendor archive contains macOS symlinks, and Windows
only allows creating symlinks with developer mode or administrator rights — without
them the extraction fails, even though a Windows build needs no macOS artifact at
all. The script extracts the archive into the cache without the `darwin` branch;
enabling Windows developer mode works just as well.

Two more deliberate settings in the `build` configuration: `electronDist` points at
the already extracted local Electron (no second download), and `npmRebuild: false`
stops electron-builder from recompiling node-pty — `npm run setup` does that, with
the special cases above handled.

## Rendering

The terminal enables the **Unicode 11 width tables** (`@xterm/addon-unicode11`).
Without them xterm.js uses Unicode 6, where emoji such as `✅`, `❌` or `📁` count as
one column wide although they are drawn two columns wide — the glyph then covers the
following space and the text appears glued to the symbol.

## How session handling works

- **aterm's own Claude tabs**: aterm generates a UUID and starts
  `claude --session-id <uuid>`; resuming uses `claude --resume <uuid>`. The ID is
  therefore known before the process runs.
- **Sessions started by hand in PowerShell tabs**: shell tabs run with the startup
  profile `resources/aterm-profile.ps1`, which wraps `claude` and reports the UUID it
  assigned. If the wrapper is bypassed, a watcher on `~/.claude/projects` takes over —
  the first user line of a new transcript names both `sessionId` and `cwd`. When
  several candidates match equally well, aterm deliberately does not guess.
- **Session list**: `~/.claude/history.jsonl`, grouped by `sessionId`; the title is
  the first prompt.
- **Resume or start fresh**: whether `--resume` is possible at all is decided by
  looking at the transcript, not by a stored flag. Claude Code only writes one once a
  conversation has actually taken place; a session that was merely opened and closed
  again could not be resumed and would fail with "No conversation found with session
  ID". When there is no conversation, the tab starts fresh under the same ID and thus
  keeps its identity.
- **Inherited session markers**: when aterm is launched from inside a running Claude
  Code session, it inherits that session's `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`,
  `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT` and `CLAUDE_PID`. Passing those
  on to the tabs would make Claude Code consider itself a subprocess and write **no
  transcript** — session handling would quietly do nothing. `launchers.ts` therefore
  strips them from the tab environment.

The user's own PowerShell `$PROFILE` is left untouched, as is
`~/.claude/settings.json`.

## Configuration

| Environment variable | Effect |
|---|---|
| `ATERM_CLAUDE_PATH` | Path to `claude.exe` if it is not on the `PATH` |

State lives in `%APPDATA%\aterm\state.json`.
