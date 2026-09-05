# Generic image-asset contract

Use this as a Gate-2/3 checklist after selecting the required image-prompt
Skill template.

1. State the asset's one downstream responsibility and the exact output form.
2. Declare every input image by position and state both its allowed extraction
   and forbidden transfer. Say explicitly when there is no input image.
3. Define the subject, space or product in self-contained language: identity,
   structure, material, color, fixed geometry and visible constraints.
4. Fix the output layout: aspect ratio, grid count, every cell/view and its
   required camera position.
5. Specify lighting, background, realism and cross-view consistency.
6. Exclude text, logos, watermarks, unintended people, extra views, identity
   drift, structural errors and unapproved reference leakage.
7. End with observable checks that a reviewer can verify from the resulting
   pixels without assuming hidden context.

Never record a passing result without its input SHA, prompt fingerprint,
template source, Skill ID and human-Gate result. A generated image, a passing
lint, or a file hash alone is not acceptance.
