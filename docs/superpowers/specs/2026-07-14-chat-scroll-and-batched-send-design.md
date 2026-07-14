# AL chat scroll and batched-send design

Date: 2026-07-14

## Goal

Fix polling-induced scroll jumps and let the player compose several independent chat bubbles before submitting them to the character as one conversational turn.

## Scope

This change covers two connected chat-input behaviors:

1. Background/native polling may update chat data, but must not force the conversation to the bottom.
2. The player may create multiple independent bubbles, then press `发送结束` once to submit the whole batch to the AI pipeline.

Cloud timer scheduling, native diagnostics, and unrelated chat rendering defects remain separate fixes.

## Scroll behavior

- Entering a conversation initially positions the viewport at the newest message.
- Creating one of the player's own bubbles positions the viewport at the newest message.
- Native polling, typing-state changes, assistant replies, proactive replies, and moment synchronization do not change the current scroll position.
- Re-rendering preserves the currently visible message anchor and its pixel offset. If the anchor no longer exists, it preserves the previous numeric `scrollTop` as a fallback.
- No periodic operation calls `scrollChatBottom()`.

## Batched-send interaction

### Bubble creation

- The existing send control creates an independent green player bubble immediately.
- The bubble is stored locally with `deliveryState: "staged"` and a shared `batchId`.
- A staged bubble is visible in chat history but is excluded from all AI context and memory processing.
- Creating the first staged bubble starts the current batch. Later bubbles join that batch until it is committed.

### Batch completion

- While the current conversation has staged bubbles, a text command labeled `发送结束` appears in the composer.
- Pressing `发送结束` atomically changes every staged bubble in the current batch to `deliveryState: "sent"`.
- The last bubble becomes the source message for the native execution turn; the complete batch is included as ordered individual user messages in the selected latest-30-message context.
- The memory-retrieval AI runs once for the committed batch.
- The chat AI runs once after memory retrieval and receives the complete RP rules, character/state data, latest context, selected memories, and all committed batch bubbles.
- The assistant may return multiple bubbles, but they all belong to the single committed batch turn.

### Persistence and editing

- Staged batches are persisted in the existing chats store and survive navigation, lock screen, process death, and app restart.
- Retracting or deleting a staged bubble removes it from the batch before submission.
- If every staged bubble is removed, the batch is cleared and `发送结束` disappears.
- Staged bubbles are never submitted automatically because of navigation, polling, proactive messages, or app startup.

### Failure and retry

- Reply state is attached to the batch, with a compatibility marker on the final source bubble for the current UI.
- A failed native/model execution marks the whole batch as failed.
- `重新发送` resubmits the same committed batch with the same ordered contents. It does not duplicate bubbles and does not retry only the last sentence.
- A completed native turn clears the batch failure state exactly once and cannot append duplicate assistant replies.

## Data model

Each player message may contain:

```js
{
  batchId: "batch-...",
  deliveryState: "staged" | "sent",
  batchSequence: 0,
  batchCommittedAt: 0
}
```

Each chat may contain:

```js
{
  stagedBatch: {
    batchId: "batch-...",
    messageIds: ["msg-..."],
    createdAt: 0
  },
  pendingReply: {
    batchId: "batch-...",
    sourceMessageId: "msg-..."
  }
}
```

Legacy messages without these fields remain sent and available to AI.

## AI context rules

- `messageAvailableToAI` returns false for staged messages.
- On commit, all batch messages become available in one transaction before task construction.
- Latest-30 selection counts the committed bubbles individually and retains their original order and timestamps.
- The native task records the batch message IDs so retry and result reconciliation remain deterministic.
- Memory extraction after the assistant reply treats the committed batch and reply as one turn, while preserving every individual bubble in raw context.

## UI behavior

- The normal send control remains responsible only for adding the next bubble.
- `发送结束` is shown only when the active conversation has at least one staged bubble.
- Both controls are available while composing the current batch.
- After `发送结束` commits a batch, the composer follows the existing single-turn rule and remains unavailable until that AI turn completes or fails. This prevents two player batches from racing or receiving replies out of order.

## Error handling

- If native task submission fails before a turn is accepted, the committed batch is marked failed and remains retryable.
- If the app exits after the local commit but before native submission, startup recovery detects a committed batch without a native turn and submits it once using a deterministic turn ID.
- If a completed reply already exists for the batch, recovery acknowledges it instead of submitting again.
- Invalid or partially migrated batch metadata is rebuilt from message order without deleting user-visible messages.

## Tests

### Scroll tests

- Poll reconciliation while reading old messages preserves the visible anchor and offset.
- Assistant reply insertion does not force the viewport down.
- Player bubble creation scrolls to the bottom.
- Initial chat entry scrolls to the bottom.

### Batch tests

- Three staged bubbles produce zero model calls before `发送结束`.
- `发送结束` produces one memory-retrieval call and one chat turn containing all three bubbles in order.
- Staged bubbles are excluded from proactive-chat context before commit.
- Navigation/restart preserves staged bubbles without submitting them.
- Retracting the middle staged bubble submits only the remaining two.
- A failed batch retry preserves all bubbles, uses one deterministic native turn, and creates no duplicate user bubbles.
- Completed native reconciliation appends the assistant result once and clears the batch failure state.
- Legacy one-message histories continue to work.

## Release constraint

Implementation and tests may be completed locally, but this change is not published until the user finishes reporting the remaining issues and explicitly requests a combined release.
