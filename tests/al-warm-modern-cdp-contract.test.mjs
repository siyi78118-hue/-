import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const auditPath = 'scripts/audit-warm-modern-ui-cdp.mjs';
const auditExists = existsSync(auditPath);
const auditScript = auditExists ? readFileSync(auditPath, 'utf8') : '';

const expectedScreens = [
  'screen-chats', 'screen-search', 'screen-chat', 'screen-chat-info',
  'screen-contacts', 'screen-contact-profile', 'screen-discover', 'screen-moments',
  'screen-me', 'screen-self-profile', 'screen-settings', 'screen-import',
  'screen-role-plans', 'screen-stage-personas', 'screen-memory', 'screen-memory-edit',
  'screen-diagnostics', 'screen-wallet', 'screen-pay'
];

const expectedViewports = ['360x800', '393x873', '520x900'];

test('provides one reusable warm-modern CDP audit runner', () => {
  assert.equal(auditExists, true, `${auditPath} must exist`);
  for (const option of ['--cdp', '--url', '--target-url-prefix', '--output']) {
    assert.ok(auditScript.includes(option), `missing CLI option ${option}`);
  }
});

test('pins exactly 19 screens by 3 viewports for 57 unique probes', () => {
  for (const screen of expectedScreens) {
    assert.ok(auditScript.includes(`'${screen}'`), `missing CDP screen ${screen}`);
  }
  for (const viewport of expectedViewports) {
    assert.ok(auditScript.includes(`'${viewport}'`), `missing CDP viewport ${viewport}`);
  }
  assert.match(auditScript, /const expectedProbeCount\s*=\s*57\s*;/);
  assert.match(auditScript, /new Set\([^)]*probeKey/);
});

test('uses real CDP viewport, navigation, cache-clearing, and page evaluation commands', () => {
  for (const command of [
    'Emulation.setDeviceMetricsOverride',
    'Storage.clearDataForOrigin',
    'Page.reload',
    'Runtime.evaluate'
  ]) {
    assert.ok(auditScript.includes(command), `missing CDP command ${command}`);
  }
  assert.match(auditScript, /ignoreCache:\s*true/);
  assert.match(auditScript, /serviceWorker\.getRegistrations/);
  assert.match(auditScript, /caches\.keys/);
  assert.match(auditScript, /requestAnimationFrame/);
});

test('waits for the hosted navigation and a genuinely new document after reload', () => {
  assert.match(auditScript, /location\.href/);
  assert.match(auditScript, /__alWarmModernReloadPending/);
  assert.match(auditScript, /delete\s+globalThis\.__alWarmModernReloadPending/);
});

test('measures every required boundary and validates the warm presentation layer', () => {
  for (const boundary of [
    'horizontalOverflow',
    'viewportClipping',
    'topbarOverlap',
    'scrollTopReachable',
    'scrollBottomReachable',
    'footerClipping',
    'touchTargetFailures'
  ]) {
    assert.ok(auditScript.includes(boundary), `missing CDP boundary ${boundary}`);
  }
  assert.ok(auditScript.includes('warm-modern.css'), 'missing stylesheet presence check');
  assert.ok(auditScript.includes('rgb(237, 237, 237)'), 'missing legacy gray rejection');
  for (const selector of [
    '.icon-btn', '.top-text-btn', '.search-cancel', '.primary', '.secondary',
    '.inline-btn', '.composer-tool', '.send', '.voice-hold', '.batch-finish',
    '.moment-compose-actions button', '.moment-reply-bar button', '.plus-item',
    '.message-action-sheet button'
  ]) {
    assert.ok(auditScript.includes(selector), `missing primary control ${selector}`);
  }
});

test('writes sanitized numeric evidence and exits nonzero for any failed probe', () => {
  for (const field of [
    'schemaVersion', 'screenCount', 'probeCount', 'expectedProbeCount',
    'aggregateFailures', 'failedProbes', 'backstageConversationRows',
    'chatContentsIncluded'
  ]) {
    assert.ok(auditScript.includes(field), `missing evidence field ${field}`);
  }
  assert.match(auditScript, /chatContentsIncluded:\s*false/);
  assert.match(auditScript, /process\.exitCode\s*=\s*1/);
  assert.doesNotMatch(auditScript, /innerText|textContent|outerHTML|localStorage|sessionStorage/);
});
