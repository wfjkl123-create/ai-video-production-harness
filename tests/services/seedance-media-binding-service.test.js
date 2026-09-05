import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSeedanceMediaBoundPrompt, verifySeedanceMediaTokenMapping } from '../../src/services/seedance-media-binding-service.js';

const sha = value => value.repeat(64).slice(0, 64);

function packageValue() {
  return {
    imageInputs: [
      { id: 'scene-v2', sha256: sha('a') },
      { id: 'product-v1', sha256: sha('b') }
    ],
    videoInputs: [],
    audioInputs: [{ id: 'dialogue-v1', sha256: sha('c') }],
    responsibilityMap: {
      'scene-v2': { controls: ['space_structure'], mustNotControl: ['identity'] },
      'product-v1': { controls: ['product_structure'], mustNotControl: ['scene'] },
      'dialogue-v1': { controls: ['dialogue_words'], mustNotControl: ['visual appearance'] }
    }
  };
}

test('compiles stable asset IDs into final package-order platform tags without injecting audit metadata', () => {
  const result = compileSeedanceMediaBoundPrompt(
    '@素材[product-v1]控制产品，@素材[scene-v2]控制场景，口型跟随@素材[dialogue-v1]。',
    packageValue()
  );
  assert.match(result.text, /@图2控制产品，@图1控制场景，口型跟随@音频1/);
  assert.doesNotMatch(result.text, /参考素材｜本次实际上传|执行提示词正文|@图1=scene-v2|R1｜控:/);
  assert.deepEqual(result.bindings.map(item => [item.tag, item.id]), [
    ['@图1', 'scene-v2'], ['@图2', 'product-v1'], ['@音频1', 'dialogue-v1']
  ]);
  assert.equal(result.mediaTokenMappingManifest.length, 3);
  assert.equal(verifySeedanceMediaTokenMapping(
    '@素材[product-v1]控制产品，@素材[scene-v2]控制场景，口型跟随@素材[dialogue-v1]。',
    result.text,
    result.mediaTokenMappingManifest
  ), true);
  assert.throws(
    () => verifySeedanceMediaTokenMapping(
      '@素材[product-v1]控制产品，@素材[scene-v2]控制场景，口型跟随@素材[dialogue-v1]。',
      `${result.text}擅自加一句。`,
      result.mediaTokenMappingManifest
    ),
    /outside the declared media token mapping/
  );
});

test('rejects positional references, free-form aliases and unselected semantic IDs in source prompts', () => {
  assert.throws(() => compileSeedanceMediaBoundPrompt('@图1控制产品。', packageValue()), /must not hard-code/);
  assert.throws(() => compileSeedanceMediaBoundPrompt('@产品图控制产品。', packageValue()), /unsupported media aliases/);
  assert.throws(() => compileSeedanceMediaBoundPrompt('@素材[missing-v1]控制产品。', packageValue()), /not selected/);
});
