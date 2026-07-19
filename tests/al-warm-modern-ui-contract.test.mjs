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

test('warms real forms, model controls, and the import page without invented anchors', () => {
  for (const selector of [
    '.form',
    '.form .cell-group',
    '.input',
    '.textarea',
    '.select',
    '.range',
    '.model-row',
    '.model-tools',
    '.model-tools .select',
    '.inline-btn',
    '#screen-import .page-pad',
    '#screen-import .page-pad > .wx-group',
    '#screen-import .page-pad > .wx-group .cell'
  ]) {
    assert.ok(declarationsFor(selector), `missing real CSS rule for ${selector}`);
  }

  assertDeclaration('.form', /background\s*:\s*var\(--wm-page\)/);
  assertDeclaration('.form .cell-group', /background\s*:\s*var\(--wm-card\)/);
  assertDeclaration('.input', /min-height\s*:\s*44px/);
  assertDeclaration('.textarea', /background\s*:\s*var\(--wm-card\)/);
  assertDeclaration('.select', /min-height\s*:\s*44px/);
  assertDeclaration('.range', /accent-color\s*:\s*var\(--wm-jade\)/);
  assertDeclaration('.model-row', /background\s*:\s*var\(--wm-card\)/);
  assertDeclaration('.model-tools', /gap\s*:\s*10px/);
  assertDeclaration('.model-tools .select', /min-height\s*:\s*44px/);
  assertDeclaration('.inline-btn', /min-height\s*:\s*44px/);
  assertDeclaration('#screen-import .page-pad', /background\s*:\s*var\(--wm-page\)/);
  assertDeclaration('#screen-import .page-pad > .wx-group', /background\s*:\s*var\(--wm-card\)/);
  assertDeclaration('#screen-import .page-pad > .wx-group .cell', /min-height\s*:\s*56px/);
});

test('gives schedules, stages, memory, and diagnostics a calm information hierarchy', () => {
  for (const selector of [
    '.plan-card',
    '.plan-card-title',
    '.plan-card-meta',
    '.plan-card-intent',
    '.plan-card-actions',
    '.plan-card-actions button',
    '.stage-current',
    '.stage-meta',
    '.stage-editor-text',
    '.stage-history-item',
    '.stage-history-title',
    '.stage-history-meta',
    '.memory-section',
    '.memory-section-title',
    '.memory-item',
    '.memory-actions',
    '.memory-actions .inline-btn',
    '.diagnostic-list',
    '.diagnostic-item',
    '.diagnostic-title',
    '.diagnostic-state',
    '.diagnostic-state.state-fail',
    '.diagnostic-meta',
    '.diagnostic-memory',
    '.diagnostic-section',
    '.diagnostic-section summary',
    '.diagnostic-pre'
  ]) {
    assert.ok(declarationsFor(selector), `missing real CSS rule for ${selector}`);
  }

  assertDeclaration('.plan-card', /background\s*:\s*var\(--wm-card\)/);
  assertDeclaration('.plan-card-title', /color\s*:\s*var\(--wm-text\)/);
  assertDeclaration('.plan-card-meta', /color\s*:\s*var\(--wm-muted\)/);
  assertDeclaration('.plan-card-intent', /color\s*:\s*var\(--wm-text\)/);
  assertDeclaration('.plan-card-actions button', /min-height\s*:\s*44px/);
  assertDeclaration('.stage-current', /color\s*:\s*var\(--wm-text\)/);
  assertDeclaration('.stage-meta', /color\s*:\s*var\(--wm-muted\)/);
  assertDeclaration('.stage-editor-text', /background\s*:\s*var\(--wm-card\)/);
  assertDeclaration('.stage-history-item', /background\s*:\s*var\(--wm-card\)/);
  assertDeclaration('.stage-history-title', /color\s*:\s*var\(--wm-text\)/);
  assertDeclaration('.stage-history-meta', /color\s*:\s*var\(--wm-muted\)/);
  assertDeclaration('.memory-section-title', /background\s*:\s*var\(--wm-page\)/);
  assertDeclaration('.memory-item', /background\s*:\s*var\(--wm-card\)/);
  assertDeclaration('.memory-actions .inline-btn', /min-height\s*:\s*44px/);
  assertDeclaration('.diagnostic-item', /background\s*:\s*var\(--wm-card\)/);
  assertDeclaration('.diagnostic-title', /color\s*:\s*var\(--wm-text\)/);
  assertDeclaration('.diagnostic-state', /background\s*:\s*var\(--wm-jade\)/);
  assertDeclaration('.diagnostic-state.state-fail', /background\s*:\s*var\(--wm-danger\)/);
  assertDeclaration('.diagnostic-meta', /color\s*:\s*var\(--wm-muted\)/);
  assertDeclaration('.diagnostic-memory', /color\s*:\s*var\(--wm-muted\)/);
  assertDeclaration('.diagnostic-section summary', /min-height\s*:\s*44px/);
  assertDeclaration('.diagnostic-pre', /background\s*:\s*var\(--wm-page\)/);
  assertDeclaration('.diagnostic-pre', /color\s*:\s*var\(--wm-muted\)/);
});

test('styles real moments controls as warm social surfaces with accessible targets', () => {
  for (const selector of [
    '.moments-cover',
    '.moments-user',
    '.moments-user .avatar',
    '.moment',
    '.moment .avatar',
    '.moment-body',
    '.moment-name',
    '.moment-text',
    '.moment-media',
    '.moment-foot',
    '.moment-action',
    '.moment-reactions',
    '.moment-like-line',
    '.moment-comment',
    '.moment-seen',
    '.moment-seen-line',
    '.moment-compose',
    '.moment-compose textarea',
    '.moment-compose-actions',
    '.moment-compose-actions button',
    '.moment-compose-actions .send-moment',
    '.moment-reply-bar',
    '.moment-reply-bar textarea',
    '.moment-reply-bar button',
    '.moment-reply-bar .send-moment'
  ]) {
    assert.ok(declarationsFor(selector), `missing real CSS rule for ${selector}`);
  }

  assertDeclaration('.moment', /background\s*:\s*var\(--wm-card\)/);
  assertDeclaration('.moment', /border-color\s*:\s*var\(--wm-line\)/);
  assertDeclaration('.moment .avatar', /border-radius\s*:\s*12px/);
  assertDeclaration('.moment-name', /color\s*:\s*var\(--wm-jade\)/);
  assertDeclaration('.moment-name', /min-height\s*:\s*44px/);
  assertDeclaration('.moment-text', /color\s*:\s*var\(--wm-text\)/);
  assertDeclaration('.moment-foot', /color\s*:\s*var\(--wm-muted\)/);
  assertDeclaration('.moment-action', /min-width\s*:\s*44px/);
  assertDeclaration('.moment-action', /min-height\s*:\s*44px/);
  assertDeclaration('.moment-reactions', /background\s*:\s*var\(--wm-surface\)/);
  assertDeclaration('.moment-like-line', /min-height\s*:\s*44px/);
  assertDeclaration('.moment-comment', /min-height\s*:\s*44px/);
  assertDeclaration('.moment-compose', /background\s*:\s*var\(--wm-card\)/);
  assertDeclaration('.moment-compose-actions button', /min-height\s*:\s*44px/);
  assertDeclaration('.moment-compose-actions .send-moment', /background\s*:\s*var\(--wm-jade\)/);
  assertDeclaration('.moment-reply-bar', /background\s*:\s*var\(--wm-surface\)/);
  assertDeclaration('.moment-reply-bar textarea', /min-height\s*:\s*44px/);
  assertDeclaration('.moment-reply-bar button', /min-height\s*:\s*44px/);
  assertDeclaration('.moment-reply-bar .send-moment', /background\s*:\s*var\(--wm-jade\)/);
});

test('warms wallet and payment surfaces while preserving their real states', () => {
  for (const selector of [
    '.wallet-note',
    '.pay-target',
    '.pay-target .avatar',
    '.pay-target-name',
    '.pay-target-note',
    '.pay-amount-box',
    '.pay-amount-label',
    '.pay-amount-line',
    '.pay-yuan',
    '.pay-input',
    '.pay-input::placeholder',
    '.pay-balance',
    '.pay-note-input',
    '.pay-card',
    '.pay-card.received',
    '.pay-card.refused',
    '.pay-card-main',
    '.pay-card-icon',
    '.pay-card-title',
    '.pay-card-note',
    '.pay-card-foot',
    '.pay-status-tip'
  ]) {
    assert.ok(declarationsFor(selector), `missing real CSS rule for ${selector}`);
  }

  assertDeclaration('.wallet-note', /color\s*:\s*var\(--wm-muted\)/);
  assertDeclaration('.pay-target', /background\s*:\s*var\(--wm-card\)/);
  assertDeclaration('.pay-target-name', /color\s*:\s*var\(--wm-text\)/);
  assertDeclaration('.pay-target-note', /color\s*:\s*var\(--wm-muted\)/);
  assertDeclaration('.pay-amount-box', /background\s*:\s*var\(--wm-card\)/);
  assertDeclaration('.pay-amount-label', /color\s*:\s*var\(--wm-muted\)/);
  assertDeclaration('.pay-amount-line', /border-color\s*:\s*var\(--wm-line\)/);
  assertDeclaration('.pay-yuan', /color\s*:\s*var\(--wm-text\)/);
  assertDeclaration('.pay-input', /color\s*:\s*var\(--wm-text\)/);
  assertDeclaration('.pay-balance', /color\s*:\s*var\(--wm-muted\)/);
  assertDeclaration('.pay-note-input', /min-height\s*:\s*44px/);
  assertDeclaration('.pay-card', /background\s*:\s*var\(--wm-jade\)/);
  assertDeclaration('.pay-card', /min-height\s*:\s*92px/);
  assertDeclaration('.pay-card.received', /background\s*:\s*var\(--wm-jade-pressed\)/);
  assertDeclaration('.pay-card.refused', /background\s*:\s*var\(--wm-muted\)/);
  assertDeclaration('.pay-card-foot', /background\s*:\s*var\(--wm-card\)/);
  assertDeclaration('.pay-card-foot', /color\s*:\s*var\(--wm-muted\)/);
  assertDeclaration('.pay-status-tip', /color\s*:\s*var\(--wm-muted\)/);
});

test('styles only real overlays as warm, safe, touchable foreground surfaces', () => {
  for (const selector of [
    '.toast',
    '.modal-mask',
    '.message-action-sheet',
    '.message-action-sheet button',
    '.message-action-cancel',
    '.plus-menu',
    '.plus-item'
  ]) {
    assert.ok(declarationsFor(selector), `missing real overlay CSS rule for ${selector}`);
  }

  assertDeclaration('.toast', /z-index\s*:\s*220/);
  assertDeclaration('.toast', /overflow-wrap\s*:\s*anywhere/);
  assertDeclaration('.modal-mask', /z-index\s*:\s*180/);
  assertDeclaration('.message-action-sheet', /background\s*:\s*var\(--wm-surface\)/);
  assertDeclaration('.message-action-sheet', /env\(safe-area-inset-bottom\s*,\s*0px\)/);
  assertDeclaration('.message-action-sheet button', /min-height\s*:\s*54px/);
  assertDeclaration('.message-action-cancel', /margin-top\s*:\s*8px\s*!important/);
  assertDeclaration('.plus-menu', /z-index\s*:\s*170/);
  assertDeclaration('.plus-item', /min-height\s*:\s*48px/);
  assert.equal(declarationsFor('.sheet'), '', 'dead .sheet selector must not be an acceptance anchor');
});

test('exposes visible keyboard focus on the real primary interaction paths', () => {
  for (const selector of [
    '.icon-btn:focus-visible',
    '.top-text-btn:focus-visible',
    '.tab:focus-visible',
    '.search-box:focus-visible',
    '.search-input:focus-visible',
    '.composer-tool:focus-visible',
    '.chat-input:focus-visible',
    '.send:focus-visible',
    '.moment-name:focus-visible',
    '.moment-action:focus-visible',
    '.moment-compose-actions button:focus-visible',
    '.moment-reply-bar button:focus-visible',
    '.plus-item:focus-visible',
    '.message-action-sheet button:focus-visible'
  ]) {
    assertDeclaration(selector, /outline\s*:\s*3px\s+solid\s+rgba\(71\s*,\s*121\s*,\s*100\s*,\s*0?\.42\)/);
    assertDeclaration(selector, /outline-offset\s*:\s*2px/);
  }
});

test('honors device safe areas and reduced-motion preferences', () => {
  assertDeclaration('.tabbar', /env\(safe-area-inset-bottom\s*,\s*0px\)/);
  assertDeclaration('.composer', /env\(safe-area-inset-bottom\s*,\s*0px\)/);
  assertDeclaration('.moment-reply-bar', /env\(safe-area-inset-bottom\s*,\s*0px\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?animation-duration\s*:\s*0\.01ms\s*!important[\s\S]*?transition-duration\s*:\s*0\.01ms\s*!important[\s\S]*?scroll-behavior\s*:\s*auto\s*!important/);
});

test('keeps long content and 360-to-520 layouts structurally stable', () => {
  for (const selector of ['.bubble', '.moment-text', '.moment-comment', '.diagnostic-pre', '.plus-item']) {
    assertDeclaration(selector, /overflow-wrap\s*:\s*anywhere/);
  }

  assert.match(css, /@media\s*\(max-width:\s*380px\)\s*\{[\s\S]*?\.top-left\s*,\s*\.top-right\s*\{[\s\S]*?width\s*:\s*96px[\s\S]*?min-width\s*:\s*96px[\s\S]*?flex-basis\s*:\s*96px[\s\S]*?\.composer\s*\{[\s\S]*?gap\s*:\s*4px[\s\S]*?\.chat-input\s*\{[\s\S]*?min-width\s*:\s*0/);
  assert.match(css, /@media\s*\(min-width:\s*520px\)\s*\{[\s\S]*?\.moment-reply-bar\s*\{[\s\S]*?max-width\s*:\s*520px[\s\S]*?left\s*:\s*50%[\s\S]*?transform\s*:\s*translateX\(-50%\)/);
});
