# Chat Quote and Player Moment Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add correctly attributed chat quotes and safe deletion of the player's own moments across UI, native bridge context, persistence, memory, and asynchronous moment interactions.

**Architecture:** Keep the persisted chat message and moment arrays as the source of truth. A focused quote snapshot/serialization layer supplies UI and AI context without duplicating speech, while a focused player-moment deletion function removes the moment before any asynchronous completion can commit and relies on an existence guard to reject late results.

**Tech Stack:** Vanilla HTML/CSS/JavaScript PWA in `tavern-app`, Capacitor Android wrapper, Node `vm` regression tests in `test-basic.mjs`, Gradle Android unit tests, GitHub Actions signed APK workflow.

## Global Constraints

- Only visible, non-retracted assistant messages in the current chat are quoteable.
- Quote attribution must carry `speakerType="assistant"`, the exact character ID, and a sent-time text snapshot.
- Quote snapshots survive source-message deletion and character renaming.
- Only real moments with `authorType="player"` may be deleted.
- Characters who already saw or interacted with a deleted moment retain that experience; unseen characters gain no moment or deletion memory.
- Late asynchronous interaction results for a deleted moment must never write likes, comments, seen state, or memory.
- Deletion must not invoke chat AI or memory AI.
- The delivered APK must retain package `com.siyi.al` and the original signing certificate.

---

### Task 1: Quote Snapshot and AI Serialization Domain

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `test-basic.mjs`

**Interfaces:**
- Consumes: existing `messageAvailableToAI(message)`, `messageById(chat, messageId)`, `formatMoney(amount)`, `charName(char)`, and `sceneMessagesForAI(chat, count, options)`.
- Produces: `buildMessageQuote(message, char) -> Quote|null`, `quoteContextText(quote) -> string`, `messageContentForAI(message) -> string`, and quote-aware `messageLine(message, char) -> string`.

- [ ] **Step 1: Write failing domain tests**

Add assertions in `test-basic.mjs` that exercise real exported functions:

```js
const quotedText = buildMessageQuote(
  { id: 'a1', role: 'assistant', content: '我会记得这件事', time: 10 },
  { id: 'yuqi', name: '虞栖' }
);
assert.deepEqual(quotedText, {
  messageId: 'a1', speakerId: 'yuqi', speakerType: 'assistant',
  speakerName: '虞栖', contentType: 'text', content: '我会记得这件事'
});
assert.equal(buildMessageQuote({ id: 'u1', role: 'user', content: '我说的' }, { id: 'yuqi', name: '虞栖' }), null);
assert.match(quoteContextText(quotedText), /speakerType=assistant/);
assert.match(quoteContextText(quotedText), /speakerId=yuqi/);
assert.match(messageContentForAI({ role: 'user', content: '那你记住', quote: quotedText }), /用户本次正文：那你记住/);
assert.match(messageLine({ role: 'user', content: '那你记住', time: 20, quote: quotedText }, { id: 'yuqi', name: '虞栖' }), /虞栖原话/);
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node test-basic.mjs`  
Expected: FAIL because `buildMessageQuote`, `quoteContextText`, and `messageContentForAI` are undefined or unexported.

- [ ] **Step 3: Implement the minimal quote domain**

Add focused functions next to message helpers in `tavern-app/index.html`:

```js
function buildMessageQuote(message, char) {
  if (!message || message.role !== 'assistant' || !messageAvailableToAI(message) || message.hidden) return null;
  const type = message.type || message.payType || 'text';
  const content = type === 'voice'
    ? (String(message.transcript || '').trim() || '[语音]')
    : ['redpacket', 'transfer'].includes(type)
      ? `${type === 'redpacket' ? '红包' : '转账'} ${formatMoney(message.amount)}${message.note ? `，${message.note}` : ''}`
      : String(message.content || '').trim();
  if (!content) return null;
  return {
    messageId: String(message.id || ''),
    speakerId: String(char?.id || ''),
    speakerType: 'assistant',
    speakerName: charName(char),
    contentType: type,
    content
  };
}
function quoteContextText(quote) {
  if (!quote?.content || quote.speakerType !== 'assistant') return '';
  return `【引用元数据｜speakerType=assistant｜speakerId=${quote.speakerId}｜speakerName=${quote.speakerName}】${quote.speakerName}原话：${quote.content}`;
}
function messageContentForAI(message) {
  const body = String(message?.content || '');
  const quote = quoteContextText(message?.quote);
  return quote ? `${quote}\n用户本次正文：${body}` : body;
}
```

Use `messageContentForAI(m)` in `sceneMessagesForAI`, the native memory recent-history text, visible-history ingestion content, and `messageLine`. Do not add another message row for the quoted source.

- [ ] **Step 4: Export helpers for the existing VM test harness**

Add the three helpers to `context.__appTest`'s destructured export list so tests call production code.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `node test-basic.mjs`  
Expected: PASS, including attribution assertions.

- [ ] **Step 6: Commit the domain behavior**

```powershell
git add -- tavern-app/index.html test-basic.mjs
git commit -m "feat: preserve attributed chat quote context"
```

---

### Task 2: Quote Selection, Rendering, Send, Retry, and Native Bridge

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `tavern-app/warm-modern.css`
- Modify: `test-basic.mjs`

**Interfaces:**
- Consumes: Task 1 `buildMessageQuote`, existing long-press menu, staged batching, `queueAndroidUserReply`, and retry flow.
- Produces: `selectMessageQuote(charId, messageId) -> boolean`, `clearSelectedQuote()`, `renderQuotePreview()`, `renderQuoteCard(quote) -> string`, and optional `quote` on persisted user messages and native `inputJson.message`.

- [ ] **Step 1: Write failing selection and transport tests**

Add assertions proving:

```js
assert.match(html, /id="chat-quote-preview"/);
assert.match(script, /onclick="selectSelectedMessageQuote\(\)"/);
assert.match(script, /stagePlayerMessage\(chat, text, \{ quote/);
assert.match(script, /message:\s*\{[\s\S]*quote:\s*userMessage\.quote/);
```

Add a VM probe that sets a real assistant source message, calls `selectMessageQuote`, deletes the source, renders the sent user's `quote` snapshot, and asserts the quote card still contains the original name and content.

- [ ] **Step 2: Run tests and verify RED**

Run: `node test-basic.mjs`  
Expected: FAIL because quote preview, actions, selection state, and transport fields are absent.

- [ ] **Step 3: Add quote preview markup and state**

Add above `.composer`:

```html
<div class="chat-quote-preview" id="chat-quote-preview" hidden>
  <div class="chat-quote-preview-copy"><b id="chat-quote-name"></b><span id="chat-quote-text"></span></div>
  <button type="button" onclick="clearSelectedQuote()" aria-label="取消引用">×</button>
</div>
```

Add `let selectedMessageQuote = null;` beside existing message action state. Clear it whenever the active chat changes.

- [ ] **Step 4: Add quote selection and rendering behavior**

Implement selection using the current chat and character, revalidate immediately before send, and add “引用” to the assistant message action menu. Render the sent snapshot inside the user's bubble:

```js
function renderQuoteCard(quote) {
  if (!quote?.content) return '';
  return `<div class="message-quote"><b>${esc(quote.speakerName)}</b><span>${esc(quote.content)}</span></div>`;
}
```

`renderMessageBody(m)` must prepend the quote card to the user's ordinary message body without changing the source content.

- [ ] **Step 5: Persist quote on staged messages and clear only after staging succeeds**

In `sendMessage`, snapshot the validated selection and call:

```js
const quote = validatedSelectedQuote(requestCharId);
const staged = stagePlayerMessage(chat, text, quote ? { quote } : {});
if (staged) clearSelectedQuote();
```

Batch commit and retry already reuse the stored message. Extend native direct submit and native retry `inputJson.message` with `quote: userMessage.quote || null`; extend `buildAndroidUserReplyTask` options only if a consumer requires the field, avoiding a second source of truth.

- [ ] **Step 6: Add quote styles**

In `warm-modern.css`, add a compact preview above the composer and an inset quote card with subdued background, one-line/two-line ellipsis, clear attribution name, accessible close target, and dark-mode-compatible inherited colors. Keep existing composer height and safe-area padding behavior.

- [ ] **Step 7: Run focused and full tests**

Run: `node test-basic.mjs`  
Expected: PASS.

Run: `android\gradlew.bat testDebugUnitTest` from the project root or `gradlew.bat testDebugUnitTest` from `android`.  
Expected: BUILD SUCCESSFUL.

- [ ] **Step 8: Commit the complete quote UI and transport**

```powershell
git add -- tavern-app/index.html tavern-app/warm-modern.css test-basic.mjs
git commit -m "feat: add chat quote interaction"
```

---

### Task 3: Safe Player Moment Deletion

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `test-basic.mjs`

**Interfaces:**
- Consumes: existing `allMoments`, `saveMoments`, `momentNotificationFlights`, `runMomentNotification`, and `mirrorAppState`.
- Produces: `deletePlayerMoment(momentId) -> Promise<boolean>`, `confirmDeletePlayerMoment(momentId) -> Promise<boolean>`, and `momentStillCurrent(momentId, expectedMoment) -> boolean`.

- [ ] **Step 1: Write failing deletion tests**

Add direct VM tests:

```js
assert.equal(await deletePlayerMoment('player-moment'), true);
assert.equal(allMoments.some(row => row.id === 'player-moment'), false);
assert.equal(await deletePlayerMoment('char-moment'), false);
assert.equal(await deletePlayerMoment('missing'), false);
```

Seed the player moment with one `notifiedCharId` and one unseen character, delete it, and assert no new hidden chat messages are appended for either character. Start a deferred `callMomentInteractionAI`, delete before resolving it, resolve with `{like:true, comment:'迟到回复'}`, and assert the moment is not recreated and no memory event is appended.

- [ ] **Step 2: Run tests and verify RED**

Run: `node test-basic.mjs`  
Expected: FAIL because player-moment deletion and late-result guarding do not exist.

- [ ] **Step 3: Implement author-checked, idempotent deletion**

Add:

```js
function momentStillCurrent(momentId, expectedMoment) {
  return allMoments.find(moment => moment.id === momentId) === expectedMoment;
}
async function deletePlayerMoment(momentId) {
  const index = allMoments.findIndex(moment => moment.id === momentId && moment.authorType === 'player' && !moment.virtual);
  if (index < 0) return false;
  allMoments.splice(index, 1);
  saveMoments();
  mirrorAppState().catch(err => console.warn('[AL State] deleted moment mirror skipped:', err.message));
  return true;
}
```

Do not record a deletion event and do not invoke memory extraction.

- [ ] **Step 4: Guard every async interaction commit**

In `runMomentNotification`, retain the loaded `moment` object and check `momentStillCurrent(momentId, moment)` after each awaited AI call and before `notifyFailures`, likes, comments, memory events, saves, or memory extraction. If false, stop handling that target and return/continue without side effects.

- [ ] **Step 5: Add the moment action menu and confirmation**

Reuse the bottom action sheet with a distinct target type, or add a small focused moment action sheet. For player moments show “通知角色” and red “删除动态”; for character moments retain the comment action. Confirmation text must be:

```text
删除这条动态？朋友圈将不再显示，但已经看过的人仍可能记得。
```

The UI handler calls `deletePlayerMoment`, closes the sheet, and toasts “动态已删除” only when deletion succeeds.

- [ ] **Step 6: Run tests and verify GREEN**

Run: `node test-basic.mjs`  
Expected: PASS, including deferred late-result regression.

- [ ] **Step 7: Commit moment deletion behavior**

```powershell
git add -- tavern-app/index.html test-basic.mjs
git commit -m "feat: safely delete player moments"
```

---

### Task 4: Regression, APK Build, Signature Verification, and Handoff

**Files:**
- Modify only if a discovered regression requires it: `tavern-app/index.html`, `tavern-app/warm-modern.css`, `test-basic.mjs`, Android tests.
- Create: `artifacts/AL-1.0.<build>-release.apk`

**Interfaces:**
- Consumes: completed Tasks 1-3 and existing signed-build GitHub Actions workflow.
- Produces: a cover-installable, original-signed APK and recorded verification evidence.

- [ ] **Step 1: Run all JavaScript regressions**

Run: `node test-basic.mjs`  
Expected: all assertions pass with no uncaught errors.

- [ ] **Step 2: Run all Android unit tests**

Run: `android\gradlew.bat testDebugUnitTest`  
Expected: BUILD SUCCESSFUL.

- [ ] **Step 3: Inspect the exact diff**

Run:

```powershell
git diff --check
git status --short
git diff -- tavern-app/index.html tavern-app/warm-modern.css test-basic.mjs
```

Expected: no whitespace errors; unrelated user-owned deletions and untracked files remain untouched.

- [ ] **Step 4: Commit any final regression fix**

Stage only feature-owned files and commit with a scoped message. Never stage unrelated dirty-worktree files.

- [ ] **Step 5: Push `codex/al-tdd` and wait for signed build**

Run:

```powershell
git push origin codex/al-tdd
```

Monitor the triggered GitHub Actions run until success, then fetch `signed-builds` and restore the versioned APK into `artifacts/`.

- [ ] **Step 6: Verify package, version, signer, and checksum**

Run Android build tools `aapt dump badging`, `apksigner verify --print-certs`, and `Get-FileHash -Algorithm SHA256` against the delivered APK.

Expected:

- package: `com.siyi.al`
- signer certificate SHA-256: `5761277e3bdf4a64236c3bad569de6a07666581f643167d01e37f13e9e832b2b`
- versionCode greater than 74
- signature verification succeeds

- [ ] **Step 7: Deliver**

Provide a clickable absolute path to the APK, state that it can cover-install without uninstalling, summarize the quote and deletion behavior, and include the tested version and SHA-256.
