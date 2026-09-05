# Review checklists

## Creative review

- Can the story be understood without relying on undeclared captions or narration?
- Is the first beat legible in the first seconds?
- Does each action causally trigger the next?
- Are emotions expressed through observable performance rather than labels?
- Is the product proof visible and attributable to the product?
- Is the camera behavior achievable and consistent with the intended recording style?
- Is the proposed asset set minimal but sufficient?
- Are inspiration sources clearly separated from generation references?
- Does the review scope match what the user asked to evaluate?

## Product pixel audit

- How many product identities are visible?
- Which side or orientation is actually shown?
- Which color, silhouette, seams, texture, openings, labels, packaging, and accessories are visible?
- Are people, body parts, text, logos, watermarks, or UI present?
- What is occluded, cropped, blurred, or absent?
- Does the asset role match the pixels?
- Does the responsibility note avoid claims about hidden views?
- Is the audit bound to the exact SHA-256 and revision?

Use `PASS` only when no blocker prevents the asset from fulfilling its declared role. A clean product cutout may pass as a front-view product authority while remaining insufficient for rear or side views.

## Segmentation and handoff

- Do segment durations sum to the target duration?
- Does each segment have one clear narrative task?
- Are start and end camera states explicit?
- Are character pose, gaze, wardrobe, prop/product position, hand position, lighting, and motion direction explicit where relevant?
- Does every adjacent boundary preserve causal action?
- Is the cut hidden by stable framing, stillness, motion blur, or natural occlusion when possible?
- Does the next segment start from the real prior tail frame rather than a prose approximation?
- Are extra segments justified by a generator limit or continuity need?

## Generated visual asset review

- Identity: correct subject, age range, count, wardrobe, and distinguishing traits.
- Composition: correct aspect ratio, framing, camera height, gaze, pose, and empty space for the next action.
- Scene: correct geometry, time of day, light direction, and phone-captured versus polished look.
- Product fidelity: no invented color, seams, length, texture, labels, or hidden views.
- Action readiness: hands, fabric, posture, and occlusion permit the planned first motion.
- Continuity: the asset can seed the relevant segment without contradicting locked story or segmentation state.
- Artifact integrity: actual output path, provenance, revision, and hash are recorded.

Classify results as `PASS`, `REVISE`, or `REJECT`. Do not silently replace a locked revision.

## Adversarial completion check

Before reporting completion, ask:

- Could the same evidence mean only that generation started, not that a file was saved?
- Was an approval attached to an older revision?
- Did character or scene generation alter the product authority?
- Did image-generation authorization get incorrectly expanded to video, upload, publication, or media buying?
- Is a local PASS being presented as platform acceptance or business performance?

If any answer is uncertain, report the missing evidence instead of closing the gate.
