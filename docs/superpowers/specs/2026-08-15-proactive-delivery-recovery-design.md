# Proactive Delivery Recovery Design

## Problem and evidence

The authority-v1 proactive path introduced after the legacy Android flow can permanently lose a chat or moment generation.

- The PC database contains no proactive turn newer than 2026-07-31 02:35:18 +08:00.
- On 2026-08-15 the production cloud authority reported chat generation 6 and moment generation 1 as `paused`, with no active job or due time.
- The moment stream changed to `paused` at 17:16:24 and the production delivery probe recorded `automatic schedule stale delivery` at the same instant.
- A manual cloud-timer test is not sufficient evidence: `AlFirebaseMessagingService` deliberately routes `test=true` around the authority token parser, Room claim, turn creation, wake and PC bridge.
- `deliverJob()` currently requests a phone acknowledgement only when the stored push subscription advertises `backgroundAck >= 1`. An automatic-authority FCM target registered by an older build may therefore be treated as fire-and-forget; after a successful FCM HTTP response the Worker changes the stream to `paused` even when the new Android authority path rejected or never claimed the payload.
- Android currently wakes execution only for `CLAIMED`; `REPLAY`, `STALE` and invalid tokens disappear without a recoverable signal.
- Version 1.0.119 registers the FCM token for both Web and bridge device identities, but it does not repair an already paused remote stream or the silent replay gap.

## Goal

Make a real proactive chat or moment generation remain recoverable until Android has durably claimed and completed it, automatically repair the known remote-paused/local-scheduled upgrade state without changing the user's planned time, and expose enough metadata-only state to identify the first failed stage.

## Non-goals

- Do not change the cognition, memory, expression or quality-evaluation pipeline.
- Do not generate a proactive message merely because a transport retry occurred.
- Do not bypass role-deletion tombstones, direct-conversation pause, or the single Room schedule authority.
- Do not use the manual test notification as an end-to-end acceptance gate.
- Do not add a second Web/localStorage schedule authority.

## Chosen architecture

### 1. Cloud delivery remains recoverable

Every FCM delivery for an `automaticAuthority` job enters `awaiting_ack` after Firebase accepts the request, regardless of the historical subscription's `backgroundAck` capability. Legacy non-authority jobs retain their existing capability-based behavior.

The Worker does not mark an automatic stream `paused` merely because Firebase returned success. While Android/PC processing is incomplete, the existing delivery retry schedule continues to send the same epoch, generation and job identity. Completion advances the stream through the next Android schedule transition.

### 2. Android dispatch outcomes have explicit behavior

- `CLAIMED`: the Room turn already exists durably; post the one pending notification and enqueue the execution wake.
- `REPLAY`: do not create another turn or notification, but enqueue the execution wake so a crash between claim and wake cannot strand the turn.
- `STALE`: do not execute the payload or create semantic rows; append one metadata-only schedule event and enqueue remote schedule reconciliation.
- Invalid authority token: do not execute it; append a bounded metadata-only diagnostic only when a safe stream identity can be derived, then enqueue reconciliation. No chat text, prompt, token or complete authority epoch is stored.
- Role-deleted streams remain silent and do not reschedule.

### 3. Exact paused-stream recovery

Room remains the only local authority. Reconciliation compares a local `scheduled` row and its immutable outbox payload with the closed `/v2/schedule-status` response.

The only automatically repairable mismatch is:

- same owner, device, character, kind, epoch fingerprint, generation and schedule checksum;
- local state is `scheduled` with an immutable job and due time;
- remote state is `paused` with no active job or due time;
- no local turn has claimed that job;
- the role is not deleted.

Under those conditions Android performs one exact CAS from the existing generation's `synced` outbox row back to `waiting`. It does not run the planner, increment generation, change job ID, or change due time.

The Worker recognizes the exact same-generation/same-checksum scheduled transition as recovery only when the current remote row is the matching empty `paused` shell. It restores the original scheduled payload. A normal exact replay in any healthy state remains idempotent. A different checksum, epoch, generation, owner, target, active job or nonempty due time fails closed.

This rule cannot revive a legitimate direct-conversation pause: that pause has a local paused state and its own later generation/checksum, so it does not satisfy the local-scheduled recovery predicate.

### 4. Diagnostic boundary

`automatic_schedule_events` stores only stream key, generation, event type, bounded result code, job identities and timestamps. The settings projection may expose only a compact last real delivery stage/time. Manual test UI must say that it proves FCM transport only.

Required stages are `push_claimed`, `push_replay_wake`, `push_stale_resync`, `remote_paused_requeued`, and `remote_conflict`. The status must not contain chat text, memory, prompts, tokens, full epoch values or FCM registration tokens.

## Safety invariants

1. One Room stream row and one immutable outbox row remain the only Android schedule facts.
2. Recovery never runs the planner and never changes generation, job ID, due time or schedule checksum.
3. `CLAIMED` and `REPLAY` may wake execution; only `CLAIMED` may show the initial pending notification.
4. `STALE`, invalid and remote-conflict paths create no turn, attempt, reply, moment, payment, memory or notification.
5. A role-deletion tombstone suppresses dispatch, repair, diagnostics that reveal semantics, notifications and wakeups.
6. Concurrent reconcilers may make at most one outbox row sendable.
7. A healthy `scheduled`, `awaiting_ack`, `claimed`, direct-paused or disabled stream is never rescheduled by reconciliation.
8. Worker retries preserve the same authority tuple; they cannot mint a new proactive generation.

## Verification

- Node Worker tests cover historical `backgroundAck=0`, automatic retry, exact paused-shell recovery, healthy replay, and all conflict dimensions.
- Android JVM tests cover all FCM dispatch outcomes, one-notification behavior, replay wake and role-delete suppression.
- Android Room tests cover exact requeue, concurrent CAS, restart, immutable due/job/generation/checksum, and fail-closed states.
- Web contract tests distinguish transport-only test push from real proactive stages.
- A production smoke test requires a real short-interval chat generation to appear in the PC database and then advance to a next scheduled generation. A test notification alone does not pass.

## Work allocation

- Primary controller: Worker state machine, integration, production evidence, release and final APK.
- “中控”: Android Room/FCM/reconciliation and Web status implementation within the assigned file lock.
- “常务”: read-only adversarial review and independent gates; it never edits either implementation line.

