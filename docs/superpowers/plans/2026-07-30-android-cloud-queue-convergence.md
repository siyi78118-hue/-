# Android Cloud Queue Convergence Implementation Plan

**Goal:** Remove cloud mailbox head-of-line blocking and make the phone UI distinguish local queueing from actual remote thinking.

**Architecture:** Cloud enqueue becomes an asynchronous durable handoff. The engine persists `BRIDGE_WAITING` and releases the single Room worker; the existing independent cloud inbox drain commits the final result.

### Task 1: Red transport and router tests

- Add a cloud test proving successful enqueue returns immediately without polling.
- Add a router test proving accepted handoff never invokes fallback.
- Run focused tests and observe the new assertions fail.

### Task 2: Red engine and mirror tests

- Add an engine test for `MEMORY_RUNNING -> BRIDGE_WAITING`.
- Add a mirror test that imports a terminal result into the original waiting turn.
- Prove the next queued turn remains runnable.

### Task 3: Implement asynchronous cloud handoff

- Add the accepted signal and router handling.
- Add the waiting state and store transition.
- Allow terminal cloud import from waiting state.
- Keep cloud failures and LAN behavior unchanged.

### Task 4: Correct WebView progress semantics

- Render local queueing as delivery, not thinking.
- Render `CLOUD_ACCEPTED/BRIDGE_WAITING` as waiting for the computer.
- Preserve PC model stage text once bridge status exists.

### Task 5: Verify and publish

- Run focused Android and UI tests, then full Node and Android suites.
- Increment the formal Android/Web/update version without reverting existing 1.0.107 work.
- Build and verify a formally signed, cover-installable OTA APK under the project signing runbook.
