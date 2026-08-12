# Yuqi Three-Judge Blind Pilot Design

## Goal

Compare the currently deployed Yuqi conversation flow with the reconstructed cognition/expression flow on representative role-play conversations, while preserving the exact questions and blind A/B outputs for a human judge. The comparison is diagnostic evidence, not rollout or promotion evidence.

## Compared systems

The stable side reproduces the pre-reconstruction role routing and preset family:

- preset: `1.9.2`
- pipeline: `stable-visible-baseline-2026-07-30`
- fast cognition/memory: `gpt-5.6-terra/medium`
- deep cognition/memory: `gpt-5.6-sol/medium`
- expression/brain: `gpt-5.6-sol/medium`
- supervisor: `gpt-5.6-terra/medium` when the legacy route invokes it

The candidate side uses the reconstructed v3 flow and the user's approved model allocation:

- preset: `2.1.0`
- pipeline: `yuqi-lived-agency-v3`
- fast cognition: `gpt-5.6-sol/medium`
- deep cognition: `gpt-5.6-sol/xhigh`
- expression: `gpt-5.6-sol/medium`
- lived-quality supervision: deterministic local rules; the persisted `supervisor` profile remains `gpt-5.6-sol/medium` as a closed compatibility field and must not cause an ordinary v3 model call

Official OpenAI documentation lists `xhigh` as a supported GPT-5.6 reasoning effort. The local release-profile validator must accept it without silently changing it to `high`.

## Judges and weighting

Two isolated model judges score every A/B pair before the human sees it:

- evaluator primary: `gpt-5.6-sol/medium`, weight `0.25`
- evaluator secondary: `gpt-5.6-terra/high`, weight `0.25`
- human evaluator: user, weight `0.50`

The human package contains only the conversation context, Reply A, Reply B, a generic rubric, and blank score fields. It excludes release names, models, phase names, prompts, checksums, automatic scores, and the A/B mapping. The mapping is stored in a separate sealed private file and is revealed only after the human submits scores.

Each judge scores the six existing quality dimensions from 1 to 5 and chooses `A`, `B`, `tie`, or `unresolved`:

1. social understanding
2. agency
3. relationship participation
4. state continuity and flexibility
5. lived expression
6. action/fact integrity

For each side, the weighted dimension score is `0.25 * primary + 0.25 * secondary + 0.50 * human`. Preference is converted to candidate probability (`candidate=1`, `stable=0`, `tie=0.5`); any `unresolved` human score blocks a final verdict for that item. The candidate is a directional winner for a stage only when its weighted mean is at least `0.20` higher than stable, its weighted preference is at least `0.625`, no human dimension is `1`, and no critical integrity regression exists. With only 2, 6, or 12 items, results are explicitly called directional rather than statistically conclusive.

## Staged questions

The 12 questions are taken from the reviewed, tracked 246-item quality plan. Each final keeps its complete timestamped transcript and source grounding. Stages are cumulative in reporting but use separate immutable run authorities, so a later stage cannot widen an already approved paid-call boundary.

### Stage 1: two questions

1. `sentinel:first_red_packet_as_social_action:0` — gift/red-packet social meaning
2. `sentinel:fourth_coquetry_test_or_pressure:0` — mixed motive, coquetry, testing, or pressure

### Stage 2: four additional questions

3. `sentinel:first_scolded_by_manager:0` — comfort after public humiliation
4. `sentinel:fourth_rejecting_insincere_comfort:0` — correction after template-like comfort
5. `sentinel:fourth_push_away_and_want_pursuit:0` — prior promise and push-away language
6. `coverage:second_interruption_changes_with_time__surface:0` — interruption and continuity

### Stage 3: six additional questions

7. `sentinel:first_initial_stage_not_fixed_coldness:0` — relationship-stage ambiguity
8. `coverage:second_one_day_no_contact__delayed:0` — silence and proactive continuity
9. `coverage:second_proactive_before_presentation__delayed:0` — remembered event and proactive follow-up
10. `coverage:fourth_topic_shift_meaning_split__delayed:0` — public/moment context and topic shift
11. `coverage:first_red_packet_as_social_action__feature:0` — structured payment target and social meaning
12. `coverage:fourth_coquetry_test_or_pressure__feature:0` — life/role-plan scheduling through the existing Codex bridge only

The reviewed 246-item plan does not contain a true same-batch multi-bubble final. This pilot therefore does not claim to validate same-batch multi-bubble behavior. That remains a separate explicit gap rather than being mislabeled as covered by a multi-turn scene.

## Isolation and cost boundaries

Each stage uses a fresh, clean detached candidate and a fresh ignored private SQLite ledger. Stable execution, candidate execution, evaluator primary, and evaluator secondary use distinct client sessions and stores. The source worktree, production databases, Android Room, cloud relay, rollout state, visible chats, actions, and memories are read-only or absent from the test.

Stage 1 is authorized now. It permits exactly the two Stage 1 final keys, no automatic retry of uncertain calls, at most 32 model calls per final, at most 64 total model calls, at most 16 calls in one phase, and 45 minutes wall-clock time. Model usage tokens are not observable through the existing app-server bridge, so the result reports observed request count and latency rather than inventing a token total. Stage 2 and Stage 3 require new user approval after the preceding report.

The model runner stops on source drift, release/profile drift, side-effect detection, invalid structured output, uncertain remote completion, or a limit breach. A failed or uncertain call is retained as evidence and is not automatically reissued.

## Outputs

All mutable outputs are ignored private artifacts under `artifacts/yuqi-lived-agency-v3/private/three-judge-pilot/`:

- one ledger per stage
- raw checksummed model-call and judgment evidence
- one sealed A/B mapping JSON per stage
- one human-review Markdown file and one machine-readable scoring JSON template per stage
- one AI-only provisional report per stage
- one final weighted report after human scores are imported

The human-review Markdown is the file delivered to the user. It retains every tested question and A/B answer verbatim. Before human scoring, no user-facing file reveals which side is stable or candidate.

## Error handling

- Unsupported or silently changed model/effort: stop before starting a client.
- Missing or changed question: stop before ledger creation.
- Invalid model output: record the phase as failed; do not retry automatically.
- Accepted remote request with missing local result: mark uncertain and block the stage.
- Human score shape error or changed A/B package checksum: reject the import without revealing the mapping.
- A/B disagreement: preserve both AI judgments; do not create a third automatic judge.

## Acceptance

Stage 1 is complete only when both finals have stable/candidate outputs, two independent AI judgments, zero uncertain calls, a sealed mapping, and a blind human package whose checksum is bound to the ledger. The final stable/candidate comparison remains pending until the user submits the human scores.
