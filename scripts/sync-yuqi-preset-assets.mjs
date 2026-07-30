import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileCognitionAssets } from './compile-yuqi-cognition-assets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function extractCombinedRp(html) {
  const match = String(html || '').match(/combined:\s*\{[\s\S]*?prompt:\s*`([\s\S]*?)`\s*\r?\n\s*\},\s*\r?\n\s*custom:/);
  if (!match) throw new Error('AL 综合 RP could not be extracted from tavern-app/index.html');
  return match[1].replaceAll('\\n', '\n').trim();
}

export function renderYuqiCoreAsset(markdown) {
  const core = String(markdown || '').trim();
  if (!core) throw new Error('yuqi-core.md is empty');
  return `globalThis.AL_YUQI_CORE_PROMPT = ${JSON.stringify(core)};\n`;
}

function syncFile(path, expected, checkOnly) {
  let actual = '';
  try { actual = readFileSync(path, 'utf8'); } catch {}
  if (actual === expected) return false;
  if (checkOnly) throw new Error(`preset asset is out of sync: ${path}`);
  writeFileSync(path, expected, 'utf8');
  return true;
}

export function syncYuqiPresetAssets({ checkOnly = false } = {}) {
  const cognition = compileCognitionAssets({ rootDir: root, checkOnly });
  const htmlPath = resolve(root, 'tavern-app', 'index.html');
  const corePath = resolve(root, 'yuqi-runtime', 'presets', 'yuqi-core.md');
  const combinedPath = resolve(root, 'yuqi-runtime', 'presets', 'al-combined-rp.md');
  const browserCorePath = resolve(root, 'tavern-app', 'lib', 'yuqi-core-preset.js');
  const combined = `${extractCombinedRp(readFileSync(htmlPath, 'utf8'))}\n`;
  const browserCore = renderYuqiCoreAsset(readFileSync(corePath, 'utf8'));
  return {
    combinedChanged: syncFile(combinedPath, combined, checkOnly),
    coreChanged: syncFile(browserCorePath, browserCore, checkOnly),
    cognitionChanged: cognition.changed,
    livedAgencyV3Changed: false,
    livedAgencyV3Experiences: cognition.livedAgencyV3.experienceCount
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = syncYuqiPresetAssets({ checkOnly: process.argv.includes('--check') });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}
