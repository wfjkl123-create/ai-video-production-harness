# Input Contract

Use this reference to normalize loose user requests into a concrete collection job.

## Fields

| Field | Meaning | Default |
| --- | --- | --- |
| `target_url` | Source website/page to collect from | `https://cy.chanmama.com/case/liveDrainageSearch/` |
| `target_name` | Model/category/keyword name supplied by user | Required |
| `target_type` | `category`, `keyword`, or `auto` | `auto` |
| `category_path` | Full category path, e.g. `服饰内衣-内衣/袜子/家居服-塑身衣` | Empty |
| `keyword` | Search keyword, e.g. `收腹裤` | Empty |
| `time_window` | Site-visible period such as `近7天` | `近7天` |
| `new_material_only` | Whether to select `新发素材` | True if user says new/新发 |
| `sort_metric` | Ranking metric | `点赞数` |
| `sort_order` | Sort direction | Descending |
| `top_n` | Number of rows to collect before threshold filter | 20 |
| `threshold` | Metric filter after collection | None unless user specifies |
| `link_policy` | Link/download behavior | Use links; download videos if no link |
| `feishu_group` | Exact Feishu group name | Required for publishing |

## Interpreting "model name"

If the user says "模型名称" or gives a single target name:

- Treat a string with separators like `-`, `/`, or full category words as a category path first.
- Treat a short product/material phrase as a keyword if no category path is visible.
- For Chanmama, use `快速检索品类` to test whether the target is a category. If a matching full path exists, prefer the category path.
- If both category and keyword interpretations are plausible and would materially change results, ask one concise question.

## Examples

`服饰内衣-内衣/袜子/家居服-塑身衣，近七天，点赞排序前20，新发，点赞>1000，发到星祁点A组内容交流群`

- `target_type=category`
- `category_path=服饰内衣-内衣/袜子/家居服-塑身衣`
- `time_window=近7天`
- `new_material_only=true`
- `sort_metric=点赞数`
- `top_n=20`
- `threshold=digg_count > 1000`

`收腹裤，近七天，点赞排序前20，新发，点赞>1000，发到AI视频`

- `target_type=keyword`
- `keyword=收腹裤`
- Other fields same as above.
