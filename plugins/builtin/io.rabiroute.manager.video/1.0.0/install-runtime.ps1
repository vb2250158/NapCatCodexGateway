[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ComponentRoot)
$ErrorActionPreference = 'Stop'
$ComponentRoot = [IO.Path]::GetFullPath($ComponentRoot)
$drive = [IO.Path]::GetPathRoot($ComponentRoot).TrimEnd('\')
if ($ComponentRoot.StartsWith('\\') -or (Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$drive'").DriveType -ne 3) { throw 'A local fixed disk is required.' }
foreach ($ancestor in @($ComponentRoot, (Split-Path $ComponentRoot -Parent))) {
  if ((Get-Item -LiteralPath $ancestor).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked component directories are not supported.' }
}
if (Test-Path -LiteralPath (Join-Path $ComponentRoot 'runtime.json')) { throw 'Runtime already configured; preserve the existing installation.' }
$stage = Join-Path $ComponentRoot ('setup-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
$pythonRoot = Join-Path $stage 'python'
$comfy = Join-Path $stage 'ComfyUI'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
# Fixed official sources. No URL, command, or package name is accepted from the API.
Invoke-WebRequest 'https://www.python.org/ftp/python/3.10.11/python-3.10.11-embed-amd64.zip' -OutFile (Join-Path $stage 'python.zip') -UseBasicParsing
Expand-Archive -LiteralPath (Join-Path $stage 'python.zip') -DestinationPath $pythonRoot
$pth = Join-Path $pythonRoot 'python310._pth'
$moduleRoot = Join-Path $ComponentRoot 'ComfyUI'
[IO.File]::WriteAllText($pth, "python310.zip`n.`nLib\site-packages`n$moduleRoot`nimport site`n", [Text.UTF8Encoding]::new($false))
$python = Join-Path $pythonRoot 'python.exe'
Invoke-WebRequest 'https://bootstrap.pypa.io/get-pip.py' -OutFile (Join-Path $stage 'get-pip.py') -UseBasicParsing
& $python (Join-Path $stage 'get-pip.py') --no-warn-script-location
if ($LASTEXITCODE -ne 0) { throw 'pip installation failed.' }
Invoke-WebRequest 'https://github.com/Comfy-Org/ComfyUI/archive/14b05228cef127ce529bc0c08660770d4af3e9a8.zip' -OutFile (Join-Path $stage 'comfy.zip') -UseBasicParsing
Expand-Archive -LiteralPath (Join-Path $stage 'comfy.zip') -DestinationPath (Join-Path $stage 'source')
$source = Join-Path $stage 'source\ComfyUI-14b05228cef127ce529bc0c08660770d4af3e9a8'
Copy-Item -LiteralPath $source -Destination $comfy -Recurse
& $python -m pip install torch==2.13.0 torchvision torchaudio --index-url https://download.pytorch.org/whl/cu130 --no-warn-script-location
if ($LASTEXITCODE -ne 0) { throw 'CUDA runtime installation failed.' }
& $python -m pip install -r (Join-Path $comfy 'requirements.txt') --no-warn-script-location
if ($LASTEXITCODE -ne 0) { throw 'Video dependencies installation failed.' }
& $python -c 'import torch, aiohttp, safetensors; assert torch.cuda.is_available(), "CUDA is unavailable"'
if ($LASTEXITCODE -ne 0) { throw 'CUDA verification failed. Check NVIDIA drivers and the installation log.' }
# Keep the staged Python path stable. Publish Comfy only after all dependency checks pass.
$target = Join-Path $ComponentRoot 'ComfyUI'
if (Test-Path -LiteralPath $target) { throw 'ComfyUI already exists; it will not be overwritten.' }
$prefix = $ComponentRoot.TrimEnd('\') + '\'
if (-not ([IO.Path]::GetFullPath($comfy).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) -or -not ([IO.Path]::GetFullPath($target).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase))) { throw 'Publication escaped the component directory.' }
Move-Item -LiteralPath $comfy -Destination $target
$settings = @{schemaVersion=1; pythonExecutable=$python} | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $ComponentRoot 'runtime.json'), $settings, [Text.UTF8Encoding]::new($false))
Write-Output 'Video runtime installed. Models are downloaded separately.'
