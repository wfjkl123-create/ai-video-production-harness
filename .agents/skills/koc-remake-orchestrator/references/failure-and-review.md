# KOC failure and review rules

## Hard vetoes

- Any original speaking face remains recognizable in an A-roll control.
- The anonymization touches subtitles, neck/body, clothing, product, background, or B-roll.
- The control changes duration, frame count, speed, edit points, motion, or audio.
- A generated segment uses the wrong source range, line, replacement identity, or first-frame policy.
- Own-product imagery appears while criticizing a competitor, or is absent when the locked own-product shot requires it.
- A generated segment freezes, changes shot structure, introduces B-roll, loses lip sync, or carries the old identity.
- A paid request lacks current node readback and explicit approval.
- A final assembly omits any accepted segment or salvageable subrange, changes B-roll, or does not preserve the source full-track audio.

## Root-cause keys

Use stable keys rather than free-form retry notes:

- `AROLL_INVENTORY_OMISSION`
- `SOURCE_RANGE_MISMATCH`
- `HEAD_MASK_TOO_SMALL`
- `HEAD_MASK_TOO_LARGE`
- `HEAD_TRACKING_GAP`
- `NON_HEAD_SOURCE_MUTATION`
- `OLD_IDENTITY_LEAK`
- `FIRST_FRAME_POLICY_MISMATCH`
- `FIRST_FRAME_IDENTITY_DRIFT`
- `PROMPT_CONTEXT_POLLUTION`
- `INCOMPLETE_DIALOGUE`
- `PRODUCT_SEMANTIC_MISBIND`
- `AUDIO_SCOPE_OVERCORRECTION`
- `AUDIO_VIDEO_DESYNC`
- `GENERATED_FREEZE`
- `UNAUTHORIZED_SUBMIT`
- `REINSERTION_OMISSION`

Do not pay to retry the same fingerprint after a hard veto. Change the control route or the failing asset, record a new fingerprint, and rerun the affected review lanes.
