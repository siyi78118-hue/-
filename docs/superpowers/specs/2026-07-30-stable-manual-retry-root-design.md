# Stable Manual Retry Root Design

## Problem

The Android chat UI creates a fresh Room turn for every manual retry, which is
correct because terminal turns are immutable. However, it currently sets
`retryOfTurnId` to the most recent retry turn. A sequence of clicks therefore
creates a fragile chain:

`original turn -> retry 1 -> retry 2 -> retry 3`

If any intermediate retry never reaches the PC, every descendant references a
missing parent and is rejected. The canonical user message remains associated
with the original deterministic turn, so chaining retries provides no useful
identity guarantee.

## Design

Every manual retry keeps its own fresh `turnId`, but always sets
`retryOfTurnId` to `nativeTurnIdForMessage(userMessageId)`, the deterministic
original turn. `retryLineageTurnIds` remains a UI-only history used to accept a
late successful ancestor; it does not determine protocol lineage.

The PC continues to require exact canonical message identity, device identity,
character identity, content, and sent time. Thus a missing original turn can be
recovered from the synchronized canonical message without trusting an
intermediate retry.

## Success Criteria

- First and later manual retries all reference the same original turn.
- Each retry still gets a fresh Room turn ID.
- A late successful retry may resolve the pending message without duplicating
  its visible reply.
- Existing direct-send, native completion, and retry safety tests remain green.
- The Android package version advances from 1.0.104 to 1.0.105.
