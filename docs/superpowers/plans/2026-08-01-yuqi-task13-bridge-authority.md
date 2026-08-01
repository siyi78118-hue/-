# Yuqi Task 13 Bridge Authority Closure Implementation Plan

> **For agentic workers:** Implement Task 13A, 13B, and 13C in order. Use
> test-driven development for every production change. Stop on a contradiction
> in an authority, transaction, migration, or production-composition boundary;
> ordinary failing tests are implementation work, not a stop condition.

**Goal:** Carry one verified conversation authority from Android submission,
through PC canonical commit and LAN/cloud projection, back into one atomic Room
completion without breaking protocol v1/v2, multi-bubble replies, actions,
retries, clear epochs, notifications, or restart recovery.

**Architecture:** Task 13A owns shared identities, protocol-v3 validation,
transactional claim verification, and one store-owned canonical bridge result.
Task 13B projects that same result for v2/v3 and wires LAN/cloud delivery and
group receipts. Task 13C prepares v3 authority immediately before Android sends,
parses the response, and applies receipt plus visible rows plus cursor in one
Room transaction. No transport or UI layer derives a group ID, checksum,
revision, release, or terminal disposition.

**Tech Stack:** Node.js ESM, SQLite, Android Java, Room v11, Capacitor bridge,
encrypted Cloudflare relay, `node:test`, Gradle JUnit and Android instrumentation
compilation.

## Global Constraints

- Services stay paused. Tests may start only process-local fixtures.
- Room remains version 11. Existing v11 columns are sufficient; no migration is
  added in Task 13.
- PC remains schema v14. Task 13 adds no PC schema column or table.
- Protocol v1 and historical result-authority-version-0 turns are byte- and
  behavior-compatible.
- Protocol v2 normalized envelopes are not mutated with synthetic zero cursors
  or authority objects; their persisted envelope checksum must remain stable.
- Protocol v3 requires a complete top-level authority claim and visibility
  cursor. The claim is verification evidence, never an authority-version or CAS
  selector.
- A fresh v3 turn must present `localSequence == persistedLane.localSequence +
  1`; an exact replay must equal its stored pin. Task 13 never accepts arbitrary
  jumps after a v3 pin exists. The sole migration exception is the first v3 turn
  on a lane: Android supplies its persisted v2 native/UI watermark, while PC
  verifies the referenced terminal turn/group identities, cursor-internal
  ordering, and the one-time lane CAS. PC v2 rows do not contain an independent
  Android native/UI sequence fact, so Task 13 must not pretend to compare that
  migration number with `turns.input_visibility_sequence`.
- A v3 clear epoch and `clearedThroughSequence` must exactly equal the PC lane
  clear authority. Any mismatch fails before writes with
  `CLEAR_EPOCH_SYNC_REQUIRED`; an ordinary turn may never create or advance a
  clear boundary, including during first-v3 bootstrap. Authenticated clear
  synchronization remains Task 20; services must not be released before Task 20
  closes it.
- `lineageRevision`, `turnRevision`, and `laneRevision` are independent values.
  Android must never copy one into another.
- A protocol-v3 result is built only from a validated receipt/group/lineage/
  lane/turn join. `reply_json` is never a v3 result fallback.
- A v2 response for a canonical internal turn is a projection of that same
  canonical group; it is not a second legacy result.
- Android `ChatTurn.turnId` is the local queue identity. The wire `turnId` is the
  PC authoritative turn identity. They are equal on the first attempt. Any
  unknown remote outcome reuses the complete prior remote envelope even if
  Android created a new local attempt; only a persisted validated PC terminal
  failure with no receipt authorizes a deterministic remote child ID. Never
  overwrite the local Room primary key with a remote retry ID.
- A canonical `skip` has a receipt and group identity but no visible/action rows
  and no notification. `action_only` has at least one action and no chat text.
- Cloud relay acceptance and native persistence are not UI application. A
  canonical delivery receipt is published only from the UI-applied confirmation
  path; draining the relay inbox may acknowledge the relay envelope but may not
  confirm PC visibility.
- Exact event, poll, cloud replay, process restart, and manual retry reuse stored
  identities. Any changed authority field returns `BRIDGE_AUTHORITY_CONFLICT`
  with zero cursor or visible-row changes.
- Preserve unrelated worktree changes. Stage only files listed under the active
  subtask.
- Raw envelopes have one validator, `validateEnvelope()`. LAN/cloud run it as a
  pure preflight before recovery reconciliation; `orchestrator.accept()`
  idempotently revalidates the immutable normalized value before rollout
  selection, lane/agency reads, routing, or turn persistence. Stored-turn
  recovery continues through its separate persisted-envelope path.

---

### Task 13A: Shared Identity, Protocol Claim, and Canonical Result

**Files:**

- Create: `yuqi-runtime/src/authority-identity.mjs`
- Create: `yuqi-runtime/src/bridge-result-projector.mjs`
- Modify: `yuqi-runtime/src/protocol.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Create: `yuqi-runtime/test/bridge-authority-v3.test.mjs`
- Modify: `yuqi-runtime/test/protocol-store.test.mjs`
- Modify: `yuqi-runtime/test/store-visible-authority-v13.test.mjs`
- Modify: `yuqi-runtime/test/v3-runtime-recovery.test.mjs`
- Read-only fixture: `tests/fixtures/authority-identity-v1.json`

**Interfaces:**

- `deriveAuthorityLineageKey({ roleId, laneKey, rootSourceId }) -> string`
- `deriveVisibleGroupId(lineageKey) -> string`
- `deriveVisibleMessageId(groupId, ordinal) -> string`
- `deriveVisibleActionId(groupId, ordinal) -> string`
- `validateEnvelope(raw) -> normalizedEnvelope`; v3 output contains verified
  `authority` and `context.visibilityCursor` but no `resultAuthorityVersion`.
- `store.loadCanonicalBridgeResultInternal(turnId) -> CanonicalBridgeResult`
  returns a closed, scoped result or throws on any join/checksum/count mismatch.
- `projectBridgeResultForWire(canonicalResult, wireVersion) -> object` is pure;
  Task 13B uses it for both LAN and cloud.

- [ ] **Step 1: Write and run identity/protocol red tests**

Add tests that:

```js
const v2Before = validateEnvelope(validProtocolV2Envelope());
assert.deepEqual(validateEnvelope(structuredClone(validProtocolV2Envelope())), v2Before);
assert.equal(Object.hasOwn(v2Before, 'authority'), false);
assert.equal(Object.hasOwn(v2Before.context, 'visibilityCursor'), false);

const v3 = validateEnvelope(validProtocolV3Envelope());
assert.equal(v3.authority.algorithm, 'al-authority-v1');
assert.equal(v3.context.visibilityCursor.localSequence, 13);
assert.equal(Object.hasOwn(v3, 'resultAuthorityVersion'), false);
```

Cover direct and every automatic kind. Automatic validation must not return
before checking the top-level cursor. V3 direct requires full
`currentBatch.messages`; `messageIds` must equal those messages by count, order,
and canonical ID, and the last normalized batch message must equal the complete
normalized top-level message projection, including speaker, recipient, and
attachments. V3 direct context accepts only `scene`, `currentBatch`, `retry`,
`payment`, and `visibilityCursor`; automatic top-level context accepts only
`visibilityCursor`. V1/v2 keep their existing normalization. Validate:

- `uiAppliedSequence <= nativeCompletedSequence < localSequence` for a fresh
  submission;
- for positive watermarks, equal native/UI sequence means equal turn/group
  identity, and the same canonical group identity cannot carry two sequences;
- `clearedThroughSequence <= localSequence`;
- canonical turn/group ID nullability is paired with sequence zero/nonzero. The
  first-v3 bootstrap alone may carry a verified legacy v2 turn anchor at
  sequence zero; its turn/group fallback IDs must be equal and the store, not
  shape validation, proves the referenced authority-version-0 terminal turn;
- `clearEpoch`, `clearedAt`, and every sequence are non-negative safe integers;
- `chatOpen` is a real boolean;
- authority keys are closed and role/lane/root/hash/retry are recomputed;
- top-level or nested `resultAuthorityVersion` is rejected.

Run:

```powershell
node --test yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/bridge-authority-v3.test.mjs
```

Expected red: protocol version 3 and shared identity imports are unavailable.

- [ ] **Step 2: Implement the shared byte algorithm and v3 shape validation**

Move the existing authority hash implementation out of `store.mjs` without
changing its bytes. Length prefixes use UTF-8 byte length, ordinals use decimal
ASCII, and output is lowercase SHA-256. Re-export all four existing helpers from
`store.mjs` so Task 10 consumers do not change imports.

Extend `validateEnvelope()` to accept only versions 1, 2, and 3. Do not create a
second normalization API. V3 derives:

```js
const rootSourceId = kind === 'DIRECT_REPLY'
  ? (normalized.context?.retry?.canonicalMessageId || normalized.message.messageId)
  : normalized.trigger.triggerId;
const laneKey = laneKeyForEnvelope(normalized);
const lineageKey = deriveAuthorityLineageKey({
  roleId: normalized.characterId,
  laneKey,
  rootSourceId
});
```

Payment source IDs use the existing `pay_* -> msg_pay_*` canonical mapping.
For a retry, the store additionally requires `canonicalMessageId`, the current
`message.messageId`, the current-batch source identity, and the parent lineage's
immutable `rootSourceId` to be identical. Only the remote retry turn ID changes;
Task 13 must not reopen Task 10's shared user-message/tombstone authority. Shape
validation compares the claimed lineage but does not read database state.

Move and compatibility-re-export all four existing byte algorithms (lineage,
group, visible message, visible action), not only the first two. The fixed
fixture is the authority for JavaScript and Java.

- [ ] **Step 3: Write transactional claim and result-builder red tests**

Persist real releases, rollout, lane, agency snapshot, and a three-message batch.
Cover:

```js
const first = createV3Canonical({ claimedLineageRevision: 1, localSequence: 1 });
assert.equal(first.turn.resultAuthorityVersion, 1);
assert.equal(first.turn.inputVisibilitySequence, 1);

assert.throws(
  () => createV3Canonical({ claimedLineageRevision: 4, localSequence: 2 }),
  /authority claim revision conflict/
);
assertZeroAuthorityWrites();

const retry = createV3Retry({
  retryOfTurnId: first.turn.turnId,
  claimedLineageRevision: first.lineage.revision + 1,
  localSequence: 2
});
assert.equal(retry.turn.authorityLineageKey, first.turn.authorityLineageKey);
```

Also cover exact same-turn replay, wrong latest parent, foreign lineage, changed
batch, cursor sequence jump, prior group ID mismatch, a clear watermark change
without authenticated Task 20 synchronization, and
`CLEAR_EPOCH_SYNC_REQUIRED`, each with a before/after database snapshot.
Add a retry whose remote turn ID changes while its current message,
`retry.canonicalMessageId`, batch source, and parent root remain identical. A
changed current or canonical message ID produces zero writes. Pass the same
normalized envelope to fresh creation and exact replay so no caller can silently
replace its cursor from the new lane state.

Cover a real bootstrap chain: completed authority-version-0 v2 history with a
legacy turn cursor, then the first v3 turn, restart, then a second v3 turn. The
first v3 claim may adopt prior native/UI watermarks only when every referenced
legacy turn/message belongs to the same role, device, and lane and is terminal;
its clear watermark must still equal PC clear authority. A
sequence-zero legacy fallback ID is allowed only in this branch. A prior
canonical group is validated through the ordinary group authority. Missing,
foreign, pending, or mixed anchors fail before writes. Once a v3 pin exists on
the lane, legacy bootstrap is permanently disabled.

For an open v3 lineage, a new retry member additionally requires the current
latest parent to be persistently `failed` with native boolean
`error_json.retryAllowed === true`. Queued/running parents, missing permission,
and forged non-boolean permission fail before writes. A committed or redacted
lineage still returns its existing outcome after immutable member validation and
does not require retry permission. A delayed child prepared before that terminal
transition keeps its historical claim: require
`claimedLineageRevision === parent.lineageRevisionAtCreation + 1`, not the now
advanced terminal lineage revision plus one. Changed parent, batch, pins, or
historical claim still fail before returning the terminal outcome. After a retry
commits, replaying the exact original member resolves the same receipt and
authoritative retry turn; it may not strand an at-least-once relay message by
insisting that the lookup member is the committed member.

Legacy automatic anchors use the same historical wire normalization as the turn
itself: local `cloud_*`/`plan_*` IDs map to `turn_cloud_*`/`turn_plan_*`. Native
and UI anchors are normalized independently because they may reference different
completed local turns.

Commit a real canonical result whose receipt revisions are deliberately
distinct (`lineageRevisionAfter=2`, `turnRevisionAfter=4`,
`laneRevisionAfter=8`). Assert the scoped bridge builder returns those exact
values, `releaseId` from the group release, fingerprint/sequence/epoch from the
closed turn/group, and disposition from the v13 validator. Corrupt each join,
count, checksum, and revision independently and require stable rejection.

Run:

```powershell
node --test yuqi-runtime/test/bridge-authority-v3.test.mjs yuqi-runtime/test/store-visible-authority-v13.test.mjs yuqi-runtime/test/v3-runtime-recovery.test.mjs
```

Expected red: claims are not checked transactionally and no closed bridge result
exists.

- [ ] **Step 4: Implement store-owned claim verification and result loading**

Inside the existing immediate canonical creation transaction:

1. Recompute role, lane, root, lineage, and retry parent.
2. For an exact turn replay, compare the complete stored claim and pinned cursor
   before returning.
3. For a first root, require claim revision 1 and no prior lineage.
4. For a retry, require `retryOfTurnId == current latestTurnId`, the same root and
   lineage, and claim revision exactly `current.revision + 1`.
5. Require matching clear epoch and cleared-through watermark for every v3
   creation. For an established v3 lane, require fresh
   `localSequence == lane.localSequence + 1` and prior native/UI identities that
   join retained canonical groups. For the first v3 turn only, verify the full
   authority-version-0/canonical-v2 bootstrap described in Step 3, require the
   fresh sequence to be exactly one above the internally consistent Android v2
   native/UI watermark, and adopt it without a separate migration write. Do not
   compare a canonical-v2 group to its PC input sequence as if that were an
   Android-applied watermark.
6. In the same lane CAS used by canonical creation, copy only the verified
   monotonic prior native/UI group watermarks from the cursor and advance
   `lane.localSequence` to the fresh pinned input sequence. This must not be a
   second lane write or a second revision increment.
7. Let the store calculate and write revisions; never use a claim as a caller CAS
   token and never accept an authority-version option.

For exact member replay, validate that member's complete immutable envelope and
pins first, then resolve a committed outcome by lineage. The receipt's
authoritative turn may be a later retry member. For a new member on an open v3
lineage, validate the persisted parent failure and `retryAllowed:true` before
the lineage/lane CAS, and require the claim to equal the current lineage revision
plus one. For a delayed child whose lineage is already committed or redacted,
validate the historical claim against the declared parent's
`lineageRevisionAtCreation + 1`, then return the existing outcome before open-
lineage retry permission and mutable lane checks. V2 retry behavior remains
unchanged.

`loadCanonicalBridgeResultInternal(turnId)` must join receipt, group, manifest,
lineage, lane, authoritative turn, ordered items, ordered actions, and release.
The input may name any original/retry member: resolve its lineage first, then use
the receipt's authoritative turn. Both original and retry polling must return the
same authoritative result. The returned `turnId` is always the receipt's
authoritative PC turn ID, never blindly the lookup argument.
Return exactly:

```js
{
  protocolVersion: 3,
  turnId,
  roleId,
  authorityOrigin,
  authorityLineageKey,
  visibleGroupId,
  lineageRevision,
  turnRevision,
  laneKey,
  laneRevision,
  inputVisibilitySequence,
  inputClearEpoch,
  generationFingerprint,
  releaseId,
  commitPayloadVersion,
  commitChecksum,
  terminalDisposition,
  replyParts, // each includes messageId, ordinal, itemChecksum, and semantic item
  actions     // each includes actionId, ordinal, actionChecksum, kind/target/payload
}
```

The three revisions come from the receipt's `*RevisionAfter` columns. This
loader performs one group-scoped validation and no full-database scan.

For a redacted canonical group, return only
`{status:'redacted',deliverable:false,turnId,authorityLineageKey,visibleGroupId,commitChecksum}`.
Do not load or reconstruct item/action semantics. The LAN projector returns 410
and the outbox cancels/quarantines the delivery; neither may fall back to
`reply_json`. Task 20 owns the remaining remote retraction lifecycle.

- [ ] **Step 5: Activate only validated v3 in the Task 11 orchestrator**

Make `orchestrator.accept(raw)` call `validateEnvelope(raw)` before any other
production operation, remove the temporary explicit v3 rejection, and change
canonical eligibility from `protocolVersion === 2` to the closed set `{2, 3}`.
Use only the normalized envelope for rollout selection, creation, routing, and
execution. Spy tests must prove malformed raw v3 performs zero rollout, lane,
agency, route, or store calls. Keep wire v1, non-Yuqi, and persisted version-0
recovery unchanged.

Run both Step 1 and Step 3 commands. Expected: green.

- [ ] **Step 6: Commit Task 13A**

Stage only the Task 13A files and commit:

```powershell
git commit -m "feat: verify v3 bridge authority claims"
```

---

### Task 13B: One Canonical Result Across LAN and Cloud

**Files:**

- Modify: `yuqi-runtime/src/bridge-result-projector.mjs`
- Modify: `yuqi-runtime/src/protocol.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/src/turn-status.mjs`
- Modify: `yuqi-runtime/src/local-server.mjs`
- Modify: `yuqi-runtime/src/cloud-relay-pump.mjs`
- Modify: `yuqi-runtime/src/result-outbox.mjs`
- Modify: `yuqi-runtime/test/bridge-authority-v3.test.mjs`
- Modify: `yuqi-runtime/test/local-server.test.mjs`
- Modify: `yuqi-runtime/test/cloud-relay-pump.test.mjs`
- Modify: `yuqi-runtime/test/result-outbox.test.mjs`

**Interfaces:**

- `publicTurnStatus(turn, { canonicalResult, stages, clock })` uses a closed
  canonical result when version 1 is terminal; version 0 retains its old parser.
- `validateAuthorityDeliveryReceipt(value)` validates one group receipt and
  permits zero items for `skip` because group checksum is the authority.
- `store.confirmAuthorityCloudDeliveryInternal(receipt, peerId)` confirms only
  the exact group/checksum already mailboxed for that peer.
- `store.confirmCanonicalV2DeliveryInternal(receipt, peerId)` maps a legacy
  receipt back to one canonical group and confirms only a complete exact
  projection; it never calls the authority-version-0 receipt writer.

- [ ] **Step 1: Write LAN/cloud red tests against real canonical commits**

Cover all of the following with real store rows, not mocked reply JSON:

- canonical internal v1 + wire v2 LAN POST/GET returns a real legacy `reply`
  projection and never reports `skip` when items exist;
- canonical internal v1 + wire v3 returns every receipt field, ordered
  `replyParts`, ordered `actions`, and no derived identity;
- v3 `visible`, `action_only`, and `skip` project distinctly;
- a broken receipt/group/item/action join returns 409/quarantine, never legacy
  fallback;
- CloudRelayPump accepts and acknowledges canonical v2/v3 input without calling
  legacy `registerCloudDelivery()`;
- canonical commit preserves `recoveryAckSeq` from the validated incoming
  recovery packet in its group delivery row;
- ResultOutbox sends v2 or v3 projection based on the persisted input wire
  version while using the same group and commit checksum;
- version-0 cloud and LAN paths are byte-compatible;
- malformed raw v3 is not ACKed and creates no turn; a terminal canonical join
  failure after durable acceptance keeps the input ACK, quarantines that group
  delivery with a diagnostic, emits no output, and never falls back to legacy;
- canonical-v2 three-message visible, every closed action kind, action-only, and
  skip follow the projection table below; old item/simple receipts are replay-
  safe and any partial or changed receipt conflicts.

Run:

```powershell
node --test yuqi-runtime/test/bridge-authority-v3.test.mjs yuqi-runtime/test/local-server.test.mjs yuqi-runtime/test/cloud-relay-pump.test.mjs yuqi-runtime/test/result-outbox.test.mjs
```

Expected red: canonical v2 cloud registration throws, LAN reads `reply_json`,
and the v3 receipt fields are incomplete.

- [ ] **Step 2: Implement one pure v2/v3 projector**

For wire v3, return the closed canonical result verbatim plus transport-only
relay metadata. For wire v2, use this deterministic compatibility table:

| Canonical result | Exact v2 projection |
| --- | --- |
| one or more text items | `replyParts` preserves every ordered item and ID; legacy `reply.content` is their content joined with one newline and uses the first item identity as a compatibility summary |
| actions | `actions` preserves every ordered canonical action and ID; also fill the existing payment/moment/relationship/role-plan fields by the closed action-kind map |
| `visible` | `terminal=true`, `action='send'`, exact `deliveryItems` for every canonical item/action |
| `action_only` | `terminal=true`, `action='send'`, `reply=null`, at least one exact action and delivery item; a Task13-capable Android treats structured action as committed even with no text |
| `skip` | `terminal=true`, `action='skip'`, `reply=null`, empty parts/actions/delivery items; no synthetic message |

The old summary is only a display compatibility field; Task13 Android prefers
exact `replyParts`/`actions`. Omit v3 revision/claim fields from v2. Never read
`reply_json` for a result-authority-version-1 turn. An old client that can only
send an itemized v1 receipt confirms a canonical group only when its item set is
exactly the complete persisted `deliveryItems`. A simple message receipt is
accepted only for exactly one text item and zero actions. An old v2 skip has no
item receipt and remains safely mailboxed (not resent); Task13 Android uses the
no-op applied path defined in 13C.

Both `local-server.mjs` and `result-outbox.mjs` must call the same projector.
In-progress turns continue to use ordinary nonterminal status without inventing
a committed result.

- [ ] **Step 3: Close canonical cloud registration and receipt routing**

After `dispatcher.accept()`:

```js
if (Number(turn.resultAuthorityVersion) === 0) {
  store.registerCloudDelivery(turn.turnId, peerId, recoveryAckSeq);
}
// version 1 commit creates its group-keyed delivery transactionally
```

LAN and cloud use one fixed order:

1. Run the pure `validateEnvelope(raw)` before any reconciliation or store read.
2. On that validated identity, require `raw.recovery.peerId ==
   normalized.deviceId` when recovery exists.
3. Reconcile and persist the monotonic acknowledgement in `sync_cursors`.
4. Pass the same immutable normalized envelope to `dispatcher.accept()`;
   `orchestrator.accept()` idempotently validates it again before its own reads.

Thus a malformed envelope, even with a valid peer, changes neither sync cursors
nor turns; and canonical execution cannot overtake reconciliation because the
turn does not exist until Step 4. At canonical commit, read the current sync
cursor for the authoritative turn's persisted device inside the commit
transaction and copy it into the group delivery row. This is intentionally a
maximum acknowledged sync watermark, so accept/restart/additional valid
reconciliation/later commit remain correct without a new schema field. Tests
must cover slow reconciliation, accept/restart/commit, a foreign peer, and an
invalid v3 with valid peer and zero total database changes.

Define the v3 applied receipt:

```json
{
  "protocolVersion": 3,
  "type": "AUTHORITY_DELIVERY_RECEIPT",
  "peerId": "phone",
  "turnId": "turn-id",
  "authorityLineageKey": "lin-id",
  "visibleGroupId": "grp-id",
  "commitChecksum": "sha256",
  "terminalDisposition": "visible|action_only|skip",
  "deliveredAt": 1700000000000
}
```

LAN accepts it at `/v3/groups/{visibleGroupId}/delivery-receipt`. CloudRelayPump
recognizes the same encrypted type. Closed-key validation includes `peerId`; the
store validates group, lineage, turn, peer, checksum, disposition, and mailboxed
state before confirming. Replays are idempotent; changed fields conflict. The v1
item receipt remains unchanged for authority-version-0 and is adapted through
`confirmCanonicalV2DeliveryInternal` for canonical-v2 as defined above.

For canonical terminal GET/POST, `local-server.mjs` first loads the scoped
canonical result and only then calls the pure projector. A corrupt live join is
HTTP 409 `CANONICAL_AUTHORITY_CONFLICT`; a redacted join is HTTP 410 and carries
no semantic result. Cloud projection failure marks only that delivery
`quarantined`, records a diagnostic, does not discard it, and never calls a
legacy result or delivery API. Invalid input/claim is not ACKed; a previously
durably accepted input remains ACKed even if its later output is quarantined.

- [ ] **Step 4: Run Task 13B gate green and commit**

Run the Step 1 command, then:

```powershell
node --test yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/v3-runtime-recovery.test.mjs
```

Stage only Task 13B files and commit:

```powershell
git commit -m "feat: project canonical bridge results across transports"
```

---

### Task 13C: Android v3 Preparation and Atomic Room Completion

**Files:**

- Modify: `android/app/src/main/java/com/siyi/al/execution/TurnSubmission.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/AuthorityIdentity.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/BridgeAuthority.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionEngine.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionEngineStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeInput.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeResult.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeTurnStatus.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeClient.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeRouter.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/RoomBridgeMirror.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/BridgeReceiptCheckpoint.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionRuntime.java`
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/AlExecutionService.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/AlNotificationPolicy.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeInputTest.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/AuthorityIdentityTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/ExecutionEngineTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/BridgeReceiptCheckpointTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeClientTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeRouterTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/RoomBridgeMirrorTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/AlNotificationPolicyTest.java`
- Modify: `android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`
- Modify: `android/app/src/androidTest/java/com/siyi/al/execution/ConversationCursorStoreTest.java`
- Modify: `tests/payment-batch-bridge-contract.test.mjs`

**Interfaces:**

- `ExecutionEngineStore.prepareBridgeSubmission(base, now) -> TurnSubmission`
  is a no-op for legacy input and an idempotent Room authority/cursor pin for a
  store-marked v3 turn.
- `ExecutionEngineStore.commitBridgedTerminal(turnId, attemptId, result, now) ->
  DeliveryDisposition` is the only v3 result writer.
- `ExecutionEngineStore.commitVerifiedRemoteFailure(turnId, attemptId, proof,
  now)` is the only authority that can make a later attempt create a remote
  child; it writes no receipt/group/cursor.
- `BridgeResult` carries immutable receipt fields plus ordered visible items and
  actions; it does not derive them from reply text. Its wire `turnId` is exposed
  as `authoritativeTurnId`; Room writes still use the separate local turn ID.

`TurnSubmission.turnId` remains the local Room identity for compatibility and a
new `authoritativeTurnId` is the v3 remote identity (equal to `turnId` for legacy
and the first attempt). BridgeInput wire turn ID, LAN expected result ID, cloud
relay message ID, and cloud idempotency key use only `authoritativeTurnId`.
Room turn/attempt writes, diagnostics, and raw user projection use only local
`turnId`. Therefore unknown-outcome replay has the same cloud key, while an
authorized remote child has a different key and cannot be deduplicated as its
parent.

- [ ] **Step 1: Write Android red tests for identities and outbound preparation**

`AuthorityIdentityTest` must load every vector in
`tests/fixtures/authority-identity-v1.json` and verify lineage, group, message,
and action IDs, including Chinese, emoji, empty text components, and large
ordinals. Java uses UTF-8 byte length, not `String.length()`.

`BridgeInputTest` and the real Room test must prove:

- a store-marked v3 direct three-bubble submission pins one cursor sequence and
  one lineage claim before network execution;
- exact process retry reuses both pins without incrementing;
- a retry authorized by a persisted PC terminal failure advances the authority
  revision exactly once and points to the persisted latest turn;
- a known PC terminal failure produces a cloud child with a new remote-derived
  relay/idempotency key, while an unknown-outcome new local attempt reuses the
  parent remote ID and identical cloud key;
- automatic root uses `triggerId`; direct/payment root uses canonical message ID;
- all current-batch messages and the full cursor are emitted;
- an old snapshot remains protocol v2 and receives no synthetic authority;
- a real Task12 cursor with sequence zero and non-null legacy fallback ID is
  normalized and accepted only for the first-v3 bootstrap;
- every automatic kind maps its completed local `cloud_*`/`plan_*` native and UI
  anchors to the historical PC wire IDs, including different anchors and restart.

There is no caller-controlled “cognition-v3 snapshot” flag. On insert,
`RoomExecutionStore.submitTurn()` removes any caller-supplied internal bridge
marker, then marks only newly inserted `characterId == 'yuqi'` turns with a
closed internal `bridgeProtocol=3` object in the persisted snapshot. Historical
rows without that store-owned marker remain v2 forever. Tests must prove a
forged marker cannot upgrade a non-Yuqi or existing turn.

Run red:

```powershell
cd android
.\gradlew.bat testDebugUnitTest --tests "*AuthorityIdentityTest" --tests "*BridgeInputTest" --tests "*ExecutionEngineTest" --no-daemon --no-problems-report
```

- [ ] **Step 2: Implement idempotent pre-route authority preparation**

Immediately before `gateway.executeBridgeTurn`, `ExecutionEngine` calls
`prepareBridgeSubmission`. In one Room transaction for a v3 snapshot:

1. Load/create the conversation cursor. Increment `localSequence` only when
   creating a fresh remote authority member; an unknown-outcome replay reuses
   the existing sequence.
2. Resolve each prior cursor anchor through its local `ChatTurnEntity`. For the
   first-v3 bootstrap, normalize automatic `cloud_*`/`plan_*` IDs with the
   existing BridgeInput wire rule; sequence-zero fallback IDs are retained only
   when they resolve to a terminal same-role turn. Missing/foreign anchors fail
   before the cursor increment.
3. Derive lane/root/lineage with `AuthorityIdentity`.
4. Derive the wire `authoritativeTurnId`: the first attempt uses the local turn
   ID. A new local attempt caused by timeout, process death, network error, or
   any unknown remote outcome reuses the prior remote ID, revision, sequence,
   claim, created/device sequence, full batch, cursor, and normalized wire
   envelope exactly. Only a persisted, validated PC terminal failure with no
   commit receipt authorizes a remote child; that child uses `turn_retry_` plus
   the shared hash of its immutable `attemptId` and advances once.
5. Insert or CAS the OPEN `ConversationAuthorityEntity` by exactly one revision;
   its `latestTurnId` is the remote authoritative ID, not the Room primary key.
   Unknown-outcome replay performs no CAS.
6. Pin lineage, lane, input sequence, and clear epoch on `ChatTurnEntity`.
7. Persist the exact per-attempt remote ID/claim and immutable normalized
   envelope checksum/fields in a metadata-only bridge checkpoint on
   `ExecutionAttemptEntity`; this is the replay/member mapping and is not model
   memory.
8. Return a `TurnSubmission` whose `BridgeAuthority` and envelope use the remote
   authoritative ID while retaining the local ID for Room execution.

Existing pins make process retry read-only. Any parent, revision, batch, or
identity conflict rolls back the cursor increment and authority row together.
`startRetry()` continues to create a new local attempt on the same local turn,
but does not itself authorize a new PC child. Preparation inspects the persisted
prior outcome using the closed rule above. Exercise commit-response-lost → new
local retry → exact original receipt through the real plugin/store entry, not
only a helper; it must converge without a revision increment.

The accepted remote member set for one local turn is deterministic and
persistent without a new column: the remote IDs in the metadata-only authority
checkpoints of its stored attempts. A committed-retry fast path may legally
return an earlier member (usually the original authoritative receipt). Android
must accept it only when the receipt has the pinned lineage and its turn ID is in
this set, then finalize `ConversationAuthority` to that receipt's committed turn.
It must not require the result turn ID to equal the currently requested/latest
retry ID.

- [ ] **Step 3: Write Android red tests for parsing and atomic completion**

Use distinct result values `lineage=2`, `turn=4`, `lane=8`. Cover:

- visible with three items;
- action-only with two actions and zero text;
- automatic skip with zero items/actions;
- direct skip rejection;
- every receipt field changed one at a time;
- exact event/poll/cloud replay;
- original commits on PC, Android starts a retry, then LAN poll and delayed cloud
  delivery for that retry return the original receipt; both resolve through the
  same lineage member set and commit once across restart;
- process restart reading the same Room row;
- old `inputClearEpoch` with a larger sequence is REDACTED, creates no reply/
  action row, does not advance native completion, and is not returned in the UI
  completion inbox;
- a fault after each write boundary rolls back receipt, attempt, parts/actions,
  raw message projection, conversation authority, and cursor;
- skip never reaches `AlNotificationFactory`; visible retains notification;
- the cross-stack contract proves the notification guard occurs after completion
  event/receipt/continuations but before notification ID/text/factory calls;
- plugin `turnResult` exposes all receipt fields and stored relay metadata.
- v3 LAN/cloud failure never commits a legacy fallback result; the pinned turn
  remains recoverable until Task 14 supplies an authority-preserving fallback.
- LAN and cloud verified PC terminal failure, then restart and retry, creates one
  child/revision; local configuration/HTTP/timeout/process errors retain the
  parent remote ID and revision. Forged or changed remote-failure proof conflicts.
- `retryAllowed:true` survives PC status, LAN/cloud parsing, Room checkpoint, and
  restart without coercion; missing, false, null, numeric, and string variants
  do not authorize a child. Changing only this field changes the raw-status
  checksum and conflicts with an already persisted proof.

Run red:

```powershell
.\gradlew.bat testDebugUnitTest --tests "*ExecutionEngineTest" --tests "*BridgeClientTest" --tests "*BridgeRouterTest" --tests "*RoomBridgeMirrorTest" --tests "*BridgeReceiptCheckpointTest" --tests "*AlNotificationPolicyTest" --no-daemon --no-problems-report
.\gradlew.bat assembleDebugAndroidTest --no-daemon --no-problems-report
```

- [ ] **Step 4: Implement one v3 parse and one Room terminal transaction**

`BridgeTurnStatus` treats `terminalDisposition` as authoritative only after all
receipt fields validate. For v3 it parses the remote result ID but defers member
acceptance to the Room authority validator; v2 retains its exact requested-turn
check. It preserves ordered reply items/actions. For a
canonical-v2 projection it prefers exact `replyParts`/`actions` when present and
treats a structured action-only terminal as committed with no text; true legacy
v2 behavior remains unchanged. `BridgeRouter` does not pre-write a v3 reply
through `RoomBridgeMirror`; legacy mirror behavior remains for authority-version
0/v2 only. Once a v3 claim is pinned, LAN/cloud failure may not route to or
commit legacy fallback.

A parsed v3 PC terminal failure is a separate closed
`verified_remote_failure` result, never inferred from `BridgeFinalException`, an
HTTP code, `retryable`, timeout, missing configuration, or process death. Its
proof contains the known remote member ID, pinned lineage, terminal failed
state/error, retry permission, canonical raw-status checksum, and authenticated
route. LAN creates it only after parsing a valid PC terminal status for a known
member; encrypted cloud `BACKLOG_FAILED` uses the identical validator.

The retry permission has one authority source: the native JSON boolean
`turns.error_json.retryAllowed` written by the PC canonical failure transaction.
The v3 terminal-status projection must always expose a closed boolean
`retryAllowed`; it is `true` only when the persisted field exists and is exactly
the JSON boolean `true`. Missing, `null`, numeric, string, or otherwise malformed
values are fail-closed as `false` and can never be coerced. A production writer
may grant retry only by passing `retryAllowed: true` in the same
`recordCanonicalTurnFailureInternal` transaction that persists the canonical
failure class. The status endpoint, LAN client, cloud client, Android router,
and Room checkpoint must copy this boolean verbatim; none may derive or upgrade
it from an exception class, HTTP code, timeout, transport retryability, or local
policy. The canonical raw-status checksum covers the field.

`commitVerifiedRemoteFailure` atomically stores that metadata-only proof in the
attempt bridge checkpoint and terminates the attempt/turn as retryable without
writing a commit receipt, group, part/action, authority revision, or cursor.
Exact proof replay is idempotent; changed proof conflicts. Cloud ACK occurs only
after this transaction; unknown/foreign failure stays pending. Preparation may
create a child only from this persisted proof and consumes that authority once.

`commitBridgedTerminal` runs one outer Room transaction:

1. Revalidate the complete pinned input claim and every result field.
2. If result epoch is older than the current cursor, preserve the complete
   receipt tuple on `ChatTurnEntity`, commit the authority and attempt, set the
   local turn to `COMPLETED` with `deletedAt=now`, retain the real remote
   `terminalDisposition`, and store only a metadata checkpoint (no reply/action
   content). Leave `uiAppliedAt`, `notificationShownAt`, and `cloudConfirmedAt`
   null; create no reply/raw-message/action rows and do not advance native/UI
   watermarks. Existing completed/unapplied queries already exclude `deletedAt`.
   Exact receipt replay returns `DeliveryDisposition.REDACTED`; changed receipt
   identity/checksum conflicts. Never invent a `redacted` terminal disposition.
3. Otherwise finalize the exact OPEN authority revision, write the receipt
   fields verbatim (including distinct revisions, fingerprint, and release),
   insert deterministic reply/action projections, finish turn and attempt, and
   advance `nativeCompleted`.
4. For exact replay, compare every field and return the stored disposition.
5. For changed replay, throw `BRIDGE_AUTHORITY_CONFLICT` before writes.

Branch to this v3 transaction immediately after the gateway returns and before
`saveMemoryResult`, `markStage(CHAT_RUNNING)`, `saveRawReply`, `commitReply`, or
`commitSkip`. A v3 turn must call none of those legacy writers. The transaction
owns its receipt/checkpoint, attempt state, change/diagnostic rows, parts/actions,
raw-message projections, authority and cursor together.

Projection is exact and collision-free: visible items become `ReplyPartEntity`
rows with `replyPartId=canonical messageId`, sequence `0..itemCount-1`, type
`TEXT`, exact content, and canonical metadata payload; they alone create
`RawMessageEntity` rows using the canonical message ID and remote authoritative
turn ID. Actions become reply parts with `replyPartId=canonical actionId`,
sequence `itemCount..itemCount+actionCount-1`, empty content, a closed
kind-to-type map, and canonical semantic payload. Actions never create raw chat
messages. Validate item and action counts, ordinals, IDs, semantic checksums, and
sets separately across restart; a total-count-only check is forbidden.

For canonical `skip`, the terminal transaction performs a safe no-op UI apply:
it sets `uiAppliedAt`, advances native and UI cursors to the group, writes no
parts/actions, and leaves the turn in completed queries so the service still
emits the completion event, sends the group receipt, and runs proactive/role-plan
continuations. It is absent from the unapplied UI inbox. `action_only` advances
native completion but waits for Web action application before UI completion.

Update the DAO finalization query so it accepts the already pinned lineage and
writes `generationFingerprint` plus `pipelineReleaseId`. Do not use
`lineageRevision` as the turn or lane revision. Do not filter
`completedTurns()` or `unappliedCompletedTurns()` by disposition. Update
`AlNotificationPolicy` and call it only at the actual notification branch, after
completion event, receipt/ack, and continuations. Visible text may notify;
`action_only` and `skip` never create a chat notification or placeholder text.

`BridgeReceiptCheckpoint.extract()` accepts a complete v3 canonical receipt even
with zero items and no relay ID, preserves the original response and route, and
rejects partial identity. For cloud backlog, `ExecutionRuntime` constructs one
shared `RoomExecutionStore`/canonical applier and injects it into
`RoomBridgeMirror`. The v3 backlog path resolves exactly one local turn by the
receipt's lineage and the deterministic remote member set across that turn's
stored attempts, requires its persisted active attempt and pinned claim, and
calls the same `commitBridgedTerminal`; it may not create a legacy backfill turn.
A known prior member returned by the PC committed-retry fast path is valid even
when it is not `latestTurnId`; only missing/foreign identities remain in the
relay inbox for retry with a diagnostic. Exact replay reads the persisted
checkpoint.
The relay envelope is ACKed only after the Room transaction commits. A REDACTED
late result ACKs only that relay envelope and never publishes an applied group
receipt. Otherwise `confirmAppliedResult()` publishes the Task 13B group receipt
only after UI application; the skip no-op is already UI-applied atomically.

- [ ] **Step 5: Run cross-stack Task 13 gate**

From repository root:

```powershell
node --test tests/payment-batch-bridge-contract.test.mjs yuqi-runtime/test/bridge-authority-v3.test.mjs yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/store-visible-authority-v13.test.mjs yuqi-runtime/test/v3-runtime-recovery.test.mjs yuqi-runtime/test/local-server.test.mjs yuqi-runtime/test/cloud-relay-pump.test.mjs yuqi-runtime/test/result-outbox.test.mjs
cd android
.\gradlew.bat testDebugUnitTest assembleDebugAndroidTest --no-daemon --no-problems-report
```

Expected: all pass. Record that `connectedDebugAndroidTest` is still unavailable
when no device is attached; it remains a formal release gate, not a skipped code
gate.

- [ ] **Step 6: Commit Task 13C and run the repository gate**

Stage only Task 13C files and commit:

```powershell
git commit -m "feat: atomically apply v3 bridge authority on Android"
```

Then run:

```powershell
npm.cmd test
```

Do not begin Task 14 until the three Task 13 commits, focused cross-stack gate,
full repository gate, and a file-boundary audit all pass.
