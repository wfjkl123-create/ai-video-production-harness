import test from "node:test";
import assert from "node:assert/strict";
import { compileImagePrompt } from "../../src/services/image-prompt-compiler-service.js";
import { lintImagePromptIr } from "../../src/services/image-prompt-lint-service.js";
import {
  validCharacterIr,
  validDirectorViewProxyIr,
  verifiedModelProfile,
} from "../helpers/image-prompt-fixture.js";

test("compiles a zero-context prompt with traceability and immutable fingerprints", () => {
  const result = compileImagePrompt(validCharacterIr(), verifiedModelProfile());
  assert.equal(result.lint.decision, "PASS");
  assert.match(result.promptSha256, /^[a-f0-9]{64}$/);
  assert.match(result.requestFingerprint, /^[a-f0-9]{64}$/);
  assert.match(result.prompt, /TASK AND PURPOSE/);
  assert.match(result.prompt, /GLOBAL VISUAL STYLE CONTRACT/);
  assert.match(result.prompt, /No media is bound to this request/);
  assert.doesNotMatch(result.prompt, /prior pixels/i);
  assert.doesNotMatch(
    result.prompt,
    /\b(?:current|old|previous|earlier|prior)\b|other views|all nine views|same scene geography/i,
  );
  assert.deepEqual(result.skillsApplied, ["gpt-image-2-style-library", "imagegen", "seedance-characters"]);
});

test("compiles edit scope and bound view-change anchors into an immutable edit request", () => {
  const source = validCharacterIr({
    operation: 'edit',
    inputBindings: [{
      tag: 'Image1', artifactId: 'room-a-v1', path: 'assets/room-a.png', sha256: 'a'.repeat(64),
      primaryRole: 'source room geometry', subjectSelector: 'the complete room', transfer: ['room geometry'], ignore: ['people']
    }],
    preserve: ['room geometry'],
    editScope: { mode: 'view_change', change: 'render a reverse camera view', continuityAfterChange: 'preserve fixed room geometry and materials' },
    viewChangeMap: {
      sourceView: 'north-facing', targetView: 'south-facing',
      anchors: [
        { anchorId: 'sofa', sourcePosition: 'screen-right', targetPosition: 'screen-left' },
        { anchorId: 'door', sourcePosition: 'behind camera', targetPosition: 'screen-center' }
      ]
    }
  });
  const result = compileImagePrompt(source, verifiedModelProfile());
  assert.match(result.prompt, /EDIT SCOPE/);
  assert.match(result.prompt, /VIEW-CHANGE ANCHORS/);
  assert.deepEqual(result.editScope, source.editScope);
  assert.deepEqual(result.viewChangeMap, source.viewChangeMap);
});

test("preserves an explicit source-modification authority contract in the prompt and immutable request", () => {
  const sourceReferenceContract = {
    referenceIntent: 'source_modification',
    sourceRole: 'authority',
    segmentId: 'segment-001',
    authorityScope: 'source frames control room geometry only',
    allowedModification: 'remove people and text pollution',
    prohibitedModification: 'do not redesign the room geometry'
  };
  const result = compileImagePrompt(validCharacterIr({
    segmentId: 'segment-001',
    referenceIntent: 'source_modification',
    sourceRole: 'authority',
    sourceReferenceContract
  }), verifiedModelProfile());

  assert.equal(result.referenceIntent, 'source_modification');
  assert.equal(result.sourceRole, 'authority');
  assert.deepEqual(result.sourceReferenceContract, sourceReferenceContract);
  assert.match(result.prompt, /SOURCE REFERENCE CONTRACT/);
  assert.match(result.prompt, /referenceIntent: source_modification/);
  assert.match(result.prompt, /sourceRole: authority/);
});

test("preserves an exact failed-audit and changed-control-route remediation binding", () => {
  const failureRemediationBinding = {
    failureRecordId: 'image-failure-character-a-v1',
    latestUnresolved: true,
    failedAuditId: 'asset-visual-audit-character-a-v1',
    failedAuditFileSha256: 'b'.repeat(64),
    failedAssetSha256: 'c'.repeat(64),
    rootCauseKey: 'image-asset:neutral-view:torso-emphasis',
    priorControlRouteFingerprint: 'd'.repeat(64),
    replacementControlRouteFingerprint: 'e'.repeat(64)
  };
  const result = compileImagePrompt(validCharacterIr({ failureRemediationBinding }), verifiedModelProfile());

  assert.deepEqual(result.failureRemediationBinding, failureRemediationBinding);
  assert.match(result.prompt, /FAILURE REMEDIATION BINDING/);
  assert.match(result.prompt, /asset-visual-audit-character-a-v1/);
  assert.match(result.prompt, /image-asset:neutral-view:torso-emphasis/);
});

test("character compilation fails when identity contract or required skill is missing", () => {
  const missingIdentity = validCharacterIr({
    subjectContract: {
      ...validCharacterIr().subjectContract,
      identityDefinition: "",
    },
  });
  const lint = lintImagePromptIr(missingIdentity, verifiedModelProfile());
  assert.equal(lint.decision, "FAIL");
  assert.ok(
    lint.errors.some((item) => item.code === "CHARACTER_CONTRACT_INCOMPLETE"),
  );
  assert.throws(
    () =>
      compileImagePrompt(
        validCharacterIr({ skillsApplied: ["gpt-image-2-style-library", "imagegen", "seedance-camera"] }),
        verifiedModelProfile(),
      ),
    /seedance-characters/,
  );
});

test("unverified model profiles and unsupported ratios fail before generation", () => {
  assert.throws(
    () =>
      compileImagePrompt(
        validCharacterIr(),
        verifiedModelProfile({ evidenceStatus: "unverified" }),
      ),
    /unverified/,
  );
  assert.throws(
    () =>
      compileImagePrompt(
        validCharacterIr({
          outputSpec: { aspectRatio: "9:16", quality: "high" },
        }),
        verifiedModelProfile(),
      ),
    /not verified/,
  );
});

test("director-view proxy compiles through an explicitly scoped model profile with zero-context boundaries", () => {
  const result = compileImagePrompt(
    validDirectorViewProxyIr(),
    verifiedModelProfile({ supportedProfileIds: ["director_view_proxy_v1"] }),
  );
  assert.equal(result.lint.decision, "PASS");
  assert.equal(result.profileId, "director_view_proxy_v1");
  assert.equal(
    result.templateSource,
    "knowledge/image-profiles/director-view-proxy.md#director_view_proxy_v1",
  );
  assert.deepEqual(result.skillsApplied, [
    "gpt-image-2-style-library",
    "imagegen",
    "seedance-camera",
    "seedance-characters",
  ]);
  assert.match(
    result.prompt,
    /final camera-view subject order, screen scale, depth layers, occlusion and contact points only/,
  );
  assert.match(
    result.prompt,
    /Must not control: real-person identity or facial appearance/,
  );
});

test("director-view proxy lint rejects missing character skill and appearance-authority input transfer", () => {
  const missingSkill = lintImagePromptIr(
    validDirectorViewProxyIr({ skillsApplied: ["gpt-image-2-style-library", "imagegen", "seedance-camera"] }),
    verifiedModelProfile(),
  );
  assert.ok(
    missingSkill.errors.some(
      (item) =>
        item.code === "SKILL_TRACE_MISSING" &&
        /seedance-characters/.test(item.message),
    ),
  );

  const binding = {
    tag: "Image1",
    artifactId: "source-frame-v1",
    path: "assets/source-frame.png",
    sha256: "a".repeat(64),
    primaryRole: "source frame camera blocking and final material",
    subjectSelector: "all visible subjects",
    transfer: ["camera perspective", "wardrobe material"],
    ignore: [
      "identity",
      "wardrobe",
      "product appearance",
      "material and texture",
      "final color grade",
    ],
  };
  const invalidTransfer = lintImagePromptIr(
    validDirectorViewProxyIr({
      operation: "edit",
      inputBindings: [binding],
      preserve: ["camera perspective and subject layout"],
    }),
    verifiedModelProfile(),
  );
  assert.ok(
    invalidTransfer.errors.some(
      (item) => item.code === "DIRECTOR_PROXY_INPUT_TRANSFER_INVALID",
    ),
  );
});

test("every image prompt fails lint when the mandatory style-library skill is absent", () => {
  const lint = lintImagePromptIr(
    validCharacterIr({ skillsApplied: ["imagegen", "seedance-characters"] }),
    verifiedModelProfile(),
  );
  assert.equal(lint.decision, "FAIL");
  assert.ok(
    lint.errors.some(
      (item) => item.code === "IMAGE_PROMPT_SKILL_MISSING",
    ),
  );
});

test("storyboard lint accepts an explicit user-selected single image prompt skill decision", () => {
  const base = validCharacterIr({
    id: 'ir-storyboard-single-skill-v1',
    segmentId: 'segment-001',
    assetId: 'storyboard-segment-001-v1',
    atomicAssetId: 'storyboard-segment-001-full-sheet-v1',
    assetType: 'storyboard_sheet',
    profileId: 'storyboard_sheet_15s_v1',
    purpose: 'Create one six-panel storyboard sheet for a declared six-second office shot',
    responsibility: 'panel order, framing, blocking and action endpoints',
    mustNotControl: ['canonical identity', 'canonical wardrobe'],
    templateSource: 'knowledge/image-profiles/storyboard-sheet.md#storyboard_sheet_15s_v1',
    skillsApplied: ['gpt-image-2-style-library'],
    skillRoutingDecision: {
      mode: 'user_selected_single_image_prompt_skill',
      skillId: 'gpt-image-2-style-library',
      scope: 'storyboard_prompt_method_only',
      reason: 'The user selected the installed image prompt skill instead of unavailable legacy prompt helpers',
      supersededLegacySkillIds: ['seedance-camera', 'seedance-characters', 'seedance-antislop', 'seedance-sequence']
    },
    subjectContract: {
      segmentId: 'segment-001', segmentDurationSec: 6.133, recurringCharacters: 'Lead',
      characterContracts: [{ characterId: 'lead', tag: 'Lead', identityDefinition: 'adult woman', wardrobe: 'locked office outfit' }],
      sceneContract: { sceneId: 'office', geography: 'front aisle', lighting: 'daylight', screenDirection: 'forward then screen-right gaze' },
      declaredTimeRange: '0s through 6.133s', actionScope: 'declared entrance action only', prohibitedAdvance: 'no later conversation'
    },
    compositionContract: {
      mode: 'complete_storyboard_sheet_first_pass', rows: 3, columns: 2, panelCount: 6,
      readingOrder: 'left_to_right_then_top_to_bottom',
      panels: Array.from({ length: 6 }, (_, index) => ({ panelIndex: index + 1, timeSec: index, shotId: 'S01_SH01' }))
    },
    outputSpec: { aspectRatio: '3:8', quality: 'high', deliverable: 'one six-panel storyboard sheet' }
  });
  const lint = lintImagePromptIr(base, verifiedModelProfile({ supportedAspectRatios: ['3:8'] }));
  assert.equal(lint.decision, 'PASS');
  const result = compileImagePrompt(base, verifiedModelProfile({ supportedAspectRatios: ['3:8'] }));
  assert.deepEqual(result.skillsApplied, ['gpt-image-2-style-library']);
  assert.equal(result.skillRoutingDecision.mode, 'user_selected_single_image_prompt_skill');
});

test("generic director-view proxy IR cannot omit locked shot or scene geometry context", () => {
  const ir = validDirectorViewProxyIr({
    subjectContract: {
      subjects: validDirectorViewProxyIr().subjectContract.subjects,
    },
  });
  const lint = lintImagePromptIr(ir, verifiedModelProfile());
  assert.equal(lint.decision, "FAIL");
  assert.ok(
    lint.errors.some(
      (item) =>
        item.code === "DIRECTOR_PROXY_SUBJECTS_INVALID" &&
        item.field === "subjectContract.shotId",
    ),
  );
  assert.ok(
    lint.errors.some(
      (item) =>
        item.code === "DIRECTOR_PROXY_SUBJECTS_INVALID" &&
        item.field === "subjectContract.sceneGeometry",
    ),
  );
});

test("generic director-view proxy IR cannot hide wardrobe or material authority inside pose text", () => {
  const source = validDirectorViewProxyIr();
  const subjects = structuredClone(source.subjectContract.subjects);
  subjects[0].pose = "standing in a detailed red silk dress";
  const subjectLayout = structuredClone(
    source.compositionContract.subjectLayout,
  );
  subjectLayout[0].pose = subjects[0].pose;
  const lint = lintImagePromptIr(
    validDirectorViewProxyIr({
      subjectContract: { ...source.subjectContract, subjects },
      compositionContract: { ...source.compositionContract, subjectLayout },
    }),
    verifiedModelProfile(),
  );
  assert.equal(lint.decision, "FAIL");
  assert.ok(
    lint.errors.some(
      (item) =>
        item.code === "DIRECTOR_PROXY_AUTHORITY_LEAK" &&
        item.field.endsWith(".pose"),
    ),
  );
});
