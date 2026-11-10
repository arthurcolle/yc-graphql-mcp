import { z } from 'zod';
import { identifierPattern } from './graphql.js';

export const identifier = z.string().min(1).max(128).regex(identifierPattern);
export const uuid = z.string().length(36).uuid();
export const variablesSchema = z.record(z.string(), z.unknown()).default({});
export const requestSchema = z.strictObject({
  query: z.string().min(1).max(100_000),
  operationName: identifier,
  variables: variablesSchema,
});
export const inspectSchema = z.strictObject({
  terms: z.array(z.string().min(1).max(100)).min(1).max(10).optional(),
  maxScripts: z.number().int().min(1).max(30).default(20),
  maxHitsPerTerm: z.number().int().min(1).max(5).default(3),
});
export const taskSchema = z.discriminatedUnion('method', [
  z.strictObject({
    method: z.literal('request'),
    input: requestSchema.extend({ allowMutation: z.boolean().default(false) }),
  }),
  z.strictObject({ method: z.literal('describeSchema') }),
  z.strictObject({
    method: z.literal('describeType'),
    name: identifier,
    includeDeprecated: z.boolean(),
  }),
  z.strictObject({ method: z.literal('introspectSchema') }),
  z.strictObject({ method: z.literal('inspectLoadedScripts'), input: inspectSchema }),
  z.strictObject({ method: z.literal('inspectEditability'), appUuid: uuid }),
]);
export type BrowserTask = z.infer<typeof taskSchema>;
export const helloSchema = z.strictObject({
  type: z.literal('hello'),
  version: z.literal(1),
  token: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]+(?![\s\S])/),
  tabId: z.number().int().nonnegative(),
  origin: z.literal('https://apply.ycombinator.com'),
  allowMutations: z.boolean(),
});
export const replySchema = z.discriminatedUnion('ok', [
  z.strictObject({
    type: z.literal('result'),
    id: uuid,
    ok: z.literal(true),
    data: z.unknown(),
  }),
  z.strictObject({
    type: z.literal('result'),
    id: uuid,
    ok: z.literal(false),
    error: z.strictObject({ code: z.string().min(1).max(80), message: z.string().max(500) }),
  }),
]);
