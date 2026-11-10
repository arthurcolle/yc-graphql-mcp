export function mutationOutcome(
  data: unknown,
  roots: {
    name: string;
    responseKey: string;
    selection: { name: string; responseKey: string }[];
  }[],
): 'succeeded' | 'rejected' | 'unverified' {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !roots.length)
    return 'unverified';
  let verified = true;
  for (const root of roots) {
    const value = (data as Record<string, unknown>)[root.responseKey];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      verified = false;
      continue;
    }
    const result = value as Record<string, unknown>;
    const values = (name: string) =>
      root.selection
        .filter((field) => field.name === name)
        .map((field) => result[field.responseKey]);
    const successes = values('success');
    const persisted = values('persisted');
    const errors = values('errors');
    if (
      successes.includes(false) ||
      persisted.includes(false) ||
      errors.some((value) => Array.isArray(value) && value.length > 0)
    )
      return 'rejected';
    if (
      !successes.length ||
      successes.some((value) => value !== true) ||
      persisted.some((value) => value !== undefined && value !== null && value !== true) ||
      errors.some((value) => value !== undefined && value !== null && !Array.isArray(value))
    )
      verified = false;
    const entity = root.name === 'updateApp' ? 'app' : root.name === 'updateBio' ? 'bio' : null;
    if (
      entity &&
      values(entity).some((value) => !value || typeof value !== 'object' || Array.isArray(value))
    )
      verified = false;
  }
  return verified ? 'succeeded' : 'unverified';
}
