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
- Use only selectors proven to exist in `tavern-app/index.html`; the chat footer contract is `.composer`, `.composer-tool`, `.chat-input`, and `.send` (not `.chat-composer`, `.chat-tool`, or `.chat-send`).
- Preserve the 10 existing inline scroll backgrounds as application markup, but override all ten with one verified, screen-ID-scoped `> .scroll { background: var(--wm-page) !important; }` rule covering contact-profile, role-plans, stage-personas, discover, me, self-profile, wallet, pay, chat-info, and moments.
- Any legacy rule that can still outrank the theme must be overridden with a screen-scoped selector of equal or higher specificity; do not use dead selectors as proof that a page is themed.
- Keep `.icon-btn`, `.top-text-btn`, `.composer-tool`, `.send`, `.primary`, `.secondary`, `.inline-btn`, moment action buttons, and other primary actions at least `44px` on the relevant axis.
- Reserve enough top-bar side space for the real two-button chats header at 360px without allowing `.top-title` to overlap `.top-left` or `.top-right`.
- Support 360×800, 393×873, and 520px-wide layouts without horizontal scrolling.
- Keep technical maintenance screens accessible from their current settings hierarchy, but visually subordinate them to ordinary chat and relationship surfaces.
- Preserve user-owned unrelated working-tree changes.

---

## File Structure

- Create `tavern-app/warm-modern.css`: the complete presentation override, organized into tokens, shell, chat, people, secondary pages, maintenance, overlays, responsive rules, and reduced-motion rules.
- Create `tests/al-warm-modern-ui-contract.test.mjs`: stable structural, token, offline-cache, privacy, responsiveness, and release assertions.
- Create `scripts/audit-warm-modern-ui-cdp.mjs`: one deterministic CDP audit runner shared by hosted-web QA and exact-installed-APK QA; it probes all 19 screens at all 3 viewports and exits non-zero on any boundary violation.
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

test('defines the approved palette and real shared mobile components', () => {
  for (const token of ['#f3f0ea', '#faf8f3', '#eef0eb', '#477964', '#b8d9c6', '#2a302d', '#c95d57']) {
    assert.ok(css.includes(token), `missing ${token}`);
  }
  for (const selector of ['#app', '.screen', '.scroll', '.topbar', '.top-left', '.top-right', '.top-title', '.icon-btn', '.tabbar', '.search-box', '.search-field', '.row', '.cell', '.primary', '.secondary', '.switch', '.avatar']) {
    assert.ok(css.includes(selector), `missing ${selector}`);
  }
});

test('overrides all ten retained inline screen backgrounds with verified screen IDs', () => {
  const legacyInlineBackgrounds = [...html.matchAll(/class="scroll"\s+style="background:#(?:ededed|fff)"/g)];
  assert.equal(legacyInlineBackgrounds.length, 10);
  for (const id of ['screen-contact-profile', 'screen-role-plans', 'screen-stage-personas', 'screen-discover', 'screen-me', 'screen-self-profile', 'screen-wallet', 'screen-pay', 'screen-chat-info', 'screen-moments']) {
    assert.ok(css.includes(`#${id} > .scroll`), `missing high-priority background override for ${id}`);
  }
  assert.match(css, /background:\s*var\(--wm-page\)\s*!important/);
});

test('reserves non-overlapping topbar action space and 44px primary targets', () => {
  assert.match(css, /\.top-left\s*,\s*\.top-right\s*\{[^}]*flex-basis:\s*96px/s);
  assert.match(css, /\.top-title\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.icon-btn\s*,\s*\.top-text-btn\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s);
});
```

- [ ] **Step 2: Run the test and confirm it fails on missing shared selectors**

Run `node --test tests/al-warm-modern-ui-contract.test.mjs`.

Expected: FAIL because the 10 retained inline backgrounds do not yet have screen-ID-scoped high-priority overrides and the real two-button top bar does not yet reserve 96px per side.

- [ ] **Step 3: Add the complete shared shell override**

Append to `tavern-app/warm-modern.css`:

```css
html, body { background: #dedbd4; color: var(--wm-text); }
#app, .screen, .page-pad, .form { background: var(--wm-page); }
#screen-contact-profile > .scroll,
#screen-role-plans > .scroll,
#screen-stage-personas > .scroll,
#screen-discover > .scroll,
#screen-me > .scroll,
#screen-self-profile > .scroll,
#screen-wallet > .scroll,
#screen-pay > .scroll,
#screen-chat-info > .scroll,
#screen-moments > .scroll { background: var(--wm-page) !important; }
.topbar {
  height: 56px;
  padding: 0 16px;
  background: rgba(250, 248, 243, 0.97);
  border-color: var(--wm-line);
  color: var(--wm-text);
  backdrop-filter: saturate(130%) blur(14px);
}
.top-left, .top-right { width: auto; flex: 0 0 96px; flex-basis: 96px; min-width: 0; }
.top-title { flex: 1 1 auto; min-width: 0; font-weight: 650; letter-spacing: 0.01em; }
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
- Consumes: existing `.chat-scroll`, `.chat-list`, `.msg-wrap`, `.bubble`, `.composer`, `.composer-tool`, `.chat-input`, `.send`, `.message-failed`, `.contact-*`, `.profile-*`, and `.chat-info-*` markup.
- Produces: the approved intimate chat appearance and quieter person-detail hierarchy.

- [ ] **Step 1: Add failing relationship-surface assertions**

```js
test('styles chat and relationship surfaces without backstage conversation labels', () => {
  for (const selector of ['.chat-scroll', '.msg-wrap:not(.me) .bubble', '.msg-wrap.me .bubble', '.composer', '.composer-tool', '.chat-input', '.send', '.message-failed', '.contact-profile-head', '.chat-info-advanced']) {
    assert.ok(css.includes(selector), `missing ${selector}`);
  }
  assert.match(css, /\.msg-wrap\.me \.bubble\s*\{[^}]*background:\s*var\(--wm-outgoing\)/s);
  for (const deadSelector of ['.chat-composer', '.chat-tool', '.chat-send']) {
    assert.ok(!css.includes(deadSelector), `dead selector must not be an acceptance anchor: ${deadSelector}`);
  }
  assert.match(css, /\.composer-tool\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s);
  assert.match(css, /\.send\s*\{[^}]*min-height:\s*44px/s);
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
.composer { background: var(--wm-surface); border-color: var(--wm-line); }
.chat-input { min-height: 40px; border-radius: 12px; background: var(--wm-card); }
.composer-tool { width: 44px; height: 44px; min-width: 44px; min-height: 44px; border-radius: 12px; }
.send { min-width: 56px; min-height: 44px; height: 44px; border-radius: 12px; background: var(--wm-jade); color: #fff; }
.send.inactive { background: #d8ddd9; color: var(--wm-muted); }
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
- Consumes: existing `.moment`, `.moments-*`, `.moment-compose`, `.moment-reply-bar`, `.wx-icon`, `.wallet-note`, `.pay-target`, `.pay-amount-box`, `.pay-input`, `.pay-note-input`, `#screen-import .page-pad`, `#screen-import .cell`, `.form`, `.plan-card`, `.memory-*`, `.diagnostic-*`, and `.stage-*` components.
- Produces: consistent secondary pages while leaving memory evidence and diagnostic detail intact.

- [ ] **Step 1: Add failing secondary-page assertions**

```js
test('styles every real secondary-page surface including wallet, pay, moments, and import', () => {
  const requiredSelectors = [
    '.moment', '.moments-cover', '.moment-compose', '.moment-reply-bar',
    '.wx-icon', '.wallet-note', '.pay-target', '.pay-amount-box', '.pay-input', '.pay-note-input',
    '#screen-import .page-pad', '#screen-import .cell', '.form', '.plan-card',
    '.memory-section-title', '.diagnostic-item', '.stage-history-item'
  ];
  for (const selector of requiredSelectors) {
    const className = [...selector.matchAll(/\.([a-z0-9-]+)/gi)].at(-1)?.[1];
    assert.match(html, new RegExp(`class=["'][^"']*\\b${className}\\b`), `selector is not backed by source markup: ${selector}`);
    assert.ok(css.includes(selector), `missing ${selector}`);
  }
  assert.match(css, /\.moment-compose-actions button\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.moment-reply-bar button\s*\{[^}]*min-height:\s*44px/s);
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
.moment { background: var(--wm-card); border-color: var(--wm-line); }
.moment-name, .moment-comment b { color: var(--wm-jade); }
.moment-reactions { background: #f0f3ef; color: var(--wm-jade); }
.moment-compose, .moment-reply-bar { background: var(--wm-surface); border-color: var(--wm-line); }
.moment-compose-actions button { min-height: 44px; border-radius: 10px; }
.moment-reply-bar button { min-height: 44px; border-radius: 10px; }
.moment-compose-actions .send-moment, .moment-reply-bar .send-moment { background: var(--wm-jade); color: #fff; }
.form { padding-top: 12px; background: var(--wm-page); }
.input, .textarea, .select { color: var(--wm-text); }
.input::placeholder, .textarea::placeholder { color: var(--wm-faint); }
#screen-import .scroll, #screen-import .page-pad { background: var(--wm-page); }
#screen-import .page-pad { padding-top: 12px; }
#screen-import .cell { border-color: var(--wm-line); }
#screen-import button.cell:active { background: #edf3ef; }
.wallet-note { color: var(--wm-muted); }
#screen-wallet .scroll, #screen-pay .scroll { background: var(--wm-page); }
.pay-target, .pay-amount-box { background: var(--wm-card); }
.pay-target-note, .pay-balance { color: var(--wm-muted); }
.pay-amount-line { border-color: var(--wm-line); }
.pay-input { color: var(--wm-text); }
.pay-note-input { min-height: 44px; }
.plan-card { background: var(--wm-card); }
.plan-card-meta, .stage-meta, .stage-history-meta { color: var(--wm-muted); }
.plan-card-actions button { min-height: 44px; border-radius: 10px; background: #eff2ee; }
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
  for (const selector of ['.icon-btn, .top-text-btn', '.search-box, .search-field', '.primary', '.secondary, .inline-btn', '.composer-tool', '.send', '.voice-hold', '.batch-finish', '.moment-compose-actions button', '.moment-reply-bar button']) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(css, new RegExp(`${escaped}\\s*\\{[^}]*(?:min-width|min-height|width|height):\\s*(?:4[4-9]|[5-9]\\d)px`, 's'), `missing 44px target for ${selector}`);
  }
  assert.match(css, /@media\s*\(max-width:\s*380px\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /#screen-(?:wallet|pay|import)\s+\.scroll/);
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
.plus-item, .message-action-sheet button { min-height: 48px; }
.search-box, .search-field { min-height: 44px; }
.search-cancel { min-width: 44px; min-height: 44px; }
.voice-hold, .batch-finish { min-height: 44px; }
button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, [tabindex]:focus-visible {
  outline: 2px solid var(--wm-jade);
  outline-offset: 2px;
}
button, .tab, .row, .cell { touch-action: manipulation; }

@media (max-width: 380px) {
  .topbar { padding: 0 12px; }
  .top-left, .top-right { width: auto; flex-basis: 96px; }
  .row { padding-left: 12px; padding-right: 12px; }
  .bubble { max-width: 78%; font-size: 15px; }
  .cell-label { width: 82px; }
  .composer { gap: 4px; padding-left: 6px; padding-right: 6px; }
  .composer-tool { width: 44px; min-width: 44px; }
  .send { min-width: 52px; padding-left: 8px; padding-right: 8px; }
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

### Task 6: Enforce Browser QA with 57 CDP Screen/Viewport Probes

**Files:**
- Create: `scripts/audit-warm-modern-ui-cdp.mjs`
- Modify: `tests/al-warm-modern-ui-contract.test.mjs`
- Modify if required by observed defects: `tavern-app/warm-modern.css`
- Create: `artifacts/verification/al-warm-modern-ui-browser-audit.json`

**Interfaces:**
- Consumes: the complete web build from Tasks 1-5, a Chrome DevTools endpoint supplied with `--cdp`, and either a fresh hosted origin supplied with `--url` or an installed Android WebView target supplied with `--target-url-prefix`.
- Produces: exactly 57 sanitized results (`19 screens * 3 viewports`), explicit boundary metrics, and a non-zero process exit on any failed screen.

- [ ] **Step 1: Write the failing CDP audit-runner contract**

Add to `tests/al-warm-modern-ui-contract.test.mjs`:

```js
const auditScript = readFileSync('scripts/audit-warm-modern-ui-cdp.mjs', 'utf8');

test('pins one reusable 57-probe CDP audit matrix', () => {
  for (const screen of [
    'screen-chats', 'screen-search', 'screen-chat', 'screen-chat-info',
    'screen-contacts', 'screen-contact-profile', 'screen-discover', 'screen-moments',
    'screen-me', 'screen-self-profile', 'screen-settings', 'screen-import',
    'screen-role-plans', 'screen-stage-personas', 'screen-memory', 'screen-memory-edit',
    'screen-diagnostics', 'screen-wallet', 'screen-pay'
  ]) assert.ok(auditScript.includes(`'${screen}'`), `missing CDP screen ${screen}`);
  for (const viewport of ['360x800', '393x873', '520x900']) {
    assert.ok(auditScript.includes(`'${viewport}'`), `missing CDP viewport ${viewport}`);
  }
  assert.match(auditScript, /expectedProbeCount\s*=\s*57/);
  for (const boundary of ['horizontalOverflow', 'viewportClipping', 'topbarOverlap', 'scrollTopReachable', 'scrollBottomReachable', 'footerClipping', 'touchTargetFailures']) {
    assert.ok(auditScript.includes(boundary), `missing CDP boundary ${boundary}`);
  }
});
```

Run `node --test tests/al-warm-modern-ui-contract.test.mjs`.

Expected: FAIL because `scripts/audit-warm-modern-ui-cdp.mjs` does not exist.

- [ ] **Step 2: Implement the reusable CDP matrix runner**

Create `scripts/audit-warm-modern-ui-cdp.mjs`. It must accept:

```text
--cdp http://127.0.0.1:<port>
--url <fresh-hosted-origin>                 # hosted mode
--target-url-prefix https://localhost       # installed WebView mode
--output <json-path>
```

Define these exact constants and refuse to write a passing record unless all 57 unique pairs are present:

```js
const screens = [
  'screen-chats', 'screen-search', 'screen-chat', 'screen-chat-info',
  'screen-contacts', 'screen-contact-profile', 'screen-discover', 'screen-moments',
  'screen-me', 'screen-self-profile', 'screen-settings', 'screen-import',
  'screen-role-plans', 'screen-stage-personas', 'screen-memory', 'screen-memory-edit',
  'screen-diagnostics', 'screen-wallet', 'screen-pay'
];
const viewports = [
  { key: '360x800', width: 360, height: 800 },
  { key: '393x873', width: 393, height: 873 },
  { key: '520x900', width: 520, height: 900 }
];
const expectedProbeCount = 57;
```

For each pair, use `Emulation.setDeviceMetricsOverride`, activate only the requested `.screen`, await two animation frames, and collect these exact fields:

```js
{
  horizontalOverflow,      // document, #app, active screen and active .scroll fit width (+1px tolerance)
  viewportClipping,        // #app and active screen stay inside left/right/top/bottom viewport edges
  topbarOverlap,           // .top-title never intersects visible .top-left/.top-right children
  scrollTopReachable,      // active .scroll returns to scrollTop === 0
  scrollBottomReachable,   // active .scroll reaches scrollHeight-clientHeight (+1px tolerance)
  footerClipping,          // visible .tabbar/.composer/.moment-reply-bar stays inside viewport
  touchTargetFailures      // visible named primary controls whose width and height are both below 44px
}
```

The named primary-control set is `.icon-btn`, `.top-text-btn`, `.search-cancel`, `.primary`, `.secondary`, `.inline-btn`, `.composer-tool`, `.send`, `.voice-hold`, `.batch-finish`, `.moment-compose-actions button`, `.moment-reply-bar button`, `.plus-item`, and `.message-action-sheet button`. The runner must also fail when `warm-modern.css` is absent from `document.styleSheets`, or when the computed background of a themed active screen/scroll remains legacy `rgb(237, 237, 237)`.

Before the first hosted probe, call CDP `Storage.clearDataForOrigin`, unregister every service worker and delete every Cache Storage entry in page context, then call `Page.reload` with `ignoreCache: true`. Never accept a result from a previously cached service worker.

- [ ] **Step 3: Start on a fresh origin and run all 57 hosted probes**

Use a port not used by an earlier preview:

```powershell
$env:PORT='41873'
npm.cmd start
```

In a second terminal, attach to a Chrome DevTools endpoint, open `http://127.0.0.1:41873/?warm-modern-audit=1`, and run:

```powershell
node scripts/audit-warm-modern-ui-cdp.mjs --cdp http://127.0.0.1:9223 --url http://127.0.0.1:41873/?warm-modern-audit=1 --output artifacts/verification/al-warm-modern-ui-browser-audit.json
```

Expected: `57/57 probes passed`; the JSON has `probeCount: 57`, `expectedProbeCount: 57`, 19 unique screen IDs, all three viewports, `failedProbes: []`, and no page text, chat contents, tokens, or secrets.

- [ ] **Step 4: Apply only evidence-backed CSS corrections and rerun tests**

For every failure, record the viewport, screen ID, failing boundary, and numeric rectangles before editing. Patch only `tavern-app/warm-modern.css`, then run:

```powershell
node --test tests/al-warm-modern-ui-contract.test.mjs tests/yuqi-ui-contract.test.mjs
node test-basic.mjs
node scripts/audit-warm-modern-ui-cdp.mjs --cdp http://127.0.0.1:9223 --url http://127.0.0.1:41873/?warm-modern-audit=1 --output artifacts/verification/al-warm-modern-ui-browser-audit.json
```

Expected after every correction: focused tests PASS and the full matrix prints `57/57 probes passed`. A manual glance is supplementary and cannot replace this result.

- [ ] **Step 5: Validate the sanitized browser evidence**

The runner creates `artifacts/verification/al-warm-modern-ui-browser-audit.json` with this minimum shape and actual per-probe results:

```json
{
  "schemaVersion": 1,
  "viewports": ["360x800", "393x873", "520x900"],
  "screenCount": 19,
  "probeCount": 57,
  "expectedProbeCount": 57,
  "aggregateFailures": {
    "horizontalOverflow": 0,
    "viewportClipping": 0,
    "topbarOverlap": 0,
    "footerClipping": 0,
    "touchTargetFailures": 0
  },
  "backstageConversationRows": 0,
  "failedProbes": [],
  "chatContentsIncluded": false
}
```

Run:

```powershell
node -e "const a=JSON.parse(require('fs').readFileSync('artifacts/verification/al-warm-modern-ui-browser-audit.json','utf8')); if(a.probeCount!==57||a.expectedProbeCount!==57||a.failedProbes.length) process.exit(1); console.log('browser audit 57/57')"
```

Expected: `browser audit 57/57`.

- [ ] **Step 6: Commit the visual QA corrections and record**

```powershell
git add scripts/audit-warm-modern-ui-cdp.mjs tests/al-warm-modern-ui-contract.test.mjs tavern-app/warm-modern.css artifacts/verification/al-warm-modern-ui-browser-audit.json
git commit -m "test: enforce 57-screen AL visual audit"
```

---

### Task 7: Build and Verify the Exact 1.0.73 Android Artifact

**Files:**
- Modify: `tavern-app/index.html:1325`
- Modify: `test-basic.mjs:174`
- Modify: `android/app/build.gradle:10-11`
- Create: `artifacts/verification/al-warm-modern-ui-android-audit.json`
- Create: `artifacts/verification/al-warm-modern-ui-verification.json`
- Create: `artifacts/AL-1.0.73-warm-modern-ui-verified.apk`

**Interfaces:**
- Consumes: verified web resources and existing Android signing configuration.
- Produces: the exact signed, install-tested version-73 APK, source/Capacitor/APK asset-hash equality, a second 57-probe audit against the installed APK, and a sanitized evidence record.

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
node --test tests/al-warm-modern-ui-contract.test.mjs
npm.cmd run yuqi:verify
npm.cmd test
```

Expected: the new warm-modern contract test explicitly PASSes, followed by every Yuqi verification gate and regression test. Do not infer that `npm.cmd test` includes the new file unless `package.json` is separately changed and verified.

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

- [ ] **Step 6: Verify package, signature, and source/Capacitor/APK hash identity**

Run:

```powershell
& 'C:\Users\PC\AppData\Local\Android\Sdk\build-tools\36.0.0\aapt.exe' dump badging 'artifacts\AL-1.0.73-warm-modern-ui-verified.apk'
& 'C:\Users\PC\AppData\Local\Android\Sdk\build-tools\36.0.0\apksigner.bat' verify --print-certs 'artifacts\AL-1.0.72-yuqi-async-verified.apk'
& 'C:\Users\PC\AppData\Local\Android\Sdk\build-tools\36.0.0\apksigner.bat' verify --print-certs 'artifacts\AL-1.0.73-warm-modern-ui-verified.apk'
Get-FileHash -Algorithm SHA256 -LiteralPath 'artifacts\AL-1.0.73-warm-modern-ui-verified.apk'

$artifactPath = (Resolve-Path 'artifacts\AL-1.0.73-warm-modern-ui-verified.apk').Path
$extractRoot = Join-Path ([IO.Path]::GetTempPath()) ('al-apk-assets-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $extractRoot | Out-Null
Push-Location $extractRoot
& "$env:JAVA_HOME\bin\jar.exe" xf $artifactPath assets/public/index.html assets/public/warm-modern.css
Pop-Location

$assetHashes = foreach ($asset in @('index.html', 'warm-modern.css')) {
  $source = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path 'tavern-app' $asset)).Hash
  $capacitor = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path 'android\app\src\main\assets\public' $asset)).Hash
  $apk = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $extractRoot (Join-Path 'assets\public' $asset))).Hash
  if ($source -ne $capacitor -or $source -ne $apk) { throw "asset hash mismatch: $asset" }
  [pscustomobject]@{ asset = $asset; source = $source; capacitor = $capacitor; apk = $apk }
}
$assetHashes | Format-Table
```

Expected: package `com.siyi.al`, version 73/1.0.73, the same signer certificate digest as 1.0.72, and identical source/Capacitor/APK SHA-256 values for both `index.html` and `warm-modern.css`.

- [ ] **Step 7: Install the exact delivery APK and rerun the same 57 probes inside its WebView**

Run:

```powershell
$adb = 'C:\Users\PC\AppData\Local\Android\Sdk\platform-tools\adb.exe'
& $adb -s emulator-5554 install -r 'artifacts\AL-1.0.73-warm-modern-ui-verified.apk'
& $adb -s emulator-5554 shell dumpsys package com.siyi.al
& $adb -s emulator-5554 shell am force-stop com.siyi.al
& $adb -s emulator-5554 shell monkey -p com.siyi.al -c android.intent.category.LAUNCHER 1
Start-Sleep -Seconds 3

$webviewSocket = (((& $adb -s emulator-5554 shell cat /proc/net/unix) | Select-String 'webview_devtools_remote' | Select-Object -Last 1).Line -split '\s+')[-1].TrimStart('@')
if (-not $webviewSocket) { throw 'Android WebView CDP socket not found' }
& $adb -s emulator-5554 forward tcp:9224 "localabstract:$webviewSocket"
node scripts/audit-warm-modern-ui-cdp.mjs --cdp http://127.0.0.1:9224 --target-url-prefix https://localhost --output artifacts/verification/al-warm-modern-ui-android-audit.json
```

After the automated matrix, manually press Android Back once from a secondary page and once from the chat page to verify the existing navigation contract; do not clear app data.

Expected: upgrade succeeds without clearing data; `versionCode=73`, `versionName=1.0.73`; the audit prints `57/57 probes passed` against the installed delivery APK; `al-warm-modern-ui-android-audit.json` has `probeCount: 57`, `failedProbes: []`; Android Back returns to the expected parent without a crash.

- [ ] **Step 8: Write the final sanitized verification record**

Using `apply_patch`, create `artifacts/verification/al-warm-modern-ui-verification.json` with `schemaVersion: 1`; a `release` object containing package `com.siyi.al`, version 73/1.0.73, the delivery artifact path, the exact uppercase SHA-256 printed by Step 6, and `signingCertificateMatchedPreviousApk: true`; an `assetHashes` array containing `index.html` and `warm-modern.css`, with identical `source`, `capacitor`, and `apk` SHA-256 values copied from Step 6; a `ui` object containing 19 screens, 3 passed viewports, `hostedProbeCount: 57`, `installedApkProbeCount: 57`, zero boundary failures, zero horizontal overflow, and zero backstage conversation rows; a `tests` object recording the explicit new contract command plus zero regression and Yuqi-verifier failures and `exactApkSmoke: "passed"`; and a `privacy` object setting chat-content, secret, and internal-reasoning inclusion to `false`.

Run `node -e "JSON.parse(require('fs').readFileSync('artifacts/verification/al-warm-modern-ui-verification.json','utf8')); console.log('verification json valid')"`.

Expected: `verification json valid`.

- [ ] **Step 9: Commit the release evidence**

```powershell
git add tavern-app/index.html test-basic.mjs android/app/build.gradle tests/al-warm-modern-ui-contract.test.mjs scripts/audit-warm-modern-ui-cdp.mjs artifacts/verification/al-warm-modern-ui-browser-audit.json artifacts/verification/al-warm-modern-ui-android-audit.json artifacts/verification/al-warm-modern-ui-verification.json
git commit -m "release: verify AL warm modern 1.0.73"
```

Expected: only intended UI/release files are staged; unrelated dirty files remain untouched.
