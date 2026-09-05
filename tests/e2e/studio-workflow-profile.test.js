import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initializeProject } from '../../src/services/project-service.js';
import { issueOwnerSession } from '../../src/services/studio-team-access-service.js';
import { createCreativeBrief } from '../../src/services/creative-brief-service.js';
import { autoLockArtifact, submitForReview } from '../../src/services/review-service.js';
import { registerArtifact } from '../../src/services/intake-service.js';
import { runCheckpointApprove } from '../../src/commands/checkpoint-approve.js';
import { readJson } from '../../src/storage/json-store.js';
import { creativeBrief, creativeDecision } from '../helpers/creative-brief-fixture.js';

const execFileAsync = promisify(execFile);

const ROUTE = {
  policyVersion: 'ingress-route-v1',
  harnessRequired: true,
  reason: 'video_input_and_creation_intent',
  inputTypes: ['video'],
  sourceVideoIds: ['reference-video-001'],
  referenceRoleStatus: 'authority'
};

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

test('Studio exposes workflow routes, switches to simple_remake, and skips hand-written source facts', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-wf-e2e-'));
  const projectsRoot = join(root, 'projects');
  const stateRoot = join(root, 'state');
  const owner = await issueOwnerSession(stateRoot);
  const projectRoot = join(projectsRoot, 'remake-001');
  await initializeProject(projectRoot, { projectId: 'remake-001', routeDecision: ROUTE });
  await mkdir(join(projectRoot, 'brief'), { recursive: true });
  await writeFile(join(projectRoot, 'brief', 'director-intake-v1.json'), JSON.stringify({
    schemaVersion: 1, projectId: 'remake-001', requestText: '复刻这个视频并替换产品，台词动作不变。', route: ROUTE, recordedAt: new Date().toISOString()
  }, null, 2));

  const port = await freePort();
  const child = spawn(process.execPath, ['apps/harness-studio/server.js'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: { ...process.env, HARNESS_PROJECTS_ROOT: projectsRoot, HARNESS_STUDIO_STATE_ROOT: stateRoot, HARNESS_STUDIO_PORT: String(port), HARNESS_STUDIO_HOST: '127.0.0.1', HARNESS_STUDIO_DISABLE_LOOPBACK_OWNER: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => child.kill('SIGTERM'));
  await waitForServer(child, port);
  const base = `http://127.0.0.1:${port}`;
  const cookie = `harness_studio_session=${owner.token}`;
  const session = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json();
  const postHeaders = { cookie, origin: base, 'content-type': 'application/json', 'x-harness-csrf': session.csrfToken };

  const projectList = await (await fetch(`${base}/api/projects`, { headers: { cookie } })).json();
  assert.equal(projectList.executionPortfolio.kind, 'execution_ledger_portfolio');
  assert.equal(projectList.executionPortfolio.scope.totalProjects, 1);
  assert.equal(projectList.executionPortfolio.scope.initializedProjects, 0);
  assert.equal(projectList.executionPortfolio.scope.projectsWithV2Observations, 0);
  assert.equal(projectList.executionPortfolio.scope.projectsWithAutomaticObservations, 0);
  assert.equal(projectList.executionPortfolio.observations.eventCount, 0);
  assert.equal(projectList.projects[0].workflowProfileId, null);
  assert.deepEqual(projectList.projects[0].visibleSteps.map(step => step.gate), [0, 1, 2, 3, 4, 5]);
  assert.equal(projectList.projects[0].directorInterview, null);
  const portfolioResponse = await fetch(`${base}/api/execution-ledger/portfolio`, { headers: { cookie } });
  assert.equal(portfolioResponse.status, 200);
  assert.equal((await portfolioResponse.json()).observation, 'unavailable');

  const detailBefore = await (await fetch(`${base}/api/projects/remake-001`, { headers: { cookie } })).json();
  assert.equal(detailBefore.workflowProfileView.recommendation.id, 'simple_remake');
  assert.equal(detailBefore.studioFlow.contractVersion, 'harness-30-60-studio-projection-v2');
  assert.equal(detailBefore.studioFlow.routeKind, 'remake');
  assert.deepEqual(detailBefore.studioFlow.humanDecisions.map(item => item.id), ['creative', 'paid_package', 'final_acceptance']);
  assert.equal(detailBefore.studioFlow.completion.wholeFilmComplete, false);
  assert.equal(detailBefore.executionLedger.kind, 'execution_ledger_status');
  assert.equal(detailBefore.executionLedger.consistency, 'not_initialized');
  assert.equal(detailBefore.executionLedger.observations.schemaVersion, 2);
  assert.equal(detailBefore.executionLedger.observations.eventCount, 0);
  const ledgerResponse = await fetch(`${base}/api/projects/remake-001/execution-ledger`, { headers: { cookie } });
  assert.equal(ledgerResponse.status, 200);
  assert.equal((await ledgerResponse.json()).projectId, 'remake-001');
  const appSource = await (await fetch(`${base}/app.js`, { headers: { cookie } })).text();
  assert.match(appSource, /\['ledger', '运行诊断'\]/);
  assert.match(appSource, /执行观察基线/);
  assert.match(appSource, /第二版 \/ 自动取证项目/);
  assert.match(appSource, /生成准备机器时间/);
  assert.match(appSource, /六个机器检查点，三类关键人工决策/);
  assert.match(appSource, /剧情段决定叙事，生成单元决定调用/);
  assert.match(appSource, /分段结果不等于最终成片/);
  assert.match(appSource, /等待服务投影，无法验证交付状态/);
  assert.match(appSource, /旧合同映射/);
  assert.match(appSource, /每次付费调用都必须先显示模型、绑定资产、生成次数、精确指纹与实际费用/);
  assert.match(appSource, /合同状态/);
  assert.match(appSource, /提交结果不确定/);
  assert.match(appSource, /safeGenerationSegments/);
  assert.match(appSource, /取消原暂停任务/);
  assert.doesNotMatch(appSource, /五道正式人工审核|六道门|九个镜头|三段验证方案|三次常规人工决策/);
  assert.doesNotMatch(appSource, /用户常规决策固定为 3 次/);
  assert.doesNotMatch(appSource, /unitOutputCount\s*\n\s*\?\? artifacts\.filter/);

  const setProfile = await fetch(`${base}/api/projects/remake-001/workflow-profile`, {
    method: 'POST', headers: postHeaders, body: JSON.stringify({ id: 'simple_remake', selectedBy: 'user', confirm: true })
  });
  assert.equal(setProfile.status, 200);

  const detailAfter = await (await fetch(`${base}/api/projects/remake-001`, { headers: { cookie } })).json();
  assert.equal(detailAfter.workflowProfileId, 'simple_remake');
  assert.deepEqual(detailAfter.visibleSteps.map(step => step.gate), [1, 4, 5]);
  const listAfter = await (await fetch(`${base}/api/projects`, { headers: { cookie } })).json();
  assert.equal(listAfter.projects[0].workflowProfileId, 'simple_remake');
  assert.deepEqual(listAfter.projects[0].visibleSteps.map(step => step.gate), [1, 4, 5]);

  const assetSelection = await fetch(`${base}/api/projects/remake-001/remake-controls`, {
    method: 'POST', headers: postHeaders, body: JSON.stringify({ selectedModes: ['storyboard_control', 'depth_control'], confirm: true })
  });
  assert.equal(assetSelection.status, 200);
  const assetBody = await assetSelection.json();
  assert.equal(assetBody.assetSelection.estimatedPaidImageTasks, 1);
  assert.equal(assetBody.remakeControlSelection.requiresReversePrompt, true);
  assert.equal(assetBody.directorInterview.status, 'complete');
  assert.equal(assetBody.directorInterview.questionCount, 0);
  assert.equal(assetBody.directorInterview.method, 'deterministic_simple_remake_intake');
  const detailWithControls = await (await fetch(`${base}/api/projects/remake-001`, { headers: { cookie } })).json();
  assert.deepEqual(detailWithControls.workflowProfileView.remakeControlSelection.selectedModes, ['storyboard_control', 'depth_control']);
  assert.equal(detailWithControls.directorInterview.status, 'complete');
  assert.equal(detailWithControls.directorInterview.questionCount, 0);
  assert.notEqual(detailWithControls.studioFlow.nextAction.id, 'answer_director_interview');
  assert.match(appSource, /nextAction\?\.id === 'answer_director_interview'/);
  assert.match(appSource, /project\.workflowProfileId === 'simple_remake' && !project\.workflowProfileView\?\.remakeControlSelection/);
  assert.doesNotMatch(appSource, /visualControlMethodSelection/);
  assert.match(appSource, /只选你要用的方式，可自由组合/);
  assert.match(appSource, /这次想做哪一种/);
  assert.match(appSource, /上传原片，告诉我换什么/);
  assert.match(appSource, /先聊故事，不填表格/);
  assert.match(appSource, /生成第一版复刻方案/);
  assert.match(appSource, /不改写原片剧情/);
  assert.match(appSource, /一次只回答这一件事/);
  assert.match(appSource, /现在只做这一件事/);
  assert.match(appSource, /查看进度与资料/);
  assert.match(appSource, /今天想做什么/);
  assert.match(appSource, /查看全部项目/);
  assert.match(appSource, /返回当前任务/);
  assert.match(appSource, /正在应用方案/);
  assert.match(appSource, /正在检查/);
  const buttonIds = [...new Set([...appSource.matchAll(/<button\b[^>]*id="([^"]+)/g)].map(match => match[1]))];
  assert.deepEqual(buttonIds.filter(id => appSource.split(id).length - 1 < 2), [], 'every rendered button id must also appear in an interaction binding');
  const metadataOnly = new Set(['data-selected-by', 'data-work-order', 'data-stage', 'data-artifact-project', 'data-segment', 'data-member-label', 'data-asset-id']);
  const dataActions = [...new Set([...appSource.matchAll(/<button\b[^>]*\s(data-[a-z0-9-]+)=/g)].map(match => match[1]))]
    .filter(attribute => !metadataOnly.has(attribute));
  assert.deepEqual(dataActions.filter(attribute => !appSource.includes(`[${attribute}`)), [], 'every rendered data-action button must have a delegated interaction binding');
});

test('simple_remake auto Gate 2 supports long projects by splitting fixed source-aligned windows', { timeout: 90_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-wf-long-remake-'));
  const projectsRoot = join(root, 'projects');
  const stateRoot = join(root, 'state');
  const owner = await issueOwnerSession(stateRoot);
  const projectRoot = join(projectsRoot, 'remake-long-001');
  await initializeProject(projectRoot, { projectId: 'remake-long-001', routeDecision: ROUTE, workflowVersion: 2 });
  await mkdir(join(projectRoot, 'brief'), { recursive: true });
  await writeFile(join(projectRoot, 'brief', 'director-intake-v1.json'), JSON.stringify({
    schemaVersion: 1, projectId: 'remake-long-001',
    requestText: '复刻这个视频的前 190 秒，把手持产品替换成我们的产品。',
    route: ROUTE, recordedAt: new Date().toISOString()
  }, null, 2));

  // A real 190-second source video: the rough storyboard preview is sampled
  // from these actual frames, so the test proves the whole deterministic chain.
  const ffmpeg = process.env.HARNESS_FFMPEG_EXECUTABLE ?? 'ffmpeg';
  await mkdir(join(projectRoot, 'brief', 'reference'), { recursive: true });
  await execFileAsync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x568:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '190', '-shortest', '-pix_fmt', 'yuv420p',
    join(projectRoot, 'brief', 'reference', 'reference-video-001.mp4')
  ]);
  await registerArtifact(projectRoot, {
    id: 'reference-video-001', type: 'reference_video', revision: 1, status: 'draft',
    path: 'brief/reference/reference-video-001.mp4', mediaKind: 'video'
  });
  await autoLockArtifact(projectRoot, 'reference-video-001', 'test: lock the source video input');
  await mkdir(join(projectRoot, 'assets', 'project', 'uploads'), { recursive: true });
  await execFileAsync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:size=320x568', '-frames:v', '1',
    join(projectRoot, 'assets', 'project', 'uploads', 'product-reference-v1.png')
  ]);
  await registerArtifact(projectRoot, {
    id: 'product-reference-v1', type: 'project_asset', revision: 1, status: 'draft',
    path: 'assets/project/uploads/product-reference-v1.png', mediaKind: 'image', assetType: 'product_reference',
    visualAuditId: 'product-reference-v1-visual-audit-r1'
  });

  const port = await freePort();
  const child = spawn(process.execPath, ['apps/harness-studio/server.js'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: { ...process.env, HARNESS_PROJECTS_ROOT: projectsRoot, HARNESS_STUDIO_STATE_ROOT: stateRoot, HARNESS_STUDIO_PORT: String(port), HARNESS_STUDIO_HOST: '127.0.0.1', HARNESS_STUDIO_DISABLE_LOOPBACK_OWNER: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => child.kill('SIGTERM'));
  await waitForServer(child, port);
  const base = `http://127.0.0.1:${port}`;
  const cookie = `harness_studio_session=${owner.token}`;
  const session = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json();
  const postHeaders = { cookie, origin: base, 'content-type': 'application/json', 'x-harness-csrf': session.csrfToken };

  await fetch(`${base}/api/projects/remake-long-001/workflow-profile`, {
    method: 'POST', headers: postHeaders, body: JSON.stringify({ id: 'simple_remake', selectedBy: 'user', confirm: true })
  }).then(response => assert.equal(response.status, 200));
  await fetch(`${base}/api/projects/remake-long-001/remake-controls`, {
    method: 'POST', headers: postHeaders, body: JSON.stringify({ selectedModes: ['native_source'], confirm: true })
  }).then(response => assert.equal(response.status, 200));

  const brief = await createCreativeBrief(projectRoot, creativeBrief({
    projectId: 'remake-long-001',
    targetDurationSec: 190,
    creativeDecision: creativeDecision({
      referenceWorkflow: {
        referenceIntent: 'source_modification',
        sourceVideoIds: ['reference-video-001'],
        sourceRole: 'authority',
        workflowRoute: 'source_fact',
        requiresSourceFactWorkflow: true,
        requiredStages: ['adaptive_source_analysis', 'source_fact_contract', 'source_comparator_audit']
      }
    })
  }));
  await submitForReview(projectRoot, brief.id);
  await runCheckpointApprove(['--project', projectRoot, '--checkpoint', 'checkpoint_creative', '--note', '测试：锁定 190 秒复刻创意']);

  const detail = await (await fetch(`${base}/api/projects/remake-long-001`, { headers: { cookie } })).json();
  assert.equal(detail.compactGate2.supported, true);
  assert.equal(detail.compactGate2.mode, 'simple_remake');
  assert.equal(detail.next.actions[0].id, 'prepare_story_plan');

  const created = await fetch(`${base}/api/projects/remake-long-001/story-plans/auto-lightweight`, {
    method: 'POST', headers: postHeaders, body: JSON.stringify({ confirm: true })
  });
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.equal(body.mode, 'simple_remake');
  assert.equal(body.machineReviewed, true);

  const state = await readJson(join(projectRoot, 'project-state.json'));
  const story = state.artifacts.find(item => item.id === body.artifact.id);
  assert.equal(story.status, 'locked');
  const plan = JSON.parse(await readFile(join(projectRoot, story.path), 'utf8'));
  assert.equal(plan.videoSegments.length, 13);
  assert.equal(plan.shotPlanning.shots.length, 13);
  assert.deepEqual(plan.videoSegments.map(segment => [segment.startSec, segment.endSec]).flat(),
    [0, 15, 15, 30, 30, 45, 45, 60, 60, 75, 75, 90, 90, 105, 105, 120, 120, 135, 135, 150, 150, 165, 165, 180, 180, 190]);
  assert.ok(plan.videoSegments.every(segment => segment.continuityStrategy === 'canonical_open'));
  assert.ok(plan.shotPlanning.shots.every(shot => shot.durationSec <= 15));
  assert.deepEqual(
    [...new Set(plan.shotPlanning.shots.flatMap(shot => shot.directorIntent.signals.requiredAssetTypes))],
    ['product_reference']
  );
  assert.equal(plan.assetScope.requiredBeforeGate3.join(','), 'product_reference');
  assert.ok(plan.shotPlanning.roughStoryboardPreview.sha256);
  const previewStat = await readFile(join(projectRoot, plan.shotPlanning.roughStoryboardPreview.path));
  assert.ok(previewStat.length > 0);

  // Machine review also locked the deterministic capability route, so the
  // project can now derive canonical generation units without human Gate 2.
  assert.ok(state.verifiedCapabilityManifestId);
  const after = await (await fetch(`${base}/api/projects/remake-long-001`, { headers: { cookie } })).json();
  assert.equal(after.next.actions[0].id, 'propose_segmentation');

  const segmentation = await fetch(`${base}/api/projects/remake-long-001/operations/canonical-segmentation`, {
    method: 'POST', headers: postHeaders, body: JSON.stringify({ confirm: true })
  });
  assert.equal(segmentation.status, 201);
  const segmentationBody = await segmentation.json();
  assert.equal(segmentationBody.segments.length, 13);
  assert.ok(segmentationBody.segments.every(segment => segment.duration <= 15));
  assert.deepEqual(segmentationBody.segments.map(segment => segment.id), Array.from({ length: 13 }, (unused, index) => `segment-${String(index + 1).padStart(3, '0')}`));

  const rubricResponse = await fetch(`${base}/api/projects/remake-long-001/operations/quality-rubric`, {
    method: 'POST', headers: postHeaders, body: JSON.stringify({ confirm: true })
  });
  assert.equal(rubricResponse.status, 201);
  const rubricBody = await rubricResponse.json();
  assert.equal(rubricBody.rubric.version, 2);

  const contractResponse = await fetch(`${base}/api/projects/remake-long-001/operations/segment-contract`, {
    method: 'POST', headers: postHeaders, body: JSON.stringify({ confirm: true })
  });
  assert.equal(contractResponse.status, 201);
  const contractBody = await contractResponse.json();
  assert.equal(contractBody.segmentId, 'segment-001');
  const stateWithContract = await readJson(join(projectRoot, 'project-state.json'));
  const contractArtifact = stateWithContract.artifacts.find(item => item.id === contractBody.artifactId);
  const contractValue = JSON.parse(await readFile(join(projectRoot, contractArtifact.path), 'utf8'));
  assert.equal(contractValue.executionControl.executionUnitStrategy, 'segmented_editorial');
  assert.equal(contractValue.executionControl.generatedUnitShotCount, 1);
  assert.equal(contractValue.executionControl.platformCapability.exposed, false);

  const manifestResponse = await fetch(`${base}/api/projects/remake-long-001/segments/segment-001/production/asset-manifest`, {
    method: 'POST', headers: postHeaders, body: JSON.stringify({ confirm: true })
  });
  assert.equal(manifestResponse.status, 201);
  const manifestBody = await manifestResponse.json();
  assert.equal(manifestBody.manifest.status, 'locked');
  assert.equal(manifestBody.review.actor, 'system');
  assert.equal(manifestBody.review.delegatedByProfile, 'simple_remake');
  assert.deepEqual(manifestBody.manifest.items.map(item => item.id), ['product-reference-v1']);
  const stateWithManifest = await readJson(join(projectRoot, 'project-state.json'));
  assert.equal(stateWithManifest.artifacts.find(item => item.id === 'product-reference-v1').status, 'locked');

  const narrationResponse = await fetch(`${base}/api/projects/remake-long-001/segments/segment-001/production/narration-auto`, {
    method: 'POST', headers: postHeaders, body: JSON.stringify({ confirm: true })
  });
  assert.equal(narrationResponse.status, 201);
  const promptResponse = await fetch(`${base}/api/projects/remake-long-001/segments/segment-001/production/prompt-auto`, {
    method: 'POST', headers: postHeaders, body: JSON.stringify({ confirm: true })
  });
  assert.equal(promptResponse.status, 201);
  const promptBody = await promptResponse.json();
  const promptText = await readFile(join(projectRoot, promptBody.artifact.path), 'utf8');
  assert.match(promptText, /@素材\[reference-video-001-segment-001\]/);
  assert.match(promptText, /@素材\[product-reference-v1\]/);
  assert.match(promptText, /只做一项修改/);
  assert.doesNotMatch(promptText, /深度视频/);

  const compileResponse = await fetch(`${base}/api/projects/remake-long-001/segments/segment-001/production/compile`, {
    method: 'POST', headers: postHeaders,
    body: JSON.stringify({ confirm: true, model: 'Seedance 2.0', resolution: '480p' })
  });
  const compileText = await compileResponse.text();
  assert.equal(compileResponse.status, 201, compileText);
  const stateAfterCompile = await readJson(join(projectRoot, 'project-state.json'));
  assert.equal(stateAfterCompile.artifacts.filter(item => item.type === 'story_plan').length, 1,
    'compiling a valid native-source plan must not create a replacement story plan');
});

test('lost intake response can replay the staged source without duplicating references', {timeout:30000}, async t => {
  const root=await mkdtemp(join(tmpdir(),'studio-intake-replay-'));
  const projectsRoot=join(root,'projects'), stateRoot=join(root,'state');
  const owner=await issueOwnerSession(stateRoot);
  const port=await freePort();
  const child=spawn(process.execPath,['apps/harness-studio/server.js'],{cwd:fileURLToPath(new URL('../..',import.meta.url)),env:{...process.env,HARNESS_PROJECTS_ROOT:projectsRoot,HARNESS_STUDIO_STATE_ROOT:stateRoot,HARNESS_STUDIO_PORT:String(port),HARNESS_STUDIO_HOST:'127.0.0.1',HARNESS_STUDIO_DISABLE_LOOPBACK_OWNER:'true'},stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill('SIGTERM')); await waitForServer(child,port);
  const base=`http://127.0.0.1:${port}`,cookie=`harness_studio_session=${owner.token}`;
  const session=await(await fetch(`${base}/api/session`,{headers:{cookie}})).json();
  const headers={cookie,origin:base,'content-type':'application/json','x-harness-csrf':session.csrfToken};
  const create=await fetch(`${base}/api/projects`,{method:'POST',headers,body:JSON.stringify({projectId:'replay',confirm:true})}); assert.equal(create.status,201);
  const video=join(root,'input.mp4');
  await execFileAsync(process.env.HARNESS_FFMPEG_EXECUTABLE??'ffmpeg',['-y','-f','lavfi','-i','color=c=black:s=32x32:d=0.2','-c:v','libx264',video]);
  const upload=await fetch(`${base}/api/projects/replay/reference-staging?confirm=true&filename=input.mp4`,{method:'POST',headers:{...headers,'content-type':'video/mp4'},body:await readFile(video)}); assert.equal(upload.status,201);
  const staged=await upload.json();
  const body=JSON.stringify({requestText:'复刻原视频，只替换产品',referenceIntent:'source_modification',stagedReference:{token:staged.token,id:'reference-video-001'},confirm:true});
  // Deliberately discard the first body, as a client with a lost result would.
  const first=await fetch(`${base}/api/projects/replay/intake`,{method:'POST',headers,body}); assert.equal(first.status,200); await first.arrayBuffer();
  const before=await readJson(join(projectsRoot,'replay','project-state.json'));
  const second=await fetch(`${base}/api/projects/replay/intake`,{method:'POST',headers,body}); assert.equal(second.status,200,await second.text());
  const after=await readJson(join(projectsRoot,'replay','project-state.json'));
  assert.deepEqual(after.artifacts,before.artifacts);
  assert.equal(after.directionRevision.id,before.directionRevision.id);
});


test('Studio change requests bind project and current preview without implicit execution', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-change-e2e-'));
  const projectsRoot = join(root, 'projects'), stateRoot = join(root, 'state');
  const owner = await issueOwnerSession(stateRoot);
  const projectRoot = join(projectsRoot, 'change-a');
  await initializeProject(projectRoot, { projectId: 'change-a' });
  await initializeProject(join(projectsRoot, 'change-b'), { projectId: 'change-b' });
  const port = await freePort();
  const child = spawn(process.execPath, ['apps/harness-studio/server.js'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: { ...process.env, HARNESS_PROJECTS_ROOT: projectsRoot, HARNESS_STUDIO_STATE_ROOT: stateRoot,
      HARNESS_STUDIO_PORT: String(port), HARNESS_STUDIO_HOST: '127.0.0.1', HARNESS_STUDIO_DISABLE_LOOPBACK_OWNER: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => child.kill('SIGTERM'));
  await waitForServer(child, port);
  const base = `http://127.0.0.1:${port}`, cookie = `harness_studio_session=${owner.token}`;
  const session = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json();
  const headers = { cookie, origin: base, 'content-type': 'application/json', 'x-harness-csrf': session.csrfToken };
  const post = (path, input, customHeaders = headers) => fetch(`${base}/api/projects/${path}`, {
    method: 'POST', headers: customHeaders, body: JSON.stringify(input)
  });
  const input = { scope: 'unknown', description: '只想调一点颜色，先分析影响' };
  const before = await readFile(join(projectRoot, 'project-state.json'), 'utf8');
  const previewResponse = await post('change-a/change-impact-preview', input);
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  const requestInput = { ...input, snapshotSha256: preview.snapshotSha256, confirm: true };
  assert.equal((await fetch(`${base}/api/projects/change-a/change-requests`)).status, 401);
  assert.equal((await post('change-a/change-requests', requestInput, { origin: base, 'content-type': 'application/json' })).status, 401);
  assert.equal((await post('change-a/change-requests', requestInput, { cookie, origin: base, 'content-type': 'application/json' })).status, 403);
  assert.equal((await post('change-a/change-requests', { ...requestInput, confirm: false })).status, 400);
  assert.equal((await post('change-b/change-requests', requestInput)).status, 409);
  const savedResponse = await post('change-a/change-requests', requestInput);
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.equal(saved.request.status, 'awaiting_analysis');
  assert.equal(saved.request.execution.applied, false);
  assert.equal(saved.request.execution.paidSubmissionAllowed, false);
  assert.equal((await (await post('change-a/change-requests', requestInput)).json()).reused, true);
  const records = await (await fetch(`${base}/api/projects/change-a/change-requests`, { headers: { cookie } })).json();
  assert.equal(records.requests.length, 1);
  assert.equal(records.requests[0].id, saved.request.id);
  assert.equal(await readFile(join(projectRoot, 'project-state.json'), 'utf8'), before);
  const changed = JSON.parse(before);
  changed.updatedAt = '2026-09-05T09:00:00Z';
  await writeFile(join(projectRoot, 'project-state.json'), JSON.stringify(changed));
  const staleResponse = await post('change-a/change-requests', { ...requestInput, description: '另一条修改' });
  assert.equal(staleResponse.status, 409);
  assert.match((await staleResponse.json()).error, /过期/);
  const after = await (await fetch(`${base}/api/projects/change-a/change-requests`, { headers: { cookie } })).json();
  assert.equal(after.requests.length, 1);
});
