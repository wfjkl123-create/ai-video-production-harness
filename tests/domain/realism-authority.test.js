import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCharacterActingMaster,
  assertCharacterStoryState,
  assertSceneGeometry,
  assertVoiceIdentity
} from '../../src/domain/realism-authority.js';

const binding = (id = 'source-v1', sha = 'a'.repeat(64)) => ({ id, revision: 1, sha256: sha });

function actingMaster() {
  return {
    kind: 'character_acting_master_v1', version: 1, id: 'acting-a-v1', projectId: 'project-001', characterId: 'character-a',
    sourceBindings: [binding()],
    physicalBiography: {
      ageAndPhysiology: '29-year-old adult with ordinary healthy facial muscle tone', baselineEnergy: 'contained and alert',
      posture: 'shoulders slightly forward when listening', gait: 'short grounded steps without model-walk posing',
      breath: 'quiet nasal breathing until speech pressure rises', gazeBaseline: 'looks at the task or partner, not into the lens',
      handBehavior: 'thumb rubs the side of the index finger only under social pressure'
    },
    psychologicalEngine: {
      want: 'protect dignity while being understood', fear: 'being pitied in public', protectiveMask: 'matter-of-fact competence',
      fracturePattern: 'voice catches before eye contact breaks', recoveryPattern: 'swallows, resets breath, resumes the unfinished task'
    },
    triggeredHabits: [{ cueId: 'family-subject', cue: 'after the partner mentions her mother', observableResponse: 'lower eyelids tighten, breath pauses, gaze drops to the cup', doNotUseAsClock: true }],
    continuityLocks: ['baseline posture', 'gaze avoidance under scrutiny'],
    sceneAdaptationPolicy: 'select only habits causally triggered in the current beat; active stillness is allowed',
    responsibility: 'long-term behavior identity that remains stable across scenes',
    mustNotControl: ['current story injury', 'scene lighting', 'camera movement']
  };
}

test('accepts a cue-driven character acting master and rejects timer-like blink schedules', () => {
  assert.equal(assertCharacterActingMaster(actingMaster()).characterId, 'character-a');
  const timer = actingMaster();
  timer.triggeredHabits[0] = { cueId: 'timer', cue: '每隔 3 秒', observableResponse: '眨眼一次', doNotUseAsClock: true };
  assert.throws(() => assertCharacterActingMaster(timer), /cue-driven/);
});

test('keeps story-caused state deltas separate from canonical identity', () => {
  const state = {
    kind: 'character_story_state_v1', version: 1, id: 'state-a-cry-v1', projectId: 'project-001', characterId: 'character-a', scopeKey: 'scene-cry',
    identityPackBinding: binding('identity-a-v2'), actingMasterBinding: binding('acting-a-v1', 'b'.repeat(64)),
    cause: 'she has been crying quietly for several minutes before entering the shot',
    appearanceDeltas: [
      { region: 'lower eyelids and inner eye corners', observableChange: 'slight swelling, wetness and localized red tone', persistence: 'persists through the scene' },
      { region: 'nose tip and nostril rims', observableChange: 'subtle redness with one damp highlight', persistence: 'fades only after recovery beat' }
    ],
    performanceDeltas: [{ cue: 'before answering the first question', observableResponse: 'nostrils flutter once and the lower lip presses inward', doNotUseAsClock: true }],
    preserve: ['canonical facial geometry', 'hair silhouette', 'wardrobe structure'],
    responsibility: 'story-caused appearance and behavior deltas for one character and one scope',
    mustNotControl: ['canonical identity', 'camera movement', 'scene geometry']
  };
  assert.equal(assertCharacterStoryState(state).appearanceDeltas.length, 2);
});

test('separates stable vocal identity from state-dependent delivery', () => {
  const voice = {
    kind: 'voice_identity_v1', version: 1, id: 'voice-a-v1', projectId: 'project-001', characterId: 'character-a',
    sourceBasis: 'recorded_reference', sourceBindings: [binding('voice-sample-v1')],
    vocalCore: { pitchRange: 'mid-low', timbre: 'slightly dry', resonance: 'forward and chest-light', baselinePace: 'measured', articulation: 'clear consonants with softened sentence endings', breathPattern: 'short inhale before difficult clauses' },
    allowedStateDeltas: [{ deltaId: 'suppressed-crying', trigger: 'after suppressed crying', allowedChange: 'slightly nasal onset and one broken breath', stableCore: 'mid-low pitch and softened sentence ending remain recognizable' }],
    responsibility: 'stable speaker identity and the permitted state-dependent vocal range',
    mustNotControl: ['dialogue wording', 'camera timing', 'visual identity']
  };
  assert.equal(assertVoiceIdentity(voice).sourceBasis, 'recorded_reference');
  assert.throws(() => assertVoiceIdentity({ ...voice, sourceBindings: [] }), /requires sourceBindings/);
});

test('preserves the 1/4 director term only through observable scene geometry', () => {
  const geometry = {
    kind: 'scene_geometry_v2', version: 2, id: 'geometry-room-v2', projectId: 'project-001', sceneId: 'room-a', applicability: 'required', directorLabel: '1/4',
    observableAnchor: {
      openingDirection: 'camera sees the left wall and the open doorway on the right rear',
      entranceExitRelation: 'the actor enters from the rear-right doorway and exits toward camera-left',
      pathToDepthPlane: 'walking path crosses from background doorway through midground table edge to foreground left',
      wallReveal: 'left wall occupies about one quarter of the horizontal frame while the far wall remains visible',
      depthRead: 'doorway, table and actor form three distinct depth layers'
    },
    landmarks: [
      { id: 'door', worldRelation: 'rear right of table', screenRelation: 'upper-right background' },
      { id: 'table', worldRelation: 'center and closer to camera', screenRelation: 'middle foreground' }
    ],
    screenDirectionAxes: { characterTravel: 'screen right to left', cameraSide: 'south side of travel axis', eyelineAxis: 'door to seated partner' },
    reverseShotMap: [{ shotId: 'S03', cameraSide: 'remains south of eyeline axis', preservedScreenDirection: 'standing actor remains screen right' }],
    responsibility: 'observable space geometry, landmarks and screen-direction continuity only',
    mustNotControl: ['character identity', 'story emotion', 'surface texture']
  };
  assert.equal(assertSceneGeometry(geometry).directorLabel, '1/4');
  assert.equal(assertSceneGeometry({
    kind: 'scene_geometry_v2', version: 2, id: 'geometry-macro-na', projectId: 'project-001', sceneId: 'macro-product', applicability: 'not_applicable',
    notApplicableReason: 'isolated macro insert has no reusable room geography or reverse axis',
    responsibility: 'observable space geometry, landmarks and screen-direction continuity only', mustNotControl: ['product structure']
  }).applicability, 'not_applicable');
});
