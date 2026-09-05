import { join, resolve } from 'node:path';
import { option } from './args.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { writeTextAtomic } from '../storage/text-store.js';
import { compileSeedance20Standard15Execution } from '../services/seedance20-standard15-execution-service.js';

export async function runCompileSeedance20Standard15(args) {
  const root = resolve(option(args, 'project'));
  const input = resolve(option(args, 'input'));
  const unit = await readJson(input);
  const compiled = await compileSeedance20Standard15Execution(root, unit);
  const outputDirectory = `prompts/${unit.id}`;
  const executionPromptPath = `${outputDirectory}/execution-prompt.txt`;
  const packagePath = `${outputDirectory}/seedance20-standard15-package.json`;
  const persisted = { ...compiled, compiledFrom: { ...compiled.compiledFrom, executionUnitPath: relativeToProject(root, input) }, executionPromptPath };
  delete persisted.executionPrompt;
  await writeTextAtomic(join(root, executionPromptPath), compiled.executionPrompt);
  await writeJsonAtomic(join(root, packagePath), persisted);
  return { executionUnitId: unit.id, packagePath, executionPromptPath, executionPromptSha256: compiled.executionPromptSha256,
    inputs: { image: compiled.imageInputs.length, video: compiled.videoInputs.length, audio: compiled.audioInputs.length }, paidGenerationSubmitted: false };
}

function relativeToProject(root, file) {
  const prefix = `${root}/`;
  if (!file.startsWith(prefix)) throw new Error('execution unit input must stay inside the project root');
  return file.slice(prefix.length);
}
