[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$InstallRoot,
  [Parameter(Mandatory=$true)][string]$ComfySourceRoot,
  [Parameter(Mandatory=$true)][string]$PythonExecutable,
  [Parameter(Mandatory=$true)][string]$ModelSourceRoot
)
$ErrorActionPreference = 'Stop'
function Assert-Local([string]$Value) {
  $resolved = [IO.Path]::GetFullPath($Value)
  $drive = [IO.Path]::GetPathRoot($resolved).TrimEnd('\')
  $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$drive'"
  if ($resolved.StartsWith('\\') -or -not $disk -or $disk.DriveType -ne 3) { throw 'Video runtime destinations must use a local fixed disk.' }
  return $resolved
}
$InstallRoot = Assert-Local $InstallRoot
$PythonExecutable = Assert-Local $PythonExecutable
if ([IO.Path]::GetFileName($PythonExecutable) -ne 'python.exe') { throw 'PythonExecutable must select python.exe.' }
$component = Join-Path $InstallRoot 'components\video'
if (Test-Path -LiteralPath $component) { throw 'Video component already exists. Preserve the existing component and use a new staging installation.' }
$stage = Join-Path $InstallRoot ('components\video-stage-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$comfy = Join-Path $stage 'ComfyUI'
New-Item -ItemType Directory -Path $comfy | Out-Null
$archive = Join-Path $stage 'source.tar'
# The caller explicitly selects the source checkout. Only tracked source enters the runtime.
$safeSource = $ComfySourceRoot.Replace('\', '/')
if ($safeSource.StartsWith('//')) { $safeSource = '%(prefix)/' + $safeSource }
& git -c "safe.directory=$safeSource" -C $ComfySourceRoot archive --format=tar "--output=$archive" HEAD
if ($LASTEXITCODE -ne 0) { throw 'ComfyUI source export failed.' }
& tar -xf $archive -C $comfy
if ($LASTEXITCODE -ne 0) { throw 'ComfyUI source extraction failed.' }
& $PythonExecutable -c 'import torch, aiohttp, safetensors; assert torch.cuda.is_available(), "CUDA is unavailable"; print(torch.__version__)'
if ($LASTEXITCODE -ne 0) { throw 'The selected Python environment is missing video dependencies or CUDA.' }
$catalog = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$model = $catalog.models[0]
$files = @(
  @('diffusion_models', $model.files.diffusion), @('text_encoders', $model.files.textEncoder),
  @('vae', $model.files.vae), @('loras', $model.files.lora)
)
foreach ($pair in $files) {
  $source = Join-Path (Join-Path $ModelSourceRoot $pair[0]) $pair[1]
  $field = @($model.files.PSObject.Properties | Where-Object { $_.Value -eq $pair[1] })[0].Name
  if ((Get-Item -LiteralPath $source).Length -ne [long]$model.expectedBytes.$field) { throw "Model size mismatch: $($pair[1])" }
  $destination = Join-Path (Join-Path $comfy 'models') $pair[0]
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  Write-Host "Copying $($pair[1])"
  Copy-Item -LiteralPath $source -Destination (Join-Path $destination $pair[1])
  if ((Get-Item -LiteralPath (Join-Path $destination $pair[1])).Length -ne [long]$model.expectedBytes.$field) { throw "Copied model size mismatch: $($pair[1])" }
  & $PythonExecutable -c 'import sys; from safetensors import safe_open; f=safe_open(sys.argv[1],framework="pt",device="cpu"); assert len(f.keys())>0' (Join-Path $destination $pair[1])
  if ($LASTEXITCODE -ne 0) { throw "Invalid model: $($pair[1])" }
}
$runtime = @{ schemaVersion = 1; pythonExecutable = $PythonExecutable } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $stage 'runtime.json'), $runtime, [Text.UTF8Encoding]::new($false))
$componentPrefix = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'components')).TrimEnd('\') + '\'
if (-not ([IO.Path]::GetFullPath($stage).StartsWith($componentPrefix, [StringComparison]::OrdinalIgnoreCase)) -or -not ([IO.Path]::GetFullPath($component).StartsWith($componentPrefix, [StringComparison]::OrdinalIgnoreCase))) { throw 'Video publication path escaped components.' }
Move-Item -LiteralPath $stage -Destination $component
Write-Host 'Video component installed. Start it through the Rabi video plugin; inference is not yet verified.'
