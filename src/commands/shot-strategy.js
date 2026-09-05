import { resolve } from 'node:path';
import { option } from './args.js';
import { readJson } from '../storage/json-store.js';
import { classifyShotStrategy } from '../domain/shot-strategy.js';

export async function runShotStrategy(args) {
  const input = option(args, 'input');
  return classifyShotStrategy(await readJson(resolve(input)));
}
