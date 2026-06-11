/**
 * Typed error used by handlers and hooks to produce stable IPC error payloads.
 */
export class IpcError<
  TName extends string = string,
  TData = unknown,
  TStatus extends number = number,
> extends Error {
  readonly data?: TData;
  readonly status?: TStatus;

  constructor(
    name: TName,
    options?: {
      message?: string;
      data?: TData;
      cause?: unknown;
      status?: TStatus;
    },
  ) {
    super(options?.message ?? name, { cause: options?.cause });
    this.name = name;
    this.data = options?.data;
    this.status = options?.status;
  }
}

export interface IpcErrorOptions<TData = undefined, TStatus extends number = number> {
  message?: string;
  data?: TData;
  cause?: unknown;
  status?: TStatus;
}

export function fail<const TName extends string>(name: TName): IpcError<TName, undefined>;
export function fail<
  const TName extends string,
  const TMessage extends string,
  const TStatus extends number = number,
>(
  name: TName,
  message: TMessage,
  options?: IpcErrorOptions<undefined, TStatus>,
): IpcError<TName, undefined, TStatus>;
export function fail<
  const TName extends string,
  const TData,
  const TStatus extends number = number,
>(name: TName, options: IpcErrorOptions<TData, TStatus>): IpcError<TName, TData, TStatus>;
export function fail<
  const TName extends string,
  const TData,
  const TStatus extends number = number,
>(
  name: TName,
  message: string,
  options: IpcErrorOptions<TData, TStatus>,
): IpcError<TName, TData, TStatus>;
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
