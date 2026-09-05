// The automatic simple-remake prompt builder must not collapse the locked
// narration into a generic "follow the depth video" instruction. This helper
// preserves the approved physical-action order as a deterministic input to the
// final source prompt; it does not invent any new creative semantics.
export function orderedPhysicalActionsFromNarration(narration) {
  if (!narration || !Array.isArray(narration.shots)) return [];
  return narration.shots.flatMap(shot => Array.isArray(shot?.physicalActions)
    ? shot.physicalActions
      .filter(action => typeof action === 'string')
      .map(action => action.trim())
      .filter(Boolean)
    : []);
}

export function renderOrderedPhysicalActionInstruction(narration) {
  const actions = orderedPhysicalActionsFromNarration(narration);
  if (actions.length === 0) throw new Error('locked shot narration has no physical actions');
  return `动作必须严格按以下已锁定顺序完成，不得提前、跳过、合并或改写验证步骤：${actions.join('；')}`;
}
