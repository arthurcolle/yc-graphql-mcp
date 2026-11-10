import { createHash } from 'node:crypto';
import type { YCTransport } from './transport.js';
import { YCError } from './errors.js';
import { normalizeRequest, YC_ORIGIN, type GraphQLRequest } from './graphql.js';
import { StateStore, type Receipt } from './store.js';
import { canonicalJSON } from './json.js';
import { mutationOutcome } from './mutation-outcome.js';

export class YCService {
  private prepared = new Map<string, ReturnType<typeof normalizeRequest>>();
  private active = new Set<Promise<unknown>>();
  private closing = false;
  private guards = new Map<string, (signal?: AbortSignal) => Promise<void>>();
  private guardedCommits = new Set<string>();
  constructor(
    readonly bridge: YCTransport,
    readonly store: StateStore,
    readonly allowMutations = false,
  ) {}
  private track<T>(work: Promise<T>): Promise<T> {
    this.active.add(work);
    void work.then(
      () => {
        this.active.delete(work);
      },
      () => {
        this.active.delete(work);
      },
    );
    return work;
  }
  async shutdown() {
    this.closing = true;
    await this.bridge.close();
    await Promise.allSettled([...this.active]);
  }
  status() {
    return {
      ...this.bridge.status(),
      serverMutationsEnabled: this.allowMutations,
      stateDirectory: this.store.directory,
      storage: this.store.health(),
    };
  }
  async query(input: GraphQLRequest, signal?: AbortSignal) {
    if (this.closing) throw new YCError('SERVER_STOPPED', 'The server is shutting down.');
    const operation = normalizeRequest(input);
    if (operation.kind !== 'query')
      throw new YCError(
        'MUTATION_BLOCKED',
        'Use yc_prepare_mutation and yc_commit_mutation for changes.',
      );
    return this.track(
      this.bridge.execute(
        {
          method: 'request',
          input: {
            query: operation.query,
            operationName: operation.operationName,
            variables: operation.variables,
            allowMutation: false,
          },
        },
        signal,
      ),
    );
  }
  prepare(input: GraphQLRequest & { idempotencyKey: string }) {
    if (this.closing) throw new YCError('SERVER_STOPPED', 'The server is shutting down.');
    if (!this.allowMutations)
      throw new YCError(
        'MUTATION_BLOCKED',
        'Restart the MCP server with --allow-mutations to prepare changes.',
      );
    for (const id of this.prepared.keys()) {
      const stale = this.store.getReceipt(id);
      if (Date.now() - Date.parse(stale.createdAt) > 600_000) {
        this.store.record({ ...stale, status: 'expired', updatedAt: new Date().toISOString() });
        this.prepared.delete(id);
        this.guards.delete(id);
      }
    }
    const operation = normalizeRequest(input);
    if (operation.kind !== 'mutation')
      throw new YCError('QUERY_REQUIRED_ELSEWHERE', 'Use yc_query for queries.');
    const digest = createHash('sha256')
      .update(
        canonicalJSON({
          query: operation.query,
          operationName: operation.operationName,
          variables: operation.variables,
        }),
      )
      .digest('hex');
    let existing: Receipt | undefined;
    try {
      existing = this.store.getReceipt(input.idempotencyKey);
    } catch (error) {
      if (!(error instanceof YCError) || error.code !== 'RECEIPT_NOT_FOUND') throw error;
    }
    if (existing) {
      if (existing.digest !== digest)
        throw new YCError(
          'IDEMPOTENCY_CONFLICT',
          'This idempotencyKey is already bound to different mutation parameters.',
        );
      return { receipt: existing, preview: operation, expiresInSeconds: 600, replay: true };
    }
    if (this.prepared.size >= 100)
      throw new YCError(
        'PREVIEW_LIMIT',
        'There are 100 outstanding previews. Commit a reviewed change or wait for older previews to expire.',
      );
    const target = this.bridge.currentTarget();
    if (target.origin !== YC_ORIGIN)
      throw new YCError(
        'WRONG_ORIGIN',
        'The authenticated target must be the YC application origin.',
      );
    if (!target.allowMutations)
      throw new YCError(
        'MUTATION_BLOCKED',
        'Enable mutations for the selected transport before preparing changes.',
      );
    const timestamp = new Date().toISOString();
    const receipt = this.store.record({
      id: input.idempotencyKey,
      digest,
      operationName: operation.operationName,
      fields: operation.fields,
      target: {
        connectionId: target.connectionId,
        origin: YC_ORIGIN,
        ...(target.tabId !== undefined ? { tabId: target.tabId } : {}),
        ...(target.transport ? { transport: target.transport } : {}),
      },
      status: 'prepared',
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 2,
    });
    this.prepared.set(receipt.id, structuredClone(operation));
    return { receipt, preview: structuredClone(operation), expiresInSeconds: 600, replay: false };
  }
  commit(id: string, confirmDigest: string, signal?: AbortSignal) {
    if (this.guardedCommits.has(id))
      return Promise.reject(
        new YCError('BRIDGE_BUSY', 'This guarded commit is already in progress.'),
      );
    if (!this.guards.has(id)) return this.track(this.commitInternal(id, confirmDigest, signal));
    this.guardedCommits.add(id);
    return this.track(
      this.commitInternal(id, confirmDigest, signal).finally(() => {
        this.guardedCommits.delete(id);
        if (this.store.getReceipt(id).status !== 'prepared') this.guards.delete(id);
      }),
    );
  }
  prepareGuarded(
    input: GraphQLRequest & { idempotencyKey: string },
    guard: (signal?: AbortSignal) => Promise<void>,
  ) {
    const result = this.prepare(input);
    if (result.replay)
      throw new YCError(
        'IDEMPOTENCY_CONFLICT',
        'This key already belongs to a prepared or completed operation. Use its original workflow.',
      );
    this.guards.set(result.receipt.id, guard);
    return result;
  }
  private async commitInternal(id: string, confirmDigest: string, signal?: AbortSignal) {
    if (this.closing) throw new YCError('SERVER_STOPPED', 'The server is shutting down.');
    if (!this.allowMutations)
      throw new YCError('MUTATION_BLOCKED', 'Mutations are disabled on the server.');
    let receipt = this.store.getReceipt(id);
    if (receipt.digest !== confirmDigest)
      throw new YCError('DIGEST_MISMATCH', 'confirmDigest does not match the exact preview.');
    if (receipt.status === 'succeeded')
      return receipt.version === 2
        ? { receipt, replay: true, data: null }
        : {
            receipt,
            replay: true,
            data: null,
            error: {
              code: 'MUTATION_UNVERIFIED',
              message:
                'This legacy receipt confirmed only a GraphQL envelope. It will not be replayed. Read back the application to verify the historical change.',
            },
          };
    if (
      receipt.status === 'rejected' ||
      receipt.status === 'unverified' ||
      receipt.status === 'not_sent'
    )
      return {
        receipt,
        replay: true,
        data: null,
        error: {
          code:
            receipt.status === 'rejected'
              ? 'MUTATION_REJECTED'
              : receipt.status === 'not_sent'
                ? 'MUTATION_NOT_SENT'
                : 'MUTATION_UNVERIFIED',
          message:
            'This receipt is terminal and will not be dispatched again. Read the application before deciding whether another change is needed.',
        },
      };
    if (receipt.status === 'uncertain' || receipt.status === 'dispatched') {
      return {
        receipt,
        replay: true,
        data: null,
        error: {
          code: 'MUTATION_UNCERTAIN',
          message:
            'This mutation was already dispatched and its outcome is uncertain. Do not retry. Query the application first.',
        },
      };
    }
    if (receipt.status === 'expired')
      return {
        receipt,
        replay: true,
        data: null,
        error: {
          code: 'PREVIEW_EXPIRED',
          message:
            'This preview expired. Read the application and prepare a fresh authorized change.',
        },
      };
    const operation = this.prepared.get(id);
    if (!operation || Date.now() - Date.parse(receipt.createdAt) > 600_000) {
      receipt = this.store.record({
        ...receipt,
        status: 'expired',
        updatedAt: new Date().toISOString(),
      });
      this.prepared.delete(id);
      throw new YCError('PREVIEW_EXPIRED', 'Prepare a fresh preview with a new idempotencyKey.');
    }
    const guard = this.guards.get(id);
    if (guard) await guard(signal);
    if (this.closing) throw new YCError('SERVER_STOPPED', 'The server is shutting down.');
    const target = this.bridge.currentTarget();
    const currentDigest = createHash('sha256')
      .update(
        canonicalJSON({
          query: operation.query,
          operationName: operation.operationName,
          variables: operation.variables,
        }),
      )
      .digest('hex');
    if (currentDigest !== receipt.digest)
      throw new YCError(
        'DIGEST_MISMATCH',
        'The prepared payload no longer matches its immutable digest.',
      );
    if (
      target.connectionId !== receipt.target.connectionId ||
      target.tabId !== receipt.target.tabId
    )
      throw new YCError(
        'TARGET_CHANGED',
        'The authenticated session or browser pairing changed after preview. Prepare a new preview.',
      );
    if (!target.allowMutations)
      throw new YCError('MUTATION_BLOCKED', 'Mutations are disabled for the selected transport.');
    if (signal?.aborted) throw new YCError('CANCELLED', 'Mutation cancelled before dispatch.');
    if (this.bridge.status().pendingRequests)
      throw new YCError('BRIDGE_BUSY', 'Wait for the current request before committing.');
    receipt = this.store.record({
      ...receipt,
      status: 'dispatched',
      updatedAt: new Date().toISOString(),
    });
    this.prepared.delete(id);
    try {
      const data = await this.bridge.execute(
        {
          method: 'request',
          input: {
            query: operation.query,
            operationName: operation.operationName,
            variables: operation.variables,
            allowMutation: true,
          },
        },
        signal,
        target.connectionId,
      );
      const outcome = mutationOutcome(data, operation.rootFields);
      receipt = this.store.record({
        ...receipt,
        status: outcome,
        updatedAt: new Date().toISOString(),
      });
      return {
        receipt,
        replay: false,
        data,
        ...(outcome === 'succeeded'
          ? {}
          : {
              error: {
                code: outcome === 'rejected' ? 'MUTATION_REJECTED' : 'MUTATION_UNVERIFIED',
                message:
                  outcome === 'rejected'
                    ? 'YC reported rejection or no persistence. No retry was made; read back the application.'
                    : 'YC did not provide a verifiable mutation result. Do not assume it was saved. Read back the application before further changes.',
              },
            }),
      };
    } catch (error) {
      const errorCode = error instanceof YCError ? error.code : 'INTERNAL_ERROR';
      if (errorCode.startsWith('STATE_') || this.store.getReceipt(id).status !== 'dispatched')
        throw new YCError(
          'STATE_WRITE_FAILED',
          'A mutation response could not be recorded reliably. Preserve the receipt and read the application; do not retry.',
          { receipt: this.store.getReceipt(id) },
        );
      try {
        receipt = this.store.record({
          ...receipt,
          status: errorCode === 'TARGET_CHANGED' ? 'not_sent' : 'uncertain',
          errorCode,
          updatedAt: new Date().toISOString(),
        });
      } catch {
        throw new YCError(
          'STATE_WRITE_FAILED',
          'The mutation outcome could not be durably recorded. Preserve this receipt and read the application before further changes.',
          { receipt: this.store.getReceipt(id) },
        );
      }
      // A receipt accompanies every dispatched outcome, including failure.
      return {
        receipt,
        replay: false,
        data: null,
        error: {
          code: errorCode === 'TARGET_CHANGED' ? 'MUTATION_NOT_SENT' : 'MUTATION_UNCERTAIN',
          message:
            errorCode === 'TARGET_CHANGED'
              ? 'Authentication changed before dispatch. This receipt will not be sent; prepare a fresh preview.'
              : 'The mutation may have taken effect. Do not retry. Query the application and inspect this receipt.',
        },
      };
    }
  }
}
