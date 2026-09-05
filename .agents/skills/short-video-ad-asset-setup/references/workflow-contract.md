# Workflow contract

Use this contract to keep project state reconstructable and to prevent approval or generation scope from drifting.

## Canonical layout

```text
<project-id>/
├── project-state.json
├── brief/reference/
├── planning/
│   ├── intake.json
│   ├── asset-plan.json
│   ├── segmentation.input.json
│   ├── creative-briefs/
│   └── story-plans/
├── assets/project/
│   └── asset-manifest.json
├── reviews/
├── prompts/
├── generations/
└── workbench/
```

Keep generated outputs and disposable experiments separate. `workbench/` is not an approved-asset registry.

## Truth model

Use explicit artifact states:

- `draft`: written but not reviewed.
- `awaiting_review`: ready for a named review.
- `approved`: human-approved but not necessarily immutable.
- `locked`: approval is bound to an artifact hash and review record.
- `rejected`: retained as evidence, not an active input.
- `generated`: an output exists, but has not passed asset review.
- `blocked`: a named requirement is missing.

Never use `complete` as a substitute for the more specific state.

## Project state

`project-state.json` is the index, not the source of every detail. Preserve these fields:

```json
{
  "schemaVersion": 1,
  "projectId": "example-ad-001",
  "phase": "intake",
  "artifacts": [],
  "gates": {
    "creativeBrief": "pending",
    "storyPlan": "pending",
    "productAudit": "pending",
    "segmentation": "pending",
    "visualAssets": "pending"
  },
  "authorizations": {
    "imageGeneration": false,
    "videoGeneration": false,
    "upload": false,
    "publication": false,
    "mediaBuying": false
  }
}
```

An artifact index entry should contain `id`, `type`, `revision`, `status`, `path`, and `sha256` when the file exists. A locked entry must also contain `lockedByReviewId`.

## Review record

Bind a decision to the submitted bytes:

```json
{
  "id": "review-<uuid>",
  "artifactId": "creative-brief-example-v1",
  "decision": "approved",
  "note": "What the user actually confirmed",
  "correction": null,
  "actor": "human",
  "createdAt": "<ISO-8601>",
  "artifactSha256": "<sha256>"
}
```

If the artifact changes, the review does not carry forward automatically.

## Product asset and audit

The asset record should include stable asset ID and revision; `assetType: product_reference` and `mediaKind`; relative path and SHA-256; a responsibility note limited to visible pixels; provenance and current status.

The audit should include asset ID, revision, and SHA-256; `inspectionMode` and `inspectorContextMode`; identity count and checks with evidence; decision and blocker count; review timestamp. A product asset and its audit are separate artifacts.

## Segmentation

Each segment requires:

```json
{
  "id": "segment-001",
  "duration": 0,
  "narrativeTask": "",
  "startState": {
    "timeSec": 0,
    "camera": "",
    "subjectState": "",
    "productState": ""
  },
  "actionNodes": [],
  "endState": {
    "timeSec": 0,
    "camera": "",
    "subjectState": "",
    "productState": "",
    "handoffOcclusion": ""
  },
  "projectAssetIds": [],
  "continuityStrategy": "canonical_open",
  "previousSegmentId": null,
  "nextSegmentId": null,
  "status": "awaiting_review"
}
```

For adjacent segments, the second start state must explicitly inherit or intentionally transform the first end state. Record camera, subject, wardrobe/product, action direction, lighting, and occlusion at the boundary.

## Asset plan

For each role, record why the story requires it; whether the source is supplied, generated, or derived; which visible facts it controls; which facts it must not invent; dependent segments; status, active revision, and review ID.

Prefer one multi-purpose asset over several redundant images only when it can satisfy all downstream views without inventing hidden details.

## Authorization records

Boolean flags summarize current scope; keep the actual user instruction in a review or trace artifact when generation or external action occurs. Authorization must name the action and object. “Generate the missing character and opening frame” authorizes those image roles only; it does not authorize replacing an audited product image or generating video.
