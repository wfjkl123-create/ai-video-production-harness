---
name: chanmama-feishu-material-publisher
description: Collect Chanmama or similar JS-rendered short-video material links/downloads for arbitrary model, category, or keyword requirements, then publish filtered results to a named Feishu group with lark-cli. Use when Codex is asked to search cy.chanmama.com/case/liveDrainageSearch or similar material sites for new videos/materials, rank by metrics such as likes, apply thresholds, preserve evidence CSV/screenshots, download videos when no usable link exists, and send results to Feishu/Lark chat.
---

# Chanmama Feishu Material Publisher

Use this skill to turn a user request like "find the top 20 new materials for a category/model/keyword, filter likes > 1000, and send them to a Feishu group" into a repeatable evidence-backed workflow.

## Inputs

Normalize the user request into:

- `target_url`: source page, default `https://cy.chanmama.com/case/liveDrainageSearch/`.
- `target_name`: model/category/keyword name from the user, such as `塑身衣`, `收腹裤`, or a full category path.
- `target_type`: `category`, `keyword`, or `auto`.
- `time_window`: default `近7天` unless specified.
- `new_material_only`: default true when the user says new/newly published/新发素材.
- `sort_metric`: default `点赞数`.
- `top_n`: default 20.
- `threshold`: e.g. `digg_count > 1000`.
- `link_policy`: "use links when present, download video when no usable link exists".
- `feishu_group`: exact Feishu group name.

Read [references/input-contract.md](references/input-contract.md) when a request is ambiguous or when adding a new site.

## Workflow

1. **Prepare tools**
   - If using browser automation, also use `$browser-act` and run `browser-act get-skills core --skill-version 2.0.2` before any browser command.
   - For Chanmama evidence outputs, use the current workspace under `outputs/<site-or-task>_<yyyymmdd>/`.
   - For Feishu publishing, run `lark-cli skills read lark-shared` and `lark-cli skills read lark-im` before any IM action.

2. **Collect the source results**
   - For Chanmama `liveDrainageSearch`, follow [references/chanmama-live-drainage.md](references/chanmama-live-drainage.md).
   - For other JS-rendered material sites, use the same pattern: open with browser-act, apply visible/account-authorized filters, inspect DOM/Vue/network state, export a stable top-N table, and preserve screenshots.
   - If login is required, use browser-act remote assist. Do not store, remember, or reuse plaintext account passwords.

3. **Validate the scrape**
   - Confirm the page-visible selected filters match the normalized request.
   - Confirm the extracted list has `top_n` rows unless the site visibly has fewer.
   - Confirm the sort order is descending by the requested metric.
   - Confirm each row has a video ID, a playback/source link, or a downloaded local video path.

4. **Save evidence**
   - Save a raw JSON export, top-N CSV, filtered CSV, evidence CSV, and final filter screenshot.
   - Use numeric metric fields. Do not invent links or metrics.
   - If a row has no usable link, download the visible video and fill `video_path`.

5. **Publish to Feishu**
   - Search the group by exact name and proceed only if there is one exact match. If multiple exact/near matches remain, ask the user.
   - Send a concise text or markdown summary with filtered rows.
   - Include title, author, metric value, video ID, short playback link, and note whether long source links are in a second message or file.
   - Keep `--idempotency-key` short ASCII, preferably <= 32 chars.
   - Verify by reading the chat's latest messages.
   - Follow [references/feishu-cli-publishing.md](references/feishu-cli-publishing.md) for fallback handling.

6. **Close browser sessions**
   - Close browser-act sessions created for the task after collection and verification.

## Safety Rules

- Do not record or persist user credentials in the skill, workspace, browser descriptions, logs, or final answers.
- Do not quote Chanmama `Authorization` headers, cookies, access tokens, or app secrets.
- Treat Chanmama observations as visible/account-authorized evidence, not public-source facts.
- Do not bypass paywalls, access controls, captchas, or login checks. Escalate login/verification to the user through browser-act remote assist.
- Do not send to a Feishu group unless the user requested that group or explicitly confirmed the target.

## Output Summary

Final responses should state:

- Selected filters and collection date.
- Top-N count and filtered count.
- Whether any videos were downloaded.
- Feishu group name and message IDs.
- Local paths for JSON/CSV/evidence/screenshot.
