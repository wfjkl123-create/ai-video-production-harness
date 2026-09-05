# Harness operating contract

This repository is a local-first, evidence-bound video-production Harness.

- Begin new video work with `intake-video`; do not infer whether a source video
  is authority or inspiration when the user has not stated it.
- Never treat a plan, a prompt, a successful command, or a downloaded file as
  creative acceptance. Preserve SHA-bound evidence and use the designated Gate.
- The canonical `seedance2-prompt-fusion` Skill is the only author of Seedance/LibTV
  prompt prose. Other Skills may contribute facts, checks, and routing only.
- Do not submit paid generation automatically. The operator must inspect the
  current node's prompt, media bindings, model, duration, ratio and resolution,
  then give one node-specific approval or click generation in the provider UI.
- Never add credentials, account sessions, user media, project state, logs, or
  generated outputs to Git. Keep local state outside the source release.
- Before a production claim, run `node scripts/doctor-environment.mjs` and the
  project-level `node src/cli.js doctor --project <path>`. A PASS verifies only
  the checks named by that command; it is not a substitute for human acceptance.
