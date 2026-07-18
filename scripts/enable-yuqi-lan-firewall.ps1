$ErrorActionPreference = 'Stop'
$ruleName = 'AL 虞栖局域网桥接'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw '请以管理员权限运行此脚本。'
}

$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if (-not $existing) {
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort 17891 -Profile Private -RemoteAddress LocalSubnet `
    -Description '仅允许当前私有局域网内的手机访问虞栖 AL；应用层仍需 HMAC 配对签名。' | Out-Null
}

$rule = Get-NetFirewallRule -DisplayName $ruleName
$port = $rule | Get-NetFirewallPortFilter
$address = $rule | Get-NetFirewallAddressFilter
if ($rule.Profile -notmatch 'Private' -or $port.Protocol -ne 'TCP' -or $port.LocalPort -ne '17891' -or $address.RemoteAddress -notcontains 'LocalSubnet') {
  throw '现有虞栖防火墙规则不符合私网最小权限要求，请由维护窗口检查。'
}
Write-Output '虞栖局域网防火墙规则已启用：Private / LocalSubnet / TCP 17891。'
