/**
 * Typed error used by handlers and hooks to produce stable IPC error payloads.
 */
export class IpcError<TCode extends string = string, TData = unknown> extends Error {
  readonly code: TCode;
  readonly data?: TData;
  readonly status?: number;

  constructor(
    code: TCode,
    options?: {
      message?: string;
      data?: TData;
      cause?: unknown;
      status?: number;
    },
  ) {
    super(options?.message ?? code, { cause: options?.cause });
    this.name = 'IpcError';
    this.code = code;
    this.data = options?.data;
    this.status = options?.status;
  }
}

/**
 * Convenience factory exposed on every lifecycle context as `error`.
 */
export function createIpcError<const TCode extends string, TData = undefined>(
  code: TCode,
  options?: {
    message?: string;
    data?: TData;
    cause?: unknown;
    status?: number;
  },
): IpcError<TCode, TData> {
  return new IpcError(code, options);
}
