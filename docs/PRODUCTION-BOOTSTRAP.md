# Production bootstrap

This release is designed to make its environment state inspectable. It does not
copy an operator's identity, account, quota, project UUID, media, browser
profile, Keychain entry, provider routing, or provider agreement into Git.

## Supported baseline

The supported baseline is macOS on Apple Silicon with Node 22 or newer, Python
3.11 or newer for optional local media work, and a feature-complete FFmpeg.
This release's automated test evidence is Node 26.7.0; use the environment
doctor after choosing another supported Node version.
Install FFmpeg with the encoders, filters and muxer specified in
`manifests/environment.manifest.json`; do not assume a minimal system build is
enough.

## First run

```bash
git clone https://github.com/wfjkl123-create/ai-video-production-harness.git
cd ai-video-production-harness
node scripts/bootstrap.mjs --write-env
npm test
node scripts/doctor-environment.mjs
```

The first doctor run is expected to fail until you license the author-owned
Harness additions and install/authenticate the provider dependencies. Its
failure is deliberate: a clone is not allowed to claim it can submit a provider
job without the exact Skill, authenticated provider, and account capacity it
needs.

## Required human-owned setup

1. Install the official `libtv` CLI, log in interactively with the operator's
   own account, and verify that the account can open the intended workspace.
2. Install and authenticate `ocx` if the director or independent-audit routes
   will be used. Choose a model route and per-task budget outside this repo.
3. Keep `HARNESS_CANONICAL_PROMPT_SKILL_ROOT` pointing to the bundled,
   SHA-locked `seedance2-prompt-fusion` directory. It is the public Harness's
   canonical prompt author; its MIT-licensed Seedance 2.0 v6.7 reference layer
   is retained internally only where the fusion workflow reads it.
4. If using RunningHub, set `RUNNINGHUB_API_KEY` in `.env.local` and verify the
   account's own entitlement. The default LibTV route does not require it.

Run `node scripts/doctor-environment.mjs` again. It never prints credential
values or account information. Treat `FAIL` as a production blocker and `WARN`
as a documented non-default capability gap.

## Optional offline depth and KOC media preparation

The bundled KOC anonymizer is copied into every newly initialized project at
`scripts/derive-multiface-full-head-scrub-v1.py`. It requires Python, OpenCV,
NumPy, FFmpeg/FFprobe, and an operator-provided face detector model. The depth
runner also requires PyTorch, Transformers and model weights that the operator
is licensed to use commercially. No model binary or DSINE runtime is included;
the audited local DSINE vendor is excluded because its terms do not establish a
commercial redistribution right.

## What is deliberately not claimed

`seedance-camera`, `seedance-characters`, `seedance-antislop`, and
`seedance-sequence` are bundled from the MIT-licensed Seedance 2.0 v6.7.0
source and locked in `manifests/skills.lock.json`. They are retained because
current image and continuity lint still references these capability IDs.
