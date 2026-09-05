# KOC remake workflow contract

## 1. Source ledger

Create one authoritative row per source shot or continuous speaking interval:

`sourceRange → shotClass → spokenLine → productSemantic → controlAsset → candidateIds → usableSubranges → finalDisposition`

`shotClass` must be `aroll_speaking_lead` or `broll_preserve_source`. Never infer it from a generated output.

## 2. Segment construction

- Include every `aroll_speaking_lead` range.
- Keep each generation package at or below 15 seconds.
- Prefer filling the available duration, but never cut a continuous performance merely to reach 15 seconds.
- Do not place B-roll pixels in a generation package. If B-roll temporarily covers the speaker while the same A-roll speech continues, preserve the source B-roll in the final edit and keep the speech timeline continuous.

## 3. Head anonymization

The only allowed control-video edit is identity suppression above the neck. The mask must cover the entire old head identity strongly enough that the face cannot be recognized, while remaining tight enough to preserve hair boundary decisions required by the selected replacement treatment and all non-head pixels.

Veto any control with changes to timing, frame count, crop, speed, freeze, subtitles, body, clothing, product, background, camera movement, B-roll, or audio. Inspect the first seconds, motion peaks, occlusion boundaries, cuts, and tail frames.

## 4. First-frame policy

- `none`: bind no generated first-frame asset.
- `all_segments`: every segment requires a source-composition first frame with the replacement identity already installed.
- `selected_segments`: Gate 2 records exact segment IDs selected by the user; all other segments bind no first frame.

The first frame controls only the opening composition and replacement identity placement. It never becomes authority for later action, source timing, product structure, scene redesign, or audio.

## 5. Parallel barrier and lanes

Do not fan out until these global facts are locked: complete A-roll ledger, source-aligned segment boundaries, replacement identity, audited anonymized controls, and resolved first-frame policy.

After the barrier, create one durable lane per independent segment. Each lane may run prompt compilation, media binding, pre-generation audits, and canvas preparation independently. Use SHA-bound task checkpoints so a successful lane is reused after interruption. Do not parallelize segments that explicitly depend on a generated predecessor state.

Paid generation is not part of automatic fan-out. Each current node still needs complete readback and explicit node-specific approval. Default resolution is 480P.

## 6. Roles and review independence

- `koc_remake_orchestrator`: owns the DAG, dependency graph, stop conditions, and ledger reconciliation.
- `source_fact_auditor`: classifies A-roll/B-roll and verifies source ranges.
- `aroll_segmenter`: constructs <=15-second continuous packages without omissions.
- `head_anonymizer`: produces and audits source-faithful identity-suppressed controls.
- `first_frame_builder`: runs only when the persisted policy requires it.
- per-segment `prompt_compiler`: uses the mandatory Seedance prompt Skill and exact current assets.
- per-segment `asset_binding_auditor`: verifies roles, SHA, product semantics, and forbidden contamination.
- per-segment `preflight_reviewer`: verifies prompt, assets, model, duration, aspect ratio, 480P, and authorization fingerprint.
- `source_comparator`: compares generated frames and timing against the same source range.
- `reinsertion_auditor`: proves complete usable coverage, source B-roll preservation, and full-track audio integrity.

Before a formal gate package, keep three independent review lanes: source fidelity/timing; identity/liveness; delivery completeness/authorization. A substantive FAIL blocks the package.

## 7. Durable memory

Project artifacts are the only execution memory. For each segment persist source range and SHA, control SHA, optional first-frame SHA, prompt fingerprint, provider task ID, actual output duration/frame count, review findings, usable subranges, root-cause keys, and final disposition.

Conversation history and agent recollection may help discovery but never prove completion or authorize retries.

## 8. Reinsertion proof

The reinsertion input must give every A-roll package one `accepted_for_reinsertion` disposition. A package may use several generated subranges, including a salvageable range from an otherwise rejected candidate, but their source ranges must be gapless and exactly cover that package. Unknown, overlapping, short, or missing ranges are vetoes.

The deterministic closeout must allocate frames from cumulative source-timeline frame boundaries, preserve the complete original audio packet stream, and compare every non-replacement source interval against the assembled film using decoded-frame SHA256. File existence, matching duration, or a visually plausible spot-check is not sufficient evidence of 100% reinsertion.
