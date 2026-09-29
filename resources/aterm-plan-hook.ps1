# aterm - PreToolUse hook for ExitPlanMode.
#
# Claude Code runs this when it presents a plan. The hook hands the plan to the
# aterm that started the tab, over a named pipe, and waits for the user's answer
# there. aterm replies with the exact JSON Claude Code expects on stdout, or with
# an empty line for "no decision". Anything unexpected - no aterm, no tab id, a
# broken pipe - ends the hook without a decision, and Claude Code then asks in
# the terminal as if the hook did not exist.

param([string]$Pipe)

$utf8 = New-Object System.Text.UTF8Encoding($false)

try {
    $stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
    $payload = $stdin.ReadToEnd()
    if (-not $Pipe -or -not $env:ATERM_TAB_ID -or -not $payload.Trim()) { exit 0 }

    $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $Pipe, [System.IO.Pipes.PipeDirection]::InOut)
    $client.Connect(2000)

    # One request per line. A raw line break in JSON can only be whitespace, so
    # folding it away leaves the document intact.
    $hook = $payload -replace "[`r`n]+", ' '
    $request = '{"tabId":' + (ConvertTo-Json ([string]$env:ATERM_TAB_ID)) + ',"hook":' + $hook + '}'

    $writer = New-Object System.IO.StreamWriter($client, $utf8)
    $writer.AutoFlush = $true
    $writer.WriteLine($request)

    # Blocks until the user answers. aterm going away closes the pipe, and
    # ReadLine then returns null.
    $reader = New-Object System.IO.StreamReader($client, $utf8)
    $answer = $reader.ReadLine()
    if ($answer) {
        $bytes = $utf8.GetBytes($answer)
        $stdout = [Console]::OpenStandardOutput()
        $stdout.Write($bytes, 0, $bytes.Length)
        $stdout.Flush()
    }
} catch {
    # No decision: the terminal asks instead.
}
exit 0
