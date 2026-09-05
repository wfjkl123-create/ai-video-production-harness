import test from 'node:test';
import assert from 'node:assert/strict';
import { assertImagePromptIr, imagePromptIrFingerprint } from '../../src/domain/image-prompt-ir.js';
import { validCharacterIr } from '../helpers/image-prompt-fixture.js';

test('accepts a self-contained character prompt IR and fingerprints immutable content', () => {
  const ir = validCharacterIr();
  assert.equal(assertImagePromptIr(ir), ir);
  assert.match(imagePromptIrFingerprint(ir), /^[a-f0-9]{64}$/);
  assert.notEqual(imagePromptIrFingerprint(ir), imagePromptIrFingerprint({ ...ir, purpose: `${ir.purpose} with a tighter crop` }));
});

test('rejects hidden conversation context and unresolved placeholders', () => {
  assert.throws(() => assertImagePromptIr(validCharacterIr({ purpose: '沿用此前的人物继续生成' })), /prior-context/);
  assert.throws(() => assertImagePromptIr(validCharacterIr({ purpose: 'Create the current-project character image' })), /prior-context/);
  assert.throws(() => assertImagePromptIr(validCharacterIr({ responsibility: 'match all other views' })), /prior-context/);
  assert.throws(() => assertImagePromptIr(validCharacterIr({ subjectContract: { ...validCharacterIr().subjectContract, wardrobe: '【填写服装】' } })), /placeholder/);
});

test('requires explicit role-bounded input images and safe project paths', () => {
  const binding = {
    tag: 'Image1', artifactId: 'identity-a-v1', path: 'assets/identity-a.png', sha256: 'a'.repeat(64),
    primaryRole: 'identity', subjectSelector: 'the only person in Image1',
    transfer: ['face geometry', 'hair silhouette'], ignore: ['pose', 'background']
  };
  const ir = validCharacterIr({ operation: 'edit', inputBindings: [binding], preserve: ['face geometry'] });
  assert.doesNotThrow(() => assertImagePromptIr(ir));
  assert.throws(() => assertImagePromptIr({ ...ir, inputBindings: [{ ...binding, path: '../../outside.png' }] }), /project-relative/);
  assert.throws(() => assertImagePromptIr({ ...ir, inputBindings: [{ ...binding, ignore: ['pose', 'face geometry'] }] }), /conflict/);
  assert.throws(() => assertImagePromptIr({ ...ir, editScope: undefined }), /explicit editScope/);
});

test('requires a reversible view-change map for a view-change edit', () => {
  const ir = validCharacterIr({
    operation: 'edit',
    inputBindings: [{
      tag: 'Image1', artifactId: 'room-a-v1', path: 'assets/room-a.png', sha256: 'a'.repeat(64),
      primaryRole: 'source room geometry', subjectSelector: 'the complete room', transfer: ['room geometry'], ignore: ['people']
    }],
    preserve: ['room materials'],
    editScope: { mode: 'view_change', change: 'render the declared reverse camera view', continuityAfterChange: 'keep the same room geometry and fixed anchors' },
    viewChangeMap: {
      sourceView: 'camera faces north wall', targetView: 'camera faces south wall',
      anchors: [
        { anchorId: 'sofa', sourcePosition: 'screen-right', targetPosition: 'screen-left' },
        { anchorId: 'door', sourcePosition: 'behind camera', targetPosition: 'screen-center background' }
      ]
    }
  });
  assert.doesNotThrow(() => assertImagePromptIr(ir));
  assert.throws(() => assertImagePromptIr({ ...ir, viewChangeMap: undefined }), /requires a viewChangeMap/);
});

test('validates an explicit single image prompt skill routing decision', () => {
  const ir = validCharacterIr({
    skillRoutingDecision: {
      mode: 'user_selected_single_image_prompt_skill',
      skillId: 'gpt-image-2-style-library',
      scope: 'storyboard_prompt_method_only',
      reason: 'Use the installed image prompt method instead of unavailable legacy helpers',
      supersededLegacySkillIds: ['seedance-camera', 'seedance-sequence']
    }
  });
  assert.doesNotThrow(() => assertImagePromptIr(ir));
  assert.throws(() => assertImagePromptIr({
    ...ir,
    skillRoutingDecision: { ...ir.skillRoutingDecision, skillId: 'seedance-camera' }
  }), /must be gpt-image-2-style-library/);
});
