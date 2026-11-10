export class YCError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'YCError';
  }
}

export function errorInfo(error: unknown): { code: string; message: string } {
  if (error instanceof YCError) return { code: error.code, message: error.message };
  return {
    code: 'INTERNAL_ERROR',
    message: 'The operation failed. Check the local server setup; no automatic retry was made.',
  };
}
