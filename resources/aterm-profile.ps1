# aterm — startup profile for shell tabs.
#
# Purpose: when the user types `claude` here by hand, aterm should know the
# session id so it can restore the tab later. To that end a UUID is supplied up
# front and reported back to aterm. PowerShell still loads the user's own
# $PROFILE — nothing here replaces it.

function global:claude {
    $exe = $env:ATERM_CLAUDE_PATH
    if (-not $exe) {
        $cmd = Get-Command claude.exe -CommandType Application -ErrorAction SilentlyContinue |
               Select-Object -First 1
        if ($cmd) { $exe = $cmd.Source }
    }
    if (-not $exe) {
        Write-Error 'claude.exe not found.'
        return
    }

    # If the call already carries its own session, nothing is added.
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
        # Write without a BOM — Set-Content -Encoding utf8 adds one in Windows
        # PowerShell 5.1, and JSON.parse chokes on it.
        $json = $report | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText($file, $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch {
        # Reporting failed: aterm's transcript watcher still catches this session.
    }

    & $exe --session-id $sessionId @args
}
