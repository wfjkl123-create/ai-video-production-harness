# Chanmama Live Drainage Workflow

Use this reference for `https://cy.chanmama.com/case/liveDrainageSearch/`.

## Browser setup

1. Load browser-act core before any browser command:

```powershell
browser-act get-skills core --skill-version 2.0.2
```

2. Use an existing approved browser when available. Create a new session name for the task.
3. If Chanmama redirects to login, call `remote-assist` and wait for the user to reply that login is complete.
4. Do not store credentials or repeat them in messages.

## Apply filters

After every click, run `wait stable` and then `state`; old indexes can become invalid.

For category targets:

1. Click `快速检索品类`.
2. Type the category/model name.
3. Select the exact visible path, e.g. `服饰内衣-内衣/袜子/家居服-塑身衣`.
4. Confirm the selected-condition box shows the full path.

For keyword targets:

1. Choose the correct search tab, usually `按综合搜` or `按标题搜`.
2. Type the keyword in the material search input.
3. Trigger search and confirm the selected/visible keyword state.

Common filters:

- Select `新发素材` when requested.
- Select the requested period, usually `近7天`.
- Click the requested sort field, usually `点赞数`, and confirm `searchData.sort == "digg_count"` and `order_by == "desc"` in Vue state.

## Extract Vue data

Chanmama API responses may be encrypted. Prefer decrypted Vue component state after the page renders.

Find the result component:

```javascript
Array.from(document.all)
  .filter(e => e.__vue__)
  .map((e, i) => {
    const v = e.__vue__;
    const d = v["_data"] || {};
    const opt = v[String.fromCharCode(36) + "options"] || {};
    return {
      i,
      tag: e.tagName,
      cls: String(e.className).slice(0, 60),
      name: opt.name || v._componentTag || "",
      keys: Object.keys(d).filter(k => /dataList|searchData|category|catShow/.test(k)),
      text: (e.innerText || "").slice(0, 100)
    };
  })
  .filter(x => x.keys.length);
```

The Chanmama result component is usually `live-section` with `_data.dataList`.

Export top-N rows:

```javascript
(() => {
  const el = Array.from(document.all)
    .find(e => e.__vue__ && String(e.className).includes("live-section"));
  const d = el.__vue__["_data"];
  const rows = (d.dataList || []).slice(0, 20).map((x, i) => ({
    rank: i + 1,
    material_id: x.material_id || "",
    video_id: x.video_id || "",
    material_title: x.material_title || "",
    author_name: x.author_name || "",
    author_id: x.author_id || "",
    author_fans: x.author_fans || 0,
    chanmama_play_link: x.dy_url || "",
    douyin_player_link: x.video_id ? `https://open.douyin.com/player/video?vid=${x.video_id}&autoplay=0` : "",
    material_cover: x.material_cover || "",
    digg_count: x.digg_count || 0,
    comment_count: x.comment_count || 0,
    collect_count: x.collect_count || 0,
    run_score: x.run_score || 0,
    days_of_lunch: x.days_of_lunch || 0,
    launch_date: x.launch_date || "",
    start_timestamp: x.start_timestamp || 0,
    end_timestamp: x.end_timestamp || 0,
    nearly_3_play_count: x.nearly_3_play_count || 0,
    nearly_7_play_count: x.nearly_7_play_count || 0,
    total_play_count: x.total_play_count || 0,
    duration_ms: x.duration || 0,
    material_type: x.material_type || "",
    link_live_count: x.link_live_count || 0,
    link_ideas_count: x.link_ideas_count || 0,
    trans_words_excerpt: (x.trans_words || "").slice(0, 220)
  }));
  return JSON.stringify({
    collected_at: new Date().toISOString(),
    filters: {
      category_id: d.category_id,
      category: d.catShowValue,
      dateRange: d.dateRange,
      searchData: d.searchData,
      totalCount: d.totalCount,
      page: d.page,
      size: d.size
    },
    rows
  });
})()
```

## Evidence files

Create:

- `*_top20.json`
- `*_top20.csv`
- `*_likes_gt1000.csv` or threshold-specific filtered CSV
- `*_evidence.csv`
- `filters_final.png`
- `videos/` only when a row lacks a usable link

Evidence CSV columns:

```text
evidence_id,platform,page_type,collected_at,category,entity_type,entity_id,entity_name,source_url,metric_name,metric_value,metric_unit,metric_window,material_path,screenshot_path,video_path,notes,conclusion_ref_ids,confidence,cross_industry
```

## Download fallback

Only download video when both source/play links are missing or unusable.

1. Open/click the material card using browser-act.
2. Inspect the detail DOM for `<video src>`, `video_id`, or media URLs.
3. Inspect browser-act network requests for media responses only if the DOM does not expose the URL.
4. Download the visible media URL to `videos/<rank>_<video_id-or-material_id>.mp4`.
5. Record the path in `video_path`.

If the site blocks direct download but provides a visible playable link, keep the link and note that no local download was possible.
