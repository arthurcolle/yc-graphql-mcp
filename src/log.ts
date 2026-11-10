export type LogLevel = 'error' | 'warn' | 'info';
const rank = { error: 0, warn: 1, info: 2 };
/** Only explicitly selected operational metadata. Never log queries, variables, headers or provider errors. */
export class Logger {
  constructor(
    private level: LogLevel = 'warn',
    private write: (line: string) => void = (line) => {
      process.stderr.write(line);
    },
  ) {}
  event(
    level: LogLevel,
    event: string,
    fields: {
      code?: string;
      durationMs?: number;
      requestId?: string;
      tool?: string;
      mode?: string;
      version?: string;
    } = {},
  ) {
    if (rank[level] <= rank[this.level])
      this.write(
        JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }) + '\n',
      );
  }
}
