# Evidence Schema

Use CSV for the first version because it is easy to edit after manual Chanmama observation.

Required headers:

```text
evidence_id,platform,page_type,collected_at,category,entity_type,entity_id,entity_name,source_url,metric_name,metric_value,metric_unit,metric_window,material_path,screenshot_path,video_path,notes,conclusion_ref_ids,confidence,cross_industry
```

Required values per row:

- `evidence_id`: stable ID such as `E001`.
- `platform`: source platform, usually `蝉妈妈` in v1.
- `page_type`: source page type, such as video rank, video detail, product related videos, competitor video, comment observation.
- `collected_at`: ISO-like timestamp with timezone when possible.
- `category`: use current main category in v1.
- `entity_type`: video, product, author, comment, shop, topic, or other observable object.
- `entity_id`: platform-visible ID or stable manual ID.
- `source_url`: real URL, exported source, or explicit visible-account locator. Never invent public URLs.
- `confidence`: HIGH, MED, LOW, or UNKNOWN.

Evidence classification:

- Data evidence: `metric_name` and `metric_value` are both present.
- Material evidence: `material_path` or `video_path` is present.
- Screenshot evidence: `screenshot_path` is present, useful for webpage state but not enough by itself for material evidence.

Direction threshold:

- Each direction needs at least 3 data evidence IDs.
- Each direction needs at least 2 material evidence IDs.

