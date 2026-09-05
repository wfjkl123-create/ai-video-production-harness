import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCharacterIdentityPack, planCharacterShotCoverage } from '../../src/services/character-shot-coverage-service.js';

test('derives only identity dimensions that approved shots can actually reveal', () => {
  const coverage = planCharacterShotCoverage({
    characterId: 'character-a',
    shots: [
      { shotId: 'S01', shotSize: 'close_up', faceAngles: ['three_quarter'], bodyVisibility: 'partial', wardrobeVisibility: 'partial', actionRisk: 'low' },
      { shotId: 'S02', shotSize: 'medium_close_up', faceAngles: ['profile'], bodyVisibility: 'partial', wardrobeVisibility: 'partial', actionRisk: 'low' }
    ]
  });
  assert.deepEqual(coverage.requiredProfileIds, [
    'character_front_face_closeup_v1',
    'character_profile_face_closeup_v1'
  ]);
  assert.ok(coverage.explicitlyNotRequired.some(item => item.profileId === 'character_front_full_body_v2'));
  assert.ok(coverage.explicitlyNotRequired.some(item => item.profileId === 'character_full_body_back_v1'));
});

test('full-body action requests a complete front body instead of the legacy headless wardrobe crop', () => {
  const coverage = planCharacterShotCoverage({
    characterId: 'character-a',
    shots: [
      { shotId: 'S03', shotSize: 'full', faceAngles: ['front'], bodyVisibility: 'front', wardrobeVisibility: 'full', actionRisk: 'high' }
    ]
  });
  assert.deepEqual(coverage.requiredProfileIds, ['character_front_full_body_v2']);
  assert.ok(!coverage.requiredProfileIds.includes('character_front_wardrobe_no_head_v1'));
});

test('identity pack accepts exactly the locked members required by coverage', () => {
  const coveragePlan = planCharacterShotCoverage({
    characterId: 'character-a',
    shots: [{ shotId: 'S01', shotSize: 'close_up', faceAngles: ['front'], bodyVisibility: 'partial', wardrobeVisibility: 'partial', actionRisk: 'low' }]
  });
  const pack = buildCharacterIdentityPack({
    id: 'character-a-identity-v2', characterId: 'character-a', coveragePlan,
    members: [{ id: 'character-a-front-face-v1', characterId: 'character-a', profileId: 'character_front_face_closeup_v1', status: 'locked', sha256: 'a'.repeat(64) }]
  });
  assert.equal(pack.requiredMembers.length, 1);
  assert.equal(pack.mustNotControl.includes('story emotion'), true);
  assert.throws(() => buildCharacterIdentityPack({
    id: 'character-a-identity-v2', characterId: 'character-a', coveragePlan,
    members: [
      { id: 'character-a-front-face-v1', characterId: 'character-a', profileId: 'character_front_face_closeup_v1', status: 'locked', sha256: 'a'.repeat(64) },
      { id: 'character-a-back-v1', characterId: 'character-a', profileId: 'character_full_body_back_v1', status: 'locked', sha256: 'b'.repeat(64) }
    ]
  }), /unrequested profile members/);
});

test('does not manufacture identity assets for shots where identity is not visible', () => {
  assert.throws(() => planCharacterShotCoverage({
    characterId: 'character-a',
    shots: [{ shotId: 'S01', shotSize: 'wide', faceAngles: ['not_visible'], bodyVisibility: 'occluded', wardrobeVisibility: 'occluded', actionRisk: 'low' }]
  }), /do not create an unused identity asset/);
});
