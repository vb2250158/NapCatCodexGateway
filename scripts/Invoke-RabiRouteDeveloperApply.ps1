param(
    [Parameter(Mandatory = $true)]
    [string]$CandidateRoot,
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "Programs\RabiRoute"),
    [int]$ReadyTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Get-InstallMutexName([string]$NormalizedInstallRoot) {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($NormalizedInstallRoot.ToLowerInvariant())
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $digest = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
    return "Local\RabiRoute.Install.$($digest.Substring(0, 32))"
}

function Enter-InstallMutex([string]$NormalizedInstallRoot) {
    $mutex = [Threading.Mutex]::new($false, (Get-InstallMutexName $NormalizedInstallRoot))
    $acquired = $false
    try {
        try {
            $acquired = $mutex.WaitOne(0)
        }
        catch [Threading.AbandonedMutexException] {
            $acquired = $true
        }
        if (-not $acquired) {
            throw "Another RabiRoute install or Developer activation is already mutating this installation."
        }
        return $mutex
    }
    catch {
        if (-not $acquired) { $mutex.Dispose() }
        throw
    }
}

function Get-ContentToken([byte[]]$Content) {
    return [Convert]::ToBase64String($Content)
}

function Get-CurrentPointerReleaseId([string]$CurrentPath) {
    if (-not (Test-Path -LiteralPath $CurrentPath -PathType Leaf)) {
        throw "The installed current pointer is missing: $CurrentPath"
    }
    $pointer = [Text.UTF8Encoding]::new($false).GetString([IO.File]::ReadAllBytes($CurrentPath)) | ConvertFrom-Json
    $releaseId = [string]$pointer.releaseId
    if ($pointer.schemaVersion -ne 1 -or [string]$pointer.appId -ne "io.rabiroute.windows" -or
        [string]::IsNullOrWhiteSpace($releaseId)) {
        throw "The installed current pointer has an invalid application or release identity."
    }
    return $releaseId
}

function Assert-CurrentPointerToken([string]$CurrentPath, [string]$ExpectedToken) {
    if (-not (Test-Path -LiteralPath $CurrentPath -PathType Leaf)) {
        throw "The installed current pointer disappeared during Developer activation."
    }
    $actualToken = Get-ContentToken ([IO.File]::ReadAllBytes($CurrentPath))
    if ($actualToken -cne $ExpectedToken) {
        throw "The installed current pointer changed concurrently; refusing to overwrite it."
    }
}

function Assert-CurrentPointerReleaseId([string]$CurrentPath, [string]$ExpectedReleaseId) {
    $actualReleaseId = Get-CurrentPointerReleaseId $CurrentPath
    if ($actualReleaseId -cne $ExpectedReleaseId) {
        throw "The installed current pointer releaseId is '$actualReleaseId', expected '$ExpectedReleaseId'."
    }
}

function Invoke-HostJson([string]$HostExe, [string[]]$HostArguments) {
    $stdoutPath = Join-Path $env:TEMP ("rabiroute-host-{0}.stdout.json" -f [guid]::NewGuid().ToString("N"))
    $stderrPath = Join-Path $env:TEMP ("rabiroute-host-{0}.stderr.txt" -f [guid]::NewGuid().ToString("N"))
    try {
        $process = Start-Process -FilePath $HostExe -ArgumentList $HostArguments -Wait -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
        $stdout = if (Test-Path -LiteralPath $stdoutPath) { [IO.File]::ReadAllText($stdoutPath).Trim() } else { "" }
        $stderr = if (Test-Path -LiteralPath $stderrPath) { [IO.File]::ReadAllText($stderrPath).Trim() } else { "" }
        if (-not $stdout) { throw "Host returned no JSON. ExitCode=$($process.ExitCode); stderr=$stderr" }
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Response = $stdout | ConvertFrom-Json }
    }
    finally {
        if (Test-Path -LiteralPath $stdoutPath) { [IO.File]::Delete($stdoutPath) }
        if (Test-Path -LiteralPath $stderrPath) { [IO.File]::Delete($stderrPath) }
    }
}

function Get-HostStatus([string]$HostExe) {
    return Invoke-HostJson $HostExe @("--command", "status", "--json")
}

function Stop-HostGeneration([string]$HostExe, [object]$Status) {
    if ($Status.Response.state -eq "stopped") { return }
    $fence = if ($Status.Response.applicationGenerationId) {
        [string]$Status.Response.applicationGenerationId
    } else {
        [string]$Status.Response.controlFenceGenerationId
    }
    if (-not $fence) { throw "The active Host did not publish a lifecycle fence." }
    $quit = Invoke-HostJson $HostExe @(
        "--command", "quit", "--application-generation-id", $fence, "--json"
    )
    if ($quit.ExitCode -ne 0 -or $quit.Response.ok -ne $true) {
        throw "Exact generation-fenced Host quit failed."
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        $hostProcess = @(Get-CimInstance Win32_Process | Where-Object {
            $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).Equals(
                [IO.Path]::GetFullPath($HostExe), [StringComparison]::OrdinalIgnoreCase) -and
            $_.CommandLine -notlike "*--command*"
        })
        if ($hostProcess.Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Host did not stop after the fenced quit."
}

function Set-CurrentPointer([string]$CurrentPath, [byte[]]$Content) {
    $temporary = "$CurrentPath.developer.$([guid]::NewGuid().ToString('N')).tmp"
    $backup = "$CurrentPath.developer.$([guid]::NewGuid().ToString('N')).bak"
    [IO.File]::WriteAllBytes($temporary, $Content)
    try {
        [IO.File]::Replace($temporary, $CurrentPath, $backup)
    }
    finally {
        if (Test-Path -LiteralPath $backup) { [IO.File]::Delete($backup) }
        if (Test-Path -LiteralPath $temporary) { [IO.File]::Delete($temporary) }
    }
}

function Wait-Ready([string]$HostExe, [string]$CurrentPath, [string]$ExpectedReleaseId, [int]$TimeoutSeconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastState = "unreachable"
    $lastError = $null
    do {
        Start-Sleep -Milliseconds 500
        try {
            $statusResult = Get-HostStatus $HostExe
            $status = $statusResult.Response
            $lastState = [string]$status.state
            if ($statusResult.ExitCode -ne 0 -or $status.ok -ne $true -or
                $status.state -notin @("healthy", "degraded") -or
                -not $status.applicationGenerationId -or -not $status.managerInstanceId -or
                -not $status.managerBaseUrl -or -not $status.managerPid -or -not $status.trayPid) { continue }
            $meta = Invoke-RestMethod -Uri ($status.managerBaseUrl.TrimEnd("/") + "/meta") -TimeoutSec 10
            if ($meta.applicationGenerationId -ne $status.applicationGenerationId -or
                $meta.managerInstanceId -ne $status.managerInstanceId -or
                $meta.managerBaseUrl -ne $status.managerBaseUrl -or
                [int]$meta.managerRuntime.pid -ne [int]$status.managerPid) { continue }
            $processes = @(Get-CimInstance Win32_Process)
            $hostProcesses = @($processes | Where-Object {
                $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).Equals(
                    [IO.Path]::GetFullPath($HostExe), [StringComparison]::OrdinalIgnoreCase) -and
                $_.CommandLine -notlike "*--command*"
            })
            $manager = @($processes | Where-Object { [int]$_.ProcessId -eq [int]$status.managerPid })
            $tray = @($processes | Where-Object { [int]$_.ProcessId -eq [int]$status.trayPid })
            if ($hostProcesses.Count -ne 1 -or $manager.Count -ne 1 -or $tray.Count -ne 1 -or
                [int]$manager[0].ParentProcessId -ne [int]$hostProcesses[0].ProcessId -or
                [int]$tray[0].ParentProcessId -ne [int]$hostProcesses[0].ProcessId) { continue }
            Assert-CurrentPointerReleaseId $CurrentPath $ExpectedReleaseId
            return [pscustomobject]@{ Status = $status; HostPid = [int]$hostProcesses[0].ProcessId }
        } catch {
            $lastError = $_.Exception.Message
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    $errorSuffix = if ($lastError) { "; last error=$lastError" } else { "" }
    throw "Host did not publish a complete ready generation within $TimeoutSeconds seconds; last state=$lastState$errorSuffix."
}

$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd("\")
$CandidateRoot = [IO.Path]::GetFullPath($CandidateRoot)
$versionsRoot = [IO.Path]::GetFullPath((Join-Path $InstallRoot "versions"))
$versionsPrefix = $versionsRoot.TrimEnd("\") + "\"
if (-not $CandidateRoot.StartsWith($versionsPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Developer candidate must be an immutable child of the installed versions directory."
}
$hostExe = Join-Path $InstallRoot "RabiRouteHost.exe"
$currentPath = Join-Path $InstallRoot "current.json"
$manifestPath = Join-Path $CandidateRoot "release-manifest.json"
$installMutex = Enter-InstallMutex $InstallRoot
try {
    foreach ($required in @($hostExe, $currentPath, $manifestPath)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required activation input is missing: $required" }
    }

    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or [string]$manifest.appId -ne "io.rabiroute.windows" -or
        [string]$manifest.releaseId -ne (Split-Path -Leaf $CandidateRoot) -or
        [string]::IsNullOrWhiteSpace([string]$manifest.payloadSha256)) {
        throw "Developer candidate directory or manifest identity is invalid."
    }
    $previousPointerBytes = [IO.File]::ReadAllBytes($currentPath)
    $previousPointerToken = Get-ContentToken $previousPointerBytes
    $previousReleaseId = Get-CurrentPointerReleaseId $currentPath
    $nextPointer = [ordered]@{
        schemaVersion = 1
        appId = "io.rabiroute.windows"
        releaseId = [string]$manifest.releaseId
        versionPath = "versions/$([string]$manifest.releaseId)"
        payloadSha256 = [string]$manifest.payloadSha256
    } | ConvertTo-Json
    $nextPointerBytes = [Text.UTF8Encoding]::new($false).GetBytes($nextPointer + "`n")
    $candidatePointerToken = Get-ContentToken $nextPointerBytes

    $previousStatus = Get-HostStatus $hostExe
    if ($previousStatus.ExitCode -ne 0 -or $previousStatus.Response.ok -ne $true) {
        throw "Cannot query the current Host before Developer activation."
    }
    $sourcePatchPreflight = Join-Path $CandidateRoot "scripts\check-source-patch-upgrade.mjs"
    if (Test-Path -LiteralPath $sourcePatchPreflight -PathType Leaf) {
        & (Join-Path $CandidateRoot "node.exe") $sourcePatchPreflight $CandidateRoot (Join-Path $InstallRoot "data\.runtime\source-patches")
        if ($LASTEXITCODE -ne 0) { throw "Source patch upgrade preflight failed; the current Host has not been stopped." }
    }
    Stop-HostGeneration $hostExe $previousStatus
    Assert-CurrentPointerToken $currentPath $previousPointerToken

    $candidateStartAttempted = $false
    try {
        Set-CurrentPointer $currentPath $nextPointerBytes
        Assert-CurrentPointerToken $currentPath $candidatePointerToken
        Assert-CurrentPointerReleaseId $currentPath $manifest.releaseId
        $candidateStartAttempted = $true
        Start-Process -FilePath $hostExe -WorkingDirectory $InstallRoot -WindowStyle Hidden | Out-Null
        $ready = Wait-Ready $hostExe $currentPath $manifest.releaseId $ReadyTimeoutSeconds
    }
    catch {
        $candidateFailure = $_
        $candidateStopFailure = $null
        $pointerRollbackFailure = $null
        $rollbackFailure = $null
        if ($candidateStartAttempted) {
            try {
                $failedStatus = Get-HostStatus $hostExe
                if ($failedStatus.ExitCode -ne 0 -or $failedStatus.Response.ok -ne $true) {
                    throw "Cannot query the candidate Host before rollback."
                }
                Stop-HostGeneration $hostExe $failedStatus
            }
            catch {
                $candidateStopFailure = $_
            }
        }
        try {
            $currentAlreadyPrevious = $false
            $previousPointerMismatch = $null
            try {
                Assert-CurrentPointerToken $currentPath $previousPointerToken
                $currentAlreadyPrevious = $true
            }
            catch {
                $previousPointerMismatch = $_
            }
            if (-not $currentAlreadyPrevious) {
                # Only this activation's exact candidate bytes may be replaced.
                # A third value belongs to another writer and must fail closed.
                Assert-CurrentPointerToken $currentPath $candidatePointerToken
                Set-CurrentPointer $currentPath $previousPointerBytes
            }
            Assert-CurrentPointerReleaseId $currentPath $previousReleaseId
        }
        catch {
            $pointerRollbackFailure = $_
        }
        if (-not $candidateStopFailure -and -not $pointerRollbackFailure) {
            try {
                Start-Process -FilePath $hostExe -WorkingDirectory $InstallRoot -WindowStyle Hidden | Out-Null
                [void](Wait-Ready $hostExe $currentPath $previousReleaseId $ReadyTimeoutSeconds)
            }
            catch {
                $rollbackFailure = $_
            }
        }
        if ($candidateStopFailure -or $pointerRollbackFailure -or $rollbackFailure) {
            $candidateStopMessage = if ($candidateStopFailure) { $candidateStopFailure.Exception.Message } else { "none" }
            $pointerMessage = if ($pointerRollbackFailure) { $pointerRollbackFailure.Exception.Message } else { "none" }
            $runtimeMessage = if ($rollbackFailure) {
                $rollbackFailure.Exception.Message
            } elseif ($candidateStopFailure -or $pointerRollbackFailure) {
                "previous runtime restart skipped because rollback fencing was incomplete"
            } else {
                "none"
            }
            throw "Developer activation failed and rollback was incomplete. candidate=$($candidateFailure.Exception.Message) candidateStop=$candidateStopMessage pointer=$pointerMessage runtime=$runtimeMessage"
        }
        throw "Developer activation failed; releaseId '$previousReleaseId' was restored and its runtime recovered. candidate=$($candidateFailure.Exception.Message)"
    }

    [pscustomobject]@{
        ok = $true
        channel = "developer"
        releaseId = [string]$manifest.releaseId
        payloadSha256 = [string]$manifest.payloadSha256
        applicationGenerationId = [string]$ready.Status.applicationGenerationId
        managerInstanceId = [string]$ready.Status.managerInstanceId
        managerBaseUrl = [string]$ready.Status.managerBaseUrl
        hostPid = [int]$ready.HostPid
        managerPid = [int]$ready.Status.managerPid
        trayPid = [int]$ready.Status.trayPid
    } | ConvertTo-Json -Depth 4
}
finally {
    $installMutex.ReleaseMutex()
    $installMutex.Dispose()
}
