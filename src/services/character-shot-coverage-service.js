const PROFILE_REQUIREMENTS = Object.freeze({
  front_face: 'character_front_face_closeup_v1',
  profile_face: 'character_profile_face_closeup_v1',
  front_full_body: 'character_front_full_body_v2',
  back_full_body: 'character_full_body_back_v1'
});

const CLOSE_SIZES = new Set(['extreme_close_up', 'close_up', 'medium_close_up', 'medium']);
const FULL_SIZES = new Set(['medium_full', 'full', 'wide']);
const ANGLES = new Set(['front', 'three_quarter', 'profile', 'back', 'not_visible']);

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

export function planCharacterShotCoverage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('character shot coverage input must be an object');
  text(input.characterId, 'characterId');
  if (!Array.isArray(input.shots) || input.shots.length === 0) throw new TypeError('shots must be a non-empty array');
  const requirements = new Map();
  const add = (key, shotId, reason) => {
    const current = requirements.get(key) ?? { coverageKey: key, profileId: PROFILE_REQUIREMENTS[key], shotIds: [], reasons: [] };
    if (!current.shotIds.includes(shotId)) current.shotIds.push(shotId);
    if (!current.reasons.includes(reason)) current.reasons.push(reason);
    requirements.set(key, current);
  };
  for (const [index, shot] of input.shots.entries()) {
    text(shot.shotId, `shots[${index}].shotId`);
    text(shot.shotSize, `shots[${index}].shotSize`);
    if (!Array.isArray(shot.faceAngles) || shot.faceAngles.length === 0 || shot.faceAngles.some(angle => !ANGLES.has(angle))) {
      throw new TypeError(`shots[${index}].faceAngles must contain supported observable angles`);
    }
    if (shot.faceAngles.some(angle => ['front', 'three_quarter'].includes(angle)) && CLOSE_SIZES.has(shot.shotSize)) {
      add('front_face', shot.shotId, 'front or three-quarter facial identity is readable at this shot size');
    }
    if (shot.faceAngles.includes('profile') && CLOSE_SIZES.has(shot.shotSize)) {
      add('profile_face', shot.shotId, 'profile nose, jaw, ear and side-hair silhouette are readable');
    }
    if (FULL_SIZES.has(shot.shotSize) && (shot.bodyVisibility === 'front' || shot.wardrobeVisibility === 'full')) {
      add('front_full_body', shot.shotId, 'full front body, hands, footwear or wardrobe structure is visible');
    }
    if (shot.faceAngles.includes('back') || shot.bodyVisibility === 'back') {
      add('back_full_body', shot.shotId, 'back silhouette, hair or wardrobe structure is visible');
    }
    if (shot.actionRisk === 'high' && FULL_SIZES.has(shot.shotSize)) {
      add('front_full_body', shot.shotId, 'high-risk full-body action needs proportion and garment continuity');
    }
  }
  if (requirements.size === 0) {
    throw new Error('shots do not expose a character identity dimension; do not create an unused identity asset');
  }
  const ordered = Object.keys(PROFILE_REQUIREMENTS).filter(key => requirements.has(key)).map(key => requirements.get(key));
  return {
    kind: 'character_shot_coverage_v1', version: 1, characterId: input.characterId,
    requirements: ordered,
    requiredProfileIds: ordered.map(item => item.profileId),
    explicitlyNotRequired: Object.entries(PROFILE_REQUIREMENTS)
      .filter(([, profileId]) => !ordered.some(item => item.profileId === profileId))
      .map(([coverageKey, profileId]) => ({ coverageKey, profileId, reason: 'No approved Shot makes this identity dimension visible.' }))
  };
}

export function buildCharacterIdentityPack(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('character identity pack input must be an object');
  const coverage = input.coveragePlan;
  if (coverage?.kind !== 'character_shot_coverage_v1' || coverage.characterId !== input.characterId) throw new Error('identity pack requires matching character shot coverage');
  if (!Array.isArray(input.members)) throw new TypeError('members must be an array');
  const byProfile = new Map(input.members.map(member => [member.profileId, member]));
  const requiredMembers = coverage.requiredProfileIds.map(profileId => {
    const member = byProfile.get(profileId);
    if (!member || member.status !== 'locked' || !/^[a-f0-9]{64}$/.test(member.sha256 ?? '')) {
      throw new Error(`locked identity member is required for ${profileId}`);
    }
    if (member.characterId !== input.characterId) throw new Error(`identity member ${member.id} belongs to a different character`);
    return structuredClone(member);
  });
  const extras = input.members.filter(member => !coverage.requiredProfileIds.includes(member.profileId));
  if (extras.length > 0) throw new Error(`identity pack contains unrequested profile members: ${extras.map(item => item.profileId).join(', ')}`);
  return {
    kind: 'character_identity_pack_v2', version: 2,
    id: text(input.id, 'id'), characterId: input.characterId,
    coveragePlan: structuredClone(coverage), requiredMembers,
    optionalMembers: [],
    responsibility: 'Only canonical character identity, body proportion, wardrobe and visible angle coverage declared by each member.',
    mustNotControl: ['story emotion', 'current injury or wetness', 'scene lighting', 'camera movement', 'product appearance']
  };
}
