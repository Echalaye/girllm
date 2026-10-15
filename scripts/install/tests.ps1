# Tests of the Windows installer's helpers (scripts/install/lib.ps1), plus
# checks on the installer scripts themselves. No Windows needed:
#   pwsh -NoProfile -File scripts/install/tests.ps1      (npm run test:installer)
# Exits with code 1 when a test fails. ASCII only (see lib.ps1).

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$Script:Failures = 0
$Script:Count = 0

function Assert-Equal($Expected, $Actual, [string]$Name) {
  $Script:Count++
  $e = ($Expected | Out-String).Trim()
  $a = ($Actual | Out-String).Trim()
  if ($e -ne $a) {
    $Script:Failures++
    Write-Host "FAIL $Name`n  expected: $e`n  actual:   $a" -ForegroundColor Red
  }
}

function Assert-Throws([scriptblock]$Block, [string]$Name) {
  $Script:Count++
  try {
    & $Block | Out-Null
    $Script:Failures++
    Write-Host "FAIL $Name (no error)" -ForegroundColor Red
  } catch {
    # expected
  }
}

# --- The installer scripts themselves ------------------------------------------

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$scripts = @(
  (Join-Path $PSScriptRoot 'lib.ps1'),
  (Join-Path $PSScriptRoot 'install.ps1'),
  (Join-Path $PSScriptRoot 'firewall.ps1'),
  (Join-Path $PSScriptRoot 'tests.ps1')
)
foreach ($file in $scripts) {
  $name = Split-Path $file -Leaf
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors) | Out-Null
  Assert-Equal 0 $errors.Count "$name parses"
  foreach ($err in $errors) { Write-Host "  $($err.Extent.StartLineNumber): $($err.Message)" }
  # Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.
  $bytes = [System.IO.File]::ReadAllBytes($file)
  $nonAscii = @($bytes | Where-Object { $_ -gt 127 }).Count
  Assert-Equal 0 $nonAscii "$name is ASCII only"
}
# PowerShell 7-only syntax that would break on Windows PowerShell 5.1.
$installText = Get-Content -Raw (Join-Path $PSScriptRoot 'install.ps1')
$libText = Get-Content -Raw (Join-Path $PSScriptRoot 'lib.ps1')
foreach ($text in @($installText, $libText)) {
  $code = ($text -split "`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
  Assert-Equal $false ($code -match '\?\?') 'no ?? operator'
  Assert-Equal $false ($code -match '(?m)\)\s*&&|\)\s*\|\|') 'no && / || pipeline chains'
}
# Patterns antivirus heuristics treat as malware (Avast flagged an earlier
# version as IDP.Generic): no encoded command, no hidden window, no
# download-and-run. Everything the installer runs stays readable.
$firewallText = Get-Content -Raw (Join-Path $PSScriptRoot 'firewall.ps1')
foreach ($text in @($installText, $libText, $firewallText)) {
  $code = ($text -split "`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
  Assert-Equal $false ($code -match '(?i)-EncodedCommand|FromBase64String|ToBase64String') 'no encoded command'
  Assert-Equal $false ($code -match '(?i)WindowStyle\s+Hidden') 'no hidden window'
  Assert-Equal $false ($code -match '(?i)Invoke-Expression|\biex\b|DownloadString') 'no download-and-run'
}
$ruleInstall = [regex]::Match($installText, '\$FirewallRule = ''([^'']+)''').Groups[1].Value
$ruleScript = [regex]::Match($firewallText, '\$name = ''([^'']+)''').Groups[1].Value
Assert-Equal 'girllm phone (local network)' $ruleInstall 'firewall rule name found in install.ps1'
Assert-Equal $ruleInstall $ruleScript 'same firewall rule name in install.ps1 and firewall.ps1'
$bat = [System.IO.File]::ReadAllText((Join-Path $root 'install.bat'))
Assert-Equal $true ($bat -match 'scripts\\install\\install\.ps1') 'install.bat runs install.ps1'

# --- .env values ---------------------------------------------------------------

Assert-Equal 'Etienne' (ConvertTo-EnvValue 'Etienne') 'plain value'
Assert-Equal 'mistral-nemo:12b-instruct-2407-q4_K_M' (ConvertTo-EnvValue 'mistral-nemo:12b-instruct-2407-q4_K_M') 'model id'
Assert-Equal "'Jean Pierre'" (ConvertTo-EnvValue 'Jean Pierre') 'space is quoted'
Assert-Equal "'C:\Users\me\AI\new folder'" (ConvertTo-EnvValue 'C:\Users\me\AI\new folder') 'path in single quotes (no escapes)'
Assert-Equal "'a # b'" (ConvertTo-EnvValue 'a # b') '# is quoted'
Assert-Throws { ConvertTo-EnvValue "O'Neil" } 'single quote refused'
Assert-Throws { ConvertTo-EnvValue "a`nb" } 'line break refused'

$lines = @('# COMFYUI_DIR=C:\example', 'HOST=127.0.0.1', 'COMFYUI_DIR=', 'USER_NAME=User')
$out = Set-EnvLine $lines 'COMFYUI_DIR' 'C:\AI\ComfyUI_windows_portable'
Assert-Equal '# COMFYUI_DIR=C:\example' $out[0] 'commented example kept'
Assert-Equal "COMFYUI_DIR='C:\AI\ComfyUI_windows_portable'" $out[2] 'active line replaced'
Assert-Equal 4 $out.Count 'no line added'
$out = Set-EnvLine $lines 'LAN_ENABLED' 'true'
Assert-Equal 'LAN_ENABLED=true' $out[-1] 'missing key appended'
Assert-Equal 'C:\AI\ComfyUI_windows_portable' (Get-EnvLine (Set-EnvLine $lines 'COMFYUI_DIR' 'C:\AI\ComfyUI_windows_portable') 'COMFYUI_DIR') 'read back without quotes'
Assert-Equal '' (Get-EnvLine $lines 'COMFYUI_DIR') 'empty value'
Assert-Equal '' (Get-EnvLine $lines 'MISSING') 'absent key'
Assert-Equal 'x' (Get-EnvLine @('A=x # note') 'A') 'inline comment dropped'
Assert-Throws { Set-EnvLine $lines 'bad key' 'x' } 'invalid key refused'

# The .env the installer writes, read back by Node's own parser (the one girllm
# uses), from the real .env.example.
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $example = Get-Content -LiteralPath (Join-Path $root '.env.example')
  $written = $example
  $values = [ordered]@{
    USER_NAME   = 'Jean Pierre'
    COMFYUI_DIR = 'C:\Users\me\AI\new stuff\ComfyUI_windows_portable'
    LLM_MODEL   = 'hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:IQ4_XS'
    LAN_ENABLED = 'true'
  }
  foreach ($key in $values.Keys) { $written = Set-EnvLine $written $key $values[$key] }
  $file = Join-Path ([System.IO.Path]::GetTempPath()) ("girllm-env-" + [guid]::NewGuid())
  [System.IO.File]::WriteAllText($file, (($written -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding $false))
  $json = & $node.Source -e "const {parseEnv}=require('node:util');process.stdout.write(JSON.stringify(parseEnv(require('fs').readFileSync(process.argv[1],'utf8'))))" $file
  Remove-Item -LiteralPath $file
  $parsed = $json | ConvertFrom-Json
  foreach ($key in $values.Keys) { Assert-Equal $values[$key] $parsed.$key "node reads $key back" }
  Assert-Equal $example.Count $written.Count '.env.example keeps its lines (keys replaced in place)'
} else {
  Write-Host 'node not found: .env round-trip test skipped' -ForegroundColor Yellow
}

# --- GPU and ComfyUI build -----------------------------------------------------

$gpu = ConvertFrom-NvidiaSmiLine 'NVIDIA GeForce RTX 3070, 8192, 581.57, 8.6'
Assert-Equal 'NVIDIA GeForce RTX 3070' $gpu.Name 'gpu name'
Assert-Equal 8192 $gpu.VramMb 'vram'
Assert-Equal 581 $gpu.DriverMajor 'driver major'
Assert-Equal 8.6 $gpu.ComputeCap 'compute capability'
Assert-Equal 'nvidia' (Select-ComfyBuild $gpu).Build 'RTX 3070, recent driver: CUDA 13 build'

$old = ConvertFrom-NvidiaSmiLine 'NVIDIA GeForce RTX 3070, 8192, 566.36, 8.6'
$pick = Select-ComfyBuild $old
Assert-Equal 'nvidia_cu126' $pick.Build 'RTX 3070, old driver: CUDA 12.6 build'
Assert-Equal $true ($null -ne $pick.Warning) 'old driver warns'

$blackwell = ConvertFrom-NvidiaSmiLine 'NVIDIA GeForce RTX 5060, 8151, 576.02, 12.0'
$pick = Select-ComfyBuild $blackwell
Assert-Equal $true ($null -eq $pick.Build -and $null -ne $pick.Error) 'RTX 50, old driver: must update'
Assert-Equal 'nvidia' (Select-ComfyBuild (ConvertFrom-NvidiaSmiLine 'NVIDIA GeForce RTX 5060, 8151, 581.57, 12.0')).Build 'RTX 50, recent driver'

$pascal = ConvertFrom-NvidiaSmiLine 'NVIDIA GeForce GTX 1080, 8192, 581.57, 6.1'
Assert-Equal 'nvidia_cu126' (Select-ComfyBuild $pascal).Build 'GTX 10 series: CUDA 12.6 build'
$noCap = ConvertFrom-NvidiaSmiLine 'NVIDIA GeForce RTX 2070, 8192, 581.57, [N/A]'
Assert-Equal $null $noCap.ComputeCap 'unknown compute capability'
Assert-Equal 'nvidia' (Select-ComfyBuild $noCap).Build 'unknown capability, recent driver'
Assert-Throws { ConvertFrom-NvidiaSmiLine 'garbage' } 'unexpected nvidia-smi output'

Assert-Equal 'https://github.com/Comfy-Org/ComfyUI/releases/download/v0.39.0/ComfyUI_windows_portable_nvidia.7z' (Get-ComfyDownloadUrl 'nvidia') 'pinned ComfyUI URL'
foreach ($build in $Script:ComfyBuilds.Keys) {
  Assert-Equal $true ($Script:ComfyBuilds[$build].Sha256 -match '^[0-9a-f]{64}$') "$build has a SHA-256"
}

# --- Misc ----------------------------------------------------------------------

Assert-Equal $true (Test-NodeVersion 'v24.11.0') 'node 24'
Assert-Equal $true (Test-NodeVersion 'v22.13.0') 'node 22.13'
Assert-Equal $false (Test-NodeVersion 'v22.12.1') 'node 22.12'
Assert-Equal $false (Test-NodeVersion 'v20.18.0') 'node 20'
Assert-Equal $false (Test-NodeVersion 'not a version') 'no version'

Assert-Equal 'fr' (Get-SttLanguage 'French') 'french'
Assert-Equal 'ja' (Get-SttLanguage 'Japanese') 'japanese'
Assert-Equal '' (Get-SttLanguage 'Klingon') 'unknown language: auto-detect'

Assert-Equal $true (Test-UserName 'Etienne') 'name ok'
Assert-Equal $true (Test-UserName 'Jean Pierre') 'name with a space'
Assert-Equal $false (Test-UserName '') 'empty name'
Assert-Equal $false (Test-UserName "O'Neil") 'name with a quote'
Assert-Equal $false (Test-UserName ('x' * 65)) 'name too long'

$choice = [pscustomobject]@{
  ChatModelGb = 7.5; Photos = $true; InstallComfy = $true; Klein = $true; Anime = $false; Juggernaut = $false; Voice = $true
}
Assert-Equal 35.2 (Get-DownloadGb $choice) 'download size'
Assert-Equal '--flux2-klein' ((Get-SetupImagesArgs $choice) -join ' ') 'setup:images flags'
$choice.Anime = $true
$choice.Juggernaut = $true
Assert-Equal '--flux2-klein --anime --juggernaut' ((Get-SetupImagesArgs $choice) -join ' ') 'all image flags'
$choice.Photos = $false
$choice.Voice = $false
$choice.InstallComfy = $false
Assert-Equal 8.1 (Get-DownloadGb $choice) 'chat only'

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("girllm-test-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path (Join-Path $tmp 'ComfyUI') | Out-Null
Set-Content -Path (Join-Path (Join-Path $tmp 'ComfyUI') 'main.py') -Value ''
Assert-Equal $true (Test-ComfyDir $tmp) 'portable folder recognised'
Assert-Equal $true (Test-ComfyDir (Join-Path $tmp 'ComfyUI')) 'ComfyUI folder recognised'
Assert-Equal $false (Test-ComfyDir ([System.IO.Path]::GetTempPath())) 'other folder refused'
Assert-Equal $false (Test-ComfyDir '') 'empty path refused'
Remove-Item -Recurse -Force $tmp

# -------------------------------------------------------------------------------

if ($Script:Failures -gt 0) {
  Write-Host "$($Script:Failures) of $($Script:Count) installer tests failed." -ForegroundColor Red
  exit 1
}
Write-Host "All $($Script:Count) installer tests passed." -ForegroundColor Green
