---
name: koc-remake-orchestrator
description: "Orchestrate source-faithful KOC talking-head remakes: inventory and segment all A-roll, anonymize only the head, optionally prepare replacement-identity first frames, parallelize independent segment preparation, review generated clips, and reinsert every usable range into the untouched source timeline. Use for KOC/口播换脸/只替换A-roll projects; do not use for ordinary B-roll repair or original-story creation."
---

# KOC Remake Orchestrator

Use this Skill only after the source video is confirmed as authority and `koc_remake` is selected as the exclusive remake-control route.

## Required route decisions

Before preparation, persist:

- the source video ID and SHA;
- the user-approved replacement identity asset;
- `firstFramePolicy`: `none`, `all_segments`, or `selected_segments`;
- whether the script has any exact brand-word replacements;
- product-binding semantics: own-product claims may bind the product asset; competitor criticism and unrelated A-roll must not.

Do not ask for engineering parameters. The user only chooses the KOC route and first-frame policy; normal preparation runs autonomously until an existing Harness gate or a real authorization blocker.

## Workflow

Read [workflow-contract.md](references/workflow-contract.md) and [agent-topology.yaml](references/agent-topology.yaml) before planning or running a KOC remake. Read [failure-and-review.md](references/failure-and-review.md) when auditing a control clip, generated segment, reinsertion, or repeated failure.

The fixed shape is:

```text
source authority
→ complete A-roll/B-roll ledger
→ continuous A-roll packages (each <=15s)
→ replacement identity + precise full-head anonymized controls
→ optional first frames according to the user's policy
→ preparation barrier
→ parallel per-segment prompt/binding/preflight/canvas lanes
→ node-specific paid approval and generation
→ source comparator + usable-subrange decision
→ serial reinsertion + untouched full source audio + coverage audit
```

## Prompt boundary

This Skill never authors or rewrites Seedance/LibTV prompt prose. For every video prompt, load the `seedance2-prompt` canonical Skill declared in this repository's `manifests/skills.lock.json` and follow its routing. This Skill supplies only source facts, asset responsibilities, timing, failure evidence, and the KOC execution contract.

## Completion rule

Do not call the film complete because nodes generated or files downloaded. Completion requires an auditable disposition for every source A-roll range, every usable generated subrange reinserted, B-roll preserved, the final full source audio verified, and the final coverage ledger reconciled.

## Deterministic executors

Use the Harness commands instead of project-specific shell recipes:

1. `koc-source-ledger`: compile a gapless, source-SHA-bound A-roll/B-roll inventory and natural <=15-second A-roll packages.
2. `koc-media-prepare`: cut each A-roll with embedded source audio and run strict full-head anonymization in at most four local lanes. Always dry-run before execute.
3. `koc-remake-plan`: close the preparation barrier and create durable per-segment lanes.
4. `koc-canvas-batch`: verify the final reviewed package and exact media SHA for every lane, then prepare at most four 480P LibTV nodes. It must never run a node or submit paid generation.
5. `koc-reinsert`: accept only complete `accepted_for_reinsertion` coverage, rebuild the whole source timeline, copy the full original audio stream, and verify source-gap decoded-frame hashes.

`--dry-run` means no media write or external canvas mutation. `koc-canvas-batch --execute` may upload assets and create reviewed canvas nodes, but a successful result must still report `paidGenerationTriggered: false` and `requiresUserCanvasGeneration: true` for every lane.
