import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { z } from 'zod';
import { YCError } from './errors.js';
import { inspectOperation, identifierPattern, YC_ORIGIN } from './graphql.js';
import {
  openPrivate,
  privateDirectory,
  readPrivate,
  syncDirectory,
  writePrivate,
} from './private-files.js';

export interface Operation {
  operationName: string;
  query: string;
  kind: 'query' | 'mutation';
  description: string;
}
export const receiptSchema = z.strictObject({
  id: z.string().length(36).uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}(?![\s\S])/),
  operationName: z.string().min(1).max(128).regex(identifierPattern),
  fields: z.array(z.string().min(1).max(100_000).regex(identifierPattern)).max(15_000),
  target: z.strictObject({
    connectionId: z.string().length(36).uuid(),
    origin: z.literal(YC_ORIGIN),
    tabId: z.number().int().nonnegative().optional(),
    transport: z.enum(['direct', 'browser']).optional(),
  }),
  status: z.enum([
    'prepared',
    'dispatched',
    'succeeded',
    'rejected',
    'unverified',
    'uncertain',
    'expired',
    'not_sent',
  ]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  errorCode: z.string().min(1).max(80).optional(),
  version: z.literal(2).optional(),
});
export type Receipt = z.infer<typeof receiptSchema>;
const transitions: Record<Receipt['status'], Receipt['status'][]> = {
  prepared: ['dispatched', 'expired'],
  dispatched: ['succeeded', 'rejected', 'unverified', 'uncertain', 'not_sent'],
  succeeded: [],
  rejected: [],
  unverified: [],
  uncertain: [],
  expired: [],
  not_sent: [],
};
const MAX_JOURNAL = 20_000_000,
  MAX_SNAPSHOT = 8_000_000,
  MAX_RECEIPTS = 10_000,
  MAX_LINE = 128_000;

export class StateStore {
  private lockPath: string;
  private lockFd: number | undefined;
  private journalFd: number | undefined;
  private operations = new Map<string, Operation>();
  private receipts = new Map<string, Receipt>();
  private closed = false;
  private poisoned = false;
  constructor(readonly directory: string) {
    privateDirectory(directory);
    this.lockPath = join(directory, 'server.lock');
    try {
      this.lockFd = openPrivate(
        this.lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new YCError(
          'STATE_LOCKED',
          'The state directory is locked. Use doctor to inspect it; only remove a stale lock after verifying its process has exited.',
        );
      throw error;
    }
    try {
      writeFileSync(
        this.lockFd,
        JSON.stringify({
          pid: process.pid,
          hostname: hostname(),
          instance: randomUUID(),
          startedAt: new Date().toISOString(),
        }),
      );
      fsyncSync(this.lockFd);
      syncDirectory(directory);
      try {
        const entries: unknown = JSON.parse(
          readPrivate(join(directory, 'operations.json'), 2_000_000),
        );
        if (!Array.isArray(entries) || entries.length > 100) throw new Error();
        for (const entry of entries) {
          if (!entry || typeof entry.description !== 'string' || entry.description.length > 1_000)
            throw new Error();
          const operation = inspectOperation(entry.query, entry.operationName);
          if (this.operations.has(operation.operationName)) throw new Error();
          this.operations.set(operation.operationName, {
            operationName: operation.operationName,
            query: operation.query,
            kind: operation.kind,
            description: entry.description,
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new YCError(
            'STATE_CORRUPT',
            'The operation registry is invalid or unsafe. Preserve the state directory before repair.',
          );
      }
      try {
        const source = readPrivate(join(directory, 'receipts.jsonl'), MAX_JOURNAL);
        if (source && !source.endsWith('\n'))
          throw new YCError(
            'STATE_CORRUPT',
            'Incomplete receipt journal. Preserve it; do not discard possibly dispatched mutations.',
          );
        for (const line of source.split('\n').filter(Boolean)) {
          if (Buffer.byteLength(line) > MAX_LINE) throw new Error();
          const parsed = receiptSchema.safeParse(JSON.parse(line));
          if (!parsed.success) throw new Error();
          this.validateTransition(parsed.data, true);
          this.receipts.set(parsed.data.id, parsed.data);
        }
        if (this.receipts.size > MAX_RECEIPTS) throw new Error();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          if (error instanceof YCError && error.code === 'STATE_CORRUPT') throw error;
          throw new YCError(
            'STATE_CORRUPT',
            'The receipt journal is invalid or unsafe. Preserve it before repair; deduplication must not be lost.',
          );
        }
      }
      this.journalFd = openPrivate(
        join(directory, 'receipts.jsonl'),
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
      );
      syncDirectory(directory);
      for (const receipt of [...this.receipts.values()]) {
        if (receipt.status === 'dispatched')
          this.record({
            ...receipt,
            status: 'uncertain',
            errorCode: 'SERVER_RESTARTED',
            updatedAt: new Date().toISOString(),
          });
        if (receipt.status === 'prepared')
          this.record({ ...receipt, status: 'expired', updatedAt: new Date().toISOString() });
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }
  private ensureOpen() {
    if (this.closed) throw new YCError('STATE_CLOSED', 'The state store is closed.');
  }
  private ensureWritable() {
    this.ensureOpen();
    if (this.poisoned)
      throw new YCError(
        'STATE_WRITE_FAILED',
        'A durable write failed. Stop this server and preserve the journal before recovery.',
      );
  }
  private validateTransition(next: Receipt, loading = false) {
    const previous = this.receipts.get(next.id);
    if (Date.parse(next.updatedAt) < Date.parse(next.createdAt))
      throw new YCError('STATE_CORRUPT', 'Invalid receipt timestamps.');
    if (!previous) {
      if (!loading && next.status !== 'prepared')
        throw new YCError('INVALID_RECEIPT_STATE', 'A new receipt must begin as prepared.');
      return;
    }
    const identity = (receipt: Receipt) =>
      JSON.stringify({
        digest: receipt.digest,
        operationName: receipt.operationName,
        fields: receipt.fields,
        target: receipt.target,
        createdAt: receipt.createdAt,
        version: receipt.version,
      });
    if (
      identity(next) !== identity(previous) ||
      Date.parse(next.updatedAt) < Date.parse(previous.updatedAt) ||
      (next.status !== previous.status && !transitions[previous.status].includes(next.status))
    )
      throw new YCError('STATE_CORRUPT', 'Invalid or conflicting receipt transition.');
    if (next.status === previous.status && JSON.stringify(next) !== JSON.stringify(previous))
      throw new YCError('STATE_CORRUPT', 'A receipt state cannot be rewritten in place.');
  }
  writeConnection(connection: { url: string; token: string }) {
    this.ensureWritable();
    writePrivate(join(this.directory, 'connection.json'), connection);
  }
  saveOperation(operation: Operation, replace = false) {
    this.ensureWritable();
    const inspected = inspectOperation(operation.query, operation.operationName);
    if (
      inspected.kind !== operation.kind ||
      typeof operation.description !== 'string' ||
      operation.description.length > 1_000
    )
      throw new YCError('INVALID_DOCUMENT', 'Invalid saved operation.');
    if (this.operations.has(operation.operationName) && !replace)
      throw new YCError(
        'OPERATION_EXISTS',
        'This operation already exists. Set replace: true to replace it.',
      );
    if (!this.operations.has(operation.operationName) && this.operations.size >= 100)
      throw new YCError('REGISTRY_FULL', 'The operation registry is limited to 100 entries.');
    const next = new Map(this.operations);
    next.set(operation.operationName, structuredClone(operation));
    if (Buffer.byteLength(JSON.stringify([...next.values()])) > 2_000_000)
      throw new YCError('REGISTRY_FULL', 'The operation registry exceeds 2 MB.');
    writePrivate(join(this.directory, 'operations.json'), [...next.values()]);
    this.operations = next;
    return structuredClone(operation);
  }
  listOperations() {
    this.ensureOpen();
    return [...this.operations.values()].map((operation) => structuredClone(operation));
  }
  getOperation(name: string) {
    this.ensureOpen();
    const operation = this.operations.get(name);
    if (!operation)
      throw new YCError(
        'OPERATION_NOT_FOUND',
        'Register an observed operation with this name first.',
      );
    return structuredClone(operation);
  }
  removeOperation(name: string) {
    this.ensureWritable();
    this.getOperation(name);
    const next = new Map(this.operations);
    next.delete(name);
    writePrivate(join(this.directory, 'operations.json'), [...next.values()]);
    this.operations = next;
    return { removed: name };
  }
  record(value: Receipt) {
    this.ensureWritable();
    const parsed = receiptSchema.safeParse(value);
    if (!parsed.success) throw new YCError('INVALID_RECEIPT_STATE', 'Receipt metadata is invalid.');
    const receipt = parsed.data;
    this.validateTransition(receipt);
    if (JSON.stringify(this.receipts.get(receipt.id)) === JSON.stringify(receipt))
      return structuredClone(receipt);
    const line = JSON.stringify(receipt) + '\n';
    if (Buffer.byteLength(line) > MAX_LINE)
      throw new YCError('STATE_CAPACITY', 'Mutation receipt exceeds the metadata size limit.');
    if (!this.receipts.has(receipt.id)) {
      const used = [...this.receipts.values()].reduce(
        (total, item) => total + Buffer.byteLength(JSON.stringify(item)) + 513,
        0,
      );
      if (this.receipts.size >= MAX_RECEIPTS || used + Buffer.byteLength(line) + 512 > MAX_SNAPSHOT)
        throw new YCError(
          'STATE_CAPACITY',
          'Receipt storage is full. Retain deduplication records; do not start another mutation in this state directory.',
        );
    }
    if (fstatSync(this.journalFd!).size + Buffer.byteLength(line) > MAX_JOURNAL / 2) this.compact();
    try {
      appendFileSync(this.journalFd!, line);
      fsyncSync(this.journalFd!);
    } catch {
      this.poisoned = true;
      throw new YCError(
        'STATE_WRITE_FAILED',
        'The receipt could not be durably written. Preserve the journal and restart only after inspection.',
      );
    }
    this.receipts.set(receipt.id, receipt);
    return structuredClone(receipt);
  }
  compact() {
    this.ensureWritable();
    const path = join(this.directory, 'receipts.jsonl');
    const temporary = join(this.directory, `.journal-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openPrivate(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      writeFileSync(
        fd,
        [...this.receipts.values()].map((receipt) => JSON.stringify(receipt) + '\n').join(''),
      );
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, path);
      syncDirectory(this.directory);
      closeSync(this.journalFd!);
      this.journalFd = undefined;
      this.journalFd = openPrivate(path, constants.O_WRONLY | constants.O_APPEND);
    } catch {
      this.poisoned = true;
      throw new YCError(
        'STATE_WRITE_FAILED',
        'Receipt compaction failed. Preserve the journal and inspect storage before restarting.',
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temporary);
      } catch {}
    }
  }
  getReceipt(id: string) {
    this.ensureOpen();
    const receipt = this.receipts.get(id);
    if (!receipt)
      throw new YCError('RECEIPT_NOT_FOUND', 'No mutation receipt exists with this ID.');
    return structuredClone(receipt);
  }
  listReceipts(limit = 20) {
    this.ensureOpen();
    return [...this.receipts.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((receipt) => structuredClone(receipt));
  }
  health() {
    return {
      writable: !this.closed && !this.poisoned,
      receipts: this.receipts.size,
      operations: this.operations.size,
      journalBytes: this.journalFd === undefined ? null : fstatSync(this.journalFd).size,
      receiptLimit: MAX_RECEIPTS,
    };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.journalFd !== undefined) {
      closeSync(this.journalFd);
      this.journalFd = undefined;
    }
    if (this.lockFd !== undefined) {
      const owned = fstatSync(this.lockFd);
      const same = () => {
        try {
          const now = lstatSync(this.lockPath);
          return now.ino === owned.ino && now.dev === owned.dev;
        } catch {
          return false;
        }
      };
      closeSync(this.lockFd);
      this.lockFd = undefined;
      if (same()) {
        try {
          unlinkSync(join(this.directory, 'connection.json'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        unlinkSync(this.lockPath);
        syncDirectory(this.directory);
      }
    }
  }
}
