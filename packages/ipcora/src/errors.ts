/**
 * Typed error used by handlers and hooks to produce stable IPC error payloads.
 */
export class IpcError<TName extends string = string, TData = unknown> extends Error {
  readonly data?: TData;

  constructor(
    name: TName,
    options?: {
      message?: string;
      data?: TData;
      cause?: unknown;
    },
  ) {
    super(options?.message ?? name, { cause: options?.cause });
    this.name = name;
    this.data = options?.data;
  }
}

export interface IpcErrorOptions<TData = undefined> {
  message?: string;
  data?: TData;
  cause?: unknown;
}

export function fail<const TName extends string>(name: TName): IpcError<TName, undefined>;
export function fail<const TName extends string, const TMessage extends string>(
  name: TName,
  message: TMessage,
  options?: IpcErrorOptions<undefined>,
): IpcError<TName, undefined>;
export function fail<const TName extends string, const TData>(
  name: TName,
  options: IpcErrorOptions<TData>,
): IpcError<TName, TData>;
export function fail<const TName extends string, const TData>(
  name: TName,
  message: string,
  options: IpcErrorOptions<TData>,
): IpcError<TName, TData>;
export function fail(
  name: string,
  messageOrOptions?: string | IpcErrorOptions,
  options?: IpcErrorOptions,
): IpcError {
  const message =
    typeof messageOrOptions === 'string' ? messageOrOptions : messageOrOptions?.message;
  const resolvedOptions = typeof messageOrOptions === 'string' ? options : messageOrOptions;
  return new IpcError(name, {
    ...resolvedOptions,
    message: message ?? name,
  });
}
