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
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/src/turn-dispatcher.mjs`
- Create: `tests/fixtures/canonical-failure-status-v1.json`
- Modify: `yuqi-runtime/test/bridge-authority-v3.test.mjs`
- Modify: `yuqi-runtime/test/local-server.test.mjs`
- Modify: `yuqi-runtime/test/cloud-relay-pump.test.mjs`
- Modify: `yuqi-runtime/test/result-outbox.test.mjs`
- Modify: `yuqi-runtime/test/turn-dispatcher.test.mjs`
- Modify: `yuqi-runtime/test/v3-runtime-recovery.test.mjs`
- Modify: `yuqi-runtime/test/store-visible-authority-v13.test.mjs`
- Modify: `yuqi-runtime/test/store-release-authority-v14.test.mjs`

**Interfaces:**

- `publicTurnStatus(turn, { canonicalResult, canonicalFailure, stages, clock })`
  uses a closed canonical result for committed version 1 and the closed failure
  below for wire-v3 failed version 1. Version 0 and wire-v2 failure retain their
  old parser byte-for-byte.
- `projectCanonicalFailureForWire(authority)` returns the one closed v3 failure
  value used by LAN and cloud. `rawStatusChecksum` is the lowercase SHA-256 of
  the canonical JSON of every field below except `rawStatusChecksum` itself:

  ```js
  {
    protocolVersion: 3,
    type: 'BACKLOG_FAILED',
    turnId,
    roleId,
    authorityLineageKey,
    lineageRevision,
    turnRevision,
    laneKey,
    laneRevision,
    retryOfTurnId,       // string | null
    inputVisibilitySequence,
    inputClearEpoch,
    generationFingerprint,
    releaseId,
    state: 'failed',
    errorCode,
    failureClass,       // transient | deterministic
    retryAllowed,       // native JSON boolean
    failedAt,
    rawStatusChecksum   // excluded from its own hash basis
  }
  ```

  The value is a closed-key object with exactly the listed keys. Hash bytes are
  UTF-8 `canonicalJson` as defined by `protocol.mjs`: object keys are recursively
  sorted lexicographically and array order is preserved. Transport wrappers,
  including `ok`, `recoveryAckSeq`, encryption metadata, and relay IDs, are not
  in the hash basis. `tests/fixtures/canonical-failure-status-v1.json` contains
  native-true, native-false, non-ASCII identity, retry-parent, and both error-code
  vectors with exact expected `rawStatusChecksum`. Node and Android tests load
  every vector. Unknown/missing keys, non-native booleans, and a mismatched
  checksum reject before any Room write.

  `lineageRevision` is the latest member's persisted
  `lineageRevisionAtCreation`; `turnRevision` is its post-failure revision and
  `laneRevision` is the member's persisted lane pin. `errorCode` is exactly
  `YUQI_TRANSIENT_EXECUTION_FAILURE` for `transient` and
  `YUQI_DETERMINISTIC_EXECUTION_FAILURE` for `deterministic`; raw provider
  messages and stacks remain PC-local and are not part of the wire value. The loader requires
  the turn to be the latest failed member of an open lineage, requires the
  current lineage revision to equal that member's creation revision, and reads
  all pins from persisted authority rows. It never trusts a caller-supplied
  failure object.
- `validateAuthorityDeliveryReceipt(value)` validates one group receipt and
  permits zero items for `skip` because group checksum is the authority.
- `store.confirmAuthorityCloudDeliveryInternal(receipt, peerId)` confirms only
  the exact group/checksum already mailboxed for that peer.
- `store.confirmCanonicalV2DeliveryInternal(receipt, peerId)` maps a legacy
  receipt back to one canonical group and confirms only a complete exact
  projection; it never calls the authority-version-0 receipt writer.
- `store.loadCanonicalFailureForBridgeInternal(turnId)` is the only PC loader for
  the failure authority above. `store.recordCanonicalTurnFailureInternal()` is
  its only production writer and, for a wire-v3 turn, requires an explicit
  native boolean `retryAllowed` in the same transaction as the failed state.
- `store.list/claim/completeCanonicalFailureCloudDeliveryInternal(...)` own the
  metadata-only canonical-failure outbox. Claim returns a persisted lease and
  complete requires that exact lease. All legacy delivery APIs hard-require
  `turns.result_authority_version = 0`; `authority_group_id IS NULL` alone is not
  a legacy discriminator.
- `store.supersedeCanonicalFailureDeliveryInternal(...)` is called inside v3
  child creation. It makes an unsent/pending parent failure target ineligible for
  any new send without deleting its proof. If an already-started enqueue later
  succeeds, the same relay ID may be recorded as `superseded_mailboxed`; it is
  never enqueued again. An already `mailboxed` row remains immutable evidence.
- `store.quarantineCanonicalCloudDeliveryInternal(...)` changes only the exact
  corrupt group/failure delivery target to `quarantined` and appends a redacted
  diagnostic. It never changes a committed/failed turn into a legacy state.

- [ ] **Step 1: Write red tests for the reachable PC failure authority**

Use `TurnDispatcher` with a real canonical wire-v3 turn and a production-shaped
throwing release adapter; do not call a test-only store failure helper. Prove:

- the PC classifier is the only policy source: a known transient model/provider
  execution failure is persisted terminal `failed` with native boolean
  `retryAllowed:true`, while a deterministic execution failure is persisted with
  native boolean `retryAllowed:false`;
- wire-v3 failures are not immediately requeued under the same turn ID. Wire-v2
  and authority-version-0 retain their existing same-ID transient recovery;
- `orchestrator.accept()` does not requeue a wire-v3 failed member whose persisted
  error has `retryAllowed:true`; a canonical requeue writer rejects that state so
  a visible permission cannot later be revoked by clearing `error_json`;
- the v3 failure transaction writes exactly one metadata-only
  `{turnId, peerId}` cloud target with the current persisted `sync_cursors`
  acknowledgement. Exact replay is idempotent; a changed failure or peer is a
  zero-write conflict;
- the pure failure projection survives store close/reopen and LAN/cloud use the
  exact same `rawStatusChecksum`. Changing only `retryAllowed`, using a missing,
  null, numeric, or string value, or changing any identity/pin changes the
  checksum or is rejected; none can authorize a child;
- creating an authorized v3 child transactionally supersedes a parent
  `waiting`/`pending` failure target. A pending enqueue that has already crossed
  the network boundary may record only `superseded_mailboxed`; an already
  `mailboxed` target remains evidence. Neither is sent again. Child commit creates
  only the child's group target and never recreates the parent target;
- capture before/after row snapshots for `waiting -> pending -> mailboxed`,
  `waiting -> superseded`, and
  `pending -> superseded -> superseded_mailboxed`. Run two outbox instances
  concurrently against the same unexpired lease and prove one claim CAS, one
  enqueue call, one relay identity, and stable restart state. Also cover crash
  before enqueue, expired-lease reclaim with the same relay identity, old-lease
  late success after reclaim (completion rejected), and old-lease late success
  after child supersession (only `superseded_mailboxed`);
- cancelled/redacted/quarantined lineages and a successful canonical group never
  enter the failure or legacy null-group outbox.
- close/reopen v13 and v14 fixtures cover every legal failure-target state,
  every illegal `(resultAuthorityVersion, authorityGroupId, state)` tuple,
  corrupt payload/checksum/peer/latest-member joins, and child supersession.
  Scoped operations perform one target/lineage validation and zero full scans.

Failure policy is intentionally PC-owned and closed. For wire v3, `transient`
means the existing PC classifier recognized a model/provider execution failure
as timeout, capacity/rate-limit, temporary unavailable, network, or reset. That
known remote execution failure is terminal for that remote member and grants one
persisted child permission. `deterministic` is terminal without permission.
Android HTTP errors, relay timeouts, missing configuration, process death, and
unknown remote outcomes never call this writer and continue to reuse the same
remote ID. Do not add an Android- or transport-owned retry classifier.

Reuse `cloud_deliveries`; Task13B has no schema-version change. Its authority is
the joined turn plus the group discriminator:

- version 0 + null group = legacy target;
- version 1 + non-null group = canonical committed-result target;
- version 1 + null group + wire-v3 latest terminal failed member = canonical
  failure target.

Extend v13/v14 reopen/scoped invariants to reject every other combination and to
validate peer, lineage/latest member, failed state, retry boolean, payload/checksum
and state lifecycle. Permitted failure-target states are `waiting`, `pending`,
`mailboxed`, `superseded`, `superseded_mailboxed`, and
`quarantined`; state-specific payload, relay ID, attempt and timestamp rules are
closed. No authority row is inferred merely from a null group.

The relay `messageId` and idempotency key are the same deterministic value:
`stableId('relay_failure', turnId + ':' + peerId + ':' + rawStatusChecksum)`.
The local send right uses a separate persisted lease inside `payload_json`:
`{failure, lease:{leaseId,leaseAttempt,leasedAt}}`. The lease is transport
metadata and is excluded from `rawStatusChecksum`. `leaseAttempt` is the
monotonic delivery `attempts` value and `leaseId` is
`stableId('failure_lease', turnId + ':' + peerId + ':' + rawStatusChecksum + ':' + leaseAttempt)`.

`claimCanonicalFailureCloudDeliveryInternal` uses an immediate transaction and
one compare-and-swap to claim either `waiting` or a `pending` lease whose
`updated_at` is at least `FAILURE_DELIVERY_LEASE_MS = 60000` ms old. It increments
the attempt, writes the closed lease, and returns it. A non-expired `pending` row
is not claimable or selectable by another flusher. Only the holder of the exact
current `leaseId + leaseAttempt + rawStatusChecksum` may make the enqueue call
and complete it. Completion CASes `pending -> mailboxed`; if child creation
CASed the same leased row to `superseded` while the enqueue was in flight, that
same lease may CAS only `superseded -> superseded_mailboxed`. No other state can
enter either mailboxed state, and no `superseded*` target is selected again.

Two live flushers therefore produce one HTTP call while the lease is valid. A
process crash before or during enqueue is recovered only after lease expiry;
that may produce another HTTP call, so cross-crash exactly-once is not claimed.
Every lease attempt nevertheless uses the same relay message ID/idempotency key,
and the relay's at-least-once idempotency is the external duplicate boundary. An
old lease that returns after a newer lease was claimed fails the completion CAS
and cannot overwrite it. An old lease retained by child supersession may record
only `superseded_mailboxed` with the same stable relay ID.

The failure-target state contract is exact:

| State | Required retained fields | May the outbox select it? |
| --- | --- | --- |
| `waiting` | no payload/checksum/relay ID; zero attempts | yes |
| `pending` | exact failure/checksum plus one closed active or expired lease; no relay ID | no; only the transactional claim API may reclaim an expired lease |
| `mailboxed` | exact payload/checksum/relay ID and delivered time | no |
| `superseded` | no relay ID; payload and checksum are either both absent (from waiting) or the exact pair (from pending) | no |
| `superseded_mailboxed` | exact payload/checksum/relay ID and delivered time from an enqueue already in flight | no |
| `quarantined` | pre-quarantine delivery fields plus one linked redacted diagnostic | no |

Canonical failure has no PC-side `confirmed` state in Task13: Android ACKs the
relay item only after its Room proof transaction, while PC preserves `mailboxed`
as immutable enqueue evidence. A future acknowledgement protocol must be a new
closed contract, not reuse a group receipt.

Run the first red gate:

```powershell
node --test yuqi-runtime/test/turn-dispatcher.test.mjs yuqi-runtime/test/v3-runtime-recovery.test.mjs yuqi-runtime/test/bridge-authority-v3.test.mjs yuqi-runtime/test/result-outbox.test.mjs
```

Expected red: the dispatcher requeues transient v3 failures, no production
writer stores `retryAllowed`, and a failed canonical turn has no cloud target.

- [ ] **Step 2: Implement the failure writer, outbox lifecycle, and checksum**

Keep classification in `turn-dispatcher.mjs`; pass the explicit boolean into the
store transaction. Normalize the persisted v3 error to a closed PC record with
`name`, `code`, bounded `message`, `failureClass`, and native boolean
`retryAllowed`. Only the wire projection omits message/stack. The transaction
must CAS turn state/revision, validate lineage/latest member and release pins,
write the failure, read the same-device sync cursor, and insert the failure
delivery target atomically. A fault after every write boundary rolls everything
back.

`TurnDispatcher` terminalizes wire-v3 failures once. It retains the existing
same-turn retry for wire-v2/version-0. `orchestrator.accept()` returns an exact
stored v3 failure unchanged so repeated input can poll it; only wire-v2
canonical rows may use the existing canonical same-turn recovery. The store
rejects same-turn requeue for every wire-v3 turn, and also rejects any row whose
persisted `retryAllowed === true`.

For a result-authority-version-1 turn whose persisted normalized envelope is
protocol v2, retain the pre-Task13 failure/status/requeue behavior byte-for-byte.
It never creates a canonical-failure target and never calls
`loadCanonicalFailureForBridgeInternal` or
`projectCanonicalFailureForWire`. The prohibition on parsing `reply_json` or
`error_json` applies only to protocol-v3 authority terminal paths. Add
canonical-internal wire-v2 transient and deterministic failure, restart, exact
status, duplicate, and no-failure-outbox regression tests in addition to v0.

Build and validate the closed failure object in
`bridge-result-projector.mjs`. LAN status and cloud failure outbox load it through
`loadCanonicalFailureForBridgeInternal`; they do not parse arbitrary
`turn.errorJson`. The raw checksum covers the full closed object, including the
native boolean, and excludes only itself and transport-only `recoveryAckSeq`.

All legacy null-group register/prepare/attempt/mailbox/confirm/list methods must
join the turn and require authority version 0. Add separate canonical-failure
methods rather than a boolean option on legacy methods. ResultOutbox globally
age-sorts committed-group, canonical-failure, and legacy targets, but each target
uses only its authority-specific loader and writers.

- [ ] **Step 3: Write LAN/cloud red tests against real canonical commits**

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
- malformed raw v3 with an otherwise valid recovery peer performs zero envelope
  reconciliation, zero store lookup/write, zero stale suppression, and zero ACK;
- an exact normalized v3 duplicate is ACKed only when its persisted
  `envelopeChecksum` matches; a same-turn-ID envelope with changed authority,
  batch, cursor, release pin, or checksum is `BRIDGE_AUTHORITY_CONFLICT`, is not
  ACKed, and produces zero duplicate/audit writes. V0/v2 duplicate behavior is
  byte-compatible;
- a real dispatcher failure is exposed as the same closed `BACKLOG_FAILED` value
  through LAN and encrypted cloud, including exact `rawStatusChecksum` and
  `retryAllowed`; store restart does not change either;
- canonical-v2 three-message visible, every closed action kind, action-only, and
  skip follow the projection table below; old item/simple receipts are replay-
  safe and any partial or changed receipt conflicts.

Run:

```powershell
node --test yuqi-runtime/test/bridge-authority-v3.test.mjs yuqi-runtime/test/local-server.test.mjs yuqi-runtime/test/cloud-relay-pump.test.mjs yuqi-runtime/test/result-outbox.test.mjs
```

Expected red: canonical v2 cloud registration throws, LAN reads `reply_json`,
the v3 receipt fields are incomplete, validation happens after reconciliation,
and checksum-conflict ACK is too broad.

- [ ] **Step 4: Implement one pure v2/v3 projector**

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
a committed result. A canonical failed turn calls the failure projector from
Step 2. No protocol-v3 authority-version-1 terminal path may parse `reply_json`
or directly parse `error_json` in `turn-status.mjs`; the explicit protocol-v2
compatibility branch above remains byte-identical.

- [ ] **Step 5: Close preflight, cloud registration, quarantine, and receipts**

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

Stale proactive suppression occurs only after Step 1 validation and Step 2
identity agreement. It may never ACK malformed raw input. If `dispatcher.accept`
reports a checksum conflict, cloud treats it as an exact duplicate only after a
read proves the persisted `envelopeChecksum` equals the checksum of the same
normalized envelope. Any changed v3 authority/batch/pin remains unacknowledged
and has no diagnostic/duplicate side effect.

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

Apply the same rule to a canonical failure target: corrupt lineage/member/error
or checksum joins quarantine only that failure delivery and emit no payload.
`ResultOutbox` must not swallow the exception and retry forever. Redacted or
cancelled lineages return 410/no semantics on LAN and cancel or quarantine any
unsent failure target. Group redaction never falls through to failure or legacy.

When a v3 retry child is created, supersede the parent's unsent failure target in
the same creation transaction after immutable proof validation but before the
lineage/lane CAS commits. A child creation rollback also rolls this state back.
An exact child replay does not rewrite the target. The failure payload may have
already reached Android; its stable checksum and Android's one-use checkpoint
make that harmless, while the PC outbox never originates a second delivery.

- [ ] **Step 6: Run Task 13B gate green and commit**

Run the Step 1 command, then:

```powershell
node --test yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/v3-runtime-recovery.test.mjs
```

Then run the complete focused gate in one process:

```powershell
node --test yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/bridge-authority-v3.test.mjs yuqi-runtime/test/local-server.test.mjs yuqi-runtime/test/cloud-relay-pump.test.mjs yuqi-runtime/test/result-outbox.test.mjs yuqi-runtime/test/turn-dispatcher.test.mjs yuqi-runtime/test/v3-runtime-recovery.test.mjs yuqi-runtime/test/store-visible-authority-v13.test.mjs yuqi-runtime/test/store-release-authority-v14.test.mjs
```

Required counterexample evidence before commit:

1. real dispatcher transient failure -> restart -> identical LAN/cloud failure
   checksum -> one authorized child;
2. deterministic/false and malformed boolean variants never create a child;
3. invalid raw v3 + valid recovery produces zero reconciliation/store/ACK;
4. changed valid-shape v3 checksum conflict produces zero ACK/write;
5. waiting, pending, mailboxed, and enqueue-race parent failure targets each
   follow the closed CAS/lease supersession lifecycle; two concurrent flushers
   under one unexpired lease produce one enqueue, while crash/reclaim may repeat
   HTTP only with the same deterministic relay identity;
6. corrupt committed and corrupt failure joins quarantine once, do not retry,
   and never use `reply_json`/legacy delivery;
7. version-0 LAN/cloud output and duplicate handling remain byte-identical;
8. canonical-internal wire-v2 transient/deterministic/restart status and
   duplicates remain byte-identical and never enter the failure outbox;
9. 50 mixed group/failure/legacy deliveries preserve global age fairness and
   use scoped validation with zero full-database scans.

Stage only Task 13B files and commit:

```powershell
git commit -m "feat: project canonical bridge results across transports"
```

---

### Task 13C: Android v3 Preparation and Atomic Room Completion

**Files:**

- Modify: `android/app/src/main/java/com/siyi/al/execution/TurnSubmission.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/TurnBridgeGateway.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/NativeModelGateway.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/AuthorityIdentity.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/BridgeAuthority.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionEngine.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionEngineStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/ExecutionAttemptEntity.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDatabase.java`
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
- Create: `android/app/src/main/java/com/siyi/al/execution/BridgeReceiptDeliveryCoordinator.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/AlNotificationPolicy.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeInputTest.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/AuthorityIdentityTest.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/CanonicalRawMessageTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/ExecutionEngineTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/BridgeReceiptCheckpointTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeClientTest.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeTurnStatusTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeRouterTest.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/bridge/CanonicalFailureStatusTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/RoomBridgeMirrorTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/AlNotificationPolicyTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/ExecutionServicePolicyTest.java`
- Modify: `android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`
- Modify: `android/app/src/androidTest/java/com/siyi/al/execution/ConversationCursorStoreTest.java`
- Modify: `tavern-app/index.html`
- Create: `tavern-app/lib/canonical-action-application.js`
- Modify: `tavern-app/lib/role-plan-domain.js`
- Modify: `tavern-app/lib/role-plan-repository.js`
- Create: `tests/canonical-action-application.test.mjs`
- Modify: `tests/yuqi-ui-contract.test.mjs`
- Modify: `tests/role-plan-domain.test.mjs`
- Modify: `tests/role-plan-repository.test.mjs`
- Modify: `tests/fixtures/authority-identity-v1.json`
- Modify: `tests/fixtures/canonical-failure-status-v1.json`
- Create: `tests/fixtures/canonical-raw-message-v1.json`
- Modify: `tests/payment-batch-bridge-contract.test.mjs`
- Modify: `package.json`
- Modify: `yuqi-runtime/src/authority-identity.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/test/bridge-authority-v3.test.mjs`
- Modify: `yuqi-runtime/test/visible-result-commit.test.mjs`

**Interfaces:**

- `TurnBridgeGateway.bridgeDeviceId() -> String` returns the device identity from
  the current bridge configuration used by the route. It is read before the
  Room preparation transaction and never taken from input/snapshot JSON.
- `ExecutionEngineStore.prepareBridgeSubmission(base, bridgeDeviceId, now) -> TurnSubmission`
  is a no-op for legacy input and an idempotent Room authority/cursor pin for a
  store-marked v3 turn.
- `ExecutionEngineStore.commitBridgedTerminal(turnId, attemptId, result, now) ->
  DeliveryDisposition` is the only v3 result writer.
- `ExecutionEngineStore.commitVerifiedRemoteFailure(turnId, attemptId, proof,
  now)` is the only writer for a closed PC terminal-failure proof; it writes no
  receipt/group/cursor. Only a proof whose native `retryAllowed` is exactly true
  can make one later attempt create a remote child.
- `BridgeResult` carries immutable receipt fields plus ordered visible items and
  actions; it does not derive them from reply text. Its wire `turnId` is exposed
  as `authoritativeTurnId`; Room writes still use the separate local turn ID.

`TurnSubmission.turnId` remains the local Room identity for compatibility and a
new `authoritativeTurnId` is the v3 remote identity. For legacy it equals
`turnId`. For a first v3 attempt it equals the single canonical
`BridgeInput.wireTurnId(localTurnId, kind)`: direct IDs retain the established
direct rule, while automatic `cloud_*`/`plan_*` IDs receive the historical
`turn_` wire prefix. It is not the raw local automatic ID. BridgeInput wire turn
ID, LAN expected result ID, cloud
relay message ID, and cloud idempotency key use only `authoritativeTurnId`.
Room turn/attempt writes, diagnostics, and raw user projection use only local
`turnId`. Therefore unknown-outcome replay has the same cloud key, while an
authorized remote child has a different key and cannot be deduplicated as its
parent.

Task 13C deliberately advances Android Room from v11 to v12. It does not reuse
`ExecutionAttemptEntity.memoryResult`, `rawReply`, `ChatTurnEntity.inputJson`, or
`snapshotJson` alone as the authority store. `memoryResult` remains the
legacy/model or legacy-bridge checkpoint field. Room v12 adds one nullable
store-owned provenance column, `ChatTurnEntity.bridgeProtocolVersion`, and
bridge-v3 attempt authority is held in two new nullable attempt columns:

- `bridgeAuthorityCheckpointJson`: canonical closed JSON for the attempt's
  prepared remote member and its later verified outcome;
- `bridgeAuthorityCheckpointChecksum`: lowercase SHA-256 of the recursive
  lexicographic UTF-8 canonical JSON bytes.

The provenance column and both checkpoint columns are null for every migrated
v11 row and for every v0/v2 turn/attempt. A fresh Room-created v3 Yuqi turn has
`bridgeProtocolVersion=3`; no caller field can populate this column.
They are written and changed together by exact-checksum CAS inside the same Room
transaction as the cursor/authority/turn transition. A one-sided value, a bad
checksum, an unknown key, or a checkpoint whose local turn, attempt, sequence,
lineage, remote member, pinned envelope, or outcome does not match the joined
Room rows is `BRIDGE_AUTHORITY_CONFLICT` before any network or visible write.
`MIGRATION_11_12` only adds the nullable provenance/checkpoint columns and does
not populate a bridge version, fabricate an authority member, or reinterpret
historical turns. Therefore even a historical snapshot whose bytes already
contain the exact `_alBridgeProtocol` object remains v2 because its independent
provenance column is null.
Task 20 lifecycle/redaction must treat the v12 checkpoint as an authority-bearing
copy of turn input: clear/delete/retraction rewrites it to a closed metadata
tombstone in the same transaction as the turn and cursor clear. It may not leave
`normalizedEnvelope`, failure text, receipt items/actions, route, or relay data
retrievable after the corresponding authority is redacted.

The checkpoint is version 1 and always has the exact top-level keys
`version`, `localTurnId`, `attemptId`, `attemptSequence`,
`authoritativeTurnId`, `authorityLineageKey`, `claimedLineageRevision`,
`retryOfTurnId`, `laneKey`, `inputVisibilitySequence`, `inputClearEpoch`,
`normalizedEnvelope`, `envelopeChecksum`, and `outcome`. Optional values are
explicit JSON null rather than omitted. `outcome` is a closed tagged union:
`open`, `verified_remote_failure`, `committed`, or `redacted`.
`retryOfTurnId` is always the remote authoritative parent ID from the parent
checkpoint, never the local Room turn ID; the local attempt relationship is the
shared `localTurnId` plus attempt sequence.

Every outcome object has exactly the keys `type`, `route`, `relayMessageId`,
`failure`, `result`, and `redactedAt`, with unused members present as JSON null:

- `open`: every member except `type` is null;
- `verified_remote_failure`: `route` is `lan` or `cloud`, `relayMessageId` is
  null for LAN and the authenticated relay ID for cloud, `failure` is the exact
  closed Task 13B `BACKLOG_FAILED` object including `rawStatusChecksum`, and
  `result`/`redactedAt` are null;
- `committed`: `route`/`relayMessageId` follow the same transport rule,
  `result` is exactly the Task 13B canonical v3 result object with the 19 keys
  from `CANONICAL_RESULT_KEYS`, including ordered `replyParts` and `actions`,
  and `failure`/`redactedAt` are null;
- `redacted`: `route`/`relayMessageId` follow the same transport rule,
  `result` is a metadata-only receipt identity with exactly
  `protocolVersion`, `turnId`, `roleId`, `authorityOrigin`,
  `authorityLineageKey`, `visibleGroupId`, `lineageRevision`, `turnRevision`,
  `laneKey`, `laneRevision`, `inputVisibilitySequence`, `inputClearEpoch`,
  `generationFingerprint`, `releaseId`, `commitPayloadVersion`,
  `commitChecksum`, and `terminalDisposition`; `failure` is null and
  `redactedAt` is the native safe-integer local redaction time. It retains no
  reply text, item/action payload, or semantic checksum.

Transport metadata never enters the Task 13B raw-status or commit checksum.
Every update validates and re-hashes the whole checkpoint before its CAS. A
committed outcome may contain a result `turnId` different from that attempt's
top-level `authoritativeTurnId` only through the earlier-member convergence rule
defined below; no other outcome may cross members.

The prepared v3 submission also pins the bridge device ID from
`TurnBridgeGateway.bridgeDeviceId()` inside `normalizedEnvelope`. The Room store
never reads it from caller input, snapshot, a constant, or a cursor row.
`BridgeInput` sends the already-persisted normalized envelope rather than
rebuilding it, and immediately before network I/O requires the current route
configuration's device ID to equal the pinned value. A configuration change
therefore fails before send and cannot silently fork the checkpoint. The legacy
v2 builder continues to use its existing configuration path. When a v3
automatic envelope embeds the semantic snapshot in `trigger.context`, the local
`_alBridgeProtocol` marker is removed from that embedded copy before hashing and
persistence; the Room `snapshotJson` and provenance column remain unchanged.
Local ownership metadata is never sent to PC cognition as character context.

`BridgeAuthority.canonicalJson` is byte-compatible with the PC
`protocol.mjs` canonical JSON for every supported JSON value, including
ECMAScript `JSON.stringify` number formatting (`1.0 -> 1`, negative zero ->
`0`, lowercase exponent form and matching decimal/exponent thresholds). It
rejects NaN and infinities. Fixed Java/Node vectors cover integral doubles,
fractions, negative zero, and exponent boundaries before this function is used
for an envelope or checkpoint checksum.

The store-owned v3 marker is also frozen. `RoomExecutionStore.submitTurn()`
removes any caller-supplied top-level `_alBridgeProtocol` value before lookup or
insert. Only a newly inserted `characterId == "yuqi"` turn receives exactly
`"_alBridgeProtocol":{"version":3,"owner":"room-v12"}` in its persisted
snapshot and `bridgeProtocolVersion=3` in its independent Room column. Existing
rows are returned without backfill, and non-Yuqi rows remain unmarked.
Preparation requires both the exact persisted object and the independent column;
malformed, extended, caller-owned, or historical snapshots remain v2.

Task 13C uses three implementation slices with explicit stop gates. Slice C1
owns the pure identity/checksum/closed-wire DTOs and tests. Slice C2 owns the
Room v12 migration, store marker, pre-route preparation, checkpoint CAS, cursor,
and authority state. Slice C3 owns parsing, the one terminal applier, router,
cloud/LAN integration, plugin/service lifecycle, and notification policy. C2
must consume the frozen C1 API; C3 starts only after C1 and C2 interfaces pass
their focused gates. No two slices may concurrently modify
`TurnSubmission`, `ExecutionEngineStore`, `RoomExecutionStore`,
`AlExecutionDao`, `BridgeClient`, `ExecutionEngine`, or `RoomBridgeMirror`.

- [ ] **Step 1: Write Android red tests for identities and outbound preparation**

`AuthorityIdentityTest` must load every vector in
`tests/fixtures/authority-identity-v1.json` and verify lineage, group, message,
action, and remote-retry turn IDs, including Chinese, emoji, empty text
components, and large ordinals. Java uses UTF-8 byte length, not
`String.length()`.

`CanonicalFailureStatusTest` must load every vector in
`tests/fixtures/canonical-failure-status-v1.json`, reproduce the recursive
lexicographic UTF-8 canonical JSON bytes and exact SHA-256, and reject every
unknown/missing key, boolean coercion, changed tuple field, and checksum before
calling an `ExecutionEngineStore` writer. The failure tuple preserves the PC
domain exactly: `generationFingerprint` is either an explicit JSON null or a
non-empty string, while `failedAt` is a positive safe integer.

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
- every automatic v3 envelope and checkpoint excludes `_alBridgeProtocol` from
  the embedded semantic snapshot while the Room source row retains it;
- preparation obtains the device ID from the gateway before the transaction,
  persists it in the exact normalized envelope, and a changed route device ID
  fails before either LAN or cloud sends;
- an old snapshot remains protocol v2 and receives no synthetic authority;
- a real Task12 cursor with sequence zero and non-null legacy fallback ID is
  normalized and accepted only for the first-v3 bootstrap;
- every automatic kind maps its completed local `cloud_*`/`plan_*` native and UI
  anchors to the historical PC wire IDs, including different anchors and restart.
- v11→v12 migration preserves populated turns/attempts byte-for-byte, adds both
  nullable checkpoint columns plus nullable `bridgeProtocolVersion`, leaves all
  three null, is reopen-stable, and never adds the store-owned v3 marker or
  provenance to a historical snapshot, including one whose old snapshot already
  contains the exact marker bytes;
- a fresh v12 database rejects a one-sided checkpoint/checksum, a bad checksum,
  an unknown checkpoint/outcome key, and a checkpoint joined to the wrong local
  turn, attempt sequence, lineage, or remote member before cursor/authority
  writes.

There is no caller-controlled “cognition-v3 snapshot” flag. On insert,
`RoomExecutionStore.submitTurn()` removes any caller-supplied internal bridge
marker, then marks only newly inserted `characterId == 'yuqi'` turns with a
closed internal `bridgeProtocol=3` object in the persisted snapshot and the
independent Room provenance value 3. Historical rows without that provenance
remain v2 forever even if their snapshot contains identical marker bytes. Tests
must prove a forged marker cannot upgrade a non-Yuqi or existing turn.

Run red:

```powershell
cd android
.\gradlew.bat testDebugUnitTest --tests "*AuthorityIdentityTest" --tests "*CanonicalFailureStatusTest" --tests "*BridgeInputTest" --tests "*ExecutionEngineTest" --no-daemon --no-problems-report
```

- [ ] **Step 2: Implement idempotent pre-route authority preparation**

Immediately before `gateway.executeBridgeTurn`, `ExecutionEngine` reads the
gateway's current bridge device ID and calls
`prepareBridgeSubmission(base, bridgeDeviceId, now)`. In one Room transaction
for a v3 snapshot:

1. Load/create the conversation cursor. Increment `localSequence` only when
   creating a fresh remote authority member; an unknown-outcome replay reuses
   the existing sequence.
2. Resolve each prior cursor anchor through its local `ChatTurnEntity`. For the
   first-v3 bootstrap, normalize automatic `cloud_*`/`plan_*` IDs with the
   existing BridgeInput wire rule; sequence-zero fallback IDs are retained only
   when they resolve to a terminal same-role turn. Missing/foreign anchors fail
   before the cursor increment.
3. Derive lane/root/lineage with `AuthorityIdentity`.
4. Derive the wire `authoritativeTurnId`: the first attempt uses the canonical
   `BridgeInput.wireTurnId(localTurnId, kind)` described above. A new local
   attempt caused by timeout, process death, network error, or
   any unknown remote outcome reuses the prior remote ID, revision, sequence,
   claim, created/device sequence, full batch, cursor, and normalized wire
   envelope exactly. Only a persisted, validated PC terminal failure with no
   commit receipt authorizes a remote child. Its ID is exactly `turn_retry_`
   plus the lowercase SHA-256 produced by the shared byte-length-prefixed
   authority hash with namespace `al-remote-retry-turn-v1` and immutable
   `attemptId` as its sole value. The shared identity fixture freezes this
   vector. It advances once.
5. Insert or CAS the OPEN `ConversationAuthorityEntity` by exactly one revision;
   its `latestTurnId` is the remote authoritative ID, not the Room primary key.
   Unknown-outcome replay performs no CAS.
6. Pin lineage, lane, input sequence, and clear epoch on `ChatTurnEntity`.
7. Persist the exact per-attempt remote ID/claim and immutable normalized
   envelope checksum/fields in the dedicated v12
   `bridgeAuthorityCheckpointJson` plus
   `bridgeAuthorityCheckpointChecksum` columns on `ExecutionAttemptEntity`;
   this is the replay/member mapping and is never read through or written by
   model-memory or legacy bridge checkpoint APIs.
8. Return a `TurnSubmission` whose `BridgeAuthority` and envelope use the remote
   authoritative ID while retaining the local ID for Room execution.

Existing pins make process retry read-only. Any parent, revision, batch, or
identity conflict rolls back the cursor increment and authority row together.
`startRetry()` continues to create a new local attempt on the same local turn,
but does not itself authorize a new PC child. Preparation inspects the persisted
prior outcome using the closed rule above. For a store-marked v3 turn,
`startRetry(turnId, now, inputJson, snapshotJson)` accepts only byte-identical
input/snapshot values and performs no payload replacement; any changed value is
rejected before attempt, turn, cursor, authority, or checkpoint writes. Legacy
turn replacement behavior remains byte-compatible when no internal marker is
present. If a legacy replacement snapshot contains `_alBridgeProtocol`, Room
removes only that caller field before writing, so retry replacement cannot
upgrade a historical turn. Exercise commit-response-lost → new
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
- a sixteen-kind table that freezes the exact action type and
  `{version,canonicalAction,legacyPayload}` wrapper; prefix lookalikes,
  duplicate single-value compatibility actions, wrapper drift, and
  message/action identity collision all fail before writes;
- direct, proactive, and moment UI application paths route every canonical
  action through one closed applier before any chat/moment/pending-state
  mutation. Supported actions write exact persistent application proofs;
  reserved/unknown/conflicting actions return not-applied, perform no Web UI
  acknowledgement, and therefore cannot trigger the Android receipt sender;
- PC target resolution uses only `planId`, `targetEpisodeId`, and
  `replyToCommentId` for the three non-create namespaces. The former
  `rolePlanId`, `episodeId`, and `commentId` names fail rather than becoming
  alternate wire aliases;
- three visible items create three exact raw character messages under one
  `pc-group:<groupId>` device namespace with sequence 1/2/3, stable derived
  `sentAt`, full eleven-field checksum, and `syncSeq=0`; a second group with the
  same source time does not collide, while any occupied ID/device tuple or
  missing/extra/changed row conflicts across restart;
- Node and Android load `canonical-raw-message-v1.json`, whose hard-coded
  canonical text and SHA-256 include Chinese, emoji, slash, newline, and control
  characters. They prove the eleven-field raw checksum is cross-language stable
  and intentionally differs from the canonical visible-item checksum;
- automatic skip with zero items/actions;
- direct skip rejection;
- every receipt field changed one at a time;
- exact event/poll/cloud replay;
- original commits on PC, Android starts a retry, then LAN poll and delayed cloud
  delivery for that retry return the original receipt; both resolve through the
  same lineage member set and commit once across restart. The storing child
  attempt and the receipt-owning original member remain separate identities;
- process restart reading the same Room row;
- old `inputClearEpoch` with a larger sequence is REDACTED, creates no reply/
  action row, does not advance native completion, and is not returned in the UI
  completion inbox;
- an earlier-member result may advance a lagging native watermark while
  preserving a newer local sequence; equal sequence with a different identity
  conflicts and a newer native/UI watermark never moves backwards;
- a fault after each write boundary rolls back receipt, attempt, parts/actions,
  raw message projection, conversation authority, and cursor;
- an authority conflict thrown by either v3 Room terminal writer escapes the v3
  apply branch and calls zero legacy checkpoint, result, skip, fallback, or
  `markFailed` writers;
- skip never reaches `AlNotificationFactory`; visible retains notification;
- the cross-stack contract proves the notification guard occurs after completion
  event/receipt/continuations but before notification ID/text/factory calls;
- plugin `turnResult` exposes all receipt fields and stored relay metadata.
- Web action-only applies supported payment, moment, relationship, and role-plan
  actions exactly once across reload and only then calls the idempotent native
  `acknowledgeUiApplied`. Missing target, rejected operation, changed proof, unknown kind,
  `MOMENT_CREATE`, and every `life_episode_*` kind perform no success-state
  mutation and publish no receipt; a fault after one supported action resumes the
  remaining exact actions without replaying the proven one;
- two canonical role-plan actions against the same plan, including identical
  consecutive updates and pause/resume, persist distinct actionId/checksum
  proofs with the plan state in one `role_plans_v1` write. A crash before the
  history projection or global UI proof is repaired with `historyId=actionId`
  without repeating either operation; create-dedup writes the proof on the
  reused plan. Legacy create/update attempts to inject or overwrite the reserved
  ledger are rejected and never authorize canonical replay;
- payment decline fault injection after the settings wallet/journal write but
  before the chat target write, and after the chat write but before the global
  UI proof, preserves one exact integer-cent refund. Exact replay repairs the
  missing projection and emits payment chat/memory effects once, while changed
  action/target/revision/amount conflicts. Replaying the old action after a later
  recharge or unrelated payment remains a no-op and preserves both balances;
- the executable canonical-action harness throws after every injected store
  boundary, constructs a new applier over the same state, and proves whole-set
  preflight, partial resume, exact per-domain proof recovery, and one persisted
  native UI transition under ambiguous repeated acknowledgement. It has no Web
  receipt sender. Static source-contract tests cannot satisfy this gate;
- Android service tests prove UI-not-applied sends zero group receipts; the first
  applied state sends one; repeated Web acknowledgement, service restart, and
  event/poll duplication do not create a second authoritative receipt. A network
  retry keeps the same group/idempotency identity, and successful confirmation
  persists `cloudConfirmedAt` before further service retries stop;
- v3 LAN/cloud failure never commits a legacy fallback result; the pinned turn
  remains recoverable until Task 14 supplies an authority-preserving fallback.
- LAN and cloud verified PC terminal failure, then restart and retry, creates one
  child/revision; local configuration/HTTP/timeout/process errors retain the
  parent remote ID and revision. Forged or changed remote-failure proof conflicts.
- `retryAllowed:true` survives PC status, LAN/cloud parsing, Room checkpoint, and
  restart without coercion; missing, false, null, numeric, and string variants
  do not authorize a child. Changing only this field changes the raw-status
  checksum and conflicts with an already persisted proof.
- `BridgeTurnStatus.parseV3` and the cloud parser accept only the same closed
  immutable DTO: native protocol/type/booleans/integers, exact identity and
  receipt/failure key sets, ordered items/actions, and exact Task 13B checksum.
  Unknown keys, `opt*` coercions, mixed result/failure shapes, or transport
  fields inside authority tuples are rejected before any store writer. V2 keeps
  its exact requested-turn check and byte-compatible parser.

Run red:

```powershell
node --test yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/bridge-authority-v3.test.mjs tests/role-plan-domain.test.mjs tests/role-plan-repository.test.mjs tests/canonical-action-application.test.mjs tests/payment-batch-bridge-contract.test.mjs tests/yuqi-ui-contract.test.mjs
cd android
.\gradlew.bat testDebugUnitTest --tests "*ExecutionEngineTest" --tests "*BridgeClientTest" --tests "*BridgeTurnStatusTest" --tests "*BridgeRouterTest" --tests "*RoomBridgeMirrorTest" --tests "*BridgeReceiptCheckpointTest" --tests "*AlNotificationPolicyTest" --tests "*ExecutionServicePolicyTest" --no-daemon --no-problems-report
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

`BridgeResult` is a closed discriminated result rather than a bag of legacy
reply fields. A v3 value is exactly one of `canonical_terminal` or
`verified_remote_failure`; it carries the parsed immutable tuple, ordered
items/actions, raw authenticated response, route, and nullable relay message ID.
Legacy v2 values retain their existing fields and behavior. LAN and encrypted
cloud call the same parser and produce the same DTO; neither path may infer a
terminal kind from reply text, HTTP status, `allowFallback`, or local retry
policy.

A parsed v3 PC terminal failure is a separate closed
`verified_remote_failure` result, never inferred from `BridgeFinalException`, an
HTTP code, `retryable`, timeout, missing configuration, or process death. Its
proof contains the known remote member ID, pinned lineage, terminal failed
state/error, retry permission, every field in the closed Task13B
failure-authority tuple, canonical raw-status checksum, and authenticated route.
LAN creates it only after parsing a valid PC terminal status for a known member; encrypted cloud
`BACKLOG_FAILED` uses the identical validator and exact Task13B checksum basis.

The retry permission has one authority source: the native JSON boolean
`turns.error_json.retryAllowed` written by the PC canonical failure transaction.
The v3 terminal-status projection must always expose a closed boolean
`retryAllowed`; it is `true` only when the persisted field exists and is exactly
the JSON boolean `true`; explicit false is preserved as false. A missing, null,
numeric, string, or otherwise malformed wire value is rejected as a malformed
failure proof and can never be coerced. A malformed persisted v3 value is a PC
authority conflict and is quarantined rather than projected. The production PC
writer always passes a native boolean in the same
`recordCanonicalTurnFailureInternal` transaction that persists the canonical
failure class. The status endpoint, LAN client, cloud client, Android router,
and Room checkpoint copy this boolean verbatim; none may derive or upgrade it
from an exception class, HTTP code, timeout, transport retryability, or local
policy. The Task13B canonical raw-status checksum covers the field.

`commitVerifiedRemoteFailure` atomically stores that metadata-only proof in the
attempt bridge checkpoint and terminates the attempt/turn as failed without
writing a commit receipt, group, part/action, authority revision, or cursor. It
marks the local failure retryable only when the stored proof contains native
`retryAllowed:true`; explicit false remains a verified terminal failure but
cannot create a child. Exact proof replay is idempotent; changed proof conflicts.
Cloud ACK occurs only after this transaction; unknown/foreign failure stays
pending. Preparation may create a child only from a persisted true proof and
consumes that authority once.

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

That transaction first validates the v12 attempt checkpoints and uses their
accepted remote-member set. It never searches by a guessed `turn_*`,
`cloud_*`, or `plan_*` string. Cloud backlog first resolves exactly one local
turn by `ChatTurnEntity.authorityLineageKey`, then groups that turn's attempt
checkpoints by `authoritativeTurnId`. Duplicate checkpoints for an
unknown-outcome replay are legal only when every immutable remote-member field
and envelope checksum is byte-identical. The earliest attempt sequence owns the
deterministic remote-member identity. Repeated `open` outcomes may coexist. Do
not assign a committed outcome to the attempt checkpoint's top-level remote ID:
the top-level `authoritativeTurnId` identifies the member that attempt executed,
while `outcome.result.turnId` identifies the member that actually owns the PC
receipt. A child attempt may therefore store a committed outcome whose result
belongs to an earlier original member. Build the distinct-member identity chain
only from top-level checkpoint pins and verified failure proofs; build a separate
receipt-owner index from committed/redacted outcome result IDs. A terminal result
must have exactly one receipt-member identity aggregate, while repeated stored
terminal outcomes must be canonical-JSON byte-identical. Zero local matches,
multiple receipt-member matches, no member match, or divergent duplicates remains
unacknowledged and writes one bounded redacted diagnostic.

`commitBridgedTerminal(localTurnId, activeAttemptId, result, now)` validates the
receipt against the canonical checkpoint for `result.authoritativeTurnId`, not blindly
against the currently active attempt's remote ID. It separately verifies that
`activeAttemptId` is the active attempt of the same local turn and that its
checkpoint is a valid member of the same lineage. On the first application that
active checkpoint must be `open`; on exact replay it may already contain the
byte-identical `committed` or `redacted` outcome and its attempt/turn may already
be terminal. It then finalizes that active attempt, stores the committed outcome
there without changing the attempt's top-level remote identity, and converges
`ConversationAuthority` to the result's real committed member and revisions.
Thus a PC committed-retry fast path may return a previously requested member;
zero/multiple member matches, any receipt/member-field difference, a foreign
active attempt, or a changed lineage is `BRIDGE_AUTHORITY_CONFLICT` before
writes. If the result member and active member are the same, both validations
resolve to the same checkpoint.

The `redacted` outcome in Task 13C is only the immediate old-clear-epoch result
path described above. It writes the closed metadata receipt identity and no
semantics. It does not invoke or partially implement Task 20 lifecycle clearing;
Task 20 later rewrites every remaining live checkpoint copy during explicit
clear/delete/retraction.

Branch to this v3 transaction immediately after the gateway returns and before
`saveMemoryResult`, `markStage(CHAT_RUNNING)`, `saveRawReply`, `commitReply`, or
`commitSkip`. A v3 turn must call none of those legacy writers. The transaction
owns its receipt/checkpoint, attempt state, change/diagnostic rows, parts/actions,
raw-message projections, authority and cursor together.

Projection is exact and collision-free. Visible items become `ReplyPartEntity`
rows with `replyPartId=canonical messageId`, sequence `0..itemCount-1`, type
`TEXT`, exact content, `createdAt=the first successful transaction's now`, and
`payloadJson=canonicalJson({version:1,canonicalItem:<the exact validated
replyPart object>})`. Exact replay/reopen requires every text part's `createdAt`
to equal the persisted turn `completedAt`; it never regenerates time. They alone create
`RawMessageEntity` rows. For item ordinal `i`, derive the row only from the
validated result and the unique receipt-member checkpoint:

- `messageId=replyPart.messageId`, `turnId=result.authoritativeTurnId`,
  `characterId=result.roleId`, and speaker/recipient/content are copied exactly;
- `origin=result.authorityOrigin`, which is exactly `pc` for this contract;
- `deviceId="pc-group:" + result.visibleGroupId`, `deviceSeq=i+1`, and
  `syncSeq=0`; every group therefore owns a separate collision-free device
  namespace and PC-authored character replies are not echoed through the
  fallback journal;
- let `baseSentAt=min(checkpoint.normalizedEnvelope.createdAt,
  Number.MAX_SAFE_INTEGER-(itemCount-1))`; require a positive safe integer and
  persist `sentAt=baseSentAt+i`;
- `checksum` is SHA-256 over canonical JSON for exactly the eleven persisted
  fields `messageId,turnId,characterId,speakerId,speakerType,recipientId,
  content,sentAt,origin,deviceId,deviceSeq`. It is deliberately distinct from the
  canonical item's richer `itemChecksum`.

Do not treat `INSERT IGNORE` as idempotency. Before any write, reject an existing
foreign row occupying either `messageId` or `(deviceId,deviceSeq)`. Exact replay
and restart reopen the complete character-message set for the remote turn and
recompute count, IDs, ordinals, fields, and checksums. Missing, extra, or changed
rows conflict. Actions never create raw chat messages.

Every canonical action becomes one `ReplyPartEntity` with
`replyPartId=actionId`, sequence `itemCount+ordinal`, empty content, and
`payloadJson=canonicalJson({version:1,canonicalAction,legacyPayload})`. The
`canonicalAction` object contains exactly
`actionId,ordinal,kind,targetKey,targetRevision,payload,actionChecksum` and is the
only authority source. `legacyPayload` is a deterministic compatibility
projection, never a second source. `AlExecutionPlugin` later exposes
`legacyPayload` as the old `payloadJson` while separately exposing the canonical
action for v3 revalidation. The exact kind map is:

| Canonical kind | `ReplyPartEntity.type` | deterministic `legacyPayload` |
| --- | --- | --- |
| `payment_accept` | `PAYMENT_STATUS` | `{status:"received"}` |
| `payment_decline` | `PAYMENT_STATUS` | `{status:"refused"}` |
| `moment_create` | `MOMENT_CREATE` | exact canonical payload |
| `moment_like`, `moment_comment`, `moment_reply` | `MOMENT_ACTION` | exact canonical payload |
| `role_plan_create`, `role_plan_update`, `role_plan_cancel`, `role_plan_pause`, `role_plan_resume`, `role_plan_complete` | `PLAN` | `{operations:[canonical payload]}` |
| `life_episode_create` | `LIFE_EPISODE` | exact canonical payload |
| `life_episode_update`, `life_episode_cancel` | `LIFE_ADJUSTMENT` | exact canonical payload |
| `relationship_transition` | `RELATIONSHIP_STAGE` | exact canonical payload |

The action map is an exact switch over the sixteen registered kinds; prefix
matching is forbidden. Incoming order is authoritative and is never sorted.
Payment, moment, life, and relationship compatibility projections
allow at most one action each; role-plan actions may repeat in ordinal order.
Unknown kind, duplicate single-value projection, wrapper key/type drift,
message/action ID collision, ordinal drift, or semantic checksum drift conflicts
before writes and again across restart.

Canonical payload names follow the existing cognition and feature-domain
contracts: role-plan update/cancel/pause/resume/complete targets use `planId`,
life update/cancel uses `targetEpisodeId`, and moment reply uses
`replyToCommentId`. `resolveCanonicalActionTargetInternal` must extract a target
ID only from those exact `action.payload` fields; `rolePlanId`, `episodeId`, and
`commentId` are not alternate wire payload aliases. After extraction,
`resolveCanonicalTargetRefInternal` continues to validate the target against the
existing PC store row or domain-native normalized input snapshot, where
`rolePlanId`/`episodeId`/`commentId` remain legitimate facts. Preserve the
current resolver sources: role-plan store row or `context.rolePlan`, life-episode
store row, and moment/comment target object or normalized top-level `momentId`/
`commentId` scalar. Do not independently scan raw nested trigger scalars such as
`trigger.context.targetCommentId` or `trigger.context.planId`. A correct new wire
field plus the matching old-domain source succeeds; an old wire payload name
fails even if that source exists. The compatibility wrapper may reshape a
canonical payload for an old consumer, but must never add a second canonical
identity field.

`moment_create` and all three `life_episode_*` kinds remain reserved until their
dedicated Web consumers are implemented. Room persists them under the distinct
`MOMENT_CREATE`, `LIFE_EPISODE`, or `LIFE_ADJUSTMENT` types, advances native
completion, leaves UI application pending, and never misroutes them through
`MOMENT_ACTION`, `SCHEDULE`, or a synthetic text reply.

Web uses one exact action-part applier with outcomes `applied`,
`already_applied`, `unsupported`, or `conflict`. It preflights the entire action
set before any domain/chat/pending mutation. The supported set in Task 13C is
payment accept/decline, moment like/comment/reply, relationship transition, and
the six role-plan operations. After a domain mutation succeeds, persist a
bounded application proof with exactly `turnId,actionId,actionChecksum,type,
appliedAt`; here `turnId` is the canonical `result.authoritativeTurnId`, never
the local Room turn ID. The caller supplies only the four immutable fields;
`appliedAt` is generated on the first successful application as a positive safe
integer and is thereafter retained verbatim. An existing proof is
`already_applied` only when all four immutable fields match and the stored
`appliedAt` is valid, otherwise it is `conflict`. Store proofs in the
existing Web database under `yuqiNativeActionApplications`, keyed by canonical
`actionId`; each value has exactly the five proof fields above. Retain the newest
1000 by `appliedAt`. A trimmed proof does not authorize blind replay: exact
domain-native evidence must reconstruct the same immutable tuple first.

Implement that behavior in `tavern-app/lib/canonical-action-application.js`, a
browser/Node-loadable module whose `createCanonicalActionApplier(...)` receives
injected settings, chat/payment, moment, relationship, role-plan, and global-
proof stores, `now`, a named fault hook, and one idempotent
`acknowledgeUiApplied` hook.
Its `applyGroup({localTurnId,result,actions})` performs the closed whole-set
preflight, applies actions in authoritative ordinal order, repairs exact proofs,
and returns `ready_for_ui_ack` or the already-proven equivalent only after every
action has an exact proof. It may then invoke `acknowledgeUiApplied`, but it never
constructs, publishes, or retries a group receipt. The shared native mock makes
the UI transition monotonic and idempotent, so an ambiguous Web retry may call
the API again while the persisted transition still occurs once. The module owns
no hidden globals and accepts no fallback consumer. Reload tests create a new
applier over the same injected stores after each forced fault; they must inspect
actual persisted values and call counts rather than source text.
`tavern-app/index.html` only adapts the existing DB/domain consumers to this
module. `tests/yuqi-ui-contract.test.mjs` remains a static wiring/order guard,
including the absence of a Web receipt publisher, while
`tests/canonical-action-application.test.mjs` is the mandatory executable
behavior gate.

Role-plan idempotency is not inferred from the existing summary history. Extend
the role-plan domain and repository with a canonical-application entrypoint that
accepts ordered `{operation,request}` pairs. The immutable request has exactly
`version,authoritativeTurnId,actionId,actionChecksum,kind,planId,operationJson`;
`operationJson` is the closed canonical operation to apply and `planId` is the
resolved persisted target, including the plan reused by the create-duplicate
branch. The repository adds a positive-safe-integer `appliedAt` only on first
application. Each plan owns an untrimmed `canonicalActionApplications` ledger
for its lifetime, keyed by `actionId`. The domain preflights the complete ordered
batch: an existing action ID is a no-op only when all seven immutable request
fields match and stored `appliedAt` is valid, while a changed request or duplicate
ID in the incoming batch is a conflict. A replay never regenerates or compares
`appliedAt`. It then applies only unproven operations and writes the resulting
plan state plus every new stored proof in the same single `role_plans_v1`
meta-store write.
This also applies to create deduplication and to repeated operations against the
same plan in one canonical result. `role_plan_history_v1` remains a repairable
projection and may be written after the authoritative plan/proof record; it is
never used alone to authorize replay. Existing noncanonical role-plan APIs and
rows without this ledger remain compatible and cannot fabricate a canonical
proof. When the native repository is available, the proof remains inside the
persisted plan JSON and the existing transactional `replaceRolePlans` call must
write plans/proofs and history together; the Web fallback uses the authoritative
plan/proof meta write first and may repair its history projection afterward.
Every canonical history row uses `historyId=actionId` and is derived only from
the stored ledger's `operationJson`. Missing history is inserted, an exact row
is a no-op, and a changed/duplicate row conflicts. Legacy create input containing
`canonicalActionApplications`, and legacy update patches that add/replace/delete
that reserved field, are rejected before mutation; only the canonical repository
entrypoint can create a ledger proof.

> **Role-plan execution-unit amendment (2026-08-03):** A canonical result may
> contain several role-plan actions, but every role-plan ordinal in that result
> must belong to one contiguous interval. Both PC visible-result validation and
> the Web applier reject an interleaved set such as
> `role_plan_update, payment_accept, role_plan_pause` before any write. This is
> the minimum contract that preserves authoritative ordinal order, one
> `role_plans_v1` write for the complete role block, and crash-prefix semantics;
> a closure that silently collects per-action calls is forbidden.
>
> Ordinary adapters keep `preflight`, `verifyApplied`, and `apply`. The role-plan
> batch adapter implements exactly:
>
> ```js
> preflightBatch({ items, result, localTurnId }) -> prepared
> verifyAppliedBatch({ prepared, itemsWithGlobalProof }) -> { proofsByActionId }
> applyBatch({ prepared, items, pendingActionIds }) -> { resultsByActionId }
> ```
>
> The applier first builds contiguous execution units, then preflights **all**
> units, then verifies **all** existing global proofs, and only then mutates units
> in ordinal order. One role unit calls `applyBatch` once and has one named fault
> boundary `after_domain_batch:role_plan:<firstOrdinal>:<lastOrdinal>`. Global
> proofs are repaired in action ordinal order. Missing, extra, duplicate, or
> reordered proof results conflict before UI acknowledgement.
>
> The repository exposes the closed methods
> `prepareCanonicalBatch(characterId, orderedActions, authority, appliedAt)`,
> `inspectCanonicalBatch(prepared)`, and
> `applyPreparedCanonicalBatch(prepared)`. Preparation resolves create semantic
> deduplication through the role-plan domain's existing intent comparator and
> pins the resolved plan ID and one positive safe-integer `appliedAt`; adapters
> must not copy that comparison rule. Application re-reads fresh plans/history,
> rejects any prepare-time state drift, and performs at most one authoritative
> plan/proof write. Existing ledger proofs remain session evidence even when the
> bounded global proof store trims their repaired copies, so replay retains the
> historical `appliedAt` and never repeats a role operation.

Payment idempotency is anchored to the same persisted `settings` value as the
wallet balance, not to a later chat save. Before mutation, resolve one exact
payment target and compute the immutable request with exactly `version,
authoritativeTurnId,actionId,actionChecksum,kind,targetKey,targetRevision,
characterId,targetMessageId,payType,amountCents,decision,balanceDeltaCents`.
`balanceDeltaCents` is recomputed from the existing payment rules and target;
it is not caller-controlled. On the first application only, compute
`balanceAfterCents` from the current integer-cent balance and generate positive
safe-integer `appliedAt`; append both to the stored journal entry. Store it under
`settings.nativePaymentActionApplications[actionId]` in the same single
`DB.set('settings', settings)` that applies the integer-cent balance delta.
`payment_accept` preserves the existing received behavior;
`payment_decline` preserves the existing distinction that a transfer refunds
once while a red-packet decline remains pending until expiry. On replay, look up
the action ID before reading the current balance: compare only the twelve
immutable request fields, validate the stored generated fields, retain the
historical `balanceAfterCents`/`appliedAt`, and perform no balance change. A later
recharge or unrelated payment therefore cannot turn an exact old replay into a
conflict. An exact existing journal authorizes repair of the chat target plus the
five-field UI proof; a changed request conflicts. The later
chat write stores the same action ID/checksum on the target message, so either
the wallet journal or the exact target marker can reconstruct a missing global
proof. Retain the newest 1000 journal entries; the newly written entry cannot be
trimmed by its own insertion. A crash after the wallet/journal write but before
the chat write, or after the chat write but before the global proof write, must
resume without a second refund or a second action.

Moment and relationship mutations receive the same immutable four-field action
request used by the global UI proof. Before Web adapters are implemented, the PC
producer and target resolver must obey this closed contract:

```text
moment_like    = like is true, comment is empty, replyToCommentId is null
moment_comment = comment is nonempty, replyToCommentId is null; like may be a
                 native boolean and, when true, like+comment is one atomic action
moment_reply   = comment is nonempty, replyToCommentId is nonempty, like is false
relationship_transition payload keys exactly:
  baseAction, phaseAction, expectedSceneRevision, label, changedAt
```

The producer selects reply before comment before like. It never relabels a reply
as a comment, silently drops a simultaneous like, or omits a validated
relationship-stage action from `canonicalActionSet`. Moment/comment target keys
are respectively `moment:<momentId>` and `comment:<replyToCommentId>`;
relationship uses `relationship:<roleId>`. Their target revisions are computed
from the same persisted normalized trigger-input snapshot that Android sends and
Web can reconstruct. Protocol-v3 `context.visibilityCursor` is not a substitute
for that trigger snapshot, and opaque caller revisions or legacy `id` aliases
are never trusted. Cross-stack fixtures must freeze the exact Web/Android/PC
target projection and SHA-256 vectors before an adapter may mutate state.

In the same persistence write as the domain mutation, moment targets store
`canonicalActionApplications[actionId]` with the exact five-field proof rather
than only `nativeActionTurnIds`; relationship stores the same permanent proof at
the character authority level rather than inside trimmed stage history. Exact
replay validates all four immutable fields and retains the original `appliedAt`;
changed proof conflicts. A legacy matching turn ID, comment `sourceTurnId`, stage
history `sourceTurnId`, or generic domain state is never sufficient to
reconstruct a canonical UI proof. On first application target revision is
verified before mutation; after an exact permanent domain proof exists, later
unrelated target evolution does not invalidate historical replay.

`nativeTurnHasUiLanding` must not infer action success from a chat message,
pending-reply ownership, or a generic completed state. For `action_only`, every
canonical action requires an exact `applied`/`already_applied` proof. For
`visible` with actions, both the visible message landing and every action proof
are required. Only then may Web clear pending state, record successful completion,
or call `acknowledgeUiApplied`. A preflight rejection performs
zero domain mutation; a runtime interruption after a subset applied publishes no
UI acknowledgement and resumes from the persisted per-action proofs. Reserved or unknown
types remain unapplied. Validate item and action counts, ordinals, IDs, semantic
checksums, and sets separately across restart; a total-count-only check is
forbidden.

Cursor updates are part of the same outer transaction and are independent of
arrival order. A result epoch newer than the persisted cursor conflicts. An
older epoch, or a sequence already inside the persisted clear boundary, returns
`REDACTED` with no semantic rows or cursor movement. For a live result,
`localSequence=max(existing,result.inputVisibilitySequence)`. Advance the native
watermark only when the result sequence is greater; for an equal sequence its
stored turn/group identity must match; for a smaller sequence preserve the
newer identity. Thus an earlier-member receipt may advance native from 4 to 5
while local remains 6, but it can never lower native 7. `visible` and
`action_only` advance native only. `skip` applies the same monotonic rule to both
native and UI and sets `uiAppliedAt=now` in the transaction. Both cursor identity
columns always store `nativeCompletedTurnId`/`uiAppliedTurnId=localTurnId` and
the remote `visibleGroupId`; they never store `result.authoritativeTurnId` as a
Room turn ID. Remote member IDs remain only in the checkpoint, conversation
authority, receipt fields, and raw character-message projection.

The fresh terminal transaction has nine named logical fault boundaries across
its branch matrix: checkpoint terminal CAS, reply-part batch, raw-message batch,
authority CAS, turn finalizer, active attempt finalizer, native cursor update,
skip-only UI cursor update, and change-event insert. A visible fixture does not
fake a UI-cursor write; action-only does not fake raw rows; skip does not fake
reply/raw batches; redacted executes only checkpoint, authority, turn, attempt,
and change boundaries. Tests cover every applicable boundary across those real
branches rather than claiming all nine writes occur in one call. The verified-
failure transaction has five boundaries: checkpoint failure CAS,
turn failure CAS, attempt failure CAS, change event, and metadata-only
diagnostic. A forced failure after every boundary must roll back checkpoint,
turn, attempt, authority, cursor, parts, raw messages, changes, and diagnostics.

V3 change/diagnostic projections are fixed. Live `visible`/`action_only` inserts
`REPLY_COMMITTED`, live `skip` inserts `TURN_SKIPPED`, and the old-epoch branch
inserts `TURN_REDACTED`; each change payload is canonical JSON with exactly
`turnId` (the local Room ID), `authorityLineageKey`, `visibleGroupId`, and the
real `terminalDisposition`. Verified remote failure inserts `TURN_FAILED` with
exact payload `turnId,authorityLineageKey,authoritativeTurnId,retryAllowed` and
one `ERROR/BRIDGE_REMOTE_FAILURE` diagnostic whose detail is canonical JSON with
exactly `redacted:true,errorCode,retryAllowed,rawStatusChecksum`. It stores no
failure message. Exact replay inserts no second change/diagnostic; changed rows
conflict.

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

After a gateway has returned a parsed v3 `BridgeResult`, `ExecutionEngine`
enters a dedicated apply branch outside the legacy catch-and-`markFailed` path.
An exception from `commitBridgedTerminal` or `commitVerifiedRemoteFailure`
propagates as an authority/application failure with zero legacy writes. Only
configuration, transport, timeout, or other unknown-result failures that occur
before a valid v3 result exists retain the existing local retry/failure behavior.

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

`BridgeReceiptDeliveryCoordinator` is the single testable sender used by
`AlExecutionService.confirmBridgeDelivery`. It receives injected Room receipt
state/CAS access, transport, and clock. A missing `uiAppliedAt`, redacted result,
or existing exact `cloudConfirmedAt` returns without transport. A ready result
always derives the same authority receipt and transport idempotency identity from
the persisted group/checksum; network failure retains the same retryable proof.
After authenticated PC success, the coordinator CASes the exact group/checksum
to `cloudConfirmedAt` before treating the work as finished. A crash after remote
acceptance but before that CAS may repeat HTTP with the same identity; it must
not construct a second authority receipt. Unit tests create a new coordinator
over the same fake persisted store to model service restart and repeated Web UI
acknowledgement. `ExecutionServicePolicyTest` owns these executable cases;
notification or static source-contract tests cannot substitute for them.

- [ ] **Step 5: Run cross-stack Task 13 gate**

From repository root:

```powershell
node --test tests/canonical-action-application.test.mjs tests/payment-batch-bridge-contract.test.mjs yuqi-runtime/test/bridge-authority-v3.test.mjs yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/store-visible-authority-v13.test.mjs yuqi-runtime/test/v3-runtime-recovery.test.mjs yuqi-runtime/test/local-server.test.mjs yuqi-runtime/test/cloud-relay-pump.test.mjs yuqi-runtime/test/result-outbox.test.mjs
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

Add `tests/canonical-action-application.test.mjs` to the permanent `npm test`
command in `package.json`; the Step 5 focused invocation is not its only gate.
