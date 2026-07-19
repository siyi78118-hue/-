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

test('styles every real chat surface with the warm modern hierarchy', () => {
  for (const selector of [
    '.chat-head',
    '.chat-scroll',
    '.chat-list',
    '.scenario',
    '.system-tip',
    '.msg-wrap',
    '.msg-wrap.me',
    '.msg-avatar',
    '.bubble',
    '.msg-wrap:not(.me) .bubble',
    '.msg-wrap.me .bubble',
    '.time-tip',
    '.typing-line',
    '.message-failed',
    '.message-retry',
    '.message-failure-reason',
    '.batch-finish-bar',
    '.batch-finish',
    '.composer',
    '.composer-tool',
    '.chat-input',
    '.send',
    '.composer-panel',
    '.emoji-tabs',
    '.emoji-tab',
    '.emoji-grid',
    '.action-grid',
    '.action-item',
    '.voice-hold'
  ]) {
    assert.ok(declarationsFor(selector), `missing real CSS rule for ${selector}`);
  }

  assertDeclaration('.chat-head', /background\s*:\s*var\(--wm-surface\)/);
  assertDeclaration('.chat-scroll', /background\s*:\s*var\(--wm-chat\)/);
  assertDeclaration('.chat-list', /gap\s*:\s*12px/);
  assertDeclaration('.scenario', /background\s*:\s*rgba\(71\s*,\s*121\s*,\s*100\s*,\s*0?\.12\)/);
  assertDeclaration('.system-tip', /color\s*:\s*var\(--wm-muted\)/);
  assertDeclaration('.msg-avatar', /border-radius\s*:\s*11px/);
  assertDeclaration('.bubble', /max-width\s*:\s*min\(76%\s*,\s*340px\)/);
  assertDeclaration('.msg-wrap:not(.me) .bubble', /background\s*:\s*var\(--wm-card\)/);
  assertDeclaration('.msg-wrap.me .bubble', /background\s*:\s*var\(--wm-outgoing\)/);
  assertDeclaration('.message-failed', /color\s*:\s*var\(--wm-danger\)/);
  assertDeclaration('.message-retry', /color\s*:\s*var\(--wm-jade\)/);
  assertDeclaration('.message-failure-reason', /color\s*:\s*var\(--wm-jade\)/);
  assertDeclaration('.composer', /background\s*:\s*var\(--wm-surface\)/);
  assertDeclaration('.chat-input', /background\s*:\s*var\(--wm-card\)/);
  assertDeclaration('.send', /background\s*:\s*var\(--wm-jade\)/);
  assertDeclaration('.composer-panel', /background\s*:\s*var\(--wm-surface\)/);
  assertDeclaration('.emoji-tab', /min-height\s*:\s*44px/);
  assertDeclaration('.action-item', /min-height\s*:\s*72px/);
});

test('keeps every real chat control comfortably touchable', () => {
  for (const selector of ['.composer-tool', '.send', '.batch-finish', '.message-retry', '.message-failure-reason', '.emoji-tab', '.voice-hold']) {
    assertDeclaration(selector, /min-height\s*:\s*(?:44|48)px/);
  }
  assertDeclaration('.composer-tool', /min-width\s*:\s*44px/);
  assertDeclaration('.send', /min-width\s*:\s*56px/);
  assertDeclaration('.emoji-grid button', /min-height\s*:\s*44px/);
  assertDeclaration('.action-item span', /width\s*:\s*52px/);
  assertDeclaration('.action-item span', /height\s*:\s*52px/);

  for (const deadSelector of ['.chat-composer', '.chat-tool', '.chat-send']) {
    assert.equal(declarationsFor(deadSelector), '', `dead selector must not be an acceptance anchor: ${deadSelector}`);
  }
});

test('styles the complete contact profile and chat-info selector audit', () => {
  for (const selector of [
    '.contact-rail',
    '.contact-index',
    '.contact-profile-head',
    '.contact-profile-name',
    '.contact-profile-id',
    '.contact-profile-actions',
    '.contact-profile-actions .primary',
    '.profile-detail-text',
    '.profile-card',
    '.profile-top',
    '.profile-name',
    '.profile-meta',
    '.profile-id',
    '.chat-info-people',
    '.chat-info-person',
    '.chat-info-advanced',
    '.chat-info-advanced summary',
    '.chat-info-editor'
  ]) {
    assert.ok(declarationsFor(selector), `missing real CSS rule for ${selector}`);
  }

  assertDeclaration('.contact-index', /background\s*:\s*var\(--wm-page\)/);
  assertDeclaration('.contact-profile-head', /background\s*:\s*var\(--wm-card\)/);
  assertDeclaration('.contact-profile-name', /color\s*:\s*var\(--wm-text\)/);
  assertDeclaration('.contact-profile-id', /color\s*:\s*var\(--wm-muted\)/);
  assertDeclaration('.contact-profile-actions', /background\s*:\s*var\(--wm-page\)/);
  assertDeclaration('.contact-profile-actions .primary', /min-height\s*:\s*48px/);
  assertDeclaration('.profile-detail-text', /color\s*:\s*var\(--wm-muted\)/);
  assertDeclaration('.profile-card', /background\s*:\s*var\(--wm-card\)/);
  assertDeclaration('.profile-top', /background\s*:\s*var\(--wm-card\)/);
  assertDeclaration('.profile-name', /color\s*:\s*var\(--wm-text\)/);
  assertDeclaration('.profile-meta', /color\s*:\s*var\(--wm-muted\)/);
  assertDeclaration('.profile-id', /color\s*:\s*var\(--wm-muted\)/);
  assertDeclaration('.chat-info-people', /background\s*:\s*var\(--wm-card\)/);
  assertDeclaration('.chat-info-person', /min-height\s*:\s*72px/);
  assertDeclaration('.chat-info-advanced', /background\s*:\s*transparent/);
  assertDeclaration('.chat-info-advanced summary', /min-height\s*:\s*44px/);
  assertDeclaration('.chat-info-editor', /background\s*:\s*var\(--wm-card\)/);
});
