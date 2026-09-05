import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { option } from './args.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { writeTextAtomic } from '../storage/text-store.js';
import { compileSeedance25StandardExecution } from '../services/seedance25-standard-execution-service.js';

export async function runCompileSeedance25Standard(args) {
  const root = resolve(option(args, 'project'));
  const input = resolve(option(args, 'input'));
  const executionUnitPath = await projectInputPath(root, input);
  const unit = await readJson(resolve(root, executionUnitPath));
  const compiled = await compileSeedance25StandardExecution(root, unit);
  const outputDirectory = `prompts/${unit.id}`;
  const absoluteOutputDirectory = await safeOutputDirectory(root, unit.id);
  const executionPromptPath = `${outputDirectory}/execution-prompt.txt`;
  const packagePath = `${outputDirectory}/seedance25-standard-package.json`;
  const persisted = {
    ...compiled,
    compiledFrom: { ...compiled.compiledFrom, executionUnitPath },
    executionPromptPath
  };
  delete persisted.executionPrompt;
  await writeTextAtomic(join(absoluteOutputDirectory, 'execution-prompt.txt'), compiled.executionPrompt);
  await writeJsonAtomic(join(absoluteOutputDirectory, 'seedance25-standard-package.json'), persisted);
  return {
    executionUnitId: unit.id,
    packagePath,
    executionPromptPath,
    executionPromptSha256: compiled.executionPromptSha256,
    inputs: { image: compiled.imageInputs.length, video: compiled.videoInputs.length, audio: compiled.audioInputs.length },
    status: compiled.status,
    canvasPreparationAllowed: false,
    paidGenerationSubmitted: false
  };
}

function outside(root, candidate) {
  const value = relative(root, candidate);
  return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value);
}

async function safeOutputDirectory(root, unitId) {
  const actualRoot = await realpath(root);
  const promptsPath = join(actualRoot, 'prompts');
  const promptsInfo = await lstat(promptsPath);
  if (promptsInfo.isSymbolicLink() || !promptsInfo.isDirectory()) {
    throw new Error('project prompts directory must be a real directory inside the project root');
  }
  const actualPrompts = await realpath(promptsPath);
  if (outside(actualRoot, actualPrompts)) throw new Error('project prompts directory must stay inside the project root');
  const candidate = join(actualPrompts, unitId);
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('execution output directory must be a real project directory');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(candidate);
  }
  const actualCandidate = await realpath(candidate);
  if (outside(actualRoot, actualCandidate)) throw new Error('execution output directory must stay inside the project root');
  return actualCandidate;
}

async function projectInputPath(root, input) {
  const [actualRoot, actualInput] = await Promise.all([realpath(root), realpath(input)]);
  const value = relative(actualRoot, actualInput);
  if (value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value) || !(await stat(actualInput)).isFile()) {
    throw new Error('execution unit input must stay inside the project root');
  }
  return value.split(sep).join('/');
}
