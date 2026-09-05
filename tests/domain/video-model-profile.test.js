import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertVideoResolutionContract,
  createVideoResolutionContract,
  resolveVideoModelProfile
} from '../../src/domain/video-model-profile.js';

const source = (width, height) => ({
  artifactId: 'reference-video-v1', path: 'brief/reference.mp4', sha256: 'a'.repeat(64), width, height
});

test('selects the smallest verified model resolution that is not below the locked source', () => {
  const profile = resolveVideoModelProfile({ executor: 'libtv', model: 'Seedance 2.0 VIP' });
  const contract = createVideoResolutionContract({ profileId: profile.id, sourceBaseline: source(1080, 1920) });
  assert.equal(contract.resolution, '1080p');
  assert.equal(assertVideoResolutionContract(contract), contract);
});

test('rejects a requested downgrade and a model that cannot satisfy the source baseline', () => {
  assert.throws(() => createVideoResolutionContract({
    profileId: 'seedance-2-vip-libtv-v1', requestedResolution: '720p', sourceBaseline: source(1080, 1920)
  }), /below locked source resolution/);
  assert.throws(() => createVideoResolutionContract({
    profileId: 'runninghub-seedance-v1', sourceBaseline: source(1080, 1920)
  }), /cannot meet source resolution/);
});

test('requires exact verified executor and model aliases instead of guessing', () => {
  assert.equal(resolveVideoModelProfile({ executor: 'libtv' }).id, 'seedance-2-vip-libtv-v1');
  assert.equal(resolveVideoModelProfile({ executor: 'libtv', model: 'Seedance 2.5' }).id, 'seedance-2-5-libtv-v1');
  assert.throws(() => resolveVideoModelProfile({ executor: 'libtv', model: 'Unverified Model' }), /no verified video model profile/);
});
