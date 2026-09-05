import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNarrationAuthoritySelections } from '../../src/services/narration-lint-service.js';

const binding = id => ({ id, revision: 1, sha256: 'a'.repeat(64) });
const master = {
  kind: 'character_acting_master_v1', version: 1, id: 'master-a', projectId: 'project-a', characterId: 'character-a',
  sourceBindings: [binding('story-a')],
  physicalBiography: { ageAndPhysiology: 'adult', baselineEnergy: 'grounded', posture: 'slight forward set', gait: 'short steps', breath: 'quiet nasal baseline', gazeBaseline: 'task oriented', handBehavior: 'hands near the active object' },
  psychologicalEngine: { want: 'finish the task', fear: 'public failure', protectiveMask: 'competence', fracturePattern: 'gaze drops', recoveryPattern: 'resets breath' },
  triggeredHabits: [{ cueId: 'criticism', cue: 'after direct criticism', observableResponse: 'breath pauses and gaze drops', doNotUseAsClock: true }],
  continuityLocks: ['grounded posture'], sceneAdaptationPolicy: 'select only causally triggered habits',
  responsibility: 'long-term behavior identity that remains stable across scenes', mustNotControl: ['lighting']
};
const voice = {
  kind: 'voice_identity_v1', version: 1, id: 'voice-a', projectId: 'project-a', characterId: 'character-a',
  sourceBasis: 'casting_spec', sourceBindings: [],
  vocalCore: { pitchRange: 'mid-low', timbre: 'dry', resonance: 'forward', baselinePace: 'measured', articulation: 'clear', breathPattern: 'short inhale' },
  allowedStateDeltas: [{ deltaId: 'held-tears', trigger: 'after holding back tears', allowedChange: 'slightly nasal onset', stableCore: 'mid-low dry core remains' }],
  responsibility: 'stable speaker identity and the permitted state-dependent vocal range', mustNotControl: ['dialogue wording']
};
const narration = () => ({ shots: [{ shotId: 'S01', authorityAdaptation: { characters: [{
  characterId: 'character-a', actingMasterBinding: binding('master-a'), voiceIdentityBinding: binding('voice-a'),
  selectedMasterCues: [{ masterCueId: 'criticism', masterCue: 'after direct criticism', triggerInShot: 'partner criticizes her', cameraVisibleAction: 'breath pauses and gaze drops' }],
  voiceStateDelta: { voiceDeltaId: 'held-tears', triggerInShot: 'before her reply', audibleChange: 'slightly nasal onset', stableCore: 'mid-low dry core remains' }
}] } }] });

test('shot authority selections must point to exact Master cue and Voice delta IDs', () => {
  const payloads = new Map([['master-a', master], ['voice-a', voice]]);
  assert.equal(assertNarrationAuthoritySelections(narration(), payloads), true);
  const staleCue = narration();
  staleCue.shots[0].authorityAdaptation.characters[0].selectedMasterCues[0].masterCueId = 'invented';
  assert.throws(() => assertNarrationAuthoritySelections(staleCue, payloads), /exact cueId/);
  const staleVoice = narration();
  staleVoice.shots[0].authorityAdaptation.characters[0].voiceStateDelta.audibleChange = 'a different voice';
  assert.throws(() => assertNarrationAuthoritySelections(staleVoice, payloads), /exact permitted delta/);
});
