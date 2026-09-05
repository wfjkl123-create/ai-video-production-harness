import { resolve } from 'node:path';
import { option } from './args.js';
import { readJson } from '../storage/json-store.js';
import { inspectArtifactFile } from '../services/artifact-file-service.js';
import { assertShotNarration } from '../domain/shot-narration.js';
import {
  renderEmotionPerformanceCapsules,
  renderEmotionPerformanceContinuityBlocks
} from '../domain/emotion-performance.js';

export async function runPerformanceCapsule(args) {
  const root = resolve(option(args, 'project'));
  const input = await inspectArtifactFile(root, option(args, 'input'));
  const narration = assertShotNarration(await readJson(input.path));
  const capsule = renderEmotionPerformanceCapsules(narration);
  if (!capsule) throw new Error('shot narration has no emotion_dlc performance plan');
  return {
    narrationId: narration.id,
    performanceShotCount: narration.shots.filter(shot => shot.performanceMode === 'emotion_dlc').length,
    promptBlock: renderEmotionPerformanceContinuityBlocks(narration),
    archivedCapsule: capsule,
    usage: 'promptBlock 进入提示词正文；archivedCapsule 只作为审计留档，禁止粘贴进提示词'
  };
}
