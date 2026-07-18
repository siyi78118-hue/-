import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function privateLanHost(value) {
  const text = String(value || '').trim();
  if (text === '127.0.0.1') return true;
  const octets = text.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

export function renderNetworkSecurityConfig(hosts) {
  const allowed = [...new Set((hosts || []).map(String).filter(privateLanHost))];
  if (!allowed.includes('127.0.0.1')) allowed.push('127.0.0.1');
  if (!allowed.some(host => host !== '127.0.0.1')) throw new Error('At least one private LAN host is required');
  const domains = allowed.map(host => `            <domain includeSubdomains="false">${host}</domain>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<network-security-config>\n    <base-config cleartextTrafficPermitted="false" />\n    <domain-config cleartextTrafficPermitted="true">\n${domains}\n    </domain-config>\n</network-security-config>\n`;
}

const policyPath = resolve(process.argv[2] || join(root, 'yuqi-runtime', 'lan-policy.json'));
const outputPath = resolve(process.argv[3] || join(root, 'android', 'app', 'src', 'main', 'res', 'xml', 'network_security_config.xml'));
const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, renderNetworkSecurityConfig(policy.allowedHosts), 'utf8');
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify({ ok: true, hosts: policy.allowedHosts.length, outputPath })}\n`);
}
