---
name: qianchuan-material-research
description: Turn weekly Qianchuan short-video research into evidence-backed material direction reports. Use when Codex needs to process Chanmama-visible data, saved Douyin/competitor videos, evidence tables, consumer insight notes, or competitor observations into weekly material directions, and when conclusions must be checked against data evidence, material evidence, source links, screenshots, confidence labels, and follow-up shooting or copywriting actions.
---

# Qianchuan Material Research

## Core Rule

Keep the system split into three layers:

1. Skill: decide what to observe, how to reason, and how to write the weekly material direction report.
2. Harness: validate evidence integrity, source binding, material references, and direction thresholds.
3. Automation: only collect or organize visible/account-authorized data; never put fragile scraping logic inside the reasoning layer.

## Workflow

1. Build or update the evidence table before analysis.
   - Use one row per observable evidence item.
   - Preserve platform, page type, collection time, category, entity ID, source, metrics, local material/screenshot paths, notes, direction IDs, and confidence.
   - Treat Chanmama webpage observations as visible-account evidence, not public-source facts.

2. Draft directions as structured candidates.
   - Each direction needs a title, summary, confidence, cause hypothesis, next actions, avoid list, data evidence IDs, and material evidence IDs.
   - Keep conclusions in the advertising-material frame unless the user provides stronger market data.
   - Mark causal explanations as hypotheses unless supported by repeated evidence.

3. Run the harness before writing the report.
   - A direction must have at least 3 data evidence rows and 2 material evidence rows.
   - Evidence IDs must exist.
   - Local paths must exist when supplied.
   - Metrics must be numeric when supplied.
   - Confidence must be one of HIGH, MED, LOW, UNKNOWN.

4. Write the weekly report.
   - Include trend summary, material commonalities, competitor movement, consumer-interest signal, executable shooting directions, and directions to avoid.
   - Every direction must show evidence IDs.
   - Do not invent source links, platform fields, rankings, or metric values.

5. Use automation only after a capture audit passes.
   - Require 3 snapshots from the same Chanmama page type.
   - Fields must remain in the same order.
   - Pagination, field copy, and screenshot saving must be observed.
   - Video download can remain manual in v1.

## Resources

- Read `references/evidence-schema.md` when creating or checking evidence tables.
- Read `references/report-standard.md` when drafting the weekly report.
- Use the project harness entry point when available: `run_qianchuan_research.py`.

