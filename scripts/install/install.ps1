# girllm installer for Windows. Run it with install.bat (double-click), from
# the girllm folder. It asks a few questions, then installs what is missing:
#
#   1. checks       Windows, winget, the NVIDIA GPU and its driver, free disk space
#   2. questions    your name, language, chat model, photos, voice, phone app
#   3. tools        Node.js LTS, Git, Ollama (and 7-Zip for ComfyUI) with winget
#   4. Ollama       OLLAMA_FLASH_ATTENTION / OLLAMA_KV_CACHE_TYPE, then the models
#   5. ComfyUI      the portable build, pinned release, SHA-256 checked
#   6. girllm       npm ci, .env filled in (an existing .env is backed up first)
#   7. models       npm run setup:images / setup:voice (pinned and checked too)
#   8. phone app    LAN_ENABLED + a narrow firewall rule (one administrator prompt)
#   9. shortcut     "girllm" on the desktop, pointing at start.bat
#
# Every step checks what is already there, so running it again completes or
# repairs an install without redoing the rest. Everything is logged to
# data\logs\install.log.
#
#   install.bat                       interactive
#   install.bat -Defaults             no questions: the recommended choices
#   install.bat -ComfyUIDir D:\ComfyUI_windows_portable   use an existing ComfyUI
#
# ASCII only and Windows PowerShell 5.1 compatible: see lib.ps1.

[CmdletBinding()]
param(
  # Answer every question with its default (recommended) choice.
  [switch]$Defaults,
  # An existing ComfyUI (portable folder) to use instead of installing one.
  [string]$ComfyUIDir = '',
  # Where a new ComfyUI is installed (the archive creates ComfyUI_windows_portable in it).
  [string]$ComfyUIParent = (Join-Path $env:USERPROFILE 'AI')
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$EnvFile = Join-Path $Root '.env'
$EnvExample = Join-Path $Root '.env.example'
$FirewallRule = 'girllm phone (local network)'

# ===========================================================================
# Output and questions
# ===========================================================================

function Write-Title([string]$Text) {
  Write-Host ''
  Write-Host "== $Text" -ForegroundColor Cyan
}
function Write-Ok([string]$Text) { Write-Host "  [ok] $Text" -ForegroundColor Green }
function Write-Info([string]$Text) { Write-Host "  $Text" }
function Write-Note([string]$Text) { Write-Host "  [!] $Text" -ForegroundColor Yellow }

function Read-YesNo([string]$Question, [bool]$Default) {
  if ($Defaults) { return $Default }
  $hint = 'y/N'
  if ($Default) { $hint = 'Y/n' }
  while ($true) {
    $answer = (Read-Host "  $Question [$hint]").Trim().ToLowerInvariant()
    if ($answer -eq '') { return $Default }
    if ($answer -in @('y', 'yes', 'o', 'oui')) { return $true }
    if ($answer -in @('n', 'no', 'non')) { return $false }
  }
}

function Read-Text([string]$Question, [string]$Default, [scriptblock]$Valid, [string]$Invalid) {
  if ($Defaults) { return $Default }
  while ($true) {
    $answer = (Read-Host "  $Question [$Default]").Trim()
    if ($answer -eq '') { $answer = $Default }
    if (& $Valid $answer) { return $answer }
    Write-Note $Invalid
  }
}

# Pick one of $Options (strings); returns its index.
function Read-Option([string]$Question, [string[]]$Options, [int]$Default = 0) {
  if ($Defaults) { return $Default }
  Write-Host "  $Question"
  for ($i = 0; $i -lt $Options.Count; $i++) { Write-Host "    $($i + 1). $($Options[$i])" }
  while ($true) {
    $answer = (Read-Host "  Number [$($Default + 1)]").Trim()
    if ($answer -eq '') { return $Default }
    $n = 0
    if ([int]::TryParse($answer, [ref]$n) -and $n -ge 1 -and $n -le $Options.Count) { return $n - 1 }
  }
}

# ===========================================================================
# System helpers
# ===========================================================================

# A command installed by winget a moment ago isn't on this session's PATH yet.
function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Find-Command([string]$Name, [string[]]$Fallbacks = @()) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  foreach ($path in $Fallbacks) { if (Test-Path -LiteralPath $path) { return $path } }
  return $null
}

# Run a native command; throw with $What when it fails.
function Invoke-Native([string]$Exe, [string[]]$Arguments, [string]$What) {
  & $Exe @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)." }
}

# Run a native command and capture its output, ignoring stderr. Windows
# PowerShell 5.1 turns redirected stderr lines into errors, which would stop
# the script under ErrorActionPreference=Stop: relax it for this call only.
function Invoke-Capture([string]$Exe, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $Exe @Arguments 2>$null
    return [pscustomobject]@{ Code = $LASTEXITCODE; Out = @($out) }
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Install-WingetPackage([string]$Id, [string]$Name) {
  Write-Info "Installing $Name with winget (Windows may ask for permission)..."
  & winget install --id $Id --exact --source winget --silent --accept-package-agreements --accept-source-agreements
  # A non-zero code can also mean "already installed": the caller checks the result.
  if ($LASTEXITCODE -ne 0) { Write-Note "winget returned code $LASTEXITCODE for $Name." }
  Update-SessionPath
}

function Get-FreeGb([string]$Path) {
  $qualifier = Split-Path -Qualifier ([System.IO.Path]::GetFullPath($Path))
  $drive = Get-PSDrive -Name $qualifier.TrimEnd(':') -ErrorAction SilentlyContinue
  if (-not $drive) { return $null }
  return [math]::Round($drive.Free / 1GB, 1)
}

function Test-Url([string]$Url) {
  try {
    Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 | Out-Null
    return $true
  } catch {
    return $false
  }
}

# ===========================================================================
# 1. Checks
# ===========================================================================

function Test-System {
  Write-Title '1/9 Checking this PC'
  if ([Environment]::OSVersion.Version.Build -lt 17763) {
    throw 'girllm needs Windows 10 (1809) or newer.'
  }
  Write-Ok "Windows $([Environment]::OSVersion.Version)"

  if (-not (Find-Command 'winget')) {
    throw ('winget (App Installer) is missing. Install "App Installer" from the Microsoft Store, ' +
      'then run install.bat again.')
  }
  Write-Ok 'winget'

  $smi = Find-Command 'nvidia-smi' @("$env:SystemRoot\System32\nvidia-smi.exe")
  if (-not $smi) {
    Write-Note 'No NVIDIA GPU found (nvidia-smi is missing). girllm needs one: chat would run on the CPU (very slowly), photos and her voice would not work.'
    if (-not (Read-YesNo 'Continue anyway?' $false)) { throw 'Stopped: no NVIDIA GPU.' }
    return $null
  }
  $query = Invoke-Capture $smi @('--query-gpu=name,memory.total,driver_version,compute_cap', '--format=csv,noheader,nounits')
  if ($query.Code -ne 0 -or -not $query.Out) {
    # Older drivers don't know compute_cap.
    $query = Invoke-Capture $smi @('--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits')
  }
  if ($query.Code -ne 0 -or -not $query.Out) { throw 'nvidia-smi could not read the GPU: update the NVIDIA driver.' }
  $gpu = ConvertFrom-NvidiaSmiLine ([string]$query.Out[0])
  Write-Ok "$($gpu.Name), $([math]::Round($gpu.VramMb / 1024)) GB of VRAM, driver $($gpu.Driver)"
  if ($gpu.VramMb -lt 7800) {
    Write-Note 'girllm is tuned for 8 GB of VRAM. With less, set CONTEXT_TOKENS=6144 and choose a smaller model (docs/models.md).'
  }
  return $gpu
}

# ===========================================================================
# 2. Questions
# ===========================================================================

function Read-Choices($Gpu) {
  Write-Title '2/9 A few questions (press Enter for the suggested answer)'
  $existingLines = @()
  if (Test-Path -LiteralPath $EnvFile) { $existingLines = Get-Content -LiteralPath $EnvFile }

  $defaultName = Get-EnvLine $existingLines 'USER_NAME'
  if (-not $defaultName -or $defaultName -eq 'User') { $defaultName = $env:USERNAME }
  if (-not (Test-UserName $defaultName)) { $defaultName = 'User' }
  $name = Read-Text 'Your name in the story' $defaultName { param($v) Test-UserName $v } `
    'Use 1 to 64 characters, without quotes.'

  $languages = @($Script:Languages.Keys)
  $language = $languages[(Read-Option 'Which language should she write and speak?' $languages 0)]

  $labels = @($Script:ChatModels | ForEach-Object { $_.Label })
  $model = $Script:ChatModels[(Read-Option 'Chat model (all fit in 8 GB; compare them later with npm run compare):' $labels 0)]

  $photos = Read-YesNo 'Photos: she sends pictures of herself (ComfyUI, ~15-25 GB)?' $true
  $klein = $false
  $anime = $false
  $juggernaut = $false
  if ($photos) {
    $klein = Read-YesNo '  Realistic characters with FLUX.2 [klein] 4B (best results, 12.5 GB)?' $true
    $anime = Read-YesNo '  Anime characters too (Animagine XL 4.0, 6.9 GB)?' $false
    $juggernaut = Read-YesNo '  Juggernaut XI, an extra realistic SDXL model (7.1 GB, licence CC BY-NC-ND 4.0: personal, non-commercial use only)?' $false
  }
  $voice = Read-YesNo 'Voice: talk to her, and hear her own voice (Whisper + Qwen3-TTS, ~9 GB)?' $true

  # ComfyUI serves both photos and her voice.
  $comfyDir = ''
  $installComfy = $false
  $comfyBuild = $null
  if ($photos -or $voice) {
    $known = $ComfyUIDir
    if (-not $known) { $known = Get-EnvLine $existingLines 'COMFYUI_DIR' }
    if (Test-ComfyDir $known) {
      $comfyDir = $known
      Write-Info "Using your ComfyUI: $comfyDir"
    } else {
      $suggested = Join-Path $ComfyUIParent 'ComfyUI_windows_portable'
      Write-Info 'ComfyUI makes her photos and her voice.'
      $answer = Read-Text 'Folder of an existing ComfyUI portable, or Enter to install one here' $suggested `
      { param($v) (Test-ComfyDir $v) -or (Test-NewComfyDir $v) } `
        'Give an existing ComfyUI (with ComfyUI\main.py), or a new, empty folder named ComfyUI_windows_portable.'
      $comfyDir = $answer
      $installComfy = -not (Test-ComfyDir $answer)
      if ($installComfy) {
        if (-not $Gpu) { throw 'ComfyUI needs an NVIDIA GPU: run the installer again without photos and voice.' }
        $pick = Select-ComfyBuild $Gpu
        if ($pick.Error) { throw $pick.Error }
        if ($pick.Warning) { Write-Note $pick.Warning }
        $comfyBuild = $pick.Build
      }
    }
  }

  $phone = Read-YesNo 'Phone app: allow paired phones on your Wi-Fi (you build the app later, docs/mobile-app.md)?' $false
  $shortcut = Read-YesNo 'Create a "girllm" shortcut on the desktop?' $true

  return [pscustomobject]@{
    Name         = $name
    Language     = $language
    ChatModel    = $model.Id
    ChatModelGb  = $model.Gb
    Photos       = $photos
    Klein        = $klein
    Anime        = $anime
    Juggernaut   = $juggernaut
    Voice        = $voice
    ComfyDir     = $comfyDir
    InstallComfy = $installComfy
    ComfyBuild   = $comfyBuild
    Phone        = $phone
    Shortcut     = $shortcut
  }
}

function Confirm-Plan($Choice) {
  $gb = Get-DownloadGb $Choice
  Write-Title 'Summary'
  Write-Info "Name: $($Choice.Name), language: $($Choice.Language)"
  Write-Info "Chat model: $($Choice.ChatModel)"
  if ($Choice.Photos) {
    $parts = @('IP-Adapter faces')
    if ($Choice.Klein) { $parts += 'FLUX.2 [klein]' }
    if ($Choice.Anime) { $parts += 'Animagine' }
    if ($Choice.Juggernaut) { $parts += 'Juggernaut XI' }
    Write-Info "Photos: $($parts -join ', ')"
  } else { Write-Info 'Photos: no' }
  Write-Info "Voice: $(if ($Choice.Voice) { 'yes' } else { 'no' })"
  if ($Choice.ComfyDir) {
    $how = 'existing'
    if ($Choice.InstallComfy) { $how = "new, ComfyUI $($Script:ComfyRelease) ($($Choice.ComfyBuild))" }
    Write-Info "ComfyUI: $($Choice.ComfyDir) ($how)"
  }
  Write-Info "Phone app: $(if ($Choice.Phone) { 'yes' } else { 'no' }), desktop shortcut: $(if ($Choice.Shortcut) { 'yes' } else { 'no' })"
  Write-Info "Downloads: about $gb GB at most (what is already installed is skipped)."

  # Models go to Ollama's folder (system drive by default) and ComfyUI's folder.
  $free = Get-FreeGb $env:USERPROFILE
  if ($null -ne $free) {
    Write-Info "Free space on $(Split-Path -Qualifier $env:USERPROFILE): $free GB"
    if ($free -lt ($gb + 10)) { Write-Note 'That may not be enough: leave about 10 GB more than the downloads.' }
  }
  if ($Choice.ComfyDir) {
    $freeComfy = Get-FreeGb $Choice.ComfyDir
    if ($null -ne $freeComfy -and (Split-Path -Qualifier $Choice.ComfyDir) -ne (Split-Path -Qualifier $env:USERPROFILE)) {
      Write-Info "Free space on $(Split-Path -Qualifier $Choice.ComfyDir) (ComfyUI): $freeComfy GB"
    }
  }
  if (-not (Read-YesNo 'Start the installation?' $true)) { throw 'Installation cancelled.' }
}

# ===========================================================================
# 3. Tools
# ===========================================================================

function Install-Tools($Choice) {
  Write-Title '3/9 Tools: Node.js, Git, Ollama'
  $node = Find-Command 'node' @("$env:ProgramFiles\nodejs\node.exe")
  $nodeOk = $false
  if ($node) { $nodeOk = Test-NodeVersion ([string](Invoke-Capture $node @('--version')).Out[0]) }
  if (-not $nodeOk) {
    Install-WingetPackage 'OpenJS.NodeJS.LTS' 'Node.js LTS'
    $node = Find-Command 'node' @("$env:ProgramFiles\nodejs\node.exe")
    if (-not $node -or -not (Test-NodeVersion ([string](Invoke-Capture $node @('--version')).Out[0]))) {
      throw "Node.js $($Script:MinNode) or newer is needed. Install the LTS from https://nodejs.org, then run install.bat again."
    }
  }
  Write-Ok "Node.js $((Invoke-Capture $node @('--version')).Out[0])"

  if (-not (Find-Command 'git')) {
    Install-WingetPackage 'Git.Git' 'Git'
    if (-not (Find-Command 'git' @("$env:ProgramFiles\Git\cmd\git.exe"))) { throw 'Git could not be installed.' }
  }
  Write-Ok 'Git'

  $ollamaPaths = @("$env:LOCALAPPDATA\Programs\Ollama\ollama.exe")
  if (-not (Find-Command 'ollama' $ollamaPaths)) {
    Install-WingetPackage 'Ollama.Ollama' 'Ollama'
    if (-not (Find-Command 'ollama' $ollamaPaths)) { throw 'Ollama could not be installed: get it from https://ollama.com.' }
  }
  Write-Ok 'Ollama'

  if ($Choice.InstallComfy -and -not (Find-SevenZip)) {
    Install-WingetPackage '7zip.7zip' '7-Zip (to extract ComfyUI)'
    if (-not (Find-SevenZip)) { throw '7-Zip could not be installed: get it from https://7-zip.org.' }
  }
}

# Where a new ComfyUI can go: the archive creates "ComfyUI_windows_portable",
# so the folder must have that name and be absent or empty.
function Test-NewComfyDir([string]$Dir) {
  if ((Split-Path -Leaf $Dir) -ne 'ComfyUI_windows_portable') { return $false }
  if (-not (Test-Path -LiteralPath $Dir)) { return $true }
  return -not (Get-ChildItem -LiteralPath $Dir -Force | Select-Object -First 1)
}

function Find-SevenZip {
  return Find-Command '7z' @("$env:ProgramFiles\7-Zip\7z.exe", "${env:ProgramFiles(x86)}\7-Zip\7z.exe")
}

# ===========================================================================
# 4. Ollama: settings and models
# ===========================================================================

function Install-OllamaModels($Choice) {
  Write-Title '4/9 Ollama: settings and models'
  $changed = $false
  $wanted = [ordered]@{ OLLAMA_FLASH_ATTENTION = '1'; OLLAMA_KV_CACHE_TYPE = 'q8_0' }
  foreach ($key in $wanted.Keys) {
    $current = [Environment]::GetEnvironmentVariable($key, 'User')
    if ($current -eq $wanted[$key]) {
      Write-Ok "$key=$current"
    } elseif ($current) {
      # The user chose another value on purpose: keep it.
      Write-Note "$key is already set to '$current' (recommended: $($wanted[$key])): left as is."
    } else {
      [Environment]::SetEnvironmentVariable($key, $wanted[$key], 'User')
      Write-Ok "$key=$($wanted[$key]) (user environment variable)"
      $changed = $true
    }
    # Processes started from here (Ollama below) see the value right away.
    $env:OLLAMA_FLASH_ATTENTION = [Environment]::GetEnvironmentVariable('OLLAMA_FLASH_ATTENTION', 'User')
    $env:OLLAMA_KV_CACHE_TYPE = [Environment]::GetEnvironmentVariable('OLLAMA_KV_CACHE_TYPE', 'User')
  }

  $ollama = Find-Command 'ollama' @("$env:LOCALAPPDATA\Programs\Ollama\ollama.exe")
  $api = 'http://127.0.0.1:11434/api/version'
  if ($changed -and (Test-Url $api)) {
    Write-Info 'Restarting Ollama so it uses these settings...'
    Get-Process -Name 'ollama app', 'ollama' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
  }
  if (-not (Test-Url $api)) {
    $app = "$env:LOCALAPPDATA\Programs\Ollama\ollama app.exe"
    if (Test-Path -LiteralPath $app) { Start-Process -FilePath $app }
    else { Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden }
    $deadline = (Get-Date).AddSeconds(60)
    while (-not (Test-Url $api)) {
      if ((Get-Date) -gt $deadline) { throw 'Ollama did not start. Start it from the Start menu, then run install.bat again.' }
      Start-Sleep -Seconds 2
    }
  }
  Write-Ok 'Ollama is running'

  foreach ($model in @($Choice.ChatModel, $Script:EmbeddingModel)) {
    Write-Info "ollama pull $model"
    Invoke-Native $ollama @('pull', $model) "Downloading $model"
    Write-Ok $model
  }
}

# ===========================================================================
# 5. ComfyUI
# ===========================================================================

function Install-ComfyUI($Choice) {
  Write-Title '5/9 ComfyUI'
  if (-not $Choice.ComfyDir) { Write-Info 'Not needed (no photos, no voice).'; return }
  if (-not $Choice.InstallComfy -or (Test-ComfyDir $Choice.ComfyDir)) {
    Write-Ok "ComfyUI: $($Choice.ComfyDir)"
    return
  }

  $build = $Script:ComfyBuilds[$Choice.ComfyBuild]
  $parent = Split-Path -Parent $Choice.ComfyDir
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $archive = Join-Path $parent $build.File
  $part = "$archive.part"

  if (-not (Test-Path -LiteralPath $archive)) {
    $have = 0
    if (Test-Path -LiteralPath $part) { $have = (Get-Item -LiteralPath $part).Length }
    if ($have -lt $build.Bytes) {
      Write-Info "Downloading ComfyUI $($Script:ComfyRelease) ($([math]::Round($build.Bytes / 1GB, 1)) GB, resumes if interrupted)..."
      # curl.exe ships with Windows 10 1803+: -C - resumes a partial download.
      Invoke-Native 'curl.exe' @('-L', '--fail', '--retry', '5', '--retry-delay', '5', '-C', '-', '-o', $part, (Get-ComfyDownloadUrl $Choice.ComfyBuild)) 'Downloading ComfyUI'
    }
    Write-Info 'Checking the download (SHA-256)...'
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $part).Hash.ToLowerInvariant()
    if ($hash -ne $build.Sha256) {
      Remove-Item -LiteralPath $part -Force
      throw "The ComfyUI download is corrupted or not the expected file (SHA-256 $hash). It was deleted: run install.bat again."
    }
    Move-Item -LiteralPath $part -Destination $archive
  }
  Write-Ok 'ComfyUI archive verified'

  Write-Info "Extracting into $parent (a few minutes)..."
  Invoke-Native (Find-SevenZip) @('x', $archive, "-o$parent", '-y', '-bso0', '-bsp1') 'Extracting ComfyUI'
  if (-not (Test-ComfyDir $Choice.ComfyDir)) {
    throw "ComfyUI was extracted but $($Choice.ComfyDir) doesn't contain it. Check $parent."
  }
  Remove-Item -LiteralPath $archive -Force
  Write-Ok "ComfyUI installed: $($Choice.ComfyDir)"
}

# ===========================================================================
# 6. girllm: dependencies and .env
# ===========================================================================

function Install-Girllm($Choice) {
  Write-Title '6/9 girllm: dependencies and settings (.env)'
  Push-Location $Root
  try {
    Invoke-Native 'npm.cmd' @('ci', '--no-audit', '--no-fund') 'npm ci'
  } finally {
    Pop-Location
  }
  Write-Ok 'Dependencies installed'

  if (Test-Path -LiteralPath $EnvFile) {
    $backup = "$EnvFile.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $EnvFile -Destination $backup
    $lines = Get-Content -LiteralPath $EnvFile
    Write-Ok "Existing .env kept and updated (backup: $(Split-Path -Leaf $backup))"
  } else {
    $lines = Get-Content -LiteralPath $EnvExample
    Write-Ok '.env created from .env.example'
  }

  $values = [ordered]@{
    USER_NAME      = $Choice.Name
    REPLY_LANGUAGE = $Choice.Language
    STT_LANGUAGE   = Get-SttLanguage $Choice.Language
    LLM_MODEL      = $Choice.ChatModel
    IMAGES_ENABLED = ([string]$Choice.Photos).ToLowerInvariant()
    VOICE_ENABLED  = ([string]$Choice.Voice).ToLowerInvariant()
    COMFYUI_DIR    = $Choice.ComfyDir
    LAN_ENABLED    = ([string]$Choice.Phone).ToLowerInvariant()
  }
  if ($Choice.Photos) {
    if ($Choice.Klein) {
      $values['REALISTIC_ENGINE'] = 'flux2-klein'
    } else {
      $values['REALISTIC_ENGINE'] = 'sdxl'
      if ($Choice.Juggernaut -and -not (Get-EnvLine $lines 'IMAGE_CHECKPOINT')) {
        $values['IMAGE_CHECKPOINT'] = 'Juggernaut-XI-byRunDiffusion.safetensors'
      }
    }
  }
  foreach ($key in $values.Keys) { $lines = Set-EnvLine $lines $key $values[$key] }
  # UTF-8 without BOM, LF line endings (like .env.example).
  [System.IO.File]::WriteAllText($EnvFile, (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding $false))
  Write-Ok '.env: your answers saved'
  if ($Choice.Photos -and -not $Choice.Klein -and -not (Get-EnvLine $lines 'IMAGE_CHECKPOINT')) {
    Write-Note 'Realistic photos need a model: FLUX.2 [klein] (run install.bat again) or an SDXL checkpoint in IMAGE_CHECKPOINT (docs/photos.md).'
  }
}

# ===========================================================================
# 7. Image and voice models
# ===========================================================================

function Install-ComfyModels($Choice) {
  Write-Title '7/9 Photo and voice models (pinned, checksum-verified)'
  Push-Location $Root
  try {
    if ($Choice.Photos) {
      $flags = Get-SetupImagesArgs $Choice
      Write-Info "npm run setup:images -- $($flags -join ' ')"
      Invoke-Native 'npm.cmd' (@('run', 'setup:images', '--') + $flags) 'npm run setup:images'
      Write-Ok 'Photo models'
    } else { Write-Info 'Photos: skipped.' }
    if ($Choice.Voice) {
      Write-Info 'npm run setup:voice'
      Invoke-Native 'npm.cmd' @('run', 'setup:voice') 'npm run setup:voice'
      Write-Ok 'Voice models'
    } else { Write-Info 'Voice: skipped.' }
  } finally {
    Pop-Location
  }
}

# ===========================================================================
# 8. Phone app
# ===========================================================================

function Enable-PhoneAccess($Choice) {
  Write-Title '8/9 Phone app'
  if (-not $Choice.Phone) { Write-Info 'Skipped (LAN_ENABLED=false).'; return }
  $port = Get-EnvLine (Get-Content -LiteralPath $EnvFile) 'LAN_PORT'
  if (-not $port) { $port = '3211' }

  if (Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue) {
    Write-Ok "Firewall rule '$FirewallRule' already present"
  } else {
    Write-Info 'Adding a firewall rule: this port only, your local network only, Private networks only.'
    Write-Info 'Windows asks for administrator permission once.'
    $command = "New-NetFirewallRule -DisplayName '$FirewallRule' -Direction Inbound -Protocol TCP " +
      "-LocalPort $port -Profile Private -RemoteAddress LocalSubnet -Action Allow | Out-Null"
    # -EncodedCommand: Start-Process doesn't quote arguments, so the command
    # goes as Base64 (UTF-16LE), the form powershell.exe expects.
    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($command))
    try {
      $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded)
      if ($p.ExitCode -ne 0) { throw "exit code $($p.ExitCode)" }
      Write-Ok "Firewall rule added (TCP $port, local subnet, Private networks)"
    } catch {
      Write-Note "The firewall rule was not added ($($_.Exception.Message)). See docs/mobile-app.md, step 1."
    }
  }

  $public = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Public' })
  foreach ($network in $public) {
    Write-Note "Your network '$($network.Name)' is marked Public in Windows: the phone can't connect through it."
    Write-Info '    If it is your home network: Settings > Network & internet > Wi-Fi (or Ethernet) > your network >'
    Write-Info '    Network profile type: Private.'
  }
  Write-Info 'Next: build the app and pair it (docs/mobile-app.md, steps 2 to 4).'
}

# ===========================================================================
# 9. Shortcut
# ===========================================================================

function New-DesktopShortcut($Choice) {
  Write-Title '9/9 Desktop shortcut'
  if (-not $Choice.Shortcut) { Write-Info 'Skipped.'; return }
  $desktop = [Environment]::GetFolderPath('Desktop')
  $link = Join-Path $desktop 'girllm.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($link)
  $shortcut.TargetPath = Join-Path $Root 'start.bat'
  $shortcut.WorkingDirectory = $Root
  $shortcut.Description = 'Start girllm (Ollama, ComfyUI and girllm, then the browser)'
  $shortcut.Save()
  Write-Ok "Shortcut: $link"
}

# ===========================================================================
# Main
# ===========================================================================

$logDir = Join-Path (Join-Path $Root 'data') 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$transcript = $false
try {
  Start-Transcript -Path (Join-Path $logDir 'install.log') -Append | Out-Null
  $transcript = $true
} catch {
  Write-Note "No log file ($($_.Exception.Message))."
}

$exitCode = 0
try {
  Write-Host 'girllm installer' -ForegroundColor Cyan
  Write-Host "Folder: $Root"
  if (-not (Test-Path -LiteralPath (Join-Path $Root 'package.json'))) {
    throw 'Run install.bat from the girllm folder (package.json not found).'
  }
  $gpu = Test-System
  $choice = Read-Choices $gpu
  Confirm-Plan $choice
  Install-Tools $choice
  Install-OllamaModels $choice
  Install-ComfyUI $choice
  Install-Girllm $choice
  Install-ComfyModels $choice
  Enable-PhoneAccess $choice
  New-DesktopShortcut $choice

  Write-Title 'Done'
  Write-Info 'Start girllm with the desktop shortcut or start.bat: it starts Ollama and ComfyUI, then opens'
  Write-Info 'http://127.0.0.1:3210 in your browser. Then create a character, or pick one and say hello.'
  Write-Info 'Change anything later in Settings (gear icon) or in .env (docs/configuration.md).'
  if (Read-YesNo 'Start girllm now?' $false) {
    Start-Process -FilePath (Join-Path $Root 'start.bat') -WorkingDirectory $Root
  }
} catch {
  $exitCode = 1
  Write-Host ''
  Write-Host "Installation stopped: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Fix the problem above, then run install.bat again: finished steps are skipped.'
  Write-Host "Log: $(Join-Path $logDir 'install.log')"
} finally {
  if ($transcript) { Stop-Transcript | Out-Null }
}
exit $exitCode
