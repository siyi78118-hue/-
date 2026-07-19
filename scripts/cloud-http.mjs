import { spawnSync as defaultSpawnSync } from 'node:child_process';

const POWERSHELL_REQUEST = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$headers = @{}
$contentType = 'application/json'
foreach ($property in $request.headers.PSObject.Properties) {
  if ($property.Name -ieq 'content-type') {
    $contentType = [string]$property.Value
  } else {
    $headers[$property.Name] = [string]$property.Value
  }
}
$parameters = @{
  Uri = [string]$request.url
  Method = [string]$request.method
  Headers = $headers
  TimeoutSec = [int]$request.timeoutSec
}
if ($null -ne $request.body) {
  $parameters.Body = [string]$request.body
  $parameters.ContentType = $contentType
}
try {
  $response = Invoke-RestMethod @parameters
  $response | ConvertTo-Json -Depth 20 -Compress
} catch {
  $status = 0
  if ($null -ne $_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
  [Console]::Error.WriteLine("Cloud HTTP request failed ($status)")
  exit 1
}
`;

export async function requestCloudJson(url, options = {}, dependencies = {}) {
  const platform = dependencies.platform || process.platform;
  const timeoutMs = Number(options.timeoutMs || 30_000);
  const method = String(options.method || 'GET').toUpperCase();
  const headers = options.headers || {};
  const body = options.body === undefined ? null : JSON.stringify(options.body);

  if (platform === 'win32') {
    const spawnSync = dependencies.spawnSync || defaultSpawnSync;
    const encoded = Buffer.from(POWERSHELL_REQUEST, 'utf16le').toString('base64');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], {
      input: JSON.stringify({ url, method, headers, body, timeoutSec: Math.ceil(timeoutMs / 1000) }),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });
    if (result.status !== 0) throw new Error('Cloud HTTP request failed through the Windows system network stack');
    return JSON.parse(String(result.stdout || '{}'));
  }

  const fetchImpl = dependencies.fetchImpl || fetch;
  const response = await fetchImpl(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Cloud HTTP request failed (${response.status})`);
  return responseBody;
}
