import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagsSchema } from '../app/shared/model';

test('tag identity normalizes Unicode, case, and spacing without accepting duplicate identities', () => {
  assert.deepEqual(tagsSchema.parse(['  ＩＤＥＮＴＩＴＹ   Service  ', 'customer, portal']), ['identity service', 'customer, portal']);
  assert.equal(tagsSchema.safeParse(['Identity', ' ＩＤＥＮＴＩＴＹ ']).success, false);
});

test('tag input rejects empty, control-character, oversized, and over-count values', () => {
  assert.equal(tagsSchema.safeParse([' ']).success, false);
  assert.equal(tagsSchema.safeParse(['identity\u0000service']).success, false);
  assert.equal(tagsSchema.safeParse(['x'.repeat(40)]).success, true);
  assert.equal(tagsSchema.safeParse(['x'.repeat(41)]).success, false);
  const limit = Array.from({ length: 20 }, (_, index) => `tag-${index}`);
  assert.equal(tagsSchema.safeParse(limit).success, true);
  assert.equal(tagsSchema.safeParse([...limit, 'one-too-many']).success, false);
});
