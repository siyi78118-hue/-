import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync('tavern-app/index.html', 'utf8');
const worker = readFileSync('tavern-app/sw-v11.js', 'utf8');
const manifest = JSON.parse(readFileSync('tavern-app/manifest.json', 'utf8'));
const capacitor = JSON.parse(readFileSync('capacitor.config.json', 'utf8'));
const screenIds = [...html.matchAll(/id="(screen-[^"]+)"/g)].map(match => match[1]);

test('loads one offline warm-modern presentation layer', () => {
  assert.ok(existsSync('tavern-app/warm-modern.css'));
  assert.match(html, /<link rel="stylesheet" href="\.\/warm-modern\.css">/);
  assert.ok(
    html.indexOf('<link rel="stylesheet" href="./warm-modern.css">') > html.indexOf('</style>'),
    'warm-modern.css must load after the legacy inline style so its overrides win'
  );
  assert.match(worker, /'\.\/warm-modern\.css'/);
  assert.match(worker, /const CACHE_NAME = 'rpchat-v95';/);
});

test('retains all application screens and uses the approved native background', () => {
  assert.equal(new Set(screenIds).size, 19);
  for (const id of ['screen-chats', 'screen-chat', 'screen-contacts', 'screen-discover', 'screen-me', 'screen-settings', 'screen-memory', 'screen-diagnostics']) {
    assert.ok(screenIds.includes(id), `missing ${id}`);
  }
  assert.equal(manifest.background_color, '#f3f0ea');
  assert.equal(manifest.theme_color, '#faf8f3');
  assert.equal(capacitor.android.backgroundColor, '#f3f0ea');
  assert.match(html, /<meta name="theme-color" content="#faf8f3">/);
});

test('does not fabricate backstage systems as visible conversations', () => {
  const visibleMarkup = html.slice(0, html.indexOf('<script'));
  assert.doesNotMatch(visibleMarkup, />\s*(记忆备份|小g|Codex|模型窗口)\s*</i);
});
