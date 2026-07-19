# AL Warm Modern Mobile UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle all 19 AL mobile screens with the approved warm-white and jade-green visual language while preserving every existing feature, DOM contract, data flow, and Yuqi bridge behavior.

**Architecture:** Keep `tavern-app/index.html` as the application and behavior owner, and place the new presentation layer in one focused `tavern-app/warm-modern.css` file loaded after the existing inline CSS. Wire that asset into the service-worker shell and Capacitor package, then verify static contracts, all existing tests, browser layouts, and an exact version-73 Android APK.

**Tech Stack:** HTML5, CSS custom properties, vanilla JavaScript, Node.js test runner, Capacitor 8, Android Gradle/JDK 21, Android WebView.

## Global Constraints

- Target release is Android `versionCode 73`, `versionName 1.0.73`.
- Preserve all 19 existing `screen-*` page IDs and every current JavaScript event entry point.
- Do not modify Yuqi prompts, bridge protocol, database schemas, Cloudflare services, role windows, or message attribution.
- Do not present memory, models, synchronization, recovery, or Codex as contacts or chat messages.
- Use exact primary colors: `#F3F0EA`, `#FAF8F3`, `#FFFFFF`, `#EEF0EB`, `#477964`, `#3C6856`, `#B8D9C6`, `#2A302D`, `#727A75`, `#A4AAA6`, `#E6E1D8`, `#C95D57`, and `#D86A64`.
- Keep primary touch targets at least `44px` high or wide.
- Support 360×800, 393×873, and 520px-wide layouts without horizontal scrolling.
- Keep technical maintenance screens accessible from their current settings hierarchy, but visually subordinate them to ordinary chat and relationship surfaces.
- Preserve user-owned unrelated working-tree changes.

---

## File Structure

- Create `tavern-app/warm-modern.css`: the complete presentation override, organized into tokens, shell, chat, people, secondary pages, maintenance, overlays, responsive rules, and reduced-motion rules.
- Create `tests/al-warm-modern-ui-contract.test.mjs`: stable structural, token, offline-cache, privacy, responsiveness, and release assertions.
- Modify `tavern-app/index.html`: load the new stylesheet and advance the web build identifier; do not rewrite the inline application script.
- Modify `tavern-app/sw-v11.js`: cache the stylesheet offline and advance the cache generation.
- Modify `tavern-app/manifest.json`: align PWA background and theme colors.
- Modify `capacitor.config.json`: align the native WebView background color.
- Modify `test-basic.mjs`: advance existing cache/build assertions.
- Modify `android/app/build.gradle`: advance the default Android version to 73/1.0.73.
- Create `artifacts/verification/al-warm-modern-ui-verification.json`: sanitized automated, visual, APK, and signature evidence.
- Create `artifacts/AL-1.0.73-warm-modern-ui-verified.apk`: exact tested delivery artifact.

---

### Task 1: Lock the UI Contract and Wire the New Stylesheet

**Files:**
- Create: `tests/al-warm-modern-ui-contract.test.mjs`
- Create: `tavern-app/warm-modern.css`
- Modify: `tavern-app/index.html:1-12`
- Modify: `tavern-app/sw-v11.js:1-2`
- Modify: `tavern-app/manifest.json:8-9`
- Modify: `capacitor.config.json:10`
- Modify: `test-basic.mjs:153`

**Interfaces:**
- Consumes: existing `screen-*` IDs, service-worker `APP_SHELL`, and Capacitor `webDir: "tavern-app"`.
- Produces: `warm-modern.css` loaded after the inline legacy CSS and available offline.

- [ ] **Step 1: Write the failing contract test**

Create `tests/al-warm-modern-ui-contract.test.mjs`:

```js
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
});

test('does not fabricate backstage systems as visible conversations', () => {
  const visibleMarkup = html.slice(0, html.indexOf('<script'));
  assert.doesNotMatch(visibleMarkup, />\s*(记忆备份|小g|Codex|模型窗口)\s*</i);
});
```

- [ ] **Step 2: Run the contract test and confirm the expected failure**

Run:

```powershell
node --test tests/al-warm-modern-ui-contract.test.mjs
```

Expected: FAIL because `tavern-app/warm-modern.css` and its link/cache entry do not exist.

- [ ] **Step 3: Add the stylesheet wiring and base tokens**

Add after the manifest link in `tavern-app/index.html`:

```html
<link rel="stylesheet" href="./warm-modern.css">
```

Create `tavern-app/warm-modern.css`:

```css
:root {
  --wm-page: #f3f0ea;
  --wm-surface: #faf8f3;
  --wm-card: #ffffff;
  --wm-chat: #eef0eb;
  --wm-jade: #477964;
  --wm-jade-pressed: #3c6856;
  --wm-outgoing: #b8d9c6;
  --wm-text: #2a302d;
  --wm-muted: #727a75;
  --wm-faint: #a4aaa6;
  --wm-line: #e6e1d8;
  --wm-danger: #c95d57;
  --wm-unread: #d86a64;
  --wm-radius-sm: 10px;
  --wm-radius-md: 14px;
  --wm-radius-lg: 18px;
  --wm-shadow-float: 0 14px 34px rgba(42, 48, 45, 0.14);
}
```

Change the first two lines of `tavern-app/sw-v11.js` to:

```js
const CACHE_NAME = 'rpchat-v95';
const APP_SHELL = ['./index.html', './manifest.json', './icon.svg', './warm-modern.css', './lib/api-endpoint.js', './lib/role-plan-domain.js', './lib/role-plan-repository.js', './sw-v11.js'];
```

Set `tavern-app/manifest.json` colors to:

```json
"background_color": "#f3f0ea",
"theme_color": "#faf8f3"
```

Set `capacitor.config.json` Android background to:

```json
"backgroundColor": "#f3f0ea"
```

Change the cache assertion in `test-basic.mjs` to:

```js
assert.match(swScript, /const CACHE_NAME = 'rpchat-v95';/);
```

- [ ] **Step 4: Run the focused contracts**

Run:

```powershell
node --test tests/al-warm-modern-ui-contract.test.mjs tests/yuqi-ui-contract.test.mjs
node test-basic.mjs
```

Expected: all tests PASS and `basic app checks passed`.

- [ ] **Step 5: Commit the contract and asset wiring**

```powershell
git add tests/al-warm-modern-ui-contract.test.mjs tavern-app/warm-modern.css tavern-app/index.html tavern-app/sw-v11.js tavern-app/manifest.json capacitor.config.json test-basic.mjs
git commit -m "test: lock AL warm modern UI contract"
```

---

### Task 2: Restyle the Application Shell and Shared Components

**Files:**
- Modify: `tests/al-warm-modern-ui-contract.test.mjs`
- Modify: `tavern-app/warm-modern.css`

**Interfaces:**
- Consumes: existing `.screen`, `.topbar`, `.tabbar`, `.search-*`, `.row`, `.cell`, `.primary`, `.secondary`, `.switch`, and `.avatar` classes.
- Produces: a common visual foundation used by every screen without DOM changes.

- [ ] **Step 1: Add failing shared-component assertions**

Append to the test file:

```js
const css = readFileSync('tavern-app/warm-modern.css', 'utf8');

test('defines the approved palette and shared mobile components', () => {
  for (const token of ['#f3f0ea', '#faf8f3', '#eef0eb', '#477964', '#b8d9c6', '#2a302d', '#c95d57']) {
    assert.ok(css.includes(token), `missing ${token}`);
  }
  for (const selector of ['.topbar', '.tabbar', '.search-box', '.row', '.cell', '.primary', '.secondary', '.switch', '.avatar']) {
    assert.ok(css.includes(selector), `missing ${selector}`);
  }
});
```

- [ ] **Step 2: Run the test and confirm it fails on missing shared selectors**

Run `node --test tests/al-warm-modern-ui-contract.test.mjs`.

Expected: FAIL with `missing .topbar`.

- [ ] **Step 3: Add the complete shared shell override**

Append to `tavern-app/warm-modern.css`:

```css
html, body { background: #dedbd4; color: var(--wm-text); }
#app, .screen, .page-pad, .form { background: var(--wm-page); }
.topbar {
  height: 56px;
  padding: 0 16px;
  background: rgba(250, 248, 243, 0.97);
  border-color: var(--wm-line);
  color: var(--wm-text);
  backdrop-filter: saturate(130%) blur(14px);
}
.top-title { font-weight: 650; letter-spacing: 0.01em; }
.icon-btn, .top-text-btn { min-width: 44px; min-height: 44px; border-radius: 12px; }
.icon-btn:active, .top-text-btn:active { background: rgba(71, 121, 100, 0.10); }
.tabbar {
  height: 62px;
  background: rgba(250, 248, 243, 0.98);
  border-color: var(--wm-line);
  color: var(--wm-muted);
  backdrop-filter: saturate(130%) blur(14px);
}
.tab, .tab .tab-ico { color: var(--wm-muted); }
.tab.active, .tab.active .tab-ico { color: var(--wm-jade); }
.search-bar, .search-top, .search-results, .search-section-title { background: var(--wm-page); }
.search-box, .search-field {
  min-height: 38px;
  border-radius: 12px;
  background: var(--wm-card);
  color: var(--wm-faint);
  box-shadow: inset 0 0 0 1px rgba(42, 48, 45, 0.035);
}
.list, .row, .cell, .wx-group, .cell-group { background: var(--wm-card); }
.row { min-height: 72px; padding: 0 16px; gap: 12px; }
.row:after, .wx-group .cell:not(:last-child):after { background: var(--wm-line); }
.row:active, .cell:active { background: #f2f4f0; }
.row-preview, .row-time, .cell-note, .hint { color: var(--wm-muted); }
.avatar { border-radius: 14px; background: var(--wm-jade); }
.cell-group, .hero-panel, .quick-card, .plan-card, .profile-card {
  border-radius: var(--wm-radius-md);
  box-shadow: 0 1px 0 rgba(42, 48, 45, 0.04);
}
.primary { min-height: 46px; border-radius: 12px; background: var(--wm-jade); }
.primary:active { background: var(--wm-jade-pressed); }
.secondary, .inline-btn { min-height: 44px; border-radius: 12px; border-color: var(--wm-line); }
.switch { background: #d3d7d3; }
.switch.on { background: var(--wm-jade); }
.badge, .dot { background: var(--wm-unread); }
.danger { color: var(--wm-danger); }
```

- [ ] **Step 4: Run focused tests**

Run:

```powershell
node --test tests/al-warm-modern-ui-contract.test.mjs tests/yuqi-ui-contract.test.mjs
node test-basic.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit the shared visual system**

```powershell
git add tests/al-warm-modern-ui-contract.test.mjs tavern-app/warm-modern.css
git commit -m "feat: restyle AL mobile shell"
```

---

### Task 3: Restyle Chat, Contacts, and Relationship Surfaces

**Files:**
- Modify: `tests/al-warm-modern-ui-contract.test.mjs`
- Modify: `tavern-app/warm-modern.css`

**Interfaces:**
- Consumes: existing `.chat-scroll`, `.chat-list`, `.msg-wrap`, `.bubble`, `.chat-composer`, `.chat-input`, `.message-failed`, `.contact-*`, `.profile-*`, and `.chat-info-*` markup.
- Produces: the approved intimate chat appearance and quieter person-detail hierarchy.

- [ ] **Step 1: Add failing relationship-surface assertions**

```js
test('styles chat and relationship surfaces without backstage conversation labels', () => {
  for (const selector of ['.chat-scroll', '.msg-wrap:not(.me) .bubble', '.msg-wrap.me .bubble', '.chat-input', '.message-failed', '.contact-profile-head', '.chat-info-advanced']) {
    assert.ok(css.includes(selector), `missing ${selector}`);
  }
  assert.match(css, /\.msg-wrap\.me \.bubble\s*\{[^}]*background:\s*var\(--wm-outgoing\)/s);
});
```

- [ ] **Step 2: Run and observe the expected failure**

Run `node --test tests/al-warm-modern-ui-contract.test.mjs`.

Expected: FAIL with `missing .chat-scroll`.

- [ ] **Step 3: Add chat and person-page overrides**

Append:

```css
.chat-head { background: var(--wm-surface); }
.chat-scroll { background: var(--wm-chat); }
.chat-list { padding: 14px 11px 20px; gap: 12px; }
.msg-avatar { width: 38px; height: 38px; border-radius: 11px; background: var(--wm-jade); }
.bubble {
  max-width: min(76%, 340px);
  padding: 9px 11px;
  border-radius: 12px;
  color: var(--wm-text);
  box-shadow: 0 1px 2px rgba(42, 48, 45, 0.045);
}
.msg-wrap:not(.me) .bubble { background: var(--wm-card); border-top-left-radius: 4px; }
.msg-wrap.me .bubble { background: var(--wm-outgoing); border-top-right-radius: 4px; }
.msg-wrap:not(.me) .bubble:before, .msg-wrap.me .bubble:after { display: none; }
.time-tip, .typing-line, .system-tip { color: var(--wm-muted); }
.chat-composer { background: var(--wm-surface); border-color: var(--wm-line); }
.chat-input { min-height: 40px; border-radius: 12px; background: var(--wm-card); }
.chat-tool, .chat-send { min-width: 40px; min-height: 40px; border-radius: 12px; }
.chat-send { background: var(--wm-jade); color: #fff; }
.message-failed { color: var(--wm-danger); }
.message-retry, .message-failure-reason { color: var(--wm-jade); }
.contact-index, .contact-profile-actions { background: var(--wm-page); }
.contact-profile-head, .profile-top, .chat-info-people, .chat-info-advanced { background: var(--wm-card); }
.contact-profile-head .avatar, .chat-info-person .avatar { border-radius: 16px; }
.contact-profile-id, .profile-id, .profile-meta, .profile-detail-text { color: var(--wm-muted); }
.chat-info-advanced summary { min-height: 44px; }
```

- [ ] **Step 4: Run focused and chat stability tests**

Run:

```powershell
node --test tests/al-warm-modern-ui-contract.test.mjs tests/yuqi-ui-contract.test.mjs
node --test tests/rp-preset-contract.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit relationship surfaces**

```powershell
git add tests/al-warm-modern-ui-contract.test.mjs tavern-app/warm-modern.css
git commit -m "feat: warm AL chat and relationship surfaces"
```

---

### Task 4: Restyle Discovery, Moments, Forms, and Maintenance Screens

**Files:**
- Modify: `tests/al-warm-modern-ui-contract.test.mjs`
- Modify: `tavern-app/warm-modern.css`

**Interfaces:**
- Consumes: existing `.moments-*`, `.wx-icon`, `.wallet-*`, `.pay-*`, `.form`, `.file-zone`, `.plan-card`, `.memory-*`, `.diagnostic-*`, and `.stage-*` components.
- Produces: consistent secondary pages while leaving memory evidence and diagnostic detail intact.

- [ ] **Step 1: Add failing secondary-page assertions**

```js
test('styles discovery, form, schedule, memory, and diagnostic pages', () => {
  for (const selector of ['.moments-cover', '.wx-icon', '.form', '.file-zone', '.plan-card', '.memory-section-title', '.diagnostic-item', '.stage-history-item']) {
    assert.ok(css.includes(selector), `missing ${selector}`);
  }
});
```

- [ ] **Step 2: Run and confirm failure**

Run `node --test tests/al-warm-modern-ui-contract.test.mjs`.

Expected: FAIL on the first missing selector.

- [ ] **Step 3: Add the complete secondary-page override**

Append:

```css
.wx-icon, .cell-ico, .quick-ico { border-radius: 10px; }
.wx-icon.green, .cell-ico, .quick-ico { background: var(--wm-jade); }
.moments-cover {
  background: linear-gradient(180deg, rgba(31, 49, 41, 0.04), rgba(31, 49, 41, 0.36)), linear-gradient(135deg, #afc2b5, #6f8a7e 52%, #455750);
}
.moments-user .avatar { border-radius: 16px; border-color: var(--wm-surface); }
.form { padding-top: 12px; background: var(--wm-page); }
.input, .textarea, .select { color: var(--wm-text); }
.input::placeholder, .textarea::placeholder { color: var(--wm-faint); }
.file-zone { border-color: #aac5b6; border-radius: var(--wm-radius-md); color: var(--wm-muted); }
.file-zone:active { background: #edf3ef; }
.plan-card { background: var(--wm-card); }
.plan-card-meta, .stage-meta, .stage-history-meta { color: var(--wm-muted); }
.plan-card-actions button { min-height: 36px; border-radius: 10px; background: #eff2ee; }
.memory-section-title, .section { background: var(--wm-page); color: var(--wm-muted); }
.memory-item, .diagnostic-item, .stage-history-item { background: var(--wm-card); border-color: var(--wm-line); }
.diagnostic-state { border-radius: 999px; background: var(--wm-jade); }
.diagnostic-state.state-fail { background: var(--wm-danger); }
.diagnostic-pre { border-radius: 10px; background: #f1f2ef; color: #535b56; }
.range { accent-color: var(--wm-jade); }
```

- [ ] **Step 4: Run focused and domain tests**

Run:

```powershell
node --test tests/al-warm-modern-ui-contract.test.mjs tests/role-plan-domain.test.mjs tests/role-plan-repository.test.mjs
node test-basic.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit secondary pages**

```powershell
git add tests/al-warm-modern-ui-contract.test.mjs tavern-app/warm-modern.css
git commit -m "feat: unify AL secondary mobile screens"
```

---

### Task 5: Finish Overlays, Accessibility, and Responsive Behavior

**Files:**
- Modify: `tests/al-warm-modern-ui-contract.test.mjs`
- Modify: `tavern-app/warm-modern.css`

**Interfaces:**
- Consumes: existing `.toast`, `.modal-mask`, `.sheet`, `.plus-menu`, `.message-action-sheet`, safe-area variables, and mobile media queries.
- Produces: coherent overlays, 44px controls, reduced motion, and 360px-safe layouts.

- [ ] **Step 1: Add failing accessibility and responsive assertions**

```js
test('includes safe-area, touch-target, narrow-screen, focus, and reduced-motion rules', () => {
  assert.match(css, /min-(?:width|height):\s*44px/);
  assert.match(css, /@media\s*\(max-width:\s*380px\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /safe-area-inset-bottom/);
});
```

- [ ] **Step 2: Run and confirm failure**

Run `node --test tests/al-warm-modern-ui-contract.test.mjs`.

Expected: FAIL on the missing accessibility selectors.

- [ ] **Step 3: Add overlays and responsive rules**

Append:

```css
.toast { border-radius: 12px; background: rgba(35, 42, 38, 0.88); box-shadow: var(--wm-shadow-float); }
.modal-mask { background: rgba(31, 38, 34, 0.34); backdrop-filter: blur(2px); }
.sheet, .message-action-sheet {
  border-radius: 20px 20px 0 0;
  background: var(--wm-surface);
  box-shadow: 0 -12px 36px rgba(42, 48, 45, 0.14);
  padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px));
}
.plus-menu { border-radius: 14px; background: #34423b; box-shadow: var(--wm-shadow-float); }
button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, [tabindex]:focus-visible {
  outline: 2px solid var(--wm-jade);
  outline-offset: 2px;
}
button, .tab, .row, .cell { touch-action: manipulation; }

@media (max-width: 380px) {
  .topbar { padding: 0 12px; }
  .top-left, .top-right { width: 64px; }
  .row { padding-left: 12px; padding-right: 12px; }
  .bubble { max-width: 78%; font-size: 15px; }
  .cell-label { width: 82px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
```

- [ ] **Step 4: Run every non-Android test**

Run `npm.cmd test`.

Expected: application/cloud tests, runtime tests, basic checks, and service-worker guard all PASS.

- [ ] **Step 5: Commit final CSS behavior**

```powershell
git add tests/al-warm-modern-ui-contract.test.mjs tavern-app/warm-modern.css
git commit -m "feat: complete accessible AL mobile UI"
```

---

### Task 6: Perform Browser Visual QA Across All 19 Screens

**Files:**
- Modify if required by observed defects: `tavern-app/warm-modern.css`
- Create: `artifacts/verification/al-warm-modern-ui-browser-audit.json`

**Interfaces:**
- Consumes: the complete web build from Tasks 1–5.
- Produces: sanitized viewport/page audit evidence and any narrowly scoped CSS corrections.

- [ ] **Step 1: Start the local application server**

Run:

```powershell
npm.cmd start
```

Expected: the static server prints a localhost URL and remains running.

- [ ] **Step 2: Inspect the three required viewports**

Using the in-app browser, inspect widths 360, 393, and 520. At each width verify:

```text
No horizontal scrollbar
Top title and both action sides remain visible
Bottom navigation respects the safe area
Chat composer remains visible and usable
Long bubbles wrap without covering avatars
Form labels and values do not overlap
```

- [ ] **Step 3: Traverse all existing screens**

Open and return from each exact screen ID:

```text
screen-chats, screen-search, screen-chat, screen-chat-info,
screen-contacts, screen-contact-profile, screen-discover, screen-moments,
screen-me, screen-self-profile, screen-settings, screen-import,
screen-role-plans, screen-stage-personas, screen-memory, screen-memory-edit,
screen-diagnostics, screen-wallet, screen-pay
```

Expected: all use the warm-modern tokens, remain scrollable, and expose no backstage system as a conversation.

- [ ] **Step 4: Apply only evidence-backed CSS corrections and rerun tests**

For every observed issue, patch only `tavern-app/warm-modern.css`, then run:

```powershell
node --test tests/al-warm-modern-ui-contract.test.mjs tests/yuqi-ui-contract.test.mjs
node test-basic.mjs
```

Expected: PASS after every correction.

- [ ] **Step 5: Record the sanitized browser audit**

Create `artifacts/verification/al-warm-modern-ui-browser-audit.json` with this exact shape and actual pass/fail values:

```json
{
  "schemaVersion": 1,
  "viewports": ["360x800", "393x873", "520x900"],
  "screenCount": 19,
  "horizontalOverflow": 0,
  "backstageConversationRows": 0,
  "failedScreens": [],
  "chatContentsIncluded": false
}
```

- [ ] **Step 6: Commit the visual QA corrections and record**

```powershell
git add tavern-app/warm-modern.css artifacts/verification/al-warm-modern-ui-browser-audit.json
git commit -m "test: verify AL warm modern screens"
```

---

### Task 7: Build and Verify the Exact 1.0.73 Android Artifact

**Files:**
- Modify: `tavern-app/index.html:1325`
- Modify: `test-basic.mjs:174`
- Modify: `android/app/build.gradle:10-11`
- Create: `artifacts/verification/al-warm-modern-ui-verification.json`
- Create: `artifacts/AL-1.0.73-warm-modern-ui-verified.apk`

**Interfaces:**
- Consumes: verified web resources and existing Android signing configuration.
- Produces: the exact signed, install-tested version-73 APK and a sanitized evidence record.

- [ ] **Step 1: Add failing release assertions**

Append to `tests/al-warm-modern-ui-contract.test.mjs`:

```js
const gradle = readFileSync('android/app/build.gradle', 'utf8');

test('pins the warm-modern release at Android 1.0.73', () => {
  assert.match(html, /const APP_BUILD_VERSION = '2026-07-19\.93';/);
  assert.match(gradle, /versionCode Integer\.parseInt\(System\.getenv\("AL_VERSION_CODE"\) \?: "73"\)/);
  assert.match(gradle, /versionName System\.getenv\("AL_VERSION_NAME"\) \?: "1\.0\.73"/);
});
```

- [ ] **Step 2: Run and confirm the release test fails**

Run `node --test tests/al-warm-modern-ui-contract.test.mjs`.

Expected: FAIL because the current defaults are version 72/1.0.72.

- [ ] **Step 3: Advance web and Android versions**

In `tavern-app/index.html` set:

```js
const APP_BUILD_VERSION = '2026-07-19.93';
```

In `test-basic.mjs` set:

```js
assert.match(script, /const APP_BUILD_VERSION = '2026-07-19\.93';/);
```

In `android/app/build.gradle` set:

```groovy
versionCode Integer.parseInt(System.getenv("AL_VERSION_CODE") ?: "73")
versionName System.getenv("AL_VERSION_NAME") ?: "1.0.73"
```

- [ ] **Step 4: Run the full web/runtime verification**

Run:

```powershell
$env:AL_EXPECT_VERSION_CODE='73'
$env:AL_EXPECT_VERSION_NAME='1.0.73'
npm.cmd run yuqi:verify
npm.cmd test
```

Expected: every verification gate and regression test PASS.

- [ ] **Step 5: Sync web assets and build the exact APK**

Run:

```powershell
$env:JAVA_HOME='C:\tmp\microsoft-jdk-21\jdk-21.0.11+10'
$env:AL_VERSION_CODE='73'
$env:AL_VERSION_NAME='1.0.73'
npm.cmd run android:sync
Set-Location android
.\gradlew.bat :app:assembleDebug :app:assembleDebugAndroidTest --no-daemon --no-problems-report
Set-Location ..
Copy-Item -LiteralPath 'android\app\build\outputs\apk\debug\app-debug.apk' -Destination 'artifacts\AL-1.0.73-warm-modern-ui-verified.apk' -Force
```

Expected: `BUILD SUCCESSFUL` and the delivery APK exists.

- [ ] **Step 6: Verify package, version, signature compatibility, and hash**

Run:

```powershell
& 'C:\Users\PC\AppData\Local\Android\Sdk\build-tools\36.0.0\aapt.exe' dump badging 'artifacts\AL-1.0.73-warm-modern-ui-verified.apk'
& 'C:\Users\PC\AppData\Local\Android\Sdk\build-tools\36.0.0\apksigner.bat' verify --print-certs 'artifacts\AL-1.0.72-yuqi-async-verified.apk'
& 'C:\Users\PC\AppData\Local\Android\Sdk\build-tools\36.0.0\apksigner.bat' verify --print-certs 'artifacts\AL-1.0.73-warm-modern-ui-verified.apk'
Get-FileHash -Algorithm SHA256 -LiteralPath 'artifacts\AL-1.0.73-warm-modern-ui-verified.apk'
```

Expected: package `com.siyi.al`, version 73/1.0.73, and the same signer certificate digest as 1.0.72.

- [ ] **Step 7: Install the exact artifact and smoke-test it**

Run:

```powershell
& 'C:\Users\PC\AppData\Local\Android\Sdk\platform-tools\adb.exe' -s emulator-5554 install -r 'artifacts\AL-1.0.73-warm-modern-ui-verified.apk'
& 'C:\Users\PC\AppData\Local\Android\Sdk\platform-tools\adb.exe' -s emulator-5554 shell dumpsys package com.siyi.al
```

Then verify launch, message list, chat composer, settings navigation, and Android back behavior on the installed exact artifact.

Expected: upgrade succeeds without clearing data; `versionCode=73`, `versionName=1.0.73`; no crash or clipped primary navigation.

- [ ] **Step 8: Write the final sanitized verification record**

Using `apply_patch`, create `artifacts/verification/al-warm-modern-ui-verification.json` with `schemaVersion: 1`; a `release` object containing package `com.siyi.al`, version 73/1.0.73, the delivery artifact path, the exact uppercase SHA-256 printed by Step 6, and `signingCertificateMatchedPreviousApk: true`; a `ui` object containing 19 screens, 3 passed viewports, zero horizontal overflow, and zero backstage conversation rows; a `tests` object recording zero contract, regression, and Yuqi-verifier failures plus `exactApkSmoke: "passed"`; and a `privacy` object setting chat-content, secret, and internal-reasoning inclusion to `false`.

Run `node -e "JSON.parse(require('fs').readFileSync('artifacts/verification/al-warm-modern-ui-verification.json','utf8')); console.log('verification json valid')"`.

Expected: `verification json valid`.

- [ ] **Step 9: Commit the release evidence**

```powershell
git add tavern-app/index.html test-basic.mjs android/app/build.gradle tests/al-warm-modern-ui-contract.test.mjs artifacts/verification/al-warm-modern-ui-verification.json
git commit -m "release: verify AL warm modern 1.0.73"
```

Expected: only intended UI/release files are staged; unrelated dirty files remain untouched.
