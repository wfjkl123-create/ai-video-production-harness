export const RUNNINGHUB_VIDEO_ENDPOINT = '/openapi/v2/bytedance/seedance-2.0-global/multimodal-video';

export const RUNNINGHUB_DEFAULTS = Object.freeze({
  duration: 15,
  ratio: '9:16',
  resolution: '480p',
  realPersonMode: true,
  generateAudio: true,
  pollIntervalMs: 5_000,
  maxWaitMs: 30 * 60 * 1_000
});
