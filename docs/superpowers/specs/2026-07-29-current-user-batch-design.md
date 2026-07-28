# Current User Batch Design

**Date:** 2026-07-29

## Goal

Preserve every independently rendered user bubble while making all bubbles committed by one
"发送完成" action one authoritative, ordered `CurrentUserBatch` throughout Android submission,
protocol validation, persistence, routing, memory analysis, generation, and supervision.

## Confirmed failure

The Android bridge already sends a `context.currentBatch` boundary, but the PC protocol validator
currently drops that field. Downstream code therefore treats only `envelope.message` (the final
bubble) as the current user input. Earlier bubbles may exist in synchronized history, but they are
misframed as earlier conversation.

## Data contract

Protocol-v2 direct turns may carry:

```json
{
  "context": {
    "currentBatch": {
      "batchId": "batch_...",
      "messageIds": ["msg_1", "msg_2"],
      "startedAt": 1780000000000,
      "committedAt": 1780000005000,
      "messages": [
        {
          "messageId": "msg_1",
          "speakerId": "user",
          "speakerType": "user",
          "recipientId": "yuqi",
          "content": "第一条",
          "sentAt": 1780000000000
        },
        {
          "messageId": "msg_2",
          "speakerId": "user",
          "speakerType": "user",
          "recipientId": "yuqi",
          "content": "第二条",
          "sentAt": 1780000003000
        }
      ]
    }
  }
}
```

The final batch item is the canonical reply anchor and must match `envelope.message`. Message IDs
must be unique and ordered, timestamps must be coherent, every item must be a user message for the
same character, and the total attachment count remains bounded by the runtime's per-turn image
limit. ID-only batches remain accepted for compatibility with already installed clients.

## Runtime behavior

- A single resolver produces one `CurrentUserBatch` for every direct turn, including legacy
  single-message turns.
- The resolver prefers self-contained protocol messages, can resolve an old ID-only batch from
  synchronized messages, records missing IDs, and never silently treats an incomplete multi-bubble
  batch as complete.
- Routing analyzes the batch's combined text. An incomplete batch is conservatively routed deep.
- Interaction timing excludes every current-batch message from history and calculates the
  conversation gap from `startedAt`.
- Memory, brain, and supervisor receive one explicit `currentUserBatch`. Current text is not
  duplicated in `recentMessages`.
- Evidence validation may still use the merged set of historical and current-batch messages so
  exact message IDs and quotes remain verifiable.
- Generation-window grouping treats historical user messages with the same batch ID as one group.

## Persistence

The SQLite runtime adds:

- `current_user_batches`: one row per accepted direct turn with batch identity and boundaries.
- `current_user_batch_items`: ordered message identity and canonical payload per accepted turn.

Existing message rows and checksums are not rewritten. Batch items can refer to messages that arrive
through synchronization before or after the turn, avoiding checksum conflicts with legacy
per-message turn IDs. Message-history reads expose batch metadata through a join.

## Compatibility and failure policy

- Protocol-v1 and protocol-v2 direct turns without a batch become a synthetic single-message batch.
- Existing protocol-v2 clients that send only `messageIds` remain valid.
- New clients send the full ordered message payload, making the current turn independent of history
  synchronization timing.
- Malformed, reordered, mismatched, oversized, or duplicate batch data is rejected before
  persistence.
- No fallback model or template is introduced by this change.

## Acceptance criteria

1. `["你明明答应过我，我真的很失望", "算了"]` routes deep even though the final bubble alone is mild.
2. The previous-message and conversation-gap calculations ignore all bubbles in the current batch.
3. Memory, brain, and supervisor receive every current bubble once, in order, under
   `currentUserBatch`.
4. Current-batch messages do not reappear in `recentMessages`.
5. Batch identity persists without changing existing message checksums.
6. Single-message, retry, payment, quote, and image flows remain compatible.
7. LAN and cloud entry paths preserve the same validated envelope.
8. The full JavaScript and Android unit suites pass before release signing.
