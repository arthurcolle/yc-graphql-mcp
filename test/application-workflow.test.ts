import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DirectTransport } from '../src/direct.js';
import { StateStore } from '../src/store.js';
import { YCService } from '../src/service.js';
import { ApplicationWorkflow } from '../src/application-workflow.js';
import { parseEditForm } from '../src/edit-forms.js';

const appUuid = '63a4d22c-1096-443e-894b-349e9c46fabb';
const html = (kind: string, fields: string[] = ['howfar', 'techstack', 'usernums']) =>
  `mount({component: "components/AppForm", props: ${JSON.stringify({ app_uuid: appUuid, update_kind: kind, active_question_groups: { Progress: Object.fromEntries(fields.map((field) => [field, { prompt: { q: 'Question ' + field, required: false } }])) }, cookie: 'must-not-leave-page' })}\n})`;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'yc-typed-'));
  const auth = join(directory, 'auth.json');
  writeFileSync(auth, JSON.stringify({ cookie: 'session=synthetic-long-session' }), {
    mode: 0o600,
  });
  const app = {
    uuid: appUuid,
    submitted: true,
    submittedAt: '2026-01-01T00:00:00Z',
    status: 'submitted',
    editable: true,
    fullEditable: false,
    questions: { howfar: 'Before', techstack: 'C', usernums: 'Private financial facts' },
  };
  const state = {
    effects: 0,
    reads: 0,
    fields: ['howfar', 'techstack', 'usernums'],
    persist: true,
    reject: false,
  };
  const transport = new DirectTransport(auth, true, async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/graphql') {
      const body = JSON.parse(String(init?.body));
      if (body.operationName === 'YCUpdateApplication') {
        state.effects++;
        if (state.persist && !state.reject)
          Object.assign(app.questions, body.variables.input.questions);
        return Response.json({
          data: {
            updateApp: {
              success: !state.reject,
              persisted: !state.reject,
              errors: state.reject ? ['refused'] : [],
              app: state.reject ? null : { uuid: appUuid },
            },
          },
        });
      }
      state.reads++;
      return Response.json({ data: { app: structuredClone(app) } });
    }
    const kind = url.pathname.split('/').at(-1)!;
    if (kind === 'full') return new Response('', { status: 404 });
    return new Response(
      kind === 'edit'
        ? `mount({component: "components/ChooseUpdateKind", props: {"visibleUpdateKinds":{"progress":true,"fundraise":true,"cofounder":true}}\n})`
        : html(kind, state.fields),
      { headers: { 'content-type': 'text/html' } },
    );
  });
  const store = new StateStore(join(directory, 'state'));
  const service = new YCService(transport, store, true);
  const workflow = new ApplicationWorkflow(service);
  const input = () => ({
    appUuid,
    updateKind: 'progress' as const,
    changes: [{ field: 'howfar', value: 'After', expectedValue: 'Before' }],
    idempotencyKey: randomUUID(),
    allowFinancialChanges: false,
  });
  return {
    app,
    state,
    service,
    store,
    workflow,
    input,
    async close() {
      await service.shutdown();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('live edit discovery returns only exposed metadata, without page props or inferred full-edit permission', async () => {
  const f = fixture();
  try {
    const out = await f.workflow.editability(appUuid);
    assert.equal(out.permissions.fullEditable, false);
    assert.equal(out.forms.length, 3);
    assert.ok(out.forms[0]!.groups[0]!.fields.some((field) => field.field === 'howfar'));
    assert.ok(!JSON.stringify(out).includes('must-not-leave-page'));
    await assert.rejects(f.workflow.prepare({ ...f.input(), updateKind: 'full' }), {
      code: 'EDIT_RESTRICTED',
    });
    assert.equal(f.state.effects, 0);
    assert.throws(
      () => parseEditForm(html('progress'), 'd37db355-b11c-4184-ae73-8fb091b110bf', 'progress'),
      { code: 'INVALID_EDIT_FORM' },
    );
    assert.throws(
      () =>
        parseEditForm(
          'mount({component: "components/AppForm", props: null\n})',
          appUuid,
          'progress',
        ),
      { code: 'INVALID_EDIT_FORM' },
    );
  } finally {
    await f.close();
  }
});

test('typed preparation is inert, immutable, and commit verifies the exact saved answer', async () => {
  const f = fixture();
  try {
    const input = f.input();
    const preview = await f.workflow.prepare(input);
    assert.equal(f.state.effects, 0);
    assert.deepEqual(preview.changes, [{ field: 'howfar', before: 'Before', after: 'After' }]);
    preview.changes[0]!.after = 'Smuggled';
    preview.preview.variables.input = { questions: { howfar: 'Smuggled' } };
    const result = await f.workflow.commit(preview.receipt.id, preview.receipt.digest);
    assert.equal(result.verification.verified, true);
    assert.equal(f.app.questions.howfar, 'After');
    assert.equal(f.state.effects, 1);
    await f.workflow.commit(preview.receipt.id, preview.receipt.digest);
    assert.equal(f.state.effects, 1);
    assert.equal(f.app.questions.usernums, 'Private financial facts');
    assert.ok(!readFileSync(join(f.store.directory, 'receipts.jsonl'), 'utf8').includes('Before'));
  } finally {
    await f.close();
  }
});

test('a generic commit cannot bypass a typed answer precondition, and concurrent user edits are preserved', async () => {
  const f = fixture();
  try {
    const preview = await f.workflow.prepare(f.input());
    f.app.questions.howfar = 'Concurrent edit';
    await assert.rejects(f.service.commit(preview.receipt.id, preview.receipt.digest), {
      code: 'PRECONDITION_FAILED',
    });
    assert.equal(f.state.effects, 0);
    assert.equal(f.app.questions.howfar, 'Concurrent edit');
    assert.equal(f.store.getReceipt(preview.receipt.id).status, 'prepared');
  } finally {
    await f.close();
  }
});

test('newly restricted edit forms block a prepared change before dispatch', async () => {
  const f = fixture();
  try {
    const preview = await f.workflow.prepare(f.input());
    f.state.fields = ['techstack'];
    await assert.rejects(f.workflow.commit(preview.receipt.id, preview.receipt.digest), {
      code: 'FIELD_NOT_EDITABLE',
    });
    assert.equal(f.state.effects, 0);
  } finally {
    await f.close();
  }
});

test('a successful envelope with an unchanged answer fails postcondition without a second effect', async () => {
  const f = fixture();
  try {
    f.state.persist = false;
    const preview = await f.workflow.prepare(f.input());
    for (let n = 0; n < 2; n++)
      await assert.rejects(
        f.workflow.commit(preview.receipt.id, preview.receipt.digest),
        (error: any) =>
          error.code === 'POSTCONDITION_FAILED' && error.details.receipt.id === preview.receipt.id,
      );
    assert.equal(f.state.effects, 1);
    assert.equal(f.store.getReceipt(preview.receipt.id).status, 'succeeded');
  } finally {
    await f.close();
  }
});

test('typed inputs reject duplicate keys, stale expectations, unsupported uploads, financial changes and idempotency conflicts', async () => {
  const f = fixture();
  try {
    const base = f.input();
    await assert.rejects(
      f.workflow.prepare({ ...base, changes: [...base.changes, ...base.changes] }),
      { code: 'DUPLICATE_FIELD' },
    );
    await assert.rejects(
      f.workflow.prepare({ ...base, changes: [{ field: 'usernums', value: '999' }] }),
      { code: 'FINANCIAL_CHANGE_BLOCKED' },
    );
    await assert.rejects(
      f.workflow.prepare({ ...base, changes: [{ field: 'codingAgentSession', value: 'file' }] }),
      { code: 'FIELD_UNSUPPORTED' },
    );
    await assert.rejects(
      f.workflow.prepare({
        ...base,
        changes: [{ field: 'howfar', value: 'After', expectedValue: 'Stale' }],
      }),
      { code: 'PRECONDITION_FAILED' },
    );
    await assert.rejects(
      f.workflow.prepare({ ...base, changes: [{ field: 'howfar', value: 'Before' }] }),
      { code: 'NO_CHANGES' },
    );
    const preview = await f.workflow.prepare(base);
    await assert.rejects(
      f.workflow.prepare({ ...base, changes: [{ field: 'howfar', value: 'Different' }] }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.equal((await f.workflow.prepare(base)).receipt.id, preview.receipt.id);
    assert.equal(f.state.effects, 0);
  } finally {
    await f.close();
  }
});

test('verification and Markdown export are read-only, and guarded concurrent commits cause one effect', async () => {
  const f = fixture();
  try {
    const verification = await f.workflow.verify(appUuid, [{ field: 'howfar', value: 'After' }]);
    assert.equal(verification.verified, false);
    assert.ok((await f.workflow.export(appUuid)).markdown.includes('## howfar'));
    assert.equal(f.state.effects, 0);
    const preview = await f.workflow.prepare(f.input());
    const results = await Promise.allSettled([
      f.workflow.commit(preview.receipt.id, preview.receipt.digest),
      f.service.commit(preview.receipt.id, preview.receipt.digest),
    ]);
    assert.equal(results[0]!.status, 'fulfilled');
    assert.equal(results[1]!.status, 'rejected');
    assert.equal(f.state.effects, 1);
  } finally {
    await f.close();
  }
});
