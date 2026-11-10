import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectOperation, normalizeRequest } from '../src/graphql.js';

test('AST validation distinguishes operations from comments, strings, and fragment names', () => {
  assert.equal(
    inspectOperation(
      '# mutation Fake { erase }\nquery Read { echo(text: "mutation") ...mutation } fragment mutation on Query { id }',
      'Read',
    ).kind,
    'query',
  );
  assert.equal(inspectOperation('mutation Write { update { id } }', 'Write').kind, 'mutation');
  for (const [document, name] of [
    ['{ id }', 'Read'],
    ['query Read { id } mutation Write { erase }', 'Read'],
    ['query Read { id }', 'Different'],
    ['subscription Watch { id }', 'Watch'],
    ['query Read { ...Cycle } fragment Cycle on Query { ...Cycle }', 'Read'],
    ['query Read { ...Missing }', 'Read'],
    ['type Query { id: ID } query Read { id }', 'Read'],
  ])
    assert.throws(() => inspectOperation(document!, name!));
});

test('identifiers reject all control characters and documents/variables have bounds', () => {
  for (const suffix of ['\n', '\r\n', '\t', '\0', '\u2028', ' ', 'é']) {
    assert.throws(() => inspectOperation('query Read { id }', 'Read' + suffix));
    assert.throws(() => inspectOperation('query Read { id }', suffix + 'Read'));
  }
  assert.throws(() => inspectOperation(' '.repeat(100001), 'Read'));
  assert.throws(() =>
    normalizeRequest({
      query: 'query Read { id }',
      operationName: 'Read',
      variables: { a: 'x'.repeat(100001) },
    }),
  );
  let nested: unknown = 1;
  for (let n = 0; n < 22; n++) nested = { a: nested };
  assert.throws(() =>
    normalizeRequest({ query: 'query Read { id }', operationName: 'Read', variables: { nested } }),
  );
});
