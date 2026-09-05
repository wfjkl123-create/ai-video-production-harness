const RESOLUTION_SPECS = Object.freeze({
  '480p': Object.freeze({ width: 496, height: 864, rank: 1 }),
  '720p': Object.freeze({ width: 720, height: 1280, rank: 2 }),
  '1080p': Object.freeze({ width: 1080, height: 1920, rank: 3 }),
  '4k': Object.freeze({ width: 2160, height: 3840, rank: 4 })
});

const VIDEO_MODEL_PROFILES = Object.freeze({
  'seedance-2-5-libtv-v1': Object.freeze({
    id: 'seedance-2-5-libtv-v1', executor: 'libtv', model: 'Seedance 2.5',
    supportedResolutions: ['480p', '720p', '1080p'], defaultResolution: '720p',
    evidence: 'libtv model star-video2.5 live schema, checked 2026-08-18'
  }),
  'seedance-2-vip-libtv-v1': Object.freeze({
    id: 'seedance-2-vip-libtv-v1', executor: 'libtv', model: 'Seedance 2.0 VIP',
    supportedResolutions: ['480p', '720p', '1080p', '4k'], defaultResolution: '480p',
    evidence: 'docs/operator-runbook.md#seedance-20-vip-平台约束star-video2已由-709-项目实测'
  }),
  'seedance-2-libtv-v1': Object.freeze({
    id: 'seedance-2-libtv-v1', executor: 'libtv', model: 'Seedance 2.0',
    supportedResolutions: ['480p', '720p'], defaultResolution: '480p',
    evidence: 'libtv model Seedance 2.0 live schema, checked 2026-08-21'
  }),
  'kling-o3-libtv-v1': Object.freeze({
    id: 'kling-o3-libtv-v1', executor: 'libtv', model: 'Kling O3',
    supportedResolutions: ['720p'], defaultResolution: '720p',
    evidence: 'src/services/video-generation-service.js#kling-o3-quality-contract'
  }),
  'runninghub-seedance-v1': Object.freeze({
    id: 'runninghub-seedance-v1', executor: 'runninghub', model: 'RunningHub Seedance',
    supportedResolutions: ['480p', '720p'], defaultResolution: '480p',
    evidence: 'src/services/video-generation-service.js#legacy-runninghub-contract'
  })
});

function profile(id) {
  const value = VIDEO_MODEL_PROFILES[id];
  if (!value) throw new Error(`unknown verified video model profile: ${id ?? ''}`);
  return value;
}

function normalizeDimensions(value) {
  if (!value) return null;
  const width = Number(value.width);
  const height = Number(value.height);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new TypeError('source resolution baseline requires positive integer width and height');
  }
  return { shortEdge: Math.min(width, height), longEdge: Math.max(width, height) };
}

export function videoResolutionSpec(resolution) {
  const value = RESOLUTION_SPECS[resolution];
  if (!value) throw new Error(`unsupported video resolution: ${resolution ?? ''}`);
  return value;
}

export function resolveVideoModelProfile({ executor = 'libtv', model } = {}) {
  if (executor === 'libtv') {
    if (model === undefined || model === 'Seedance 2.0 VIP') return profile('seedance-2-vip-libtv-v1');
    if (model === 'Seedance 2.0') return profile('seedance-2-libtv-v1');
    if (model === 'Seedance 2.5') return profile('seedance-2-5-libtv-v1');
    if (model === 'Kling O3') return profile('kling-o3-libtv-v1');
  }
  if (executor === 'runninghub' && (model === undefined || model === 'RunningHub Seedance')) return profile('runninghub-seedance-v1');
  throw new Error(`no verified video model profile for executor=${executor ?? ''} model=${model ?? ''}`);
}

export function videoModelProfileById(id) {
  return profile(id);
}

export function createVideoResolutionContract({ profileId, requestedResolution, sourceBaseline = null }) {
  const modelProfile = profile(profileId);
  const baseline = normalizeDimensions(sourceBaseline);
  const candidates = modelProfile.supportedResolutions
    .map(resolution => ({ resolution, ...videoResolutionSpec(resolution) }))
    .sort((left, right) => left.rank - right.rank);
  let resolution = requestedResolution;
  if (resolution !== undefined && !modelProfile.supportedResolutions.includes(resolution)) {
    throw new Error(`video model profile ${profileId} does not support ${resolution}; supported: ${modelProfile.supportedResolutions.join(', ')}`);
  }
  if (resolution === undefined) {
    resolution = baseline
      ? candidates.find(item => item.width >= baseline.shortEdge && item.height >= baseline.longEdge)?.resolution
      : modelProfile.defaultResolution;
  }
  if (!resolution) {
    throw new Error(`video model profile ${profileId} cannot meet source resolution ${sourceBaseline.width}x${sourceBaseline.height}; choose a verified higher-resolution model`);
  }
  const target = videoResolutionSpec(resolution);
  if (baseline && (target.width < baseline.shortEdge || target.height < baseline.longEdge)) {
    throw new Error(`requested ${resolution} (${target.width}x${target.height}) is below locked source resolution ${sourceBaseline.width}x${sourceBaseline.height}`);
  }
  return {
    version: 1,
    profileId: modelProfile.id,
    executor: modelProfile.executor,
    model: modelProfile.model,
    resolution,
    supportedResolutions: [...modelProfile.supportedResolutions],
    sourceBaseline: sourceBaseline ? { ...sourceBaseline } : null,
    evidence: modelProfile.evidence
  };
}

export function assertVideoResolutionContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) throw new TypeError('video resolution contract version 1 is required');
  const modelProfile = profile(value.profileId);
  if (value.executor !== modelProfile.executor || value.model !== modelProfile.model) throw new Error('video resolution contract does not match its verified model profile');
  const rebuilt = createVideoResolutionContract({
    profileId: value.profileId,
    requestedResolution: value.resolution,
    sourceBaseline: value.sourceBaseline ?? null
  });
  if (JSON.stringify(value.supportedResolutions) !== JSON.stringify(rebuilt.supportedResolutions) || value.evidence !== rebuilt.evidence) {
    throw new Error('video resolution contract capabilities do not match the verified model profile');
  }
  return value;
}

export const VERIFIED_VIDEO_MODEL_PROFILES = VIDEO_MODEL_PROFILES;
