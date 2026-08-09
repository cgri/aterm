# aterm

Ein schlanker Terminal-Host für KI-Agenten unter Windows. Tabs wie im Windows
Terminal — plus Session-Handling für Claude Code: Tabs überleben den Neustart,
frühere Sessions lassen sich wiederfinden und fortsetzen.

## Was es kann

- **Tabs** für Claude Code und PowerShell, mit Drag-Reorder und Statuspunkt.
- **Session-Handling** — beim Beenden gespeichert, beim Start wiederhergestellt.
  Wiederhergestellte Tabs starten *lazy*: sie erscheinen sofort, der Prozess
  startet erst auf Klick bzw. Enter.
- **Zuletzt geöffnete Sessions** (Strg+Umschalt+O) aus `~/.claude` — auch die,
  die außerhalb von aterm gestartet wurden.
- **Erkennung von Hand gestarteter Sessions**: Tippt man in einem PowerShell-Tab
  selbst `claude`, merkt aterm sich die Session-ID und bietet sie beim
  nächsten Start zum Fortsetzen an.

## Tastenbelegung

| Taste | Wirkung |
|---|---|
| `Strg+V` | Einfügen — Text direkt, Bilder als Datei im Temp-Verzeichnis (Pfad wird eingefügt) |
| `Alt+V` | wird als `ESC v` durchgereicht → Claude Codes eigene Bild-Einfügung |
| `Umschalt+Enter` | neue Zeile im Prompt (`ESC CR`) |
| `Strg+C` | mit Auswahl kopieren, ohne Auswahl abbrechen |
| `Strg+Umschalt+C/V` | explizit kopieren / einfügen |
| `Strg+T` / `Strg+Umschalt+T` | neuer Claude-Tab / neuer PowerShell-Tab |
| `Strg+W` | Tab schließen |
| `Strg+Tab`, `Strg+1…9` | Tab wechseln |
| `Strg+Umschalt+O` | Session-Picker |
| `Strg+Umschalt+F` | im Scrollback suchen |
| `Strg++` / `Strg+-` / `Strg+0` | Schriftgröße |
| `Enter` | auf einem noch nicht gestarteten Tab: öffnen |

Umbelegen über `%APPDATA%\aterm\keymap.json`. Eine Angabe ersetzt die Vorgabe
einer Aktion vollständig, ein leeres Array schaltet sie ab:

```json
{
  "newClaudeTab": ["Ctrl+N"],
  "sessionPicker": ["Ctrl+P", "Ctrl+Shift+O"],
  "search": []
}
```

Aktionen: `newClaudeTab`, `newShellTab`, `closeTab`, `nextTab`, `previousTab`,
`sessionPicker`, `search`, `paste`, `copy`, `pasteImage`, `newline`, `fontLarger`,
`fontSmaller`, `fontReset`. `Strg+C` (kontextabhängig) und `Strg+1…9` sind fest.

## Entwicklung

```powershell
npm install --ignore-scripts   # hinter einem Proxy der zuverlässigere Weg
npm run setup                  # Electron-Binary + node-pty gegen Electron bauen
npm run dev
npm run build                  # NSIS-Installer + Portable-EXE unter dist/
```

Ohne Proxy genügt `npm install` — `postinstall` ruft `npm run setup` selbst auf.

Voraussetzungen: Node ≥ 20.15, Visual Studio 2022 mit C++-Werkzeugen, Python 3.

`scripts/setup-native.mjs` fängt drei Eigenheiten gehärteter Windows-Arbeitsplätze ab:

- **`NoDefaultCurrentDirectoryInExePath=1`** — sonst findet cmd das winpty-Skript
  `GetCommitHash.bat` nicht und die gyp-Konfiguration bricht ab.
- **Fehlende Spectre-mitigierte MSVC-Bibliotheken** (MSB8040) — dann wird ohne sie
  gebaut, mit deutlicher Warnung. Wer den mitigierten Build will, installiert im
  Visual Studio Installer *MSVC v143 – VS 2022 C++ x64/x86 Spectre-mitigated libs*.
- **Proxy** — der Electron-Download fällt notfalls auf `curl` zurück, das den
  System-Proxy nutzt.

Versionen sind bewusst gepinnt: Electron 39 ist die neueste Fassung, die noch mit
Node 20 läuft; `node-gyp` steht per `overrides` auf ≥ 11, weil ältere Fassungen
`distutils` brauchen, das es in Python 3.12 nicht mehr gibt. Mit Node ≥ 22.12
lassen sich Electron, `electron-vite` und `electron-builder` wieder anheben.

### Paketbau

`npm run build` ruft vorab `scripts/setup-builder-cache.mjs` auf. Grund: Das
Vendor-Archiv `winCodeSign` von electron-builder enthält macOS-Symlinks, und
Windows lässt Symlinks nur mit Entwicklermodus oder Administratorrechten anlegen —
sonst bricht das Entpacken ab, obwohl für einen Windows-Build kein einziges
macOS-Artefakt gebraucht wird. Das Skript entpackt das Archiv ohne den
`darwin`-Zweig in den Cache; alternativ genügt der Windows-Entwicklermodus.

Zwei weitere bewusste Einstellungen in der `build`-Konfiguration:
`electronDist` zeigt auf das lokal bereits entpackte Electron (kein zweiter
Download), und `npmRebuild: false` verhindert, dass electron-builder node-pty
erneut übersetzt — das erledigt `npm run setup` mit den nötigen Sonderfällen.

## Darstellung

Das Terminal aktiviert die **Unicode-11-Breitentabelle** (`@xterm/addon-unicode11`).
Ohne sie rechnet xterm.js nach Unicode 6, wo Emoji wie `✅`, `❌` oder `📁` als
einspaltig gelten, obwohl sie zweispaltig gezeichnet werden — der Glyph überdeckt
dann das folgende Leerzeichen und der Text klebt am Symbol.

## Wie das Session-Handling funktioniert

- **Eigene Claude-Tabs**: aterm erzeugt eine UUID und startet
  `claude --session-id <uuid>`; fortgesetzt wird mit `claude --resume <uuid>`.
  Die ID steht damit fest, bevor der Prozess läuft.
- **Von Hand gestartete Sessions in PowerShell-Tabs**: Shell-Tabs laufen mit dem
  Startprofil `resources/aterm-profile.ps1`, das `claude` umhüllt und die
  vergebene UUID meldet. Wird der Wrapper umgangen, greift ein Watcher auf
  `~/.claude/projects` — die erste Nutzer-Zeile eines neuen Transkripts nennt
  `sessionId` und `cwd`. Bei mehrdeutigen Kandidaten wird bewusst nicht geraten.
- **Session-Liste**: `~/.claude/history.jsonl`, gruppiert nach `sessionId`;
  Titel ist der erste Prompt.
- **Fortsetzen oder neu starten**: Ob `--resume` überhaupt möglich ist, entscheidet
  ein Blick ins Transkript, nicht ein Merker. Claude Code legt es erst an, wenn
  wirklich ein Gespräch stattgefunden hat; eine nur geöffnete und gleich wieder
  geschlossene Session ließe sich sonst nicht fortsetzen und würde mit
  „No conversation found with session ID" abbrechen. Gibt es kein Gespräch,
  startet der Tab mit derselben ID neu und behält so seine Identität.
- **Geerbte Session-Marker**: Startet man aterm aus einer laufenden
  Claude-Code-Session heraus, erbt es deren `CLAUDECODE`,
  `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`
  und `CLAUDE_PID`. Würden sie an die Tabs weitergereicht, hielte sich Claude Code
  dort für einen Unterprozess und schriebe **kein Transkript** — das Session-Handling
  liefe still ins Leere. `launchers.ts` entfernt sie deshalb aus der Tab-Umgebung.

Das eigene PowerShell-`$PROFILE` bleibt unangetastet, ebenso
`~/.claude/settings.json`.

## Konfiguration

| Umgebungsvariable | Wirkung |
|---|---|
| `ATERM_CLAUDE_PATH` | Pfad zu `claude.exe`, falls nicht im `PATH` |

Zustand liegt unter `%APPDATA%\aterm\state.json`.
