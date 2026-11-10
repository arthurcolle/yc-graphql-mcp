import type { BrowserTask } from './protocol.js';

export interface ExecutionTarget {
  connectionId: string;
  origin: string;
  tabId?: number;
  transport?: 'direct' | 'browser';
  allowMutations: boolean;
}

export interface YCTransport {
  readonly mode: 'direct' | 'browser';
  execute(task: BrowserTask, signal?: AbortSignal, expectedConnectionId?: string): Promise<unknown>;
  currentTarget(): ExecutionTarget;
  status(): {
    connected: boolean;
    target: ExecutionTarget | null;
    pendingRequests: number;
    [key: string]: unknown;
  };
  connection(): Record<string, unknown>;
  close(): Promise<void>;
}
