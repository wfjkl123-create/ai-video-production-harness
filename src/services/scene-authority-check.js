// 场景权威一致性检查（裂变前置摘要 C 项的确定性版本）。
//
// 背景事故（2026-08-24 OEING 前 12 秒复刻）：首帧图已换成沙滩，但深度视频仍携带
// 客厅空间结构、提示词文字仍写客厅，三方场景权威互相冲突，生成结果回归客厅。
// 本模块在画布准备阶段把"三方场景声明"显式并列：提示词文本里的场景词、
// 声明控制场景/环境的素材、以及从素材 id/文件名可确定的场景线索。
// 词表是透明的关键词匹配，不是语义理解；检测不到时如实报告"无法确认"，
// 只产生黄色警告，不阻断准备流程。

const SCENE_LEXICON = Object.freeze([
  { canonical: '客厅', aliases: ['客厅', 'living room'] },
  { canonical: '卧室', aliases: ['卧室', '主卧', 'bedroom'] },
  { canonical: '沙滩', aliases: ['沙滩', '海滩', '海边', 'beach', 'seaside'] },
  { canonical: '厨房', aliases: ['厨房', 'kitchen'] },
  { canonical: '浴室', aliases: ['浴室', '卫生间', '洗手间', 'bathroom'] },
  { canonical: '办公室', aliases: ['办公室', 'office'] },
  { canonical: '健身房', aliases: ['健身房', 'gym'] },
  { canonical: '餐厅', aliases: ['餐厅', 'restaurant'] },
  { canonical: '咖啡厅', aliases: ['咖啡厅', '咖啡馆', 'cafe', 'coffee shop'] },
  { canonical: '公园', aliases: ['公园', 'park'] },
  { canonical: '街道', aliases: ['街道', '街头', '马路', 'street'] },
  { canonical: '车内', aliases: ['车内', '车里', 'in car'] },
  { canonical: '教室', aliases: ['教室', 'classroom'] },
  { canonical: '酒店', aliases: ['酒店', 'hotel'] },
  { canonical: '商场', aliases: ['商场', '商城', 'shopping mall'] },
  { canonical: '超市', aliases: ['超市', 'supermarket'] },
  { canonical: '阳台', aliases: ['阳台', 'balcony'] },
  { canonical: '书房', aliases: ['书房', 'study room'] },
  { canonical: '泳池', aliases: ['泳池', '游泳池', 'swimming pool'] },
  { canonical: '试衣间', aliases: ['试衣间', 'fitting room'] },
  { canonical: '美容院', aliases: ['美容院', '美发沙龙', 'salon'] },
  { canonical: '森林', aliases: ['森林', '树林', 'forest'] },
  { canonical: '雪地', aliases: ['雪地', '雪山', 'snow'] },
  { canonical: '舞台', aliases: ['舞台', 'stage'] },
  { canonical: '医院', aliases: ['医院', 'hospital'] },
  { canonical: '衣帽间', aliases: ['衣帽间', 'closet', 'walk-in closet'] }
]);

// 素材职责中出现这些词时，认为该素材是"场景权威"之一。
const SCENE_CONTROL_MARKERS = Object.freeze(['场景', '环境', '背景', '空间']);

function aliasPattern(alias) {
  if (/^[a-z ]+$/i.test(alias) && /[a-z]/i.test(alias)) {
    // 纯英文别名要求非字母边界，避免 "car" 误命中 "care"。
    return new RegExp(`(?<![a-z])${alias.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}(?![a-z])`, 'i');
  }
  return null;
}

export function extractSceneTerms(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const lower = text.toLowerCase();
  const found = [];
  for (const entry of SCENE_LEXICON) {
    const hit = entry.aliases.some(alias => {
      const pattern = aliasPattern(alias);
      return pattern ? pattern.test(lower) : lower.includes(alias.toLowerCase());
    });
    if (hit && !found.includes(entry.canonical)) found.push(entry.canonical);
  }
  return found;
}

function basename(path) {
  if (typeof path !== 'string') return '';
  const parts = path.split(/[\\/]/u);
  return parts[parts.length - 1] ?? '';
}

// media: [{ id, kind: 'image'|'video'|'audio', path, controls: string[] }]
export function checkSceneAuthority({ prompt, media = [] } = {}) {
  const promptScenes = extractSceneTerms(prompt ?? '');
  const declarations = [];
  const warnings = [];
  for (const item of media) {
    const controls = Array.isArray(item.controls) ? item.controls : [];
    const controlsScene = controls.some(entry => typeof entry === 'string'
      && SCENE_CONTROL_MARKERS.some(marker => entry.includes(marker)));
    const hintText = `${item.id ?? ''} ${basename(item.path)}`;
    const sceneHints = extractSceneTerms(hintText);
    declarations.push({
      id: item.id ?? null,
      kind: item.kind ?? null,
      controlsScene,
      sceneHints
    });
    if (!controlsScene || sceneHints.length === 0 || promptScenes.length === 0) continue;
    const overlap = sceneHints.some(term => promptScenes.includes(term));
    if (!overlap) {
      warnings.push(
        `场景权威冲突：素材「${item.id}」被声明为控制场景/环境，但其标识指向「${sceneHints.join('、')}」，`
        + `与提示词声明的场景「${promptScenes.join('、')}」不一致。首帧、深度视频与提示词文字必须同一场景权威，`
        + `否则生成可能回归旧场景。请确认素材或提示词后重新准备画布。`
      );
    }
  }
  return {
    promptScenes,
    mediaDeclarations: declarations,
    sceneControllingMedia: declarations.filter(item => item.controlsScene).map(item => item.id),
    warnings,
    lexicon: 'transparent-keyword-v1'
  };
}
