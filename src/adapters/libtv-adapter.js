import { runProcess } from './process-runner.js';

function commandError(args, result) {
  return new Error(`libtv ${args[0] ?? ''} failed with exit code ${Number.isInteger(result.code) ? result.code : 'unknown'}`);
}

export class LibTvAdapter {
  constructor({ runner = runProcess, cwd } = {}) {
    this.runner = runner;
    this.cwd = cwd;
  }

  invoke(args) {
    return this.runner('libtv', args, { cwd: this.cwd });
  }

  async invokeJson(args) {
    const result = await this.invoke(args);
    if (result.code !== 0) throw commandError(args, result);
    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`libtv ${args[0] ?? ''} returned invalid JSON: ${error.message}`);
    }
  }

  check() {
    return this.invoke(['--version']);
  }

  useWorkspace(workspaceId) {
    return this.invokeJson(['workspace', 'use', String(workspaceId)]);
  }

  ensureWorkspace(workspaceId) {
    return this.useWorkspace(workspaceId);
  }

  useProject(projectUuid) {
    return this.invokeJson(['project', 'use', projectUuid]);
  }

  ensureProject(projectUuid) {
    return this.useProject(projectUuid);
  }

  upload({ name, file, type = 'image' }) {
    return this.invokeJson(['upload', name, '-t', type, '--resource', file]);
  }

  createImageNode({ name, model, prompt, left = [], run = true }) {
    const args = ['node', 'create', name, '-t', 'image', '-s', `model=${model}`, '--prompt', prompt];
    for (const upstream of left) args.push('--left', upstream);
    if (run) args.push('--run');
    return this.invokeJson(args);
  }

  runNode(name) {
    return this.invokeJson(['node', name, '--run']);
  }

  async download({ node, out }) {
    if (/\.(?:png|jpe?g|webp|gif|mp4|mov|webm|mp3|wav|m4a|zip)$/i.test(out ?? '')) {
      throw new TypeError('LibTV download output directory must not be a file path');
    }
    return this.invokeJson(['download', '--node', node, '--out', out]);
  }
}
