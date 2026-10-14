# girllm installer: pure helpers (no side effects), dot-sourced by install.ps1
# and unit-tested by tests.ps1.
#
# Compatibility: Windows PowerShell 5.1 (the one every Windows ships) and
# PowerShell 7. So: no null-coalescing, no ternary, no pipeline chains, and
# ASCII only (5.1 reads a script without a BOM in the ANSI code page).

Set-StrictMode -Version 3.0

# ---------------------------------------------------------------------------
# Pinned downloads. Update them together with docs/installation.md.
# ---------------------------------------------------------------------------

# ComfyUI portable for Windows, from the official releases (Comfy-Org/ComfyUI).
# The SHA-256 values are the release's own published digests.
$Script:ComfyRelease = 'v0.39.0'
$Script:ComfyBuilds = @{
  # CUDA 13.0 / Python 3.13: RTX 20 series and newer (compute capability 7.5+).
  'nvidia'       = @{
    File   = 'ComfyUI_windows_portable_nvidia.7z'
    Sha256 = '3dca347842ed1c6c833105fafb1669284685a3e54df41578d5f94bcc898ae039'
    Bytes  = 2003629308
  }
  # CUDA 12.6 / Python 3.12: GTX 10 series and older.
  'nvidia_cu126' = @{
    File   = 'ComfyUI_windows_portable_nvidia_cu126.7z'
    Sha256 = 'c42e7d5f6a5e931f6551dcf102d739a55c5f4a4df921f748e1de9de9f648d6a2'
    Bytes  = 1895335518
  }
}

function Get-ComfyDownloadUrl([string]$Build) {
  $file = $Script:ComfyBuilds[$Build].File
  return "https://github.com/Comfy-Org/ComfyUI/releases/download/$($Script:ComfyRelease)/$file"
}

# Chat models offered (docs/models.md). Sizes in GB, for the summary.
$Script:ChatModels = @(
  @{ Id = 'mistral-nemo:12b-instruct-2407-q4_K_M'; Label = 'Mistral Nemo 12B (recommended: good French, general purpose)'; Gb = 7.5 }
  @{ Id = 'hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:IQ4_XS'; Label = 'Mag-Mell R1 12B (roleplay fine-tune, more personality)'; Gb = 6.7 }
  @{ Id = 'hf.co/bartowski/Rocinante-12B-v1.1-GGUF:IQ4_XS'; Label = 'Rocinante 12B v1.1 (roleplay fine-tune)'; Gb = 6.7 }
)
$Script:EmbeddingModel = 'paraphrase-multilingual'

# Approximate download sizes (GB) of each optional part, for the summary.
$Script:Sizes = @{
  Embedding  = 0.6
  ComfyUI    = 2.0   # download; about 6 GB once extracted
  Faces      = 3.4   # IP-Adapter + face detector (npm run setup:images)
  Klein      = 12.5  # FLUX.2 [klein] 4B
  Anime      = 6.9   # Animagine XL 4.0
  Juggernaut = 7.1   # Juggernaut XI
  Voice      = 9.2   # Qwen3-TTS (~9 GB) + Whisper (~0.2 GB)
}

# Reply languages her voice supports (Qwen3-TTS), with the Whisper code of the
# language you speak.
$Script:Languages = [ordered]@{
  'French'     = 'fr'
  'English'    = 'en'
  'German'     = 'de'
  'Spanish'    = 'es'
  'Italian'    = 'it'
  'Portuguese' = 'pt'
  'Russian'    = 'ru'
  'Japanese'   = 'ja'
  'Korean'     = 'ko'
  'Chinese'    = 'zh'
}

# Minimum Node.js version (package.json "engines").
$Script:MinNode = [version]'22.13.0'

# ---------------------------------------------------------------------------
# .env editing. Node's parser (process.loadEnvFile) expands escapes inside
# double quotes ("C:\new" would contain a newline) and cuts unquoted values at
# '#'. Values that need quoting are therefore written in single quotes, which
# Node keeps verbatim; a value containing a single quote or a newline is
# refused rather than written wrongly.
# ---------------------------------------------------------------------------

function ConvertTo-EnvValue([string]$Value) {
  if ($null -eq $Value) { return '' }
  if ($Value -match "[`r`n]") { throw 'A .env value cannot contain a line break.' }
  if ($Value -match "'") { throw "A .env value cannot contain a single quote ('): $Value" }
  if ($Value -match '^[A-Za-z0-9_.:/\-+@,]*$') { return $Value }
  return "'$Value'"
}

# Lines of a .env file with KEY set to Value: the first active "KEY=" line is
# replaced (commented examples like "# KEY=..." are left alone), otherwise the
# line is appended. Returns a new array.
function Set-EnvLine([string[]]$Lines, [string]$Key, [string]$Value) {
  if ($Key -notmatch '^[A-Z][A-Z0-9_]*$') { throw "Invalid .env key: $Key" }
  $entry = "$Key=$(ConvertTo-EnvValue $Value)"
  $result = New-Object System.Collections.Generic.List[string]
  $done = $false
  foreach ($line in $Lines) {
    if (-not $done -and $line -match "^\s*$Key\s*=") {
      $result.Add($entry)
      $done = $true
    } else {
      $result.Add($line)
    }
  }
  if (-not $done) { $result.Add($entry) }
  return , $result.ToArray()
}

# Value of KEY in .env lines ('' when absent or empty), without its quotes.
function Get-EnvLine([string[]]$Lines, [string]$Key) {
  foreach ($line in $Lines) {
    if ($line -match "^\s*$Key\s*=\s*(.*)$") {
      $raw = $Matches[1].Trim()
      if ($raw -match "^'(.*)'$" -or $raw -match '^"(.*)"$') { return $Matches[1] }
      return ($raw -replace '\s+#.*$', '')
    }
  }
  return ''
}

# ---------------------------------------------------------------------------
# Hardware
# ---------------------------------------------------------------------------

# One line of:
#   nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv,noheader,nounits
# e.g. "NVIDIA GeForce RTX 3070, 8192, 581.57, 8.6". compute_cap may be
# missing on old drivers ("[N/A]"): then ComputeCap is $null.
function ConvertFrom-NvidiaSmiLine([string]$Line) {
  $parts = $Line -split ',' | ForEach-Object { $_.Trim() }
  if ($parts.Count -lt 3) { throw "Unexpected nvidia-smi output: $Line" }
  $cap = $null
  if ($parts.Count -ge 4 -and $parts[3] -match '^\d+(\.\d+)?$') { $cap = [double]$parts[3] }
  $driverMajor = 0
  if ($parts[2] -match '^(\d+)') { $driverMajor = [int]$Matches[1] }
  return [pscustomobject]@{
    Name        = $parts[0]
    VramMb      = [int]($parts[1] -replace '[^\d]', '')
    Driver      = $parts[2]
    DriverMajor = $driverMajor
    ComputeCap  = $cap
  }
}

# Which ComfyUI portable build fits this GPU. Returns @{ Build; Warning; Error }:
#   - compute capability below 7.5 (GTX 10 series and older): the CUDA 12.6 build;
#   - otherwise the CUDA 13.0 build, which needs driver 580 or newer. With an
#     older driver: RTX 50 series (compute 12.x, CUDA 12.8+ only) must update the
#     driver; older RTX cards fall back to the CUDA 12.6 build.
function Select-ComfyBuild($Gpu) {
  $cap = $Gpu.ComputeCap
  if ($null -ne $cap -and $cap -lt 7.5) {
    return @{ Build = 'nvidia_cu126'; Warning = $null; Error = $null }
  }
  if ($Gpu.DriverMajor -ge 580) {
    return @{ Build = 'nvidia'; Warning = $null; Error = $null }
  }
  if ($null -ne $cap -and $cap -ge 12) {
    return @{
      Build   = $null
      Warning = $null
      Error   = "Your NVIDIA driver ($($Gpu.Driver)) is too old for this GPU: install the latest Game Ready or Studio driver from nvidia.com, then run the installer again."
    }
  }
  return @{
    Build   = 'nvidia_cu126'
    Warning = "NVIDIA driver $($Gpu.Driver) is older than 580: using the CUDA 12.6 build of ComfyUI. Updating the driver is recommended."
    Error   = $null
  }
}

# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------

# "v24.11.0" -> $true when at least $Script:MinNode.
function Test-NodeVersion([string]$Text) {
  if ($Text -notmatch '^v?(\d+)\.(\d+)\.(\d+)') { return $false }
  $v = [version]"$($Matches[1]).$($Matches[2]).$($Matches[3])"
  return $v -ge $Script:MinNode
}

# Whisper language code for a reply language ('' when unknown: auto-detect).
function Get-SttLanguage([string]$Language) {
  if ($Script:Languages.Contains($Language)) { return $Script:Languages[$Language] }
  return ''
}

# A name for the story: 1-64 characters, no quote or line break (.env-safe).
function Test-UserName([string]$Name) {
  return ($Name.Length -ge 1 -and $Name.Length -le 64 -and $Name -notmatch "['`"`r`n]")
}

# Total download (GB) of the chosen parts, rounded.
function Get-DownloadGb($Choice) {
  $gb = $Choice.ChatModelGb + $Script:Sizes.Embedding
  # ComfyUI serves both her photos and her voice.
  if ($Choice.InstallComfy) { $gb += $Script:Sizes.ComfyUI }
  if ($Choice.Photos) {
    $gb += $Script:Sizes.Faces
    if ($Choice.Klein) { $gb += $Script:Sizes.Klein }
    if ($Choice.Anime) { $gb += $Script:Sizes.Anime }
    if ($Choice.Juggernaut) { $gb += $Script:Sizes.Juggernaut }
  }
  if ($Choice.Voice) { $gb += $Script:Sizes.Voice }
  return [math]::Round($gb, 1)
}

# Flags for "npm run setup:images -- ..." from the choices.
function Get-SetupImagesArgs($Choice) {
  $flags = @()
  if ($Choice.Klein) { $flags += '--flux2-klein' }
  if ($Choice.Anime) { $flags += '--anime' }
  if ($Choice.Juggernaut) { $flags += '--juggernaut' }
  return , $flags
}

# Does this folder hold a ComfyUI install (portable folder or ComfyUI itself)?
# Same rule as comfyRoot() in scripts/launcherLib.ts.
function Test-ComfyDir([string]$Dir) {
  if (-not $Dir) { return $false }
  return ((Test-Path -LiteralPath (Join-Path (Join-Path $Dir 'ComfyUI') 'main.py')) -or
    (Test-Path -LiteralPath (Join-Path $Dir 'main.py')))
}
