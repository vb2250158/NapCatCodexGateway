param(
    [string]$Version,
    [string]$NodeVersion = "22.17.1",
    [string]$OutputRoot,
    [string]$DesktopRuntimeRoot,
    [string]$HostRuntimeRoot,
    [switch]$SkipBuild,
    [switch]$SkipDesktopBuild,
    [switch]$IncludeSpeech,
    [switch]$SkipInstaller,
    [switch]$SkipSmokeTest
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = [System.IO.Path]::GetFullPath((Join-Path $scriptDir ".."))
if (-not $OutputRoot) { $OutputRoot = Join-Path $env:LOCALAPPDATA "RabiRoute\build\windows-release" }
$OutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
$payload = Join-Path $OutputRoot "version-payload"
$distribution = Join-Path $OutputRoot "distribution"
$package = Get-Content -LiteralPath (Join-Path $repo "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $Version) { $Version = [string]$package.version }
if ($Version -ne [string]$package.version) {
    throw "Release version $Version does not match package.json version $($package.version)."
}

function Write-Step([string]$Message) { Write-Host "[windows-release] $Message" }

function Assert-LocalDirectory([string]$PathValue) {
    if ($PathValue.StartsWith("\\")) {
        throw "Windows release build paths must be on a local disk: $PathValue"
    }
    $root = [System.IO.Path]::GetPathRoot($PathValue).TrimEnd("\")
    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$root'" -ErrorAction SilentlyContinue
    if (-not $disk -or $disk.DriveType -eq 4) {
        throw "Windows release build paths must be on a local disk: $PathValue"
    }
}

function Remove-PayloadEntry([string]$PathValue) {
    $payloadRoot = [System.IO.Path]::GetFullPath($payload).TrimEnd("\", "/")
    $candidate = [System.IO.Path]::GetFullPath($PathValue)
    $payloadPrefix = $payloadRoot + [System.IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($payloadPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a path outside the release payload: $candidate"
    }
    if (-not (Test-Path -LiteralPath $candidate)) { return }

    $item = Get-Item -LiteralPath $candidate -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        # Windows PowerShell 5.1 Remove-Item can remove a junction and then throw
        # NullReferenceException. DirectoryInfo.Delete removes only the link.
        $item.Delete()
    } else {
        Remove-Item -LiteralPath $candidate -Recurse -Force
    }
    if (Test-Path -LiteralPath $candidate) {
        throw "Release payload entry was not removed: $candidate"
    }
}

Assert-LocalDirectory $OutputRoot
Assert-LocalDirectory $repo

$excludedRuntimeFiles = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase)
foreach ($legacyRuntimeFile in @(
    "scripts/Install-RabiRoute-HealthWatchdogTask.ps1",
    "scripts/watch-message-adapters.ps1",
    "scripts/watch-rabiroute-desktop-lifecycle.ps1",
    "scripts/watch-rabiroute-health-hidden.vbs",
    "scripts/watch-rabiroute-health.ps1"
)) {
    [void]$excludedRuntimeFiles.Add($legacyRuntimeFile)
}

$requiredPortableRuntimeFiles = @(
    "scripts/Resolve-RabiRouteManagerUrl.ps1",
    "scripts/lib/discover-manager-url.mjs"
)

function Copy-TrackedTree([string]$RelativeRoot) {
    $prefix = ($RelativeRoot.TrimEnd("\", "/") -replace "\\", "/") + "/"
    $files = & git -C $repo ls-files -- "$prefix*"
    if ($LASTEXITCODE -ne 0) { throw "git ls-files failed for $RelativeRoot" }
    foreach ($relative in $files) {
        if (-not $relative.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
        if ($excludedRuntimeFiles.Contains($relative)) { continue }
        $source = Join-Path $repo ($relative -replace "/", "\")
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
        $destination = Join-Path $payload ($relative -replace "/", "\")
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination -Force
    }
}

function Resolve-Iscc {
    $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidates = @(
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return $null
}

function Get-PortableRelativePath([string]$RootPath, [string]$FilePath) {
    $rootFull = [System.IO.Path]::GetFullPath($RootPath).TrimEnd("\", "/")
    $fileFull = [System.IO.Path]::GetFullPath($FilePath)
    $prefix = $rootFull + [System.IO.Path]::DirectorySeparatorChar
    if (-not $fileFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Portable archive source escaped its distribution root: $fileFull"
    }
    return $fileFull.Substring($prefix.Length).Replace("\", "/")
}

function New-PortableArchive([string]$SourceRoot, [string]$DestinationPath) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $sourceFull = [System.IO.Path]::GetFullPath($SourceRoot)
    $destinationFull = [System.IO.Path]::GetFullPath($DestinationPath)
    if (Test-Path -LiteralPath $destinationFull) {
        Remove-Item -LiteralPath $destinationFull -Force
    }

    $stream = [System.IO.File]::Open(
        $destinationFull,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None)
    $archive = [System.IO.Compression.ZipArchive]::new(
        $stream,
        [System.IO.Compression.ZipArchiveMode]::Create,
        $false)
    try {
        foreach ($sourceFile in @(Get-ChildItem -LiteralPath $sourceFull -Recurse -Force -File | Sort-Object FullName)) {
            $entryName = Get-PortableRelativePath -RootPath $sourceFull -FilePath $sourceFile.FullName
            [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive,
                $sourceFile.FullName,
                $entryName,
                [System.IO.Compression.CompressionLevel]::Optimal)
        }
    }
    finally {
        $archive.Dispose()
        $stream.Dispose()
    }
}

function Assert-PortableArchiveRoundTrip([string]$SourceRoot, [string]$ArchivePath) {
    $sourceFull = [System.IO.Path]::GetFullPath($SourceRoot)
    $verificationRoot = Join-Path $OutputRoot ("portable-roundtrip-" + [guid]::NewGuid().ToString("N"))
    $verificationFull = [System.IO.Path]::GetFullPath($verificationRoot)
    $outputPrefix = [System.IO.Path]::GetFullPath($OutputRoot).TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
    if (-not $verificationFull.StartsWith($outputPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Portable archive verification root escaped the release output: $verificationFull"
    }
    if (Test-Path -LiteralPath $verificationFull) {
        throw "Portable archive verification root already exists: $verificationFull"
    }

    try {
        Expand-Archive -LiteralPath $ArchivePath -DestinationPath $verificationFull
        $expected = @{}
        foreach ($sourceFile in @(Get-ChildItem -LiteralPath $sourceFull -Recurse -Force -File)) {
            $relative = Get-PortableRelativePath -RootPath $sourceFull -FilePath $sourceFile.FullName
            if ($expected.ContainsKey($relative)) {
                throw "Portable distribution contains a case-insensitive duplicate path: $relative"
            }
            $expected[$relative] = $sourceFile
        }
        $actual = @{}
        foreach ($archiveFile in @(Get-ChildItem -LiteralPath $verificationFull -Recurse -Force -File)) {
            $relative = Get-PortableRelativePath -RootPath $verificationFull -FilePath $archiveFile.FullName
            if ($actual.ContainsKey($relative)) {
                throw "Portable archive contains a case-insensitive duplicate path: $relative"
            }
            $actual[$relative] = $archiveFile
        }

        $missing = @($expected.Keys | Where-Object { -not $actual.ContainsKey($_) } | Sort-Object)
        $unexpected = @($actual.Keys | Where-Object { -not $expected.ContainsKey($_) } | Sort-Object)
        if ($expected.Count -ne $actual.Count -or $missing.Count -gt 0 -or $unexpected.Count -gt 0) {
            throw "Portable archive round-trip does not match the complete distribution. Missing: $($missing -join ', '); unexpected: $($unexpected -join ', ')."
        }

        foreach ($relative in @($expected.Keys | Sort-Object)) {
            $sourceFile = $expected[$relative]
            $archiveFile = $actual[$relative]
            if ([int64]$sourceFile.Length -ne [int64]$archiveFile.Length) {
                throw "Portable archive round-trip changed file size: $relative"
            }
            $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceFile.FullName).Hash
            $archiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archiveFile.FullName).Hash
            if ($sourceHash -ne $archiveHash) {
                throw "Portable archive round-trip changed file content: $relative"
            }
        }
    }
    finally {
        if (Test-Path -LiteralPath $verificationFull) {
            Remove-Item -LiteralPath $verificationFull -Recurse -Force
        }
    }
}

Set-Location $repo
if (-not $SkipBuild) {
    Write-Step "Installing locked dependencies and building backend + WebGUI"
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed." }
}

if (-not $DesktopRuntimeRoot) {
    $DesktopRuntimeRoot = Join-Path $env:TEMP ("rabiroute-desktop-runtime-" + [guid]::NewGuid().ToString("N"))
}

function Copy-RequiredPortableRuntimeFiles {
    foreach ($relative in $requiredPortableRuntimeFiles) {
        $source = Join-Path $repo ($relative -replace "/", "\")
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "Required portable runtime file is missing: $relative"
        }
        $destination = Join-Path $payload ($relative -replace "/", "\")
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination -Force
        if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
            throw "Required portable runtime file was not copied: $relative"
        }
    }
}
$desktopRuntime = [System.IO.Path]::GetFullPath($DesktopRuntimeRoot)
Assert-LocalDirectory $desktopRuntime

if (-not $HostRuntimeRoot) {
    $HostRuntimeRoot = Join-Path $env:LOCALAPPDATA ("RabiRoute\build\release-host-" + [guid]::NewGuid().ToString("N"))
}
$hostRuntime = [System.IO.Path]::GetFullPath($HostRuntimeRoot)
Assert-LocalDirectory $hostRuntime

if (-not $SkipDesktopBuild) {
    Write-Step "Building the modular RabiRoute Desktop host runtime"
    & (Join-Path $repo "scripts\build-desktop-runtime.ps1") -OutputRoot $desktopRuntime
    if ($LASTEXITCODE -ne 0) { throw "Desktop build failed." }
}

Write-Step "Building the unique Windows application Host"
& (Join-Path $repo "scripts\build-windows-host.ps1") -OutputRoot $hostRuntime
if ($LASTEXITCODE -ne 0) { throw "Windows Host build failed." }

if ($IncludeSpeech -and -not $SkipBuild) {
    Write-Step "Building the RabiSpeech Windows process host"
    & (Join-Path $repo "plugin-adapters\rabi-speech\scripts\build-windows-host.ps1")
    if ($LASTEXITCODE -ne 0) { throw "RabiSpeech Windows host build failed." }
} elseif (-not $IncludeSpeech) {
    Write-Step "Skipping optional RabiSpeech runtime; use -IncludeSpeech to add it"
}

$required = @(
    "dist\manager.js",
    "ribiwebgui\dist\index.html",
    "desktop-runtime\main.py",
    "desktop-runtime\python\python.exe",
    "RabiRouteHost.exe",
    "RabiRouteHost.Core.dll"
)
$speechHostRelative = "plugin-adapters\rabi-speech\runtime\RabiSpeech.exe"
if ($IncludeSpeech) { $required += $speechHostRelative }
foreach ($relative in $required) {
    $requiredPath = if ($relative -eq "RabiRouteHost.exe") {
        Join-Path $hostRuntime $relative
    } elseif ($relative -eq "RabiRouteHost.Core.dll") {
        Join-Path $hostRuntime ("version\" + $relative)
    } elseif ($relative.StartsWith("desktop-runtime\")) {
        Join-Path $desktopRuntime ($relative.Substring("desktop-runtime\".Length))
    } else {
        Join-Path $repo $relative
    }
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required build output is missing: $relative"
    }
}

Write-Step "Creating a privacy-safe runtime payload"
if (Test-Path -LiteralPath $OutputRoot) { Remove-Item -LiteralPath $OutputRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $payload | Out-Null

foreach ($relative in @("dist", "ribiwebgui\dist")) {
    $destination = Join-Path $payload $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath (Join-Path $repo $relative) -Destination $destination -Recurse -Force
}

# Compiled test files are useful in CI but are not runtime assets.
Get-ChildItem -LiteralPath (Join-Path $payload "dist") -Recurse -File -Filter "*.test.js" |
    Remove-Item -Force

$versionLogBaseName = -join @(
    [char]0x7248,
    [char]0x672C,
    [char]0x66F4,
    [char]0x65B0,
    [char]0x65E5,
    [char]0x5FD7
)
foreach ($relative in @(
    "package.json",
    "package-lock.json",
    "LICENSE",
    "README.md",
    "README_zh.md",
    ($versionLogBaseName + ".md"),
    ($versionLogBaseName + "_en.md")
)) {
    Copy-Item -LiteralPath (Join-Path $repo $relative) -Destination (Join-Path $payload $relative) -Force
}

Copy-Item -LiteralPath $desktopRuntime -Destination (Join-Path $payload "desktop-runtime") -Recurse -Force
$hostVersionRoot = Join-Path $hostRuntime "version"
$canonicalManifestName = "release-manifest.json"
foreach ($hostVersionEntry in Get-ChildItem -LiteralPath $hostVersionRoot -Force) {
    # The Host runtime has its own narrow self-test manifest. It must never
    # become the identity manifest for the complete Windows release payload.
    if ($hostVersionEntry.Name -eq $canonicalManifestName) { continue }
    Copy-Item -LiteralPath $hostVersionEntry.FullName -Destination (Join-Path $payload $hostVersionEntry.Name) -Recurse -Force
}

foreach ($tree in @(
    "assets",
    "docs",
    "examples\data",
    "apps\rabi-agent",
    "plugin-adapters",
    "plugins\contracts\plugin-sdk",
    "scripts"
)) {
    Copy-TrackedTree $tree
}

foreach ($relative in @(
    "scripts\compile-hot-patch.mjs",
    "scripts\compile-hot-patch-worker.mjs",
    "scripts\lib\source-patch-dependencies.mjs",
    "scripts\build-source-patches.mjs",
    "scripts\lib\hot-patch-compiler.mjs",
    "source-patches\modules.json",
    "docs\source-hot-patches.md",
    "docs\source-hot-patches_en.md",
    "skills\source-hot-patch-development\SKILL.md"
)) {
    $source = Join-Path $repo $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required hot patch release file is missing: $relative" }
    $destination = Join-Path $payload $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Force
}

Copy-RequiredPortableRuntimeFiles
foreach ($relative in @("apps\rabi-agent\runtime", "apps\rabi-agent\dist\agent-hooks", "skills\rabi-knowledge-search")) {
    $source = Join-Path $repo $relative
    if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Instance Agent runtime was not built: $relative" }
    $destination = Join-Path $payload $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
}

if ($IncludeSpeech) {
    $speechHostDestination = Join-Path $payload $speechHostRelative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $speechHostDestination) | Out-Null
    Copy-Item -LiteralPath (Join-Path $repo $speechHostRelative) -Destination $speechHostDestination -Force
}

Write-Step "Installing production-only npm dependencies into the payload"
& npm.cmd ci --omit=dev --ignore-scripts --prefix $payload
if ($LASTEXITCODE -ne 0) { throw "Production npm install failed." }

# npm installs local file: dependencies as directory junctions. A release payload
# must remain self-contained after it leaves the build tree, so materialize the
# SDK package and reject every remaining reparse point before archiving.
$pluginSdkSource = Join-Path $payload "plugins\contracts\plugin-sdk"
$pluginSdkInstall = Join-Path $payload "node_modules\@rabiroute\plugin-sdk"
if (-not (Test-Path -LiteralPath $pluginSdkSource -PathType Container)) {
    throw "The packaged plugin SDK source is missing: $pluginSdkSource"
}
if (Test-Path -LiteralPath $pluginSdkInstall) {
    Remove-PayloadEntry $pluginSdkInstall
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pluginSdkInstall) | Out-Null
Copy-Item -LiteralPath $pluginSdkSource -Destination $pluginSdkInstall -Recurse -Force

$payloadReparsePoints = Get-ChildItem -LiteralPath $payload -Recurse -Force | Where-Object {
    ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
}
if ($payloadReparsePoints) {
    throw "Release payload contains non-portable reparse points: $($payloadReparsePoints.FullName -join ', ')"
}

Write-Step "Embedding Node.js $NodeVersion x64"
$nodeArchive = Join-Path $env:TEMP "node-v$NodeVersion-win-x64.zip"
$nodeExtract = Join-Path $env:TEMP "rabiroute-node-$NodeVersion"
if (Test-Path -LiteralPath $nodeExtract) { Remove-Item -LiteralPath $nodeExtract -Recurse -Force }
if (-not (Test-Path -LiteralPath $nodeArchive)) {
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" -OutFile $nodeArchive
}
Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract -Force
Copy-Item -LiteralPath (Join-Path $nodeExtract "node-v$NodeVersion-win-x64\node.exe") -Destination (Join-Path $payload "node.exe") -Force

$retiredLifecyclePayloadPaths = @(
    "RabiRoute-Desktop.exe",
    "RabiRoute-Tray.exe",
    "RabiRoute-Tray.new.exe",
    "Start-RabiRoute-Tray.bat",
    "Start-RabiRoute-Health-Watchdog.bat",
    "Start-RabiRoute-MessageAdapter-Watchdog.bat",
    "scripts\Install-RabiRoute-HealthWatchdogTask.ps1",
    "scripts\watch-message-adapters.ps1",
    "scripts\watch-rabiroute-desktop-lifecycle.ps1",
    "scripts\watch-rabiroute-health-hidden.vbs",
    "scripts\watch-rabiroute-health.ps1"
)
$retiredLifecyclePayload = @($retiredLifecyclePayloadPaths | Where-Object {
    Test-Path -LiteralPath (Join-Path $payload $_) -PathType Leaf
})
if ($retiredLifecyclePayload.Count -gt 0) {
    throw "Release payload contains retired lifecycle entries: $($retiredLifecyclePayload -join ', ')"
}

$forbiddenFiles = Get-ChildItem -LiteralPath $payload -Recurse -Force -File | Where-Object {
    $payloadRelative = $_.FullName.Substring($payload.Length).TrimStart("\", "/")
    $payloadRelative -match '(?i)^(data|logs|recordings|transcripts)([\\/]|$)' -or
    ($_.Name -match '^\.env($|\.)' -and $_.Name -ne '.env.example') -or
    $_.Name -match '(?i)(token|cookie|secret).*\.json$'
}
if ($forbiddenFiles) {
    throw "Private/runtime files entered the payload: $($forbiddenFiles.FullName -join ', ')"
}

$rg = Get-Command rg.exe -ErrorAction SilentlyContinue
if ($rg) {
    $firstPartyRoots = @(
        (Join-Path $payload "dist"),
        (Join-Path $payload "ribiwebgui\dist"),
        (Join-Path $payload "docs"),
        (Join-Path $payload "examples"),
        (Join-Path $payload "plugin-adapters"),
        (Join-Path $payload "scripts"),
        (Join-Path $payload "desktop-runtime")
    ) | Where-Object { Test-Path -LiteralPath $_ }
    $leaks = & $rg.Source -a -l -F $repo @firstPartyRoots 2>$null
    if ($LASTEXITCODE -eq 0 -and $leaks) {
        throw "Build-machine path found in release payload: $($leaks -join ', ')"
    }
}

Write-Step "Creating the canonical release manifest"
$releaseManifestPath = Join-Path $payload $canonicalManifestName
if (Test-Path -LiteralPath $releaseManifestPath) {
    throw "A scoped runtime manifest entered the release payload before canonical manifest creation: $releaseManifestPath"
}
& node.exe (Join-Path $repo "scripts\create-windows-release-manifest.mjs") --payload $payload --version $Version
if ($LASTEXITCODE -ne 0) {
    throw "Release manifest creation failed."
}
$releaseManifest = Get-Content -LiteralPath $releaseManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $releaseManifest.releaseId -or -not $releaseManifest.payloadSha256) {
    throw "Release manifest did not publish a release identity."
}
if ([string]$releaseManifest.packageVersion -ne [string]$Version) {
    throw "Release manifest packageVersion $($releaseManifest.packageVersion) does not match $Version."
}
if ([string]$releaseManifest.appId -ne "io.rabiroute.windows") {
    throw "Release manifest appId $($releaseManifest.appId) is not io.rabiroute.windows."
}

$manifestPaths = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase)
foreach ($entry in @($releaseManifest.files)) {
    $releasePath = [string]$entry.path
    if (-not $releasePath -or -not $manifestPaths.Add($releasePath)) {
        throw "Release manifest contains an empty or duplicate file path: $releasePath"
    }
}
$payloadPaths = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase)
foreach ($payloadFile in Get-ChildItem -LiteralPath $payload -Recurse -File -Force) {
    if ($payloadFile.FullName -eq $releaseManifestPath) { continue }
    $releasePath = $payloadFile.FullName.Substring($payload.Length + 1).Replace("\", "/")
    [void]$payloadPaths.Add($releasePath)
}
$missingManifestPaths = @($payloadPaths | Where-Object { -not $manifestPaths.Contains($_) })
$unexpectedManifestPaths = @($manifestPaths | Where-Object { -not $payloadPaths.Contains($_) })
if ($manifestPaths.Count -ne $payloadPaths.Count -or $missingManifestPaths.Count -gt 0 -or $unexpectedManifestPaths.Count -gt 0) {
    throw "Canonical release manifest does not cover the complete payload. Missing: $($missingManifestPaths -join ', '); unexpected: $($unexpectedManifestPaths -join ', ')."
}
foreach ($requiredManifestPath in @(
    "RabiRouteHost.Core.dll",
    "node.exe",
    "dist/manager.js",
    "ribiwebgui/dist/index.html",
    "desktop-runtime/main.py",
    "desktop-runtime/python/python.exe"
)) {
    if (-not $manifestPaths.Contains($requiredManifestPath)) {
        throw "Canonical release manifest is missing required runtime file: $requiredManifestPath"
    }
}

Write-Step "Constructing the versioned portable distribution"
New-Item -ItemType Directory -Force -Path (Join-Path $distribution "versions") | Out-Null
$distributionVersion = Join-Path $distribution ("versions\" + [string]$releaseManifest.releaseId)
[IO.Directory]::Move($payload, $distributionVersion)
Copy-Item -LiteralPath (Join-Path $hostRuntime "RabiRouteHost.exe") -Destination (Join-Path $distribution "RabiRouteHost.exe") -Force
$pointer = [ordered]@{
    schemaVersion = 1
    appId = "io.rabiroute.windows"
    releaseId = [string]$releaseManifest.releaseId
    versionPath = "versions/$([string]$releaseManifest.releaseId)"
    payloadSha256 = [string]$releaseManifest.payloadSha256
}
[IO.File]::WriteAllText(
    (Join-Path $distribution "current.json"),
    (($pointer | ConvertTo-Json -Depth 4) + "`n"),
    [Text.UTF8Encoding]::new($false))

$distributionReparsePoints = Get-ChildItem -LiteralPath $distribution -Recurse -Force | Where-Object {
    ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
}
if ($distributionReparsePoints) {
    throw "Portable distribution contains non-portable reparse points: $($distributionReparsePoints.FullName -join ', ')"
}
if (-not $SkipSmokeTest) {
    Write-Step "Smoke testing bootstrap -> current.json -> immutable Core"
    $smokeProcess = Start-Process -FilePath (Join-Path $distribution "RabiRouteHost.exe") -ArgumentList "--self-test" -WorkingDirectory $distribution -Wait -PassThru
    if ($smokeProcess.ExitCode -ne 0) { throw "Versioned distribution self-test failed with exit code $($smokeProcess.ExitCode)." }
}

$portableName = "RabiRoute-$Version-windows-x64-portable.zip"
$portablePath = Join-Path $OutputRoot $portableName
Write-Step "Creating $portableName"
New-PortableArchive -SourceRoot $distribution -DestinationPath $portablePath
Write-Step "Verifying the portable archive round-trip"
Assert-PortableArchiveRoundTrip -SourceRoot $distribution -ArchivePath $portablePath

$installerPath = $null
if (-not $SkipInstaller) {
    $iscc = Resolve-Iscc
    if (-not $iscc) { throw "Inno Setup 6 (ISCC.exe) was not found." }
    $installerBase = "RabiRoute-$Version-windows-x64-setup"
    Write-Step "Compiling $installerBase.exe"
    & $iscc "/DAppVersion=$Version" "/DPortableZip=$portablePath" "/DReleaseId=$([string]$releaseManifest.releaseId)" "/DOutputDir=$OutputRoot" "/DOutputBaseFilename=$installerBase" (Join-Path $repo "installer\RabiRoute.iss")
    if ($LASTEXITCODE -ne 0) { throw "Inno Setup compilation failed." }
    $installerPath = Join-Path $OutputRoot "$installerBase.exe"
    if (-not (Test-Path -LiteralPath $installerPath)) { throw "Installer output was not found: $installerPath" }
}

$artifacts = @($portablePath)
if ($installerPath) { $artifacts += $installerPath }
$checksumPath = Join-Path $OutputRoot "SHA256SUMS.txt"
$checksumLines = foreach ($artifact in $artifacts) {
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifact).Hash.ToLowerInvariant()
    "$hash  $(Split-Path -Leaf $artifact)"
}
[System.IO.File]::WriteAllLines($checksumPath, $checksumLines, [System.Text.UTF8Encoding]::new($false))

Write-Step "Release artifacts are ready in $OutputRoot"
Get-Item -LiteralPath ($artifacts + $checksumPath) | Select-Object Name, Length, FullName
