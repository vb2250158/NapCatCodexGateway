param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot
)

$ErrorActionPreference = "Stop"
$install = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd("\")
$comparison = [System.StringComparison]::OrdinalIgnoreCase

function Exact-Path([string]$Candidate, [string]$Expected) {
    if (-not $Candidate) { return $false }
    try {
        return [System.IO.Path]::GetFullPath($Candidate).Equals(
            [System.IO.Path]::GetFullPath($Expected),
            $comparison)
    } catch {
        return $false
    }
}

function Command-References([string]$CommandLine, [string]$ExpectedPath) {
    if (-not $CommandLine) { return $false }
    $canonical = [System.IO.Path]::GetFullPath($ExpectedPath)
    $escaped = [System.Text.RegularExpressions.Regex]::Escape($canonical)
    $pattern = "(?i)(^|\s)(?:`"$escaped`"|$escaped)(?=$|\s)"
    return [System.Text.RegularExpressions.Regex]::IsMatch($CommandLine, $pattern)
}

$legacyExecutables = @(
    (Join-Path $install "RabiRoute-Desktop.exe"),
    (Join-Path $install "RabiRoute-Tray.exe"),
    (Join-Path $install "RabiRoute-Tray.new.exe")
)
$nodeExecutables = @(
    (Join-Path $install "node.exe"),
    (Join-Path $install "node\node.exe"),
    (Join-Path $install "runtime\node\node.exe")
)
$pythonExecutables = @(
    (Join-Path $install "desktop-runtime\python\python.exe"),
    (Join-Path $install "desktop-runtime\python\pythonw.exe"),
    (Join-Path $install "desktop-runtime\python\Scripts\python.exe"),
    (Join-Path $install "desktop-runtime\python\Scripts\pythonw.exe")
)
$managerEntry = Join-Path $install "dist\manager.js"
$legacyWatcherEntries = @(
    (Join-Path $install "scripts\watch-rabiroute-desktop-lifecycle.ps1"),
    (Join-Path $install "scripts\watch-rabiroute-health.ps1"),
    (Join-Path $install "scripts\watch-message-adapters.ps1")
)
$speechTaskName = "RabiSpeech"
$speechTaskDescription = "Rabi local-only TTS/ASR provider service"
$speechRoot = Join-Path $install "plugin-adapters\rabi-speech"
$speechRuntimeExecutable = Join-Path $speechRoot "runtime\RabiSpeech.exe"
$speechHostScript = Join-Path $speechRoot "scripts\windows_host.py"
$speechLegacyStartScript = Join-Path $speechRoot "scripts\start.ps1"
$speechTaskWrapper = Join-Path $env:LOCALAPPDATA "RabiPC\RabiSpeech\start-rabispeech.ps1"
$watchdogTaskName = "RabiRouteHealthWatchdog"
$watchdogTaskDescription = "RabiRoute RabiRoute Desktop and message-adapter health recovery. Runs one guarded cycle per trigger."
$watchdogEntry = Join-Path $install "scripts\watch-rabiroute-health.ps1"
$powershellProcessNames = @("powershell.exe", "pwsh.exe")
$trayEntries = @(
    (Join-Path $install "desktop-runtime\main.py"),
    (Join-Path $install "desktop-runtime\tray_app.py")
)

function Is-LegacyWatcherProcess($Process) {
    if (-not $Process -or $powershellProcessNames -notcontains [string]$Process.Name) {
        return $false
    }
    return [bool]($legacyWatcherEntries | Where-Object {
        Command-References $Process.CommandLine $_
    } | Select-Object -First 1)
}

function Is-LegacyRuntimeProcess($Process) {
    if (-not $Process) { return $false }
    $process = $Process
    $legacyExe = $legacyExecutables | Where-Object { Exact-Path $process.ExecutablePath $_ } | Select-Object -First 1
    if ($legacyExe) { return $true }
    $managerNode = $nodeExecutables | Where-Object { Exact-Path $process.ExecutablePath $_ } | Select-Object -First 1
    if ($managerNode -and (Command-References $process.CommandLine $managerEntry)) { return $true }
    $trayPython = $pythonExecutables | Where-Object { Exact-Path $process.ExecutablePath $_ } | Select-Object -First 1
    if ($trayPython) {
        return [bool]($trayEntries | Where-Object { Command-References $process.CommandLine $_ } | Select-Object -First 1)
    }
    return $false
}

function Is-InstallOwnedSpeechProcess($Process) {
    if (-not $Process) { return $false }
    return (Exact-Path $Process.ExecutablePath $speechRuntimeExecutable) -and
        (Command-References $Process.CommandLine $speechHostScript)
}

function Get-SpeechTaskCandidates {
    try {
        return @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
            [string]$_.TaskName -ceq $speechTaskName
        })
    } catch {
        throw "Could not enumerate scheduled tasks while checking the legacy RabiSpeech owner: $($_.Exception.Message)"
    }
}

function Get-WatchdogTaskCandidates {
    try {
        return @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
            [string]$_.TaskName -ceq $watchdogTaskName
        })
    } catch {
        throw "Could not enumerate scheduled tasks while checking the legacy RabiRoute watchdog owner: $($_.Exception.Message)"
    }
}

function Assert-CurrentUserAccount([string]$Account, [string]$Field) {
    if (-not $Account) {
        throw "$Field is empty; refusing to modify an unverifiable scheduled task."
    }
    try {
        $candidateSid = ([System.Security.Principal.NTAccount]$Account).Translate(
            [System.Security.Principal.SecurityIdentifier]).Value
        $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    } catch {
        throw "$Field could not be resolved to the current Windows user; refusing to modify the task."
    }
    if ($candidateSid -cne $currentSid) {
        throw "$Field belongs to another Windows user; refusing to modify the task."
    }
}

function Assert-CurrentUserTaskIdentity($Task, [int]$ExpectedTriggerCount) {
    Assert-CurrentUserAccount ([string]$Task.Principal.UserId) "Scheduled task principal"
    if ([string]$Task.Principal.RunLevel -ne "Limited" -or
        [string]$Task.Principal.LogonType -notin @("Interactive", "InteractiveToken")) {
        throw "The scheduled task principal does not match the historical current-user contract."
    }
    $triggers = @($Task.Triggers)
    if ($triggers.Count -ne $ExpectedTriggerCount) {
        throw "The scheduled task has an unknown trigger set; refusing to modify it."
    }
    $logonTriggers = @($triggers | Where-Object { [string]$_.CimClass.CimClassName -eq "MSFT_TaskLogonTrigger" })
    if ($logonTriggers.Count -ne 1 -or $logonTriggers[0].Enabled -eq $false) {
        throw "The scheduled task does not have the exact historical logon trigger."
    }
    Assert-CurrentUserAccount ([string]$logonTriggers[0].UserId) "Scheduled task logon trigger"
}

function Assert-ExactSpeechWrapper {
    if (-not (Test-Path -LiteralPath $speechTaskWrapper -PathType Leaf -ErrorAction Stop)) {
        throw "The RabiSpeech task wrapper is missing; refusing to modify an unverifiable task."
    }

    $expectedWrapper = @'
param()

$ErrorActionPreference = "Stop"
$serviceRoot = '__SERVICE_ROOT__'
$runtime = Join-Path $serviceRoot 'runtime\RabiSpeech.exe'
$hostScript = Join-Path $serviceRoot 'scripts\windows_host.py'
$dependencies = Join-Path $serviceRoot '.deps'
$config = Join-Path $PSScriptRoot 'config.json'

foreach ($required in @($runtime, $hostScript, $dependencies, $config)) {
  if (!(Test-Path -LiteralPath $required)) {
    throw "RabiSpeech user runtime is incomplete: $required"
  }
}

$env:RABISPEECH_ROOT = $serviceRoot
$env:RABISPEECH_DATA_ROOT = $PSScriptRoot
$env:RABISPEECH_CONFIG = $config
$env:PYTHONPATH = "$dependencies;$serviceRoot" + $(if ($env:PYTHONPATH) { ";$env:PYTHONPATH" } else { "" })

$nvidiaRoot = Join-Path $dependencies 'nvidia'
if (Test-Path -LiteralPath $nvidiaRoot) {
  $nvidiaBins = Get-ChildItem -LiteralPath $nvidiaRoot -Directory |
    ForEach-Object { Join-Path $_.FullName 'bin' } |
    Where-Object { Test-Path -LiteralPath $_ }
  if ($nvidiaBins) {
    $env:PATH = (($nvidiaBins -join ';') + ';' + $env:PATH)
  }
}

$pythonHome = (& py -3.10 -c "import sys; print(sys.base_prefix)").Trim()
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $pythonHome -PathType Container)) {
  throw 'RabiSpeech could not resolve Python 3.10.'
}
$env:PYTHONHOME = $pythonHome
$env:PATH = "$pythonHome;$env:PATH"
& $runtime $hostScript
exit $LASTEXITCODE
'@.Replace("__SERVICE_ROOT__", $speechRoot.Replace("'", "''"))

    $actual = (Get-Content -LiteralPath $speechTaskWrapper -Raw -Encoding UTF8 -ErrorAction Stop) -replace "`r`n?", "`n"
    $expected = $expectedWrapper -replace "`r`n?", "`n"
    if ($actual.TrimEnd("`n") -cne $expected.TrimEnd("`n")) {
        throw "The RabiSpeech task wrapper is not the exact install-owned wrapper; refusing to modify it."
    }
}

function Get-RetiredSpeechWrapperContent {
    return @'
param()

throw "This legacy RabiSpeech wrapper has been retired. Start RabiRouteHost.exe; the Manager speech plugin owns the RabiSpeech process inside the current application generation."
'@
}

function Test-RetiredSpeechWrapper {
    if (-not (Test-Path -LiteralPath $speechTaskWrapper -PathType Leaf -ErrorAction Stop)) { return $false }
    $actual = (Get-Content -LiteralPath $speechTaskWrapper -Raw -Encoding UTF8 -ErrorAction Stop) -replace "`r`n?", "`n"
    $expected = (Get-RetiredSpeechWrapperContent) -replace "`r`n?", "`n"
    return $actual.TrimEnd("`n") -ceq $expected.TrimEnd("`n")
}

function Retire-InstallOwnedSpeechWrapper([bool]$Strict) {
    if (-not (Test-Path -LiteralPath $speechTaskWrapper -PathType Leaf -ErrorAction Stop)) { return }
    if (Test-RetiredSpeechWrapper) { return }
    try {
        Assert-ExactSpeechWrapper
    } catch {
        if ($Strict) { throw }
        return
    }

    $directory = Split-Path -Parent $speechTaskWrapper
    $temporary = Join-Path $directory (".start-rabispeech.retiring-" + [Guid]::NewGuid().ToString("N") + ".tmp")
    try {
        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($temporary, (Get-RetiredSpeechWrapperContent) + "`r`n", $utf8NoBom)
        Move-Item -LiteralPath $temporary -Destination $speechTaskWrapper -Force -ErrorAction Stop
    } finally {
        if (Test-Path -LiteralPath $temporary -PathType Leaf) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
    if (-not (Test-RetiredSpeechWrapper)) {
        throw "The app-owned legacy RabiSpeech wrapper could not be retired safely."
    }
}

function Assert-InstallOwnedSpeechTask($Task) {
    if (-not $Task) {
        throw "The RabiSpeech task disappeared before its ownership could be verified."
    }
    if ([string]$Task.TaskName -cne $speechTaskName -or [string]$Task.TaskPath -ne "\") {
        throw "A scheduled task named RabiSpeech exists outside the install-owned root task identity."
    }
    if ([string]$Task.Description -cne $speechTaskDescription) {
        throw "A scheduled task named RabiSpeech has an unknown description; refusing to modify it."
    }
    Assert-CurrentUserTaskIdentity $Task 1
    if ([int]$Task.Settings.RestartCount -ne 3 -or
        [string]$Task.Settings.RestartInterval -ne "PT1M" -or
        [string]$Task.Settings.ExecutionTimeLimit -ne "PT0S" -or
        [string]$Task.Settings.MultipleInstances -ne "IgnoreNew" -or
        $Task.Settings.Enabled -eq $false -or
        $Task.Settings.Hidden -eq $true) {
        throw "The RabiSpeech task settings do not match the historical install-owned contract."
    }

    $actions = @($Task.Actions)
    if ($actions.Count -ne 1) {
        throw "The RabiSpeech task has an unknown action set; refusing to modify it."
    }
    $action = $actions[0]
    $systemPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $trustedPowerShell = ([string]$action.Execute -ieq "powershell.exe") -or
        (Exact-Path ([string]$action.Execute) $systemPowerShell)
    if (-not $trustedPowerShell) {
        throw "The RabiSpeech task does not use the install-owned Windows PowerShell action."
    }
    $wrapperArguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $speechTaskWrapper
    $directArguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $speechLegacyStartScript
    $isWrapperTask = ([string]$action.Arguments -ceq $wrapperArguments) -and
        (Exact-Path ([string]$action.WorkingDirectory) (Split-Path -Parent $speechTaskWrapper))
    $isHistoricalDirectTask = ([string]$action.Arguments -ceq $directArguments) -and
        (Exact-Path ([string]$action.WorkingDirectory) $speechRoot)

    if ($isWrapperTask) {
        Assert-ExactSpeechWrapper
    } elseif ($isHistoricalDirectTask) {
        if (-not (Test-Path -LiteralPath $speechLegacyStartScript -PathType Leaf -ErrorAction Stop)) {
            throw "The historical RabiSpeech start script is missing; refusing to modify an unverifiable task."
        }
    } else {
        throw "The RabiSpeech task has an unknown action target or working directory; refusing to modify it."
    }
}

function Assert-InstallOwnedWatchdogTask($Task) {
    if (-not $Task -or [string]$Task.TaskName -cne $watchdogTaskName -or [string]$Task.TaskPath -ne "\") {
        throw "A scheduled task named RabiRouteHealthWatchdog has an unknown identity."
    }
    if ([string]$Task.Description -cne $watchdogTaskDescription) {
        throw "A scheduled task named RabiRouteHealthWatchdog has an unknown description; refusing to modify it."
    }
    Assert-CurrentUserTaskIdentity $Task 2
    $timeTriggers = @($Task.Triggers | Where-Object { [string]$_.CimClass.CimClassName -eq "MSFT_TaskTimeTrigger" })
    if ($timeTriggers.Count -ne 1 -or $timeTriggers[0].Enabled -eq $false) {
        throw "The RabiRouteHealthWatchdog task does not have the exact historical repetition trigger."
    }
    if ([int]$Task.Settings.RestartCount -ne 3 -or
        [string]$Task.Settings.RestartInterval -ne "PT1M" -or
        [string]$Task.Settings.ExecutionTimeLimit -ne "PT10M" -or
        [string]$Task.Settings.MultipleInstances -ne "IgnoreNew" -or
        $Task.Settings.Enabled -eq $false -or
        $Task.Settings.Hidden -eq $true) {
        throw "The RabiRouteHealthWatchdog task settings do not match the historical install-owned contract."
    }
    $actions = @($Task.Actions)
    if ($actions.Count -ne 1) {
        throw "The RabiRouteHealthWatchdog task has an unknown action set; refusing to modify it."
    }
    $action = $actions[0]
    $systemPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    if (([string]$action.Execute -ine "powershell.exe") -and
        -not (Exact-Path ([string]$action.Execute) $systemPowerShell)) {
        throw "The RabiRouteHealthWatchdog task has an unknown executable."
    }
    if (-not (Exact-Path ([string]$action.WorkingDirectory) $install)) {
        throw "The RabiRouteHealthWatchdog task has an unknown working directory."
    }
    $escapedEntry = [System.Text.RegularExpressions.Regex]::Escape($watchdogEntry)
    $argumentsPattern = '^-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' +
        $escapedEntry + '" -ManagerUrl "[^"\r\n]+" -DefaultRouteName "[^"\r\n]+" -Once -NoDesktopRepair$'
    if (-not [System.Text.RegularExpressions.Regex]::IsMatch(
        [string]$action.Arguments, $argumentsPattern,
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
        throw "The RabiRouteHealthWatchdog task has unknown PowerShell arguments."
    }
}

function Assert-AllLegacyTaskOwnership {
    $speech = @(Get-SpeechTaskCandidates)
    if ($speech.Count -gt 1) { throw "Multiple scheduled tasks named RabiSpeech exist; refusing ambiguous migration." }
    if ($speech.Count -eq 1) { Assert-InstallOwnedSpeechTask $speech[0] }

    $watchdog = @(Get-WatchdogTaskCandidates)
    if ($watchdog.Count -gt 1) { throw "Multiple scheduled tasks named RabiRouteHealthWatchdog exist; refusing ambiguous migration." }
    if ($watchdog.Count -eq 1) { Assert-InstallOwnedWatchdogTask $watchdog[0] }
}

function Wait-ForSpeechTaskStop {
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        $candidates = @(Get-SpeechTaskCandidates)
        if ($candidates.Count -eq 0) { return }
        if ($candidates.Count -ne 1) {
            throw "Multiple scheduled tasks named RabiSpeech exist; refusing ambiguous migration."
        }
        Assert-InstallOwnedSpeechTask $candidates[0]
        if ([string]$candidates[0].State -notin @("Running", "Queued")) { return }
        Start-Sleep -Milliseconds 100
    }
    throw "The install-owned RabiSpeech task did not stop within 10 seconds."
}

function Remove-InstallOwnedSpeechTask {
    $candidates = @(Get-SpeechTaskCandidates)
    if ($candidates.Count -eq 0) {
        # A previous partial migration may already have removed the task while
        # leaving its exact app-owned wrapper runnable. Retire only that exact
        # template; an unrelated file at the same path is left untouched.
        Retire-InstallOwnedSpeechWrapper $false
        return
    }
    if ($candidates.Count -ne 1) {
        throw "Multiple scheduled tasks named RabiSpeech exist; refusing ambiguous migration."
    }
    $task = $candidates[0]
    Assert-InstallOwnedSpeechTask $task
    $wrapperArguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $speechTaskWrapper
    $taskUsesWrapper = [string]$task.Actions[0].Arguments -ceq $wrapperArguments

    if ([string]$task.State -in @("Running", "Queued")) {
        Stop-ScheduledTask -InputObject $task -ErrorAction Stop
        Wait-ForSpeechTaskStop
    }

    $speechPredicate = { param($process) Is-InstallOwnedSpeechProcess $process }
    $speechProcessNames = @([System.IO.Path]::GetFileName($speechRuntimeExecutable))
    Stop-MatchingProcesses $speechPredicate $speechProcessNames

    $remaining = @(Get-SpeechTaskCandidates)
    if ($remaining.Count -eq 1) {
        Assert-InstallOwnedSpeechTask $remaining[0]
        Unregister-ScheduledTask -InputObject $remaining[0] -Confirm:$false -ErrorAction Stop
    } elseif ($remaining.Count -gt 1) {
        throw "Multiple scheduled tasks named RabiSpeech appeared during migration."
    }

    if (@(Get-SpeechTaskCandidates).Count -ne 0) {
        throw "The install-owned RabiSpeech scheduled task is still registered."
    }
    if (@(Get-CimInstance Win32_Process | Where-Object { Is-InstallOwnedSpeechProcess $_ }).Count -ne 0) {
        throw "An install-owned RabiSpeech process is still running after task migration."
    }
    if ($taskUsesWrapper) {
        Retire-InstallOwnedSpeechWrapper $true
    } else {
        Retire-InstallOwnedSpeechWrapper $false
    }
}

function Wait-ForWatchdogTaskStop {
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        $candidates = @(Get-WatchdogTaskCandidates)
        if ($candidates.Count -eq 0) { return }
        if ($candidates.Count -ne 1) {
            throw "Multiple scheduled tasks named RabiRouteHealthWatchdog exist during migration."
        }
        Assert-InstallOwnedWatchdogTask $candidates[0]
        if ([string]$candidates[0].State -notin @("Running", "Queued")) { return }
        Start-Sleep -Milliseconds 100
    }
    throw "The install-owned RabiRouteHealthWatchdog task did not stop within 10 seconds."
}

function Remove-InstallOwnedWatchdogTask {
    $candidates = @(Get-WatchdogTaskCandidates)
    if ($candidates.Count -eq 0) { return }
    if ($candidates.Count -ne 1) {
        throw "Multiple scheduled tasks named RabiRouteHealthWatchdog exist; refusing ambiguous migration."
    }
    $task = $candidates[0]
    Assert-InstallOwnedWatchdogTask $task
    if ([string]$task.State -in @("Running", "Queued")) {
        Stop-ScheduledTask -InputObject $task -ErrorAction Stop
        Wait-ForWatchdogTaskStop
    }
    $remaining = @(Get-WatchdogTaskCandidates)
    if ($remaining.Count -eq 1) {
        Assert-InstallOwnedWatchdogTask $remaining[0]
        Unregister-ScheduledTask -InputObject $remaining[0] -Confirm:$false -ErrorAction Stop
    } elseif ($remaining.Count -gt 1) {
        throw "Multiple scheduled tasks named RabiRouteHealthWatchdog appeared during migration."
    }
    if (@(Get-WatchdogTaskCandidates).Count -ne 0) {
        throw "The install-owned RabiRouteHealthWatchdog task is still registered."
    }
}

function Wait-ForTargetExit($Target, [scriptblock]$Predicate) {
    $targetPid = [int]$Target.ProcessId
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        $current = Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid" -ErrorAction Stop
        if (-not $current -or -not (& $Predicate $current)) {
            return
        }
        Start-Sleep -Milliseconds 100
    }
    throw "Install-owned legacy process pid=$targetPid did not exit within 5 seconds."
}

function Get-ProcessCandidates([string[]]$ProcessNames) {
    $clauses = @($ProcessNames | Where-Object { $_ } | Select-Object -Unique | ForEach-Object {
        "Name = '$($_.Replace("'", "''"))'"
    })
    if ($clauses.Count -eq 0) { return @() }
    return @(Get-CimInstance Win32_Process -Filter ($clauses -join " OR "))
}

function Stop-MatchingProcesses([scriptblock]$Predicate, [string[]]$ProcessNames) {
    $targets = @(Get-ProcessCandidates $ProcessNames | Where-Object { & $Predicate $_ })
    foreach ($target in $targets) {
        $targetPid = [int]$target.ProcessId
        # Re-read and reclassify the PID immediately before stopping it. A PID
        # that has already exited or been reused must not inherit the old match.
        $current = Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid" -ErrorAction Stop
        if (-not $current -or -not (& $Predicate $current)) {
            continue
        }
        Stop-Process -Id $targetPid -Force -ErrorAction Stop
        Wait-ForTargetExit $current $Predicate
    }
}

$watcherPredicate = { param($process) Is-LegacyWatcherProcess $process }
$runtimePredicate = { param($process) Is-LegacyRuntimeProcess $process }
$watcherProcessNames = $powershellProcessNames
$runtimeProcessNames = @(
    $legacyExecutables + $nodeExecutables + $pythonExecutables |
    ForEach-Object { [System.IO.Path]::GetFileName($_) } |
    Where-Object { $_ } |
    Select-Object -Unique
)

# This historical AtLogOn task is a second lifecycle owner outside the Host Job.
# Remove it only after every install-owned fingerprint has been verified. A
# same-name task with any different field is deliberately left untouched and
# aborts the installer before payload replacement.
Assert-AllLegacyTaskOwnership
Remove-InstallOwnedSpeechTask
Remove-InstallOwnedWatchdogTask

# Quiesce the legacy lifecycle owner before stopping its children. Otherwise
# the watcher can recreate Manager between the first enumeration and installer
# file replacement.
Stop-MatchingProcesses $watcherPredicate $watcherProcessNames
Start-Sleep -Milliseconds 250

# Re-enumerate after the watcher exits so a Manager created during the final
# watcher iteration is still included. The second pass closes the small window
# between process creation and its visibility through CIM.
Stop-MatchingProcesses $runtimePredicate $runtimeProcessNames
Start-Sleep -Milliseconds 250
Stop-MatchingProcesses $runtimePredicate $runtimeProcessNames

# A process can disappear between CIM enumeration and verification. Only fail
# when an exact install-owned legacy process is still present after migration.
for ($verification = 0; $verification -lt 2; $verification++) {
    $remaining = @(Get-ProcessCandidates ($watcherProcessNames + $runtimeProcessNames) | Where-Object {
        (Is-LegacyWatcherProcess $_) -or (Is-LegacyRuntimeProcess $_)
    })
    if ($remaining) {
        throw "An install-owned legacy RabiRoute watcher, Manager, or Tray process is still running."
    }
    if ($verification -eq 0) {
        Start-Sleep -Milliseconds 250
    }
}
