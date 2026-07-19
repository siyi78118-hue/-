$ErrorActionPreference = 'Stop'
$ruleName = 'AL Yuqi LAN Bridge'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script as Administrator.'
}

$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if (-not $existing) {
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort 17891 -Profile Private -RemoteAddress LocalSubnet `
    -Description 'Allows Yuqi AL only from the current private local subnet; application-layer HMAC pairing is still required.' | Out-Null
}

$rule = Get-NetFirewallRule -DisplayName $ruleName
$port = $rule | Get-NetFirewallPortFilter
$address = $rule | Get-NetFirewallAddressFilter
if ($rule.Profile -notmatch 'Private' -or $port.Protocol -ne 'TCP' -or $port.LocalPort -ne '17891' -or $address.RemoteAddress -notcontains 'LocalSubnet') {
  throw 'The existing Yuqi firewall rule does not match the least-privilege private-LAN policy.'
}
Write-Output 'Yuqi LAN firewall enabled: Private / LocalSubnet / TCP 17891.'
