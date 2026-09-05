import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { inspectArtifactFile } from './artifact-file-service.js';

const ROLES = ['primary', 'secondary', 'shadow', 'highlight', 'skin', 'reflection', 'accent'];
const HEX = /^#[A-Fa-f0-9]{6}$/;

function outside(root, candidate) { const value = relative(root, candidate); return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value); }
function escapeXml(value) { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]); }

export function assertColorBoardSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('color board spec must be an object');
  if (typeof value.id !== 'string' || value.id.trim() === '') throw new TypeError('id is required');
  if (!Array.isArray(value.colors) || value.colors.length !== 7) throw new TypeError('color board requires exactly seven colors');
  value.colors.forEach((color, index) => {
    if (color.role !== ROLES[index]) throw new TypeError(`colors[${index}].role must be ${ROLES[index]}`);
    if (!HEX.test(color.hex ?? '')) throw new TypeError(`colors[${index}].hex must be #RRGGBB`);
    if (typeof color.usage !== 'string' || color.usage.trim() === '') throw new TypeError(`colors[${index}].usage is required`);
  });
  if (new Set(value.colors.map(color => color.hex.toUpperCase())).size !== 7) throw new TypeError('seven color values must be unique');
  if (typeof value.outputPath !== 'string' || isAbsolute(value.outputPath) || value.outputPath.split(/[\\/]+/).includes('..')) throw new TypeError('outputPath must be project-relative');
  return value;
}

export function renderColorBoardSvg(input) {
  const spec = assertColorBoardSpec(input);
  const width = 1400, rowHeight = 112, height = 130 + rowHeight * 7;
  const rows = spec.colors.map((color, index) => {
    const y = 100 + index * rowHeight;
    const textColor = ['#000000', '#FFFFFF'].includes(color.hex.toUpperCase()) ? (color.hex.toUpperCase() === '#000000' ? '#FFFFFF' : '#000000') : '#F3F4F4';
    return `<rect x="70" y="${y}" width="300" height="88" rx="12" fill="${color.hex.toUpperCase()}"/><text x="100" y="${y + 54}" fill="${textColor}" font-size="28" font-family="Arial,sans-serif">${color.hex.toUpperCase()}</text><text x="410" y="${y + 38}" fill="#D8BF79" font-size="24" font-family="Arial,sans-serif">${escapeXml(color.role)}</text><text x="410" y="${y + 72}" fill="#C5D0C7" font-size="22" font-family="Arial,sans-serif">${escapeXml(color.usage)}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#101612"/><text x="70" y="62" fill="#EDF3EE" font-size="34" font-family="Arial,sans-serif">${escapeXml(spec.title ?? spec.id)}</text>${rows}</svg>`;
}

async function safeDirectory(root, output) {
  const directory = dirname(output); let current = root;
  if (outside(root, directory)) throw new Error('color board output escapes project root');
  for (const part of relative(root, directory).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('color board output directory must not contain symlinks'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(current); }
  }
  const [actualRoot, actualDirectory] = await Promise.all([realpath(root), realpath(directory)]);
  if (outside(actualRoot, actualDirectory)) throw new Error('color board output escapes project root');
}

export async function composeColorBoard(root, input) {
  const spec = assertColorBoardSpec(input);
  const rootPath = resolve(root); const output = resolve(rootPath, spec.outputPath);
  await safeDirectory(rootPath, output);
  try { await writeFile(output, renderColorBoardSvg(spec), { encoding: 'utf8', flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('color board output already exists'); throw error; }
  const inspected = await inspectArtifactFile(root, spec.outputPath);
  return { id: spec.id, path: spec.outputPath, sha256: inspected.sha256, renderer: 'deterministic-svg-color-board-v1' };
}
