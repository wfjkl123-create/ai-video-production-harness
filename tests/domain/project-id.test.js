import test from 'node:test';
import assert from 'node:assert/strict';
import { assertProjectId, isProjectId, isProjectSlug } from '../../src/domain/project-id.js';

test('project ids accept Chinese letters while keeping filesystem-safe separators', () => {
  assert.equal(isProjectId('夏日收腹裤-001'), true);
  assert.equal(assertProjectId('  夏日收腹裤-001  '), '夏日收腹裤-001');
  assert.equal(isProjectId('夏日 收腹裤'), false);
  assert.equal(isProjectId('../夏日收腹裤'), false);
  assert.equal(isProjectId('-夏日收腹裤'), false);
  assert.equal(isProjectSlug('abcd1234-夏日收腹裤-001'), true);
});
