import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initializeProject } from '../../src/services/project-service.js';
import { issueOwnerSession } from '../../src/services/studio-team-access-service.js';
import { createCreativeBrief } from '../../src/services/creative-brief-service.js';
import { readJson } from '../../src/storage/json-store.js';
import { creativeBrief } from '../helpers/creative-brief-fixture.js';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(child, port) {
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 10_000;
  while (!output.includes(`127.0.0.1:${port}`)) {
    if (child.exitCode !== null) throw new Error(`Studio exited early: ${output}`);
    if (Date.now() > deadline) throw new Error(`Studio did not start: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('Studio artifact edit HTTP contract enforces read/save/preview/apply and CSRF', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-artifact-edit-http-'));
  const projectsRoot = join(root,'projects');
  const stateRoot = join(root,'state');
  const projectRoot = join(projectsRoot,'edit-project');
  await initializeProject(projectRoot,{projectId:'edit-project',workflowVersion:2});
  const artifact = await createCreativeBrief(projectRoot,creativeBrief({projectId:'edit-project'}));
  const initial = await readJson(join(projectRoot,'project-state.json'));
  const owner = await issueOwnerSession(stateRoot);
  const port = await freePort();
  const child = spawn(process.execPath,['apps/harness-studio/server.js'],{
    cwd:fileURLToPath(new URL('../..',import.meta.url)),
    env:{...process.env,HARNESS_PROJECTS_ROOT:projectsRoot,HARNESS_STUDIO_STATE_ROOT:stateRoot,HARNESS_STUDIO_PORT:String(port),HARNESS_STUDIO_HOST:'127.0.0.1',HARNESS_STUDIO_DISABLE_LOOPBACK_OWNER:'true'},
    stdio:['ignore','pipe','pipe']
  });
  t.after(()=>child.kill('SIGTERM'));
  await waitForServer(child,port);
  const base=`http://127.0.0.1:${port}`;
  const cookie=`harness_studio_session=${owner.token}`;
  const session=await (await fetch(`${base}/api/session`,{headers:{cookie}})).json();
  const headers={cookie,origin:base,'content-type':'application/json','x-harness-csrf':session.csrfToken};
  const url=`${base}/api/projects/edit-project/artifact-edits/${artifact.id}`;
  const post=(action,input,customHeaders=headers)=>fetch(`${url}/${action}`,{method:'POST',headers:customHeaders,body:JSON.stringify(input)});
  const read=await fetch(url,{headers:{cookie}});
  assert.equal(read.status,200);
  const editor=await read.json();
  assert.ok(editor.fields.some(field=>field.key==='creativeDecision.storyDirection'));
  const input={sourceSha256:editor.sourceSha256,expectedDraftRevision:0,values:{'creativeDecision.storyDirection':'通过真实体验呈现产品价值'}};
  const forbidden=await post('save',input,{cookie,origin:base,'content-type':'application/json'});
  assert.equal(forbidden.status,403);
  const getMutation=await fetch(`${url}/apply`,{headers:{cookie}});
  assert.equal(getMutation.status,405);
  assert.deepEqual(await readJson(join(projectRoot,'project-state.json')),initial);
  const save=await post('save',input);
  assert.equal(save.status,200);
  const candidate=await save.json();
  assert.equal(candidate.applied,false);
  assert.deepEqual(await readJson(join(projectRoot,'project-state.json')),initial);
  const args={draftId:candidate.draftId,expectedDraftRevision:candidate.draftRevision};
  const staleSave=await post('save',input);
  assert.equal(staleSave.status,409);
  const previewResponse=await post('preview',args);
  assert.equal(previewResponse.status,200);
  const preview=await previewResponse.json();
  assert.equal(preview.impactPolicy,'conservative_v1');
  assert.match(preview.notice,/暂不能保证只重做局部/);
  const noConfirm=await post('apply',{...args,stateFingerprint:preview.stateFingerprint});
  assert.equal(noConfirm.status,400);
  const staleFingerprint=await post('apply',{...args,stateFingerprint:'stale',confirmImpact:true});
  assert.equal(staleFingerprint.status,409);
  const appliedResponse=await post('apply',{...args,stateFingerprint:preview.stateFingerprint,confirmImpact:true});
  assert.equal(appliedResponse.status,200);
  const applied=await appliedResponse.json();
  assert.equal(applied.status,'published_for_review');
  assert.equal(applied.artifact.status,'draft');
  assert.equal(applied.paidGenerationSubmitted,false);
  const after=await readJson(join(projectRoot,'project-state.json'));
  assert.equal(after.artifacts.length,initial.artifacts.length+1);
  assert.equal(after.artifacts.find(item=>item.id===artifact.id).sha256,artifact.sha256);
  assert.equal(after.phase,'creative_review');
  const repeat=await post('apply',{...args,stateFingerprint:preview.stateFingerprint,confirmImpact:true});
  assert.equal(repeat.status,409);
});
