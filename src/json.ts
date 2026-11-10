import { YCError } from './errors.js';

/** Validate before serialization: no lossy values, accessors, custom prototypes or deep graphs. */
export function assertJSON(
  value: unknown,
  code = 'INVALID_VARIABLES',
  maxDepth = 20,
  maxNodes = 10_000,
): void {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > maxNodes || item.depth > maxDepth)
      throw new YCError(code, 'JSON exceeds the nesting or node limit.');
    const entry = item.value;
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') continue;
    if (typeof entry === 'number' && Number.isFinite(entry)) continue;
    if (
      !entry ||
      typeof entry !== 'object' ||
      (!Array.isArray(entry) &&
        Object.getPrototypeOf(entry) !== Object.prototype &&
        Object.getPrototypeOf(entry) !== null)
    )
      throw new YCError(code, 'Only finite JSON values are supported.');
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(entry) && key === 'length') continue;
      if (descriptor.get || descriptor.set || !descriptor.enumerable)
        throw new YCError(code, 'Only ordinary JSON properties are supported.');
      pending.push({ value: descriptor.value, depth: item.depth + 1 });
    }
    if (Object.getOwnPropertySymbols(entry).length)
      throw new YCError(code, 'JSON properties must have string keys.');
  }
}

export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) + ':' + canonicalJSON((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
