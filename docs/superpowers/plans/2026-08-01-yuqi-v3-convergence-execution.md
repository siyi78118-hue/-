# Yuqi v3 Convergence Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven development for implementation and systematic debugging for every failing or unexpected test. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the existing Yuqi lived-agency v3 reconstruction as a tested, signed, covering-install Android release without reopening completed authority work or allowing repeated theoretical review to prevent delivery.

**Architecture:** The detailed implementation contract remains `docs/superpowers/plans/2026-07-30-yuqi-lived-agency-v3.md`. This document is the authoritative scheduling, ownership, review, and stop-policy overlay. One Sol central window owns architecture and release decisions; two Terra execution lines implement disjoint file sets and return evidence to that central window.

**Tech Stack:** Node.js ESM, SQLite, Android Java/Room/Capacitor, WebView JavaScript, GitHub Actions, signed Android APK/OTA.

## Global Constraints

- Task 10 through Task 10F-R7 is closed at commit `54ec72d`; it may reopen only for a reproducible P0/P1 failure, never for an untriggered theoretical counterexample.
- Preserve all unrelated dirty, deleted, and untracked user files. Never reset, checkout, clean, stage, or commit a file outside the assigned file list.
- The previously paused Yuqi production runtime remains stopped until the production-migration gate explicitly authorizes restart.
- Every behavior change follows red-green-refactor. A worker must record the exact red failure before changing production code.
- One task has one file owner. Two workers may not modify the same file concurrently.
- The detailed plan owns behavior and interface requirements; this overlay owns execution order and whether an issue blocks progress.
- Only the Sol central window may amend architecture, reassign files, integrate cross-line changes, authorize production migration, or declare release readiness.
- Terra workers report to the Sol central window, never ask the user to relay messages, and do not independently broaden product scope.

---

## Severity and Stop Policy

| Severity | Definition | Worker action |
|---|---|---|
| P0 | Data loss/cross-user data, unauthorized real-world action, credential/signing compromise, irreversible production migration | Stop immediately with one complete evidence report |
| P1 | Core feature cannot work, exact-once authority can duplicate visible/action results, restart cannot recover, required interface is technically contradictory | Stop after reproducing and tracing the root cause; include every affected interface in one report |
| P2 | Recoverable local bug, missing test, ordinary interface mismatch, build/test regression confined to the current task | Fix inside the current task by TDD; do not return control merely to report it |
| P3 | Untriggered theoretical edge, optional hardening, naming/style issue, file-list wording issue with an obvious in-scope consumer | Record in the non-blocking backlog and continue |

Additional closure rules:

- A completed milestone receives one consolidated Sol review. Findings are returned once as a complete P0/P1/P2 list.
- A prior task is not reopened merely because a later task introduces a new desired invariant. The new task owns the compatibility adaptation.
- Three failed fixes for the same root cause trigger an architecture review; workers must not stack a fourth patch.
- Passing self-authored focused tests is necessary but insufficient. Each milestone requires the specified integration gate and an independent central-window counterexample review.

## Worker Ownership

### Execution line A — PC core and behavior

Owns, when assigned: release execution, PC orchestration, cognition adapters, direct/proactive/moment/plan/life behavior, quality tooling, rollout controller, and their Node tests.

It does not modify Android Room/bridge files or WebView files while execution line B owns them.

### Execution line B — Android, bridge, Web, and platform evidence

Owns, when assigned: Android Room/cursor, bridge protocol mirror, Android fallback, Web cursor handshake, Android/Web diagnostics, release/version tooling, and their tests.

It does not modify PC orchestration/store files without an explicit temporary handoff from the central window.

### Sol central window — integration and authority

Owns: dependency decisions, cross-line interface freezes, P0/P1 arbitration, shared-file handoffs, milestone review, production backup/migration, signed release verification, and final user reporting.

## Dependency Waves

### Wave 1: Freeze the production spine

#### Line A — complete detailed-plan Task 11

- [ ] Finish v14 migration preflight/fault matrix and canary subject accounting.
- [ ] Finish life-attempt release pins, result-transaction comparison creation, execution, and recovery.
- [ ] Finish real production draft providers, canonical orchestrator path, scoped comparison loader, and worker recovery.
- [ ] Run the exact Task 11 Step 4 command and `npm.cmd test`.
- [ ] Commit only Task 11 files as `feat: integrate v3 release execution and recovery`.

#### Line B — complete detailed-plan Task 12

- [ ] Add Android Room v11 cursor/authority migration tests and observe the expected red failure.
- [ ] Implement the two Room entities, migration, DAO/store CAS, clear cursor, and plugin payload.
- [ ] Run Android unit/instrumentation compilation gates; run connected migration tests when a device/emulator is available.
- [ ] Commit only Task 12 Android files as `feat: persist Android conversation visibility cursor`.

**Milestone A gate:** Task 11 named Node gate passes, `npm.cmd test` passes, Task 12 Android unit tests and instrumentation APK compile pass, and the central window confirms that Task 11 and Task 12 share receipt/cursor meanings without modifying the same files.

### Wave 2: Freeze cross-device contracts and build quality evidence

#### Line B — detailed-plan Task 13

- [ ] Implement protocol v3 authority/visibility claims, shared identity vectors, receipt-derived bridge results, and Room mirror validation.
- [ ] Preserve wire v1/v2 compatibility and prove v3 claims never select PC result-authority version.
- [ ] Run Node bridge tests and Android bridge unit tests; commit Task 13 files.

#### Line A — detailed-plan Task 21

- [ ] Separate the 270 protocol fixtures from human-quality evidence without changing live rollout counters.
- [ ] Compile the 24 source-grounded sentinels, 72 independent variants, and 30 local-only history scenes.
- [ ] Verify provenance, scene depth, feature-target integrity, privacy, unique semantic variants, and committed/private boundaries.
- [ ] Commit public fixtures/tooling only; never commit private real-history text.

**Milestone B gate:** Task 13 bridge contracts pass on Node and Android; Task 21 reports 270 protocol cases, 24 sentinels, 72 variants, and 30 local-only history scenes; live counters are byte-for-byte unchanged by replay generation.

### Wave 3: Parallel cross-device execution

This wave begins only after Task 13 freezes protocol v3.

#### Line A — detailed-plan Task 15

- [ ] Implement the bounded Web cognition-v3 snapshot and cursor fetch.
- [ ] Route event, polling, reload, and notification-open through one visible-group reconciler.
- [ ] Prove visible/action-only/skip acknowledgement and all six recovery races.
- [ ] Commit Task 15 Web/test files.

#### Line B — detailed-plan Task 14

- [ ] Implement Android cognition-v3 fallback codec while retaining v1/v2 decoders.
- [ ] Permit fallback only after explicit not-accepted/disabled outcomes; ambiguous remote ownership remains pending.
- [ ] Commit/import one local receipt exactly once without PC cognition/outbox side effects.
- [ ] Run Android fallback and PC import tests; commit Task 14 files.

**Milestone C gate:** event/poll/reload produces one UI application, ambiguous transport never creates a local duplicate, fallback receipt import produces no PC redelivery, and old v1/v2 paths remain green.

### Wave 4: Finish every user-visible feature

Tasks 16–19 are serial because they share `orchestrator.mjs` and cognition adapters. Line A owns them in order:

- [ ] Task 16: direct reply, complete multi-bubble, payment, media, voice, emoji, and quotes.
- [ ] Task 17: proactive motive, legal silence, and direct-message collision.
- [ ] Task 18: moments, comments, replies, public privacy, and exact targets.
- [ ] Task 19: role plans, schedules, life planning, user-edited stage persona, and formal relationship transitions.

While line A executes Tasks 16–19, line B owns Task 22 evaluator implementation only after Task 21 commits:

- [ ] Implement deterministic findings, blinded pair ordering, six-dimension normalization, disagreement/manual-review queue, and immutable report identity.
- [ ] Do not claim `eligible=true` until Tasks 16–19 are merged and the real repeated replay has run.

**Milestone D gate:** all preserved feature matrices pass, no structured target is inferred by expression, no ordinary stage label leaks into dialogue, and every automatic skip/action-only result uses canonical terminal authority.

### Wave 5: Cross-cutting lifecycle integration

Task 20 is serial and temporarily owns every listed PC/Android/Web lifecycle file. Both execution lines stop overlapping edits while its owner works.

- [ ] Implement the evidence-only memory allowlist.
- [ ] Implement backup/import/clear-memory/clear-chat/delete-role behavior for every v10–v14 authority table.
- [ ] Implement monotonic encrypted clear control, durable relay retraction, restart retry, and late-result suppression.
- [ ] Run memory, lifecycle, relay, outbox, Android, backup, and audit gates.

**Milestone E gate:** no cleared semantic content remains retrievable or executable, retained tombstones/commitments reopen cleanly, late results cannot reappear, and backup/restore evidence is complete.

### Wave 6: Quality, rollout, diagnostics, and release

- [ ] Finish Task 22 repeated blind replay and resolve every required manual review item.
- [ ] Complete Task 23 release registration, per-kind shadow/canary/graduation/rollback, backlog fuse, and CLI.
- [ ] Complete Task 24 sanitized four-stage diagnostics and all 18 race cases.
- [ ] Complete Task 25 manifest-based readiness gate and recompute all artifact checksums.
- [ ] Complete Task 26 version resolution, source-consistent release commit, fixed-certificate workflow, signed APK, OTA, and covering-install verification.
- [ ] Complete Task 27 only after readiness: back up production, clone-migrate, apply atomically, audit, restart stable, register eligible candidates in truthful shadow, and materialize final handoff.

Task 23 and Task 24 are not implemented concurrently because both consume runtime/store/main rollout authority. Task 25–27 remain serial release operations.

## Milestone Review Checklist

At each milestone, the Sol central window performs exactly one consolidated review:

- [ ] Compare changed files against assigned ownership and preserve unrelated dirt.
- [ ] Run the milestone's focused commands and full affected regression gate.
- [ ] Construct one realistic counterexample for each changed authority boundary.
- [ ] Check preserved features and non-Yuqi/version-0 compatibility.
- [ ] Classify every finding P0–P3 and return one combined correction list.
- [ ] Close the milestone when P0/P1 are absent and affected tests are green; P3 cannot block closure.

## Completion Contract

The implementation milestone is complete only when:

- all detailed-plan Tasks 11–26 are committed and their gates pass;
- production has a verified backup and clone migration before any apply;
- the formal APK covers the previous installed certificate/package and has a matching OTA manifest/hash;
- the 270 protocol cases and the source-grounded repeated quality evaluation are both complete and kept logically separate;
- every existing feature is represented in the feature matrix and regression evidence;
- final handoff truthfully distinguishes shipped-compatible, shadow, canary, graduated, and not-yet-active kinds;
- rollback paths exist for database, stable release, and APK.
