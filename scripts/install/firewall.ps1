# Adds the firewall rule of girllm's phone listener: inbound TCP on that one
# port, from your local network only, on Private networks only. Started by
# install.ps1 with one administrator prompt (only an administrator can add a
# firewall rule); does nothing if the rule already exists.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File firewall.ps1 -Port 3211
#
# Kept as a separate, readable script on purpose: no encoded or hidden
# command (antivirus heuristics flag those, and you can read what runs).
# ASCII only, Windows PowerShell 5.1 compatible (see lib.ps1).

param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1024, 65535)]
  [int]$Port
)

$ErrorActionPreference = 'Stop'
# Same name as $FirewallRule in install.ps1 and in docs/mobile-app.md.
$name = 'girllm phone (local network)'

if (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue) {
  Write-Host "Firewall rule '$name' already present."
  exit 0
}
New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort $Port `
  -Profile Private -RemoteAddress LocalSubnet -Action Allow | Out-Null
Write-Host "Firewall rule '$name' added (TCP $Port, local subnet, Private networks)."
