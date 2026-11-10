import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { StateStore } from '../src/store.js';

const change = (key = randomUUID()) => ({
  operationName: 'Write',
  query: 'mutation Write($text: String!) { update(text: $text) { id } }',
  variables: { text: 'private application content' },
  idempotencyKey: key,
});

test('read-only defaults reject both query smuggling and mutation previews', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.query(change()), { code: 'MUTATION_BLOCKED' });
    assert.throws(() => f.service.prepare(change()), { code: 'MUTATION_BLOCKED' });
  } finally {
    await f.close();
  }
});

test('preview is inert; concurrent duplicate commits cause exactly one fake effect with durable replay', async () => {
  const f = await fixture({ mutations: true });
  let effects = 0;
  try {
    await f.pair(true, (message, ws) => {
      assert.equal(f.store.getReceipt(preview.receipt.id).status, 'dispatched');
      effects++;
      setTimeout(
        () =>
          ws.send(
            JSON.stringify({ type: 'result', id: message.id, ok: true, data: { updated: true } }),
          ),
        10,
      );
    });
    const input = change();
    const preview = f.service.prepare(input);
    assert.equal(effects, 0);
    assert.equal(preview.preview.variables.text, input.variables.text);
    assert.throws(() => f.service.prepare({ ...input, variables: { text: 'different' } }), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await assert.rejects(f.service.commit(preview.receipt.id, '0'.repeat(64)), {
      code: 'DIGEST_MISMATCH',
    });
    const results = await Promise.all([
      f.service.commit(preview.receipt.id, preview.receipt.digest),
      f.service.commit(preview.receipt.id, preview.receipt.digest),
    ]);
    assert.equal(effects, 1);
    assert.equal(results[0].receipt.status, 'unverified');
    assert.equal(results[1].replay, true);
    await f.service.commit(preview.receipt.id, preview.receipt.digest);
    assert.equal(effects, 1);
    assert.ok(
      !readFileSync(join(f.directory, 'receipts.jsonl'), 'utf8').includes(
        'private application content',
      ),
    );
  } finally {
    await f.close();
  }
});

test('commit then dropped reply is uncertain, never redispatched, and recoverable after restart', async () => {
  const f = await fixture({ mutations: true, timeoutMs: 50 });
  let effects = 0;
  try {
    await f.pair(true, () => {
      effects++; /* fake effect committed; deliberately lose reply */
    });
    const preview = f.service.prepare(change());
    const result = await f.service.commit(preview.receipt.id, preview.receipt.digest);
    assert.equal(result.receipt.status, 'uncertain');
    assert.equal(effects, 1);
    const replay = await f.service.commit(preview.receipt.id, preview.receipt.digest);
    assert.equal(replay.replay, true);
    assert.equal(replay.error?.code, 'MUTATION_UNCERTAIN');
    assert.equal(effects, 1);
    f.store.close();
    const recovered = new StateStore(f.directory);
    assert.equal(recovered.getReceipt(preview.receipt.id).status, 'uncertain');
    recovered.close();
    // Restore an open store for the fixture's cleanup.
    (f as any).store = new StateStore(f.directory);
  } finally {
    await f.bridge.close();
    (f as any).store.close();
    const { rmSync } = await import('node:fs');
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test('extension mutation policy is independently enforced', async () => {
  const f = await fixture({ mutations: true });
  try {
    await f.pair(false);
    assert.throws(() => f.service.prepare(change()), { code: 'MUTATION_BLOCKED' });
  } finally {
    await f.close();
  }
});
