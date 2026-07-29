# Recovered Message Retry Lineage Implementation Plan

> **For agentic workers:** Execute these checkbox steps in order with test-driven development.

**Goal:** Allow a verified retry to recover when reconciliation restored its canonical message but the original turn is absent.

**Architecture:** Extend only `YuqiStore.submitTurn()` retry lineage validation. The recovered canonical message becomes the fallback proof of lineage; all identity and immutable payload fields must match.

**Tech Stack:** Node.js, `node:sqlite`, `node:test`.

## Global Constraints

- Preserve strict validation for ordinary retries and all mismatched payloads.
- Never duplicate the canonical user message.
- Do not modify Android or UI files.

### Task 1: Store retry lineage fallback

**Files:**
- Modify: `yuqi-runtime/test/protocol-store.test.mjs`
- Modify: `yuqi-runtime/src/store.mjs`

- [ ] Add a test that restores a canonical user message without its turn, retries it, and expects one new queued turn with one user message.
- [ ] Run the focused test and verify it fails with `retry turn lineage mismatch`.
- [ ] Add a negative test for a retry whose missing parent does not equal the recovered message's `turnId`.
- [ ] Implement the minimal fallback validation in `submitTurn()`.
- [ ] Run the focused test and the full runtime suite.
- [ ] Restart the runtime, allow the queued relay item to execute, and verify phone confirmation.
