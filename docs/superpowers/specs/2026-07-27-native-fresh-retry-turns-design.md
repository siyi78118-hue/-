# Native Fresh Retry Turns Design

## Problem

The phone UI creates a fresh retry turn ID, but the Android Room store currently
deduplicates submissions by `sourceMessageId`. A retry therefore resolves to the
old turn while the UI records the invented retry ID as accepted. The old completed
reply is then rejected as superseded and the retry ID can never complete.

## Decision

Retries are first-class execution turns end to end:

- `turnId` is the submission idempotency key.
- Several direct-reply turns may share one canonical `sourceMessageId`.
- Retry lineage is carried by `retry.retryOfTurnId` in the immutable input.
- The first completed turn in a lineage to land in the conversation wins.
- A completed predecessor may satisfy a currently pending descendant retry.
- Later completions for the same canonical user message do not create another
  bubble or reapply relationship, plan, payment, or schedule actions.

## Storage

Room schema version 9 changes the `sourceMessageId` index from unique to
non-unique. The `turnId` primary key remains unique. `cloudJobId` remains unique.

`RoomExecutionStore.submitTurn` first looks up `submission.turnId`. Repeating the
same submission returns the existing turn and does not create another attempt.
A different turn ID is inserted even when its source message matches an older
turn.

## UI reconciliation

The retry UI accepts a submission only when the native result returns the exact
requested turn ID. It records the ancestor IDs carried from the previous pending
reply.

Supersession checks distinguish unrelated stale turns from retry ancestors. A
completed ancestor is allowed to land and clears the pending descendant for the
same user message. Once any assistant bubble exists for that user message, a
different late turn is ignored before any side effects are applied.

This also repairs already-created phantom retries: startup replay of the original
completed turn recognizes it as an ancestor, renders its reply, and clears the
unfinishable pending ID.

## Validation

- Android store test: two turn IDs with one source message coexist.
- Android store test: repeating one turn ID creates one attempt.
- UI contract test: retry acceptance requires exact native turn ID.
- UI behavior test: a completed ancestor is not superseded by its pending retry.
- UI behavior test: an unrelated old turn remains superseded.
- Full JavaScript and Android contract suites remain green.
