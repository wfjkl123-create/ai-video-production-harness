import { join, resolve } from 'node:path';
import { option } from './args.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { writeTextAtomic } from '../storage/text-store.js';
import { compileSeedance25Standard30Execution } from '../services/seedance25-standard30-execution-service.js';

export async function runCompileSeedance25Standard30(args) {
  const root = resolve(option(args, 'project'));
  const input = resolve(option(args, 'input'));
  const unit = await readJson(input);
  const compiled = await compileSeedance25Standard30Execution(root, unit);
  const outputDirectory = `prompts/${unit.id}`;
  const executionPromptPath = `${outputDirectory}/execution-prompt.txt`;
  const packagePath = `${outputDirectory}/seedance25-standard30-package.json`;
  const persisted = {
    ...compiled,
    compiledFrom: { ...compiled.compiledFrom, executionUnitPath: relativeProjectPath(root, input) },
    executionPromptPath
  };
  delete persisted.executionPrompt;
  await writeTextAtomic(join(root, executionPromptPath), compiled.executionPrompt);
  await writeJsonAtomic(join(root, packagePath), persisted);
  return {
    executionUnitId: unit.id,
    packagePath,
    executionPromptPath,
    executionPromptSha256: compiled.executionPromptSha256,
    inputs: { image: compiled.imageInputs.length, video: compiled.videoInputs.length, audio: compiled.audioInputs.length },
    canvasPreparationAllowed: compiled.canvasPreparationAllowed,
    paidGenerationSubmitted: false
  };
}

function relativeProjectPath(root, input) {
  const rootPrefix = `${root}/`;
  if (!input.startsWith(rootPrefix)) throw new Error('execution unit input must stay inside the project root');
  return input.slice(rootPrefix.length);
}
