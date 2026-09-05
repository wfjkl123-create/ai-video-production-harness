import { join, resolve } from 'node:path';
import { option } from './args.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { writeTextAtomic } from '../storage/text-store.js';
import { compileSeedanceClips } from '../services/seedance-clip-compiler-service.js';

export async function runCompileSeedanceClips(args) {
  const root = resolve(option(args, 'project'));
  const input = resolve(option(args, 'input'));
  const [state, plan] = await Promise.all([readJson(join(root, 'project-state.json')), readJson(input)]);
  const outputs = await compileSeedanceClips(root, state, plan, {
    allowVideoInputs: args.includes('--user-confirmed-video-upload')
  });
  for (const output of outputs) {
    await writeTextAtomic(join(root, output.packagePayload.promptPath), output.executionPrompt);
    await writeJsonAtomic(join(root, output.clip.outputDirectory, 'seedance-package.json'), output.packagePayload);
  }
  return {
    planId: plan.id,
    parentSegmentId: plan.parentSegmentId,
    clips: outputs.map(({ packagePayload }) => ({
      clipId: packagePayload.clipId,
      duration: packagePayload.duration,
      promptPath: packagePayload.promptPath,
      promptSha256: packagePayload.promptSha256,
      packageFingerprint: packagePayload.packageFingerprint
    }))
  };
}
