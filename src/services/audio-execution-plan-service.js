import { assertAudioExecutionPlan, assertApprovedSourceAudio, AUDIO_STRATEGIES } from '../domain/audio-execution-plan.js';
import { assertSurfaceCapabilitySnapshot } from '../domain/surface-capability-snapshot.js';

const USER_REQUIREMENTS = new Set(['auto', 'preserve_exact', 'generate_native', 'reference_guided', 'external_remux', 'silent']);
const SOURCE_ROLES = new Set(['none', 'inspiration', 'authority']);

function chooseStrategy(input) {
  if (input.requestedStrategy !== undefined) {
    if (!AUDIO_STRATEGIES.includes(input.requestedStrategy)) throw new TypeError('requestedStrategy is unsupported');
    return input.requestedStrategy;
  }
  const requirement = input.userRequirement ?? 'auto';
  if (!USER_REQUIREMENTS.has(requirement)) throw new TypeError('userRequirement is unsupported');
  const explicit = {
    preserve_exact: 'preserve_source_audio_exact',
    generate_native: 'native_generate',
    reference_guided: 'reference_guided',
    external_remux: 'external_remux',
    silent: 'silent_visual_test'
  }[requirement];
  if (explicit) return explicit;
  if (input.approvedSourceAudio && (input.sourceRole === 'authority' || ['source_modification', 'mechanical_face_replacement'].includes(input.operation))) {
    return 'preserve_source_audio_exact';
  }
  return 'native_generate';
}

export function resolveAudioExecutionPlan(input, { now = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('audio execution input must be an object');
  if (!SOURCE_ROLES.has(input.sourceRole ?? 'none')) throw new TypeError('sourceRole is unsupported');
  const snapshot = assertSurfaceCapabilitySnapshot(input.surfaceCapabilitySnapshot, { now, requireFresh: true });
  if (snapshot.operation !== input.operation) throw new Error('surface capability snapshot operation does not match audio operation');
  const strategy = chooseStrategy(input);
  const capabilities = snapshot.capabilities;
  const approvedSourceAudio = ['preserve_source_audio_exact', 'reference_guided', 'external_remux'].includes(strategy)
    ? structuredClone(assertApprovedSourceAudio(input.approvedSourceAudio))
    : undefined;
  if (strategy === 'native_generate' && !capabilities.generatedAudio) throw new Error('current surface snapshot does not support generated audio');
  if (strategy !== 'native_generate' && !capabilities.disableGeneratedAudio) throw new Error('current surface snapshot does not prove generated audio can be disabled');
  if (strategy === 'reference_guided' && !capabilities.audioReference) throw new Error('current surface snapshot does not support reference-guided audio');
  if (strategy === 'preserve_source_audio_exact' && !capabilities.sourceAudioPreservation && !capabilities.streamCopyRemux) {
    throw new Error('exact source audio needs native preservation or verified stream-copy remux capability');
  }
  if (strategy === 'external_remux' && !capabilities.streamCopyRemux) throw new Error('external remux needs verified stream-copy capability');

  const directPreservation = strategy === 'preserve_source_audio_exact' && capabilities.sourceAudioPreservation;
  const remux = strategy === 'external_remux' || strategy === 'preserve_source_audio_exact' && !directPreservation
    ? { required: true, mode: 'stream_copy', verifyElementaryStreamSha: true }
    : { required: false, mode: 'none', verifyElementaryStreamSha: false };
  const promptPolicy = {
    native_generate: {
      allowedAudibleFacts: ['current dialogue wording', 'speaker state', 'breath and pause cues', 'visible action-linked sound', 'scene ambience'],
      prohibitedClaims: ['source audio is preserved unless separately proven']
    },
    reference_guided: {
      allowedAudibleFacts: ['approved reference voice identity and timing responsibilities', 'current visible action-linked sound'],
      prohibitedClaims: ['exact waveform preservation', 'new unapproved dialogue']
    },
    preserve_source_audio_exact: {
      allowedAudibleFacts: ['approved source audio words, timing, timbre, pauses and stress as fixed authority'],
      prohibitedClaims: ['new dialogue', 'retiming', 'repitching', 'voice replacement', 'new music or effects inside the generation node']
    },
    external_remux: {
      allowedAudibleFacts: ['visual lips and action timing align to the separately remuxed approved source clock'],
      prohibitedClaims: ['audio generated inside this node', 'new dialogue', 'retiming or repitching source audio']
    },
    silent_visual_test: {
      allowedAudibleFacts: [],
      prohibitedClaims: ['dialogue', 'voice', 'music', 'sound effect', 'ambience']
    }
  }[strategy];
  return assertAudioExecutionPlan({
    kind: 'audio_execution_plan_v1', version: 1, strategy,
    generateAudio: strategy === 'native_generate',
    enableSound: strategy === 'native_generate',
    syncAuthority: approvedSourceAudio ? `approved_audio:${approvedSourceAudio.artifactId}:${approvedSourceAudio.elementaryStreamSha256}` : strategy === 'native_generate' ? 'current_director_ir' : 'visual_only',
    promptPolicy,
    ...(approvedSourceAudio ? { approvedSourceAudio } : {}),
    remux,
    capabilitySnapshot: {
      id: snapshot.id, surface: snapshot.surface, model: snapshot.model,
      operation: snapshot.operation, expiresAt: snapshot.expiresAt
    },
    rationale: input.rationale ?? `Resolved ${strategy} from user requirement, source authority, operation and current surface capability in that priority order.`
  });
}
