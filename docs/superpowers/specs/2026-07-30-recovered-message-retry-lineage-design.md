# Recovered Message Retry Lineage Design

## Problem

A phone message can be restored to the PC database by reconciliation even when
its original turn was never accepted. The phone then retries that canonical
message with `context.retry.retryOfTurnId` pointing at the missing original
turn. `YuqiStore.submitTurn()` currently requires that turn to exist, so the
relay rejects the retry forever with `retry turn lineage mismatch`.

## Design

Keep the existing turn-based lineage validation when the original turn exists.
When it does not exist, accept the retry only if the canonical recovered user
message already exists and proves the same lineage:

- its `turnId` equals `retryOfTurnId`;
- character and device identities equal the retry envelope;
- it is a user message;
- message ID, content, and sent time exactly equal the retry envelope.

All mismatches remain rejected. The retry creates a new queued turn while
reusing the one canonical user message.

## Verification

Add a store regression test for the recovered-message/missing-turn case and a
negative test proving a different missing parent turn is still rejected. Run
the focused store test and the complete runtime test suite. After deploying the
runtime change, confirm the currently queued retry is accepted, executed, and
confirmed by the phone.
