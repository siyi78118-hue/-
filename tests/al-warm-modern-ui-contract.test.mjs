import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync('tavern-app/index.html', 'utf8');
const worker = readFileSync('tavern-app/sw-v11.js', 'utf8');
const manifest = JSON.parse(readFileSync('tavern-app/manifest.json', 'utf8'));
const capacitor = JSON.parse(readFileSync('capacitor.config.json', 'utf8'));
const screenIds = [...html.matchAll(/id="(screen-[^"]+)"/g)].map(match => match[1]);
const css = readFileSync('tavern-app/warm-modern.css', 'utf8');
const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

function declarationsFor(selector) {
  const declarations = [];
  for (const match of cssWithoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map(value => value.trim());
    if (selectors.includes(selector)) declarations.push(match[2]);
  }
  return declarations.join('\n');
}

function assertDeclaration(selector, pattern) {
  const declarations = declarationsFor(selector);
  assert.ok(declarations, `missing real CSS rule for ${selector}`);
  assert.match(declarations, pattern, `missing ${pattern} in ${selector}`);
}

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

test('maps legacy theme variables and styles the real shared mobile shell', () => {
  for (const [legacy, modern] of Object.entries({
    '--page': '--wm-page',
    '--panel': '--wm-card',
    '--line': '--wm-line',
    '--line2': '--wm-line',
    '--text': '--wm-text',
    '--muted': '--wm-muted',
    '--muted2': '--wm-faint',
    '--green': '--wm-jade',
    '--green2': '--wm-outgoing',
    '--danger': '--wm-danger',
    '--header': '--wm-surface',
    '--tab': '--wm-surface',
    '--bubble': '--wm-card',
    '--radius': '--wm-radius-sm'
  })) {
    assertDeclaration(':root', new RegExp(`${legacy}\\s*:\\s*var\\(${modern}\\)`));
  }

  assertDeclaration('html', /background\s*:\s*#dedbd4/);
  assertDeclaration('#app', /background\s*:\s*var\(--wm-page\)/);
  assertDeclaration('.screen', /background\s*:\s*var\(--wm-page\)/);
  assertDeclaration('.topbar', /background\s*:\s*rgba\(250\s*,\s*248\s*,\s*243\s*,\s*0?\.97\)/);
  assertDeclaration('.top-left', /(?:width|min-width|flex-basis)\s*:\s*96px/);
  assertDeclaration('.top-right', /(?:width|min-width|flex-basis)\s*:\s*96px/);
  assertDeclaration('.icon-btn', /min-width\s*:\s*44px/);
  assertDeclaration('.icon-btn', /min-height\s*:\s*44px/);
  assertDeclaration('.tabbar', /background\s*:\s*rgba\(250\s*,\s*248\s*,\s*243\s*,\s*0?\.98\)/);
  assertDeclaration('.tab.active', /color\s*:\s*var\(--wm-jade\)/);
  assertDeclaration('.search-box', /min-height\s*:\s*44px/);
  assertDeclaration('.search-field', /min-height\s*:\s*44px/);
  assertDeclaration('.list', /background\s*:\s*var\(--wm-card\)/);
  assertDeclaration('.row', /min-height\s*:\s*72px/);
  assertDeclaration('.row', /background\s*:\s*var\(--wm-card\)/);
  assertDeclaration('.form', /background\s*:\s*var\(--wm-page\)/);
  assertDeclaration('.cell', /min-height\s*:\s*56px/);
  assertDeclaration('.cell', /background\s*:\s*var\(--wm-card\)/);
  assertDeclaration('.primary', /background\s*:\s*var\(--wm-jade\)/);
  assertDeclaration('.secondary', /background\s*:\s*var\(--wm-card\)/);
  assertDeclaration('.switch.on', /background\s*:\s*var\(--wm-jade\)/);
  assertDeclaration('.avatar', /border-radius\s*:\s*12px/);
});

test('overrides all ten inline scroll backgrounds through scoped screen rules', () => {
  for (const screen of [
    '#screen-contact-profile',
    '#screen-role-plans',
    '#screen-stage-personas',
    '#screen-discover',
    '#screen-me',
    '#screen-self-profile',
    '#screen-wallet',
    '#screen-pay',
    '#screen-chat-info',
    '#screen-moments'
  ]) {
    assertDeclaration(`${screen} > .scroll`, /background\s*:\s*var\(--wm-page\)\s*!important/);
  }
});

test('does not fabricate backstage systems as visible conversations', () => {
  const chatsStart = html.indexOf('<div id="screen-chats"');
  const chatsEnd = html.indexOf('<div id="screen-search"', chatsStart);
  const chatsMarkup = html.slice(chatsStart, chatsEnd);
  assert.ok(chatsMarkup, 'screen-chats markup must be present');
  assert.doesNotMatch(
    chatsMarkup,
    />\s*(?:\u8bb0\u5fc6\u5907\u4efd|\u5c0fg|Codex|\u6a21\u578b\u7a97\u53e3)\s*</i
  );
});
