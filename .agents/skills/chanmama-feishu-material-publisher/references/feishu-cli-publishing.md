# Feishu CLI Publishing

Use `lark-cli` for all Feishu group publishing.

## Required reads

Before IM actions:

```powershell
lark-cli skills read lark-shared
lark-cli skills read lark-im
```

## Check identity

Use user identity for groups the user belongs to:

```powershell
lark-cli doctor
lark-cli auth status --json --verify
```

If user scopes are missing, follow `lark-shared` split-flow authorization rules. Do not try to authorize bot scopes with `auth login`.

## Find the group

```powershell
lark-cli im +chat-search --as user --query "<group name>" --chat-modes group --page-size 20 --format json
```

Proceed when exactly one result has `name` equal to the requested group. If multiple exact or plausible matches remain, ask the user to choose.

## Send messages

Preferred message structure:

1. A concise summary message with filtered rows:
   - filters
   - count
   - rank
   - metric value
   - author
   - title
   - short playback link
2. A second message with long source links if needed.
3. A CSV file attachment only when `im:resource:upload` and `im:resource` scopes are available.

Keep idempotency keys short ASCII, ideally <= 32 characters. Long keys can fail with `field validation failed`.

Text is the safest format. Markdown is fine for short messages, but if Feishu returns `99992402 field validation failed`, retry as text with a short idempotency key.

Example:

```powershell
lark-cli im +messages-send `
  --as user `
  --chat-id "oc_xxx" `
  --text $msg `
  --idempotency-key "cm-task-0630-1" `
  --format json
```

File attachment:

```powershell
lark-cli im +messages-send `
  --as user `
  --chat-id "oc_xxx" `
  --file "outputs\task\filtered.csv" `
  --idempotency-key "cm-task-0630-file" `
  --format json
```

If attachment upload fails with missing `im:resource:upload` or `im:resource`, either ask the user to authorize those scopes or send the critical links as text.

## Verify

After sending:

```powershell
lark-cli im +chat-messages-list --as user --chat-id "oc_xxx" --page-size 5 --format json
```

Confirm the sent message IDs and content are present. Include message IDs in the final response.
