import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StateStore, type Receipt } from '../src/store.js';

function receipt(status: Receipt['status']): Receipt {
  const timestamp = new Date().toISOString();
  return {
    id: randomUUID(),
    digest: '1'.repeat(64),
    operationName: 'Write',
    fields: ['update'],
    target: { connectionId: randomUUID(), tabId: 1, origin: 'https://apply.ycombinator.com' },
    status,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

test('restart expires inert previews and marks a dispatched mutation uncertain', () => {
  const directory = mkdtempSync(join(tmpdir(), 'yc-store-'));
  try {
    const first = new StateStore(directory);
    const preview = receipt('prepared'),
      dispatched = receipt('dispatched');
    first.record(preview);
    first.record({ ...dispatched, status: 'prepared' });
    first.record(dispatched);
    first.close();
    const second = new StateStore(directory);
    try {
      assert.equal(second.getReceipt(preview.id).status, 'expired');
      assert.equal(second.getReceipt(dispatched.id).status, 'uncertain');
      assert.equal(second.getReceipt(dispatched.id).errorCode, 'SERVER_RESTARTED');
    } finally {
      second.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('state lock prevents concurrent servers and state files are private', () => {
  const directory = mkdtempSync(join(tmpdir(), 'yc-store-'));
  const store = new StateStore(directory);
  try {
    assert.throws(() => new StateStore(directory), { code: 'STATE_LOCKED' });
    store.writeConnection({ url: 'ws://127.0.0.1:1/bridge', token: 'local-test-token' });
    for (const filename of ['server.lock', 'receipts.jsonl', 'connection.json'])
      assert.equal(statSync(join(directory, filename)).mode & 0o777, 0o600);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('torn receipt journal blocks startup instead of forgetting a possibly dispatched mutation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'yc-store-'));
  try {
    const store = new StateStore(directory);
    const item = receipt('prepared');
    store.record(item);
    store.record({ ...item, status: 'dispatched' });
    store.close();
    appendFileSync(join(directory, 'receipts.jsonl'), '{"id":');
    assert.throws(() => new StateStore(directory), /Incomplete receipt journal/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
