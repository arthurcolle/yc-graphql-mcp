import { createHash } from 'node:crypto';
import { z } from 'zod';
import { YCService } from './service.js';
import { YCError } from './errors.js';
import { GET_APPLICATION } from './operations.js';
import { canonicalJSON } from './json.js';
import { identifier, uuid } from './protocol.js';
import type { EditDiscovery, EditKind } from './edit-forms.js';

const value = z.string().max(20_000).nullable();
export const answerChange = z.strictObject({
  field: identifier,
  value,
  expectedValue: value.optional(),
});
export const updateInput = z.strictObject({
  appUuid: uuid,
  updateKind: z.enum(['full', 'progress', 'fundraise', 'cofounder']),
  changes: z.array(answerChange).min(1).max(30),
  idempotencyKey: uuid,
  allowFinancialChanges: z.boolean().default(false),
});
export const verifyInput = z.strictObject({
  appUuid: uuid,
  expected: z
    .array(z.strictObject({ field: identifier, value }))
    .min(1)
    .max(30),
});
type UpdateInput = z.infer<typeof updateInput>;
interface Application {
  uuid: string;
  submitted: boolean;
  submittedAt: string | null;
  editable: boolean;
  fullEditable: boolean;
  status: string;
  questions: Record<string, unknown>;
}
const applicationSchema = z.object({
  uuid,
  submitted: z.boolean(),
  submittedAt: z.string().nullable(),
  editable: z.boolean(),
  fullEditable: z.boolean(),
  status: z.string(),
  questions: z.record(z.string(), z.unknown()),
});
const financial = new Set([
  'usernums',
  'revenuesource',
  'growthrate',
  'raisingdetails',
  'revenue',
  'revenueamount',
  'currentlyraising',
  'bank',
  'burn',
  'runway',
  'investamount',
  'investyet',
  'incinvest',
  'incpercent',
  'percent2',
  'inc',
  'percent',
  'incyet',
  'inctype',
  'howmuch1',
  'howmuch2',
  'howmuch3',
  'howmuch4',
  'howmuch5',
  'howmuch6',
]);
const unsupported = new Set([
  'productCreds',
  'codingAgentSession',
  'revenueamount',
  'founderBios',
  'demoS3Key',
  'videoS3Key',
]);
const digest = (value: unknown) => createHash('sha256').update(canonicalJSON(value)).digest('hex');
const request = (appUuid: string) => ({
  operationName: 'YCGetApplication',
  query: GET_APPLICATION,
  variables: { appUuid },
});

export class ApplicationWorkflow {
  private plans = new Map<
    string,
    {
      inputDigest: string;
      input: UpdateInput;
      baseline: Application;
      preview: ReturnType<YCService['prepare']>;
      createdAt: number;
    }
  >();
  constructor(private readonly service: YCService) {}
  private async read(appUuid: string, signal?: AbortSignal): Promise<Application> {
    const data = await this.service.query(request(appUuid), signal);
    const parsed = applicationSchema.safeParse((data as { app?: unknown } | null)?.app);
    if (!parsed.success || parsed.data.uuid !== appUuid)
      throw new YCError(
        'INVALID_APPLICATION',
        'YC did not return the requested application in the expected shape.',
      );
    return parsed.data;
  }
  async editability(appUuid: string, signal?: AbortSignal) {
    uuid.parse(appUuid);
    const app = await this.read(appUuid, signal);
    const discovery = (await this.service.bridge.execute(
      { method: 'inspectEditability', appUuid },
      signal,
    )) as EditDiscovery;
    if (discovery.appUuid !== appUuid || !Array.isArray(discovery.forms))
      throw new YCError('INVALID_EDIT_FORM', 'Edit discovery did not match the application.');
    return {
      ...discovery,
      permissions: {
        submitted: app.submitted,
        editable: app.editable,
        fullEditable: app.fullEditable,
      },
      inference:
        'Fields are exposed by the current authenticated edit forms. Backend persistence is established only after commit and read-back.',
    };
  }
  private allowed(app: Application, discovery: EditDiscovery, kind: EditKind, fields: string[]) {
    if (!app.editable || (kind === 'full' && !app.fullEditable))
      throw new YCError(
        'EDIT_RESTRICTED',
        'YC does not permit this update kind for the current application.',
      );
    const form = discovery.forms.find((form) => form.kind === kind);
    if (!form)
      throw new YCError('EDIT_RESTRICTED', 'The requested update form is not currently available.');
    const exposed = new Set(
      form.groups.flatMap((group) => group.fields.map((field) => field.field)),
    );
    for (const field of fields)
      if (!exposed.has(field))
        throw new YCError(
          'FIELD_NOT_EDITABLE',
          'A requested field is absent from the selected update form. No mutation was prepared.',
        );
  }
  async prepare(raw: UpdateInput, signal?: AbortSignal) {
    const input = updateInput.parse(raw);
    const inputDigest = digest(input);
    const cached = this.plans.get(input.idempotencyKey);
    if (cached) {
      if (cached.inputDigest !== inputDigest)
        throw new YCError('IDEMPOTENCY_CONFLICT', 'This key is bound to a different typed update.');
      return {
        ...structuredClone(cached.preview),
        receipt: this.service.store.getReceipt(input.idempotencyKey),
        replay: true,
      };
    }
    for (const [id, plan] of this.plans)
      if (Date.now() - plan.createdAt > 600_000) this.plans.delete(id);
    if (this.plans.size >= 100)
      throw new YCError(
        'PREVIEW_LIMIT',
        'The typed workflow holds 100 previews; wait for older previews to expire.',
      );
    if (!this.service.allowMutations)
      throw new YCError('MUTATION_BLOCKED', 'Typed updates require --allow-mutations.');
    const seen = new Set<string>();
    for (const change of input.changes) {
      if (seen.has(change.field))
        throw new YCError('DUPLICATE_FIELD', 'Each field may occur once per update.');
      seen.add(change.field);
      if (unsupported.has(change.field))
        throw new YCError(
          'FIELD_UNSUPPORTED',
          'This field needs a dedicated upload, structured-data, or founder-profile workflow.',
        );
      if (financial.has(change.field) && !input.allowFinancialChanges)
        throw new YCError(
          'FINANCIAL_CHANGE_BLOCKED',
          'Financial answers are protected by default. Explicitly set allowFinancialChanges only for an authorized financial change.',
        );
    }
    const app = await this.read(input.appUuid, signal);
    const discovery = (await this.service.bridge.execute(
      { method: 'inspectEditability', appUuid: input.appUuid },
      signal,
    )) as EditDiscovery;
    this.allowed(app, discovery, input.updateKind, [...seen]);
    const changes = input.changes
      .map((change) => {
        if (
          !Object.hasOwn(app.questions, change.field) ||
          (app.questions[change.field] !== null && typeof app.questions[change.field] !== 'string')
        )
          throw new YCError(
            'FIELD_UNSUPPORTED',
            'Typed updates support only fields returned as text or null.',
          );
        if (
          Object.hasOwn(change, 'expectedValue') &&
          app.questions[change.field] !== change.expectedValue
        )
          throw new YCError(
            'PRECONDITION_FAILED',
            'A current answer differs from expectedValue. Read it again before preparing a change.',
          );
        return {
          field: change.field,
          before: app.questions[change.field] as string | null,
          after: change.value,
        };
      })
      .filter((change) => change.before !== change.after);
    if (!changes.length)
      throw new YCError(
        'NO_CHANGES',
        'The proposed answers already match YC. No mutation was prepared.',
      );
    const patch = Object.fromEntries(changes.map((change) => [change.field, change.after]));
    const preview = this.service.prepareGuarded(
      {
        operationName: 'YCUpdateApplication',
        query:
          'mutation YCUpdateApplication($uuid: Uuid!, $input: UpdateAppInput!, $reloadApp: Boolean) { updateApp(uuid: $uuid, input: $input, reloadApp: $reloadApp) { success persisted errors app { uuid } } }',
        variables: {
          uuid: input.appUuid,
          input: { updateKind: input.updateKind, submitOnSave: 1, questions: patch },
          reloadApp: true,
        },
        idempotencyKey: input.idempotencyKey,
      },
      async (signal) => {
        const fresh = await this.read(input.appUuid, signal);
        for (const change of changes)
          if (fresh.questions[change.field] !== change.before)
            throw new YCError(
              'PRECONDITION_FAILED',
              'An answer changed after preview. Nothing was sent; read and prepare the intended change again.',
            );
        for (const field of ['submitted', 'status', 'submittedAt'] as const)
          if (fresh[field] !== app[field])
            throw new YCError(
              'PRECONDITION_FAILED',
              'Application submission state changed after preview. Nothing was sent.',
            );
        const forms = (await this.service.bridge.execute(
          { method: 'inspectEditability', appUuid: input.appUuid },
          signal,
        )) as EditDiscovery;
        this.allowed(
          fresh,
          forms,
          input.updateKind,
          changes.map((change) => change.field),
        );
      },
    );
    const output = {
      ...preview,
      changes,
      concurrency:
        'Current values and edit permissions are checked immediately before dispatch. YC provides no atomic compare-and-swap; a race after that check remains possible.',
    };
    this.plans.set(input.idempotencyKey, {
      inputDigest,
      input,
      baseline: app,
      preview: output,
      createdAt: Date.now(),
    });
    return structuredClone(output);
  }
  async verify(
    appUuid: string,
    expected: { field: string; value: string | null }[],
    signal?: AbortSignal,
  ) {
    verifyInput.parse({ appUuid, expected });
    if (new Set(expected.map((item) => item.field)).size !== expected.length)
      throw new YCError('DUPLICATE_FIELD', 'Each verification field may occur once.');
    const app = await this.read(appUuid, signal);
    const fields = expected.map((item) => {
      if (!Object.hasOwn(app.questions, item.field))
        throw new YCError(
          'FIELD_UNSUPPORTED',
          'A verification field is not returned by the application query.',
        );
      return {
        field: item.field,
        expected: item.value,
        actual: app.questions[item.field],
        matches: app.questions[item.field] === item.value,
      };
    });
    return {
      appUuid,
      verified: fields.every((item) => item.matches),
      verifiedAt: new Date().toISOString(),
      fields,
    };
  }
  async commit(receiptId: string, confirmDigest: string, signal?: AbortSignal) {
    const plan = this.plans.get(receiptId);
    if (!plan)
      throw new YCError(
        'PREVIEW_EXPIRED',
        'This process has no typed preview. Inspect its durable receipt; never replay an uncertain operation.',
      );
    const result = await this.service.commit(receiptId, confirmDigest, signal);
    if (result.error) throw new YCError(result.error.code, result.error.message, result);
    let verification;
    try {
      verification = await this.verify(
        plan.input.appUuid,
        plan.input.changes.map((change) => ({ field: change.field, value: change.value })),
        signal,
      );
    } catch {
      throw new YCError(
        'VERIFICATION_UNAVAILABLE',
        'The mutation receipt is terminal, but read-back failed. Do not resubmit; verify current answers separately.',
        { receipt: result.receipt },
      );
    }
    if (!verification.verified)
      throw new YCError(
        'POSTCONDITION_FAILED',
        'Read-back differs from the requested answers. No retry was made. Inspect the terminal receipt and current values.',
        { receipt: result.receipt, verification },
      );
    return { ...result, verification };
  }
  async export(appUuid: string, signal?: AbortSignal) {
    const app = await this.read(appUuid, signal);
    const blocks = Object.entries(app.questions)
      .filter(([, value]) => value !== null && value !== '')
      .map(
        ([field, value]) =>
          `## ${field}\n\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`,
      );
    const markdown = `# YC application\n\nApplication: ${app.uuid}\nStatus: ${app.status}\n\n${blocks.join('\n\n')}`;
    if (Buffer.byteLength(markdown) > 2_000_000)
      throw new YCError('RESPONSE_TOO_LARGE', 'The export exceeds 2 MB.');
    return { appUuid, exportedAt: new Date().toISOString(), markdown, privateAccountData: true };
  }
}
