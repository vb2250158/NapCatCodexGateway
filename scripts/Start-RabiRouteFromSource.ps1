param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "Programs\RabiRoute"),
    [int]$ReadyTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$hostExe = Join-Path $InstallRoot "RabiRouteHost.exe"
$transcribing = $false

function Read-HostStatus {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $hostExe
    $info.Arguments = "--command status --json"
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($info)
    try {
        $output = $process.StandardOutput.ReadToEnd()
        $errorOutput = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0 -or -not $output.Trim()) { throw "Host status failed: $errorOutput" }
        return $output | ConvertFrom-Json
    } finally { $process.Dispose() }
}

try {
    # A launcher may inherit PowerShell 7 module paths. Child Windows PowerShell
    # builds must resolve their own inbox modules first; change this process only.
    $env:PSModulePath = (Join-Path $PSHOME 'Modules') + [IO.Path]::PathSeparator + $env:PSModulePath
    Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
    Set-Location -LiteralPath $repo
    $logDir = Join-Path $repo "logs\source-start"
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $logPath = Join-Path $logDir ("source-start-" + [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ") + ".log")
    Start-Transcript -Path $logPath | Out-Null
    $transcribing = $true
    foreach ($command in @("node.exe", "npm.cmd", "dotnet.exe")) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required build tool is missing: $command" }
    }
    if (-not (Test-Path -LiteralPath $hostExe -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $InstallRoot "current.json") -PathType Leaf)) {
        throw "Install the Windows RabiRoute package first. This source launcher reuses its dependencies, configuration and data: $InstallRoot"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $repo "node_modules\typescript\package.json"))) {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
    }
    Write-Host "Building Manager, WebGUI, plugins, Host and Desktop from this source tree."
    Write-Host "The installed application will switch to this source build; existing data is retained."
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Publish-RabiRouteDeveloperCandidate.ps1") `
        -SourceRoot $repo -InstallRoot $InstallRoot -ReadyTimeoutSeconds $ReadyTimeoutSeconds
    if ($LASTEXITCODE -ne 0) { throw "Source build or Host activation failed. See $logPath" }

    $deadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
    $lastFailure = "Host has not published a healthy application generation."
    do {
        try {
            # Discover anew on each attempt: the Host may have replaced a startup generation.
            $status = Read-HostStatus
            if (-not $status.ok -or -not $status.managerBaseUrl) { throw "Host is not ready: $($status.state)" }
            $meta = Invoke-RestMethod -Uri ($status.managerBaseUrl.TrimEnd('/') + '/meta') -TimeoutSec 10
            if ($meta.applicationGenerationId -ne $status.applicationGenerationId -or
                $meta.managerInstanceId -ne $status.managerInstanceId -or
                $meta.health.state -ne 'healthy' -or -not $meta.health.requiredReady) {
                throw "Application is not healthy: $($meta.health.message)"
            }
            $html = (Invoke-WebRequest -UseBasicParsing -Uri ($status.managerBaseUrl.TrimEnd('/') + '/') -TimeoutSec 10).Content
            $builtHtml = [IO.File]::ReadAllText((Join-Path $repo 'ribiwebgui\dist\index.html'))
            if ($html -cne $builtHtml) { throw 'The running WebGUI does not match this source build.' }
            Write-Host "RabiRoute started: $($status.managerBaseUrl)"
            Write-Host "Generation: $($status.applicationGenerationId); Manager: $($status.managerInstanceId)"
            Write-Host "Startup log: $logPath"
            exit 0
        } catch { $lastFailure = $_.Exception.Message }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Source startup did not become healthy: $lastFailure"
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
} finally {
    if ($transcribing) { Stop-Transcript | Out-Null }
}
