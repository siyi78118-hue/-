# Chat Render Performance Design

## Context

The Yuqi chat backup contains 1,908 stored messages and 1,894 visible messages.
The current chat renderer rebuilds every visible message with `innerHTML`, scans
the rendered nodes for scroll anchoring, and binds listeners to every message.
While a native reply is pending, three-second polling treats elapsed-time-only
changes as state changes, serializes the full chat to synchronous localStorage,
and triggers another full render.

## Approved approach

Keep every message in storage, memory processing, search, export, and AI context,
but window the chat DOM:

- Initially mount the latest 120 visible messages.
- Show a lightweight “load earlier messages” control for the hidden prefix.
- Each activation adds 120 older messages and preserves the current visual anchor.
- Reset the in-memory render limit to 120 when opening a conversation.
- Do not persist the limit; it is presentation state, not conversation data.

Replace per-message listeners with one delegated listener set on the chat
container. Long-press, movement cancellation, pointer completion, and context
menus resolve the closest `data-message-id` element.

Native pending-state equality ignores elapsed counters. A poll that changes only
`stageElapsedMs` or `totalElapsedMs` neither rewrites the full chat nor rerenders
the message list. Real state, stage, or visible-copy changes still reconcile.

## Non-goals

- Do not delete, summarize, archive, or rewrite historical messages.
- Do not reduce the 200-message AI evidence window.
- Do not change memory extraction, search, export, or native delivery semantics.
- Do not introduce a framework or a full variable-height virtual scroller.

## Validation

- A pure window-selection test uses 1,900 messages and returns only the latest 120.
- Expanding the window returns 240 messages with the correct earlier boundary.
- The renderer uses the selected window rather than `visibleChatMessages` directly.
- Event binding is delegated and contains no per-message listener loop.
- Elapsed-only native polling is considered current.
- The existing UI, retry, native execution, and full project suites remain green.
