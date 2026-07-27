# Chat Render Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven development and execute this plan inline task-by-task.

**Goal:** Keep long Yuqi conversations responsive without deleting or changing any stored history.

**Architecture:** Store all messages exactly as today, but select a bounded tail for DOM rendering and grow it on demand. Use delegated message actions and suppress native-poll persistence when only invisible elapsed counters changed.

**Tech Stack:** Browser JavaScript, HTML/CSS, Node test runner, Capacitor Android WebView.

## Global Constraints

- Initial render window: 120 visible messages.
- Expansion page: 120 visible messages.
- Full history remains available to storage, search, memory, export, and AI context.
- No new runtime dependency.

---

### Task 1: Window selection

**Files:**
- Modify: `tests/yuqi-ui-contract.test.mjs`
- Modify: `tavern-app/index.html`

- [ ] Add a failing executable test that evaluates `chatRenderWindow` against 1,900 messages.
- [ ] Verify the test fails because the helper and constants do not exist.
- [ ] Add `CHAT_RENDER_WINDOW_SIZE`, `chatRenderLimits`, `chatRenderWindow`, and `loadOlderChatMessages`.
- [ ] Make `renderMessages` render the selected window and prepend a load-older button.
- [ ] Reset the limit when `openChat` opens a conversation.
- [ ] Run the focused contract suite and verify it passes.

### Task 2: Delegated message actions

**Files:**
- Modify: `tests/yuqi-ui-contract.test.mjs`
- Modify: `tavern-app/index.html`

- [ ] Add a failing contract asserting one container-level event set and no `querySelectorAll(...).forEach` binding loop.
- [ ] Verify failure against the current listener implementation.
- [ ] Replace the loop with idempotent delegated pointer/context handlers using `closest('[data-message-id]')`.
- [ ] Run the focused suite and verify it passes.

### Task 3: Polling no-op detection

**Files:**
- Modify: `tests/yuqi-ui-contract.test.mjs`
- Modify: `tavern-app/index.html`

- [ ] Add an executable test for `nativePendingStateIsCurrent` where only elapsed counters differ.
- [ ] Verify it fails because elapsed counters currently invalidate equality.
- [ ] Remove elapsed counters from visible-state equality while keeping state, route, stage, model, effort, and display copy comparisons.
- [ ] Run focused tests and verify they pass.

### Task 4: Verification

- [ ] Run `node --test tests/yuqi-ui-contract.test.mjs`.
- [ ] Run `npm.cmd test`.
- [ ] Inspect the diff to ensure no storage, search, memory, prompt, or delivery behavior changed.
- [ ] Build the Android target in the clean formal pipeline when publishing the next signed APK.
