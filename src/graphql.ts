import {
  Kind,
  parse,
  print,
  visit,
  type FieldNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from 'graphql';
import { YCError } from './errors.js';
import { assertJSON } from './json.js';

export const YC_ORIGIN = 'https://apply.ycombinator.com';
export const MAX_DOCUMENT = 100_000;
export const MAX_VARIABLES = 100_000;
export const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*(?![\s\S])/;

export interface GraphQLRequest {
  query: string;
  operationName: string;
  variables?: Record<string, unknown>;
}

export function inspectOperation(query: string, operationName: string) {
  if (typeof query !== 'string' || !query.trim() || query.length > MAX_DOCUMENT) {
    throw new YCError('INVALID_DOCUMENT', 'Supply a GraphQL document of 1–100,000 characters.');
  }
  if (
    typeof operationName !== 'string' ||
    !identifierPattern.test(operationName) ||
    operationName.length > 128
  ) {
    throw new YCError(
      'INVALID_OPERATION_NAME',
      'Supply a valid operationName of at most 128 characters.',
    );
  }
  let document;
  try {
    document = parse(query, { maxTokens: 15_000 });
  } catch {
    throw new YCError('INVALID_DOCUMENT', 'The GraphQL document could not be parsed.');
  }
  const operations = document.definitions.filter((d) => d.kind === Kind.OPERATION_DEFINITION);
  if (
    operations.length !== 1 ||
    document.definitions.some(
      (d) => d.kind !== Kind.OPERATION_DEFINITION && d.kind !== Kind.FRAGMENT_DEFINITION,
    )
  ) {
    throw new YCError(
      'INVALID_DOCUMENT',
      'Use exactly one named operation, with optional fragments.',
    );
  }
  const operation = operations[0] as OperationDefinitionNode;
  if (!operation.name || operation.name.value !== operationName) {
    throw new YCError('OPERATION_MISMATCH', 'operationName must match the single named operation.');
  }
  if (operation.operation === 'subscription')
    throw new YCError('SUBSCRIPTION_UNSUPPORTED', 'Only queries and mutations are supported.');
  const fragments = document.definitions.filter((d) => d.kind === Kind.FRAGMENT_DEFINITION);
  const names = new Set<string>();
  for (const fragment of fragments) {
    if (names.has(fragment.name.value))
      throw new YCError('INVALID_DOCUMENT', 'Duplicate fragment names are not allowed.');
    names.add(fragment.name.value);
  }
  // Bound fragment expansion and reject cycles before sending any request.
  const byName = new Map(fragments.map((f) => [f.name.value, f]));
  let expanded = 0;
  function walk(node: typeof operation | (typeof fragments)[number], stack: Set<string>) {
    if (stack.size > 64)
      throw new YCError('DOCUMENT_TOO_COMPLEX', 'GraphQL fragment depth exceeds the local limit.');
    let depth = 0;
    visit(node, {
      enter() {
        if (++expanded > 20_000 || ++depth > 128)
          throw new YCError(
            'DOCUMENT_TOO_COMPLEX',
            'GraphQL depth or expansion exceeds the local limit.',
          );
      },
      leave() {
        depth--;
      },
      FragmentSpread(spread) {
        const name = spread.name.value;
        const fragment = byName.get(name);
        if (!fragment || stack.has(name))
          throw new YCError('INVALID_DOCUMENT', 'Undefined or cyclic fragment.');
        walk(fragment, new Set([...stack, name]));
      },
    });
  }
  walk(operation, new Set());
  // Even unused fragments must not contain undefined spreads or cycles.
  for (const fragment of fragments) walk(fragment, new Set([fragment.name.value]));
  const fields = new Set<string>();
  visit(document, {
    Field(node) {
      fields.add(node.name.value);
    },
  });
  function selectedFields(selection: SelectionSetNode, depth = 0): FieldNode[] {
    if (depth > 128)
      throw new YCError(
        'DOCUMENT_TOO_COMPLEX',
        'GraphQL root selection depth exceeds the local limit.',
      );
    const selected: FieldNode[] = [];
    for (const node of selection.selections) {
      if (node.kind === Kind.FIELD) selected.push(node);
      else if (node.kind === Kind.INLINE_FRAGMENT)
        selected.push(...selectedFields(node.selectionSet, depth + 1));
      else selected.push(...selectedFields(byName.get(node.name.value)!.selectionSet, depth + 1));
    }
    return selected;
  }
  const roots = new Map<
    string,
    {
      name: string;
      responseKey: string;
      selection: { name: string; responseKey: string }[];
    }
  >();
  for (const node of selectedFields(operation.selectionSet)) {
    const responseKey = node.alias?.value ?? node.name.value;
    const key = node.name.value + ':' + responseKey;
    const root = roots.get(key) ?? { name: node.name.value, responseKey, selection: [] };
    root.selection.push(
      ...(node.selectionSet ? selectedFields(node.selectionSet) : []).map((field) => ({
        name: field.name.value,
        responseKey: field.alias?.value ?? field.name.value,
      })),
    );
    roots.set(key, root);
  }
  const rootFields = [...roots.values()];
  const normalized = print(document);
  if (normalized.length > MAX_DOCUMENT)
    throw new YCError(
      'DOCUMENT_TOO_COMPLEX',
      'Normalized GraphQL document exceeds the size limit.',
    );
  return {
    kind: operation.operation as 'query' | 'mutation',
    operationName,
    query: normalized,
    fields: [...fields],
    rootFields,
  };
}

export function normalizeRequest(request: GraphQLRequest) {
  const operation = inspectOperation(request.query, request.operationName);
  const variables = request.variables ?? {};
  if (!variables || typeof variables !== 'object' || Array.isArray(variables))
    throw new YCError('INVALID_VARIABLES', 'variables must be a JSON object.');
  assertJSON(variables);
  const serialized = JSON.stringify(variables);
  if (new TextEncoder().encode(serialized).byteLength > MAX_VARIABLES)
    throw new YCError('INVALID_VARIABLES', 'variables exceed 100,000 UTF-8 bytes.');
  const cloned = JSON.parse(serialized) as Record<string, unknown>;
  return { ...operation, variables: cloned };
}

export const ROOTS_QUERY =
  'query YCSchemaRoots { __schema { queryType { name } mutationType { name } subscriptionType { name } } }';
const typeRef = (depth: number): string =>
  `kind name${depth ? ` ofType { ${typeRef(depth - 1)} }` : ''}`;
export const TYPE_QUERY = `query YCDescribeType($name: String!, $includeDeprecated: Boolean!) {
  __type(name: $name) {
    name kind description
    fields(includeDeprecated: $includeDeprecated) { name description isDeprecated deprecationReason args { name description defaultValue type { ${typeRef(8)} } } type { ${typeRef(8)} } }
    inputFields { name description defaultValue type { ${typeRef(8)} } }
    enumValues(includeDeprecated: $includeDeprecated) { name description isDeprecated deprecationReason }
    interfaces { kind name } possibleTypes { kind name }
  }
}`;
