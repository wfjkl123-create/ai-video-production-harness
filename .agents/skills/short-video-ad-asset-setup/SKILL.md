---
name: short-video-ad-asset-setup
description: Automatically set up or continue a traceable short-video advertising asset project whenever the user discusses short-video ads, 千川素材, reference-video adaptation or recreation, 创意审核, 分镜或拆段, product-image audit, 人物图、场景图或首帧图准备, or Seedance/LibTV pre-generation assets—even when this skill is not named. Use for Gate approval, continuity-aware segmentation, clean-context product audit, minimal asset planning, authorized visual-asset generation, and truthful handoff. Implicit invocation only activates the workflow; it never grants image/video generation, upload, publication, or media-buying authorization.
---

# Short-video ad asset setup

Build a reviewable project that separates observed inputs, approved creative decisions, audited product facts, generated visual assets, and later video or publishing actions.

## Start from current evidence

1. Inspect the target repository, project folder, current artifacts, and dirty worktree before writing.
2. If the request refers to recent on-screen work, use Computer History only as observed evidence. Upgrade to the actual files or app-specific tools before making claims.
3. Classify each source video as `inspiration`, `fact_source`, or `generation_reference`. Never silently promote inspiration into a generation input.
4. State the requested review scope: `creative_quality`, `performance`, `platform_risk`, or a combination. Do not inject platform or compliance review into open-ended creative development unless the user asks for it.

## Initialize the project

For a new project, run:

```bash
python3 scripts/init_ad_asset_project.py \
  --parent <projects-directory> \
  --project-id <lowercase-project-id> \
  --title <title> \
  --duration <seconds> \
  --aspect-ratio 9:16 \
  --source-role inspiration
```

The initializer refuses to overwrite an existing project. Read [workflow-contract.md](references/workflow-contract.md) before populating or changing artifacts. Read [review-checklists.md](references/review-checklists.md) when conducting a review or asset audit.

## Run the workflow

### 1. Register inputs

- Copy or link source materials into scoped project locations without altering originals.
- Record source role, origin, date, path, MIME type, and SHA-256 where available.
- Treat a UI thumbnail, download dialog, or generated-image indicator as evidence of activity, not proof of a saved or approved asset.

### 2. Prepare and lock the creative brief

- Convert the idea into observable story beats, camera behavior, character actions, product proof, duration, aspect ratio, audio/text treatment, and success definition.
- Translate abstract emotion into visible performance: gaze, breath, lips, shoulders, hands, weight shift, pause, and next action.
- Derive the smallest sufficient asset set from the story. Avoid separate assets for incidental actors, hands, shoes, props, or handoff frames unless continuity actually requires them.
- Present materially different directions only when the choice changes scope, cost, risk, or outcome.
- Save the reviewed artifact, its SHA-256, human decision, actor, timestamp, and correction. A vague “continue” is not a substitute for an explicit Gate decision when the workflow requires one.

### 3. Audit the product reference

- Inspect the image pixels in clean, zero-context mode where possible.
- Record identity count, visible orientation, silhouette, color, construction, text/logo/watermark/UI, occlusion, and any blockers.
- Write a responsibility note that controls only what the image actually shows. Do not infer rear, side, hidden, packaging, or material details.
- Bind the audit to the asset revision and SHA-256. A PASS applies only to that exact file revision.
- Keep the audited product image immutable during character and scene generation. Revise and re-audit if the pixels change.

### 4. Segment for continuity

- Segment by generator limits and causal action boundaries, not by arbitrary equal lengths.
- For every segment record start state, ordered action nodes, end state, asset IDs, duration, camera state, subject state, product/garment state, and continuity strategy.
- Put a handoff inside a stable or naturally occluded state when possible. The next segment must begin from the prior segment's real end state.
- Lock segmentation only after durations add to the target and every adjacent pair has an explicit continuity handoff.

### 5. Plan and generate missing visual assets

- Compare required roles with audited or approved assets and generate only the missing roles.
- Use the product reference as the sole authority for visible product appearance. Keep character identity, scene geometry, lighting, camera height, wardrobe, pose, and product responsibility separated by asset role.
- Before any external or potentially paid image generation, require explicit authorization for the named asset roles. Authorization to generate images does not authorize video generation.
- Use the available image-generation skill or tool for authorized generation. Attach only the references that control the named asset role; never attach an inspiration-only source as a generation reference.
- After generation, save the real output file, register its provenance and hash, then perform visual review before marking it approved or locked.
- If a generated asset fails identity, composition, product fidelity, action readiness, or continuity, keep it as rejected evidence; do not overwrite the approved revision.

### 6. Stop at the authorized boundary

Treat these as separate states: local scaffold, creative approval, product audit, segmentation lock, image generation, asset approval, video generation, upload, publication, and media buying. Never report one as proof of another.

Do not generate video, upload, publish, bind an external platform asset, or launch media buying without separate explicit authorization. Record each authorization in `project-state.json`; do not infer it from earlier approval.

## Validate and hand off

Run:

```bash
python3 scripts/validate_project.py <project-directory>
```

Then report:

- current phase and exact locked revisions;
- what is observed, generated, saved, audited, approved, or still unknown;
- explicit authorization state for image generation, video generation, upload, publication, and media buying;
- remaining missing assets, blockers, and the smallest next decision.

Never claim completion from file existence alone. A successful generator call, a saved file, a passing audit, and human acceptance are distinct facts.
