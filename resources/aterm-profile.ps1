# aterm — Startprofil für Shell-Tabs.
#
# Zweck: Startet der Benutzer hier von Hand `claude`, soll aterm die
# Session-ID kennen, um den Tab später wiederherstellen zu können. Dazu wird
# eine UUID vorgegeben und an aterm gemeldet. Das eigene $PROFILE des
# Benutzers wird von PowerShell weiterhin geladen — hier wird nichts ersetzt.

function global:claude {
    $exe = $env:ATERM_CLAUDE_PATH
    if (-not $exe) {
        $cmd = Get-Command claude.exe -CommandType Application -ErrorAction SilentlyContinue |
               Select-Object -First 1
        if ($cmd) { $exe = $cmd.Source }
    }
    if (-not $exe) {
        Write-Error 'claude.exe nicht gefunden.'
        return
    }

    # Bringt der Aufruf die Session schon selbst mit, wird nichts hinzugefügt.
    $ownsSession = $false
    foreach ($a in $args) {
        $t = [string]$a
        if ($t -like '--session-id*' -or $t -like '--resume*' -or $t -eq '-r' -or
            $t -like '--continue*'   -or $t -eq '-c' -or
            $t -like '--print*'      -or $t -eq '-p') {
            $ownsSession = $true
            break
        }
    }

    if ($ownsSession -or -not $env:ATERM_TAB_ID -or -not $env:ATERM_RUNTIME_DIR) {
        & $exe @args
        return
    }

    $sessionId = [guid]::NewGuid().ToString()
    try {
        $report = [ordered]@{
            tabId     = $env:ATERM_TAB_ID
            sessionId = $sessionId
            cwd       = (Get-Location).Path
            at        = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }
        $file = Join-Path $env:ATERM_RUNTIME_DIR ("{0}.json" -f $env:ATERM_TAB_ID)
        # Ohne BOM schreiben — Set-Content -Encoding utf8 setzt in Windows
        # PowerShell 5.1 eines, und JSON.parse scheitert daran.
        $json = $report | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText($file, $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch {
        # Meldung fehlgeschlagen: Der Transkript-Watcher in aterm greift trotzdem.
    }

    & $exe --session-id $sessionId @args
}
