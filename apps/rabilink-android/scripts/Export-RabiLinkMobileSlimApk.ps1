[CmdletBinding()]
param(
    [string]$ProjectDir,
    [string]$JavaHome = $env:JAVA_HOME,
    [string]$OutputPath,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

if (-not $ProjectDir) {
    $ProjectDir = Split-Path -Parent $PSScriptRoot
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $FilePath $($Arguments -join ' ')"
    }
}

function Resolve-AndroidSdk {
    param([string]$Root)

    foreach ($candidate in @($env:ANDROID_SDK_ROOT, $env:ANDROID_HOME)) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Container)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    $propertiesPath = Join-Path $Root "local.properties"
    if (Test-Path -LiteralPath $propertiesPath -PathType Leaf) {
        $sdkLine = Get-Content -LiteralPath $propertiesPath |
            Where-Object { $_ -match "^\s*sdk\.dir\s*=" } |
            Select-Object -First 1
        if ($sdkLine) {
            $sdkValue = ($sdkLine -replace "^\s*sdk\.dir\s*=\s*", "") -replace "\\\\", "\"
            $candidate = if ([IO.Path]::IsPathRooted($sdkValue)) {
                $sdkValue
            } else {
                Join-Path $Root $sdkValue
            }
            if (Test-Path -LiteralPath $candidate -PathType Container) {
                return (Resolve-Path -LiteralPath $candidate).Path
            }
        }
    }

    throw "Android SDK not found. Set ANDROID_SDK_ROOT/ANDROID_HOME or configure local.properties."
}

function Resolve-BuildTool {
    param(
        [string]$SdkRoot,
        [string]$Name
    )

    $tool = Get-ChildItem -LiteralPath (Join-Path $SdkRoot "build-tools") -Directory |
        Sort-Object {
            try { [version]$_.Name } catch { [version]"0.0" }
        } -Descending |
        ForEach-Object {
            $candidate = Join-Path $_.FullName $Name
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                Get-Item -LiteralPath $candidate
            }
        } |
        Select-Object -First 1
    if (-not $tool) {
        throw "Android build tool not found: $Name"
    }
    return $tool.FullName
}

$ProjectDir = (Resolve-Path -LiteralPath $ProjectDir).Path
$sdkRoot = Resolve-AndroidSdk -Root $ProjectDir
$aapt = Resolve-BuildTool -SdkRoot $sdkRoot -Name "aapt.exe"
$zipalign = Resolve-BuildTool -SdkRoot $sdkRoot -Name "zipalign.exe"
$apksigner = Resolve-BuildTool -SdkRoot $sdkRoot -Name "apksigner.bat"
$apkanalyzer = Get-ChildItem -LiteralPath (Join-Path $sdkRoot "cmdline-tools") -Directory |
    Sort-Object Name -Descending |
    ForEach-Object {
        $candidate = Join-Path $_.FullName "bin\apkanalyzer.bat"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            Get-Item -LiteralPath $candidate
        }
    } |
    Select-Object -First 1
$gradle = Join-Path $ProjectDir "gradlew.bat"

if (-not $JavaHome -or -not (Test-Path -LiteralPath (Join-Path $JavaHome "bin\java.exe") -PathType Leaf)) {
    throw "JDK 17 was not found. Pass -JavaHome <JDK 17> or set JAVA_HOME."
}
if (-not $apkanalyzer) {
    throw "apkanalyzer.bat was not found under the configured Android SDK cmdline-tools."
}
$JavaHome = (Resolve-Path -LiteralPath $JavaHome).Path

if (-not $SkipBuild) {
    $previousJavaHome = $env:JAVA_HOME
    try {
        $env:JAVA_HOME = $JavaHome
        Invoke-Checked $gradle ":app:testDebugUnitTest" ":app:assembleDebug" "-PmobileSlim" "--rerun-tasks" "--no-daemon"
    } finally {
        $env:JAVA_HOME = $previousJavaHome
    }
}

$sourceApk = Join-Path $ProjectDir "app\build\outputs\apk\debug\app-debug.apk"
if (-not (Test-Path -LiteralPath $sourceApk -PathType Leaf)) {
    throw "Slim APK was not produced: $sourceApk"
}

$badging = (& $aapt dump badging $sourceApk) -join "`n"
if ($LASTEXITCODE -ne 0) {
    throw "aapt could not read the APK manifest."
}
if ($badging -notmatch "package: name='com\.rabi\.link' versionCode='(\d+)' versionName='([^']+)'") {
    throw "Unexpected package metadata; expected com.rabi.link with version fields."
}
$versionCode = $Matches[1]
$versionName = $Matches[2]
if ($badging -notmatch "sdkVersion:'31'") {
    throw "Unexpected minSdk; the mobile package must remain minSdk 31."
}
if ($badging -notmatch "targetSdkVersion:'34'") {
    throw "Unexpected targetSdk; the mobile package must remain targetSdk 34."
}
if ($badging -notmatch "native-code: 'arm64-v8a'") {
    throw "The mobile package must contain only the arm64-v8a ABI."
}

$entries = (& $aapt list $sourceApk) -join "`n"
if ($LASTEXITCODE -ne 0) {
    throw "aapt could not list APK entries."
}
$forbiddenEntry = $entries -split "`n" |
    Where-Object {
        $_ -match "(?i)(^|/)(models?|weights?)(/|$)" -or
        $_ -match "(?i)(whisper|sensevoice|firered|qwen|workdir_asr|\.onnx$)"
    } |
    Select-Object -First 1
if ($forbiddenEntry) {
    throw "The slim package unexpectedly contains a model asset: $forbiddenEntry"
}

$sourceSize = (Get-Item -LiteralPath $sourceApk).Length
if ($sourceSize -gt 40MB) {
    throw "The slim package is unexpectedly large ($sourceSize bytes); model assets may have leaked into it."
}

$previousJavaHome = $env:JAVA_HOME
try {
    $env:JAVA_HOME = $JavaHome
    $residentServiceDex = (& $apkanalyzer.FullName dex code `
        --class "com.rabi.link.RabiConversationService" $sourceApk) -join "`n"
    if ($LASTEXITCODE -ne 0) {
        throw "apkanalyzer could not inspect the resident conversation service."
    }
    $rokidProbeEntryDex = (& $apkanalyzer.FullName dex code `
        --class "com.rabi.link.modules.rokid.RokidProbeActivity" $sourceApk) -join "`n"
    if ($LASTEXITCODE -ne 0) {
        throw "apkanalyzer could not inspect the dependency-safe Rokid diagnostics entry."
    }
} finally {
    $env:JAVA_HOME = $previousJavaHome
}
if ($residentServiceDex -match "Lcom/rokid/security/" -or
    $residentServiceDex -match "Lcom/rabi/link/modules/rokid/RokidNativeVoiceBridge;") {
    throw "The resident conversation service directly links an optional Rokid SDK class."
}
if ($residentServiceDex -notmatch "RabiGlassBridgeFactory" -or
    $residentServiceDex -notmatch "RabiGlassBridge") {
    throw "The resident conversation service is missing the dependency-safe optional bridge boundary."
}
if ($rokidProbeEntryDex -match "Lcom/rokid/security/" -or
    $rokidProbeEntryDex -match "Lcom/rokid/ai/" -or
    $rokidProbeEntryDex -match "Lcom/rabi/link/modules/rokid/RokidNativeVoiceBridge;" -or
    $rokidProbeEntryDex -match "Lcom/rabi/link/modules/rokid/RokidAiSdkVoiceBridge;") {
    throw "The mobile-safe Rokid diagnostics entry directly links an optional SDK class."
}

if (-not $OutputPath) {
    $OutputPath = Join-Path (Split-Path -Parent $sourceApk) "RabiLink-Android-$versionName-verified.apk"
} elseif (-not [IO.Path]::IsPathRooted($OutputPath)) {
    $OutputPath = Join-Path $ProjectDir $OutputPath
}
$outputDir = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$alignedApk = Join-Path $outputDir ".$([IO.Path]::GetFileNameWithoutExtension($OutputPath)).aligned.apk"

$debugKeystore = Join-Path $env:USERPROFILE ".android\debug.keystore"
if (-not (Test-Path -LiteralPath $debugKeystore -PathType Leaf)) {
    throw "Android debug keystore not found: $debugKeystore"
}

try {
    Invoke-Checked $zipalign "-f" "-p" "4" $sourceApk $alignedApk
    Invoke-Checked $apksigner "sign" `
        "--ks" $debugKeystore `
        "--ks-key-alias" "androiddebugkey" `
        "--ks-pass" "pass:android" `
        "--key-pass" "pass:android" `
        "--min-sdk-version" "24" `
        "--v1-signing-enabled" "false" `
        "--v2-signing-enabled" "true" `
        "--v3-signing-enabled" "true" `
        "--v4-signing-enabled" "false" `
        "--out" $OutputPath `
        $alignedApk

    $verification = (& $apksigner verify --min-sdk-version 24 --verbose --print-certs $OutputPath) -join "`n"
    if ($LASTEXITCODE -ne 0) {
        throw "apksigner rejected the exported APK."
    }
    if ($verification -notmatch "Verified using v2 scheme .*: true" -or
        $verification -notmatch "Verified using v3 scheme .*: true") {
        throw "The exported APK does not contain both v2 and v3 signatures."
    }
    Invoke-Checked $zipalign "-c" "-p" "4" $OutputPath
} finally {
    if (Test-Path -LiteralPath $alignedApk -PathType Leaf) {
        Remove-Item -LiteralPath $alignedApk -Force
    }
}

$outputItem = Get-Item -LiteralPath $OutputPath
$sha256 = (Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash
[pscustomobject]@{
    ok = $true
    packageName = "com.rabi.link"
    versionName = $versionName
    versionCode = [int]$versionCode
    abi = "arm64-v8a"
    modelAssets = "absent"
    optionalSdkIsolation = @{
        residentService = "passed"
        diagnosticsEntry = "passed"
    }
    signatures = @("v2", "v3")
    sizeBytes = $outputItem.Length
    sha256 = $sha256
    outputPath = $outputItem.FullName
} | ConvertTo-Json -Depth 4
