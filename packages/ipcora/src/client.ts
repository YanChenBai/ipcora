import type { EventDefinition } from './types';

type AnyFunction = (...args: any[]) => any;
type Expand<T> = { [K in keyof T]: T[K] } & {};
export type InferDefinition<T extends { readonly definition: object }> = T['definition'];
type ResultOf<T> =
  Awaited<T> extends { data: unknown; error: unknown }
    ? Awaited<T>
    : { data: Awaited<T>; error: null };

export type ClientMetadata = Record<string, unknown>;
export type Unsubscribe = () => void;
export type EventListener<TPayload> = (payload: TPayload) => void;
export interface EventSubscriber<TPayload> {
  (listener: EventListener<TPayload>): Unsubscribe;
}
type EventDefinitionLike<TPayload = unknown> = EventDefinition<string, TPayload> & {
  readonly __ipcoraEvent: true;
  readonly name: string;
  readonly channel: string;
  readonly once: boolean;
  readonly payload: TPayload;
};

export type InvokeClient<T> = T extends AnyFunction
  ? Parameters<T> extends []
    ? () => Promise<ResultOf<ReturnType<T>>>
    : (...args: [...Parameters<T>, metadata?: ClientMetadata]) => Promise<ResultOf<ReturnType<T>>>
  : T extends EventDefinitionLike
    ? never
    : T extends object
      ? {
          [K in keyof T as T[K] extends EventDefinitionLike ? never : K]: InvokeClient<T[K]>;
        }
      : never;

export type EventClient<T> = T extends object
  ? {
      [K in keyof T]: T[K] extends EventDefinitionLike
        ? T[K] extends { readonly payload: infer TPayload }
          ? EventSubscriber<TPayload>
          : never
        : T[K] extends object
          ? EventClient<T[K]>
          : never;
    }
  : never;

export interface Client<T> {
  invoke: Expand<InvokeClient<T>>;
  event: Expand<EventClient<T>>;
}

export interface ClientCall {
  /**
   * Full path segments.
   *
   * @example ["window", "raw", "move"]
   */
  path: string[];

  /**
   * Joined IPC channel name.
   *
   * @example "window.raw.move"
   */
  channel: string;

  /**
   * Namespace containing the method.
   *
   * @example "window.raw"
   */
  namespace: string;

  /**
   * Final method name being called.
   *
   * @example "move"
   */
  method: string;

  /**
   * Call arguments (params only, metadata is separated by the proxy).
   */
  args: unknown[];

  /**
   * Merged metadata. The proxy resolves this from static config,
   * the `onMetadata` hook, and per-call metadata before invoking.
   */
  metadata?: Record<string, unknown>;
}

type MetadataHook = (
  call: Omit<ClientCall, 'metadata'>,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

export interface CreateClientOptions {
  invoke(call: ClientCall): unknown | Promise<unknown>;
  subscribe?(call: ClientSubscription): Unsubscribe;

  /**
   * IPC channel prefix used to compute event subscription channels.
   * Must match the `channel` passed to the server-side `createIpcora({ channel })`.
   *
   * @default 'ipcora:invoke'
   */
  channel?: string;

  /** Static metadata merged into every call (lowest priority). */
  metadata?: Record<string, unknown>;

  /** Per-call hook that returns dynamic metadata (overrides static, overridden by per-call). */
  onMetadata?: MetadataHook;
}

export interface ClientSubscription {
  event: string;
  channel: string;
  once: boolean;
  listener: (payload: unknown) => void;
}

export function createClient<TDefinition extends object = never>(
  options: CreateClientOptions,
): Client<TDefinition> {
  return {
    invoke: createInvokeProxy({
      path: [],
      invoke: options.invoke,
      staticMetadata: options.metadata,
      onMetadata: options.onMetadata,
    }),
    event: createEventProxy({
      path: [],
      subscribe: options.subscribe,
      channel: options.channel ?? 'ipcora:invoke',
    }),
  } as Client<TDefinition>;
}

interface InvokeProxyContext {
  path: string[];
  invoke: CreateClientOptions['invoke'];
  staticMetadata?: Record<string, unknown>;
  onMetadata?: MetadataHook;
}

interface EventProxyContext {
  path: string[];
  subscribe?: CreateClientOptions['subscribe'];
  channel: string;
}

function createInvokeProxy(context: InvokeProxyContext): unknown {
  const target = function clientProxyTarget() {};

  return new Proxy(target, {
    get(_target, property) {
      if (property === 'then') {
        return undefined;
      }

      if (property === Symbol.toStringTag) {
        return 'IpcoraClient';
      }

      if (property === Symbol.for('nodejs.util.inspect.custom')) {
        return () => {
          const channel = context.path.join('.');

          return channel ? `[IpcoraClient ${channel}]` : '[IpcoraClient]';
        };
      }

      if (typeof property !== 'string') {
        return undefined;
      }

      return createInvokeProxy({
        path: [...context.path, property],
        invoke: context.invoke,
        staticMetadata: context.staticMetadata,
        onMetadata: context.onMetadata,
      });
    },

    apply(_target, _thisArg, args) {
      if (context.path.length === 0) {
        throw new TypeError('The root client cannot be called directly');
      }

      const method = context.path.at(-1)!;
      const namespace = context.path.slice(0, -1).join('.');
      const channel = context.path.join('.');

      let callArgs: unknown[];
      let perCallMetadata: Record<string, unknown> | undefined;

      perCallMetadata =
        args.length > 1 && isPlainObject(args.at(-1))
          ? (args.at(-1) as Record<string, unknown>)
          : undefined;
      callArgs = perCallMetadata ? args.slice(0, -1) : [...args];

      const call: ClientCall = {
        path: [...context.path],
        channel,
        namespace,
        method,
        args: callArgs,
      };

      return resolveMetadata(context, call, perCallMetadata).then(mergedMetadata => {
        if (mergedMetadata) {
          call.metadata = mergedMetadata;
        }
        return Promise.resolve(context.invoke(call)).then(normalizeResult);
      });
    },
  });
}

function createEventSubscriber(
  eventMethod: string,
  subscribe: CreateClientOptions['subscribe'],
  ipcChannel: string,
): (listener: (payload: unknown) => void) => Unsubscribe {
  return listener => {
    if (!subscribe) {
      throw new TypeError('Client subscribe adapter is required for IPC events');
    }

    const { event, channel, once } = parseEventMethod(eventMethod, ipcChannel);
    let unsubscribe: Unsubscribe = () => {};
    const wrappedListener = once
      ? (payload: unknown) => {
          unsubscribe();
          listener(payload);
        }
      : listener;

    unsubscribe = subscribe({
      event,
      channel,
      once,
      listener: wrappedListener,
    });
    return unsubscribe;
  };
}

function createEventProxy(context: EventProxyContext): unknown {
  const target = function clientEventProxyTarget() {};

  return new Proxy(target, {
    get(_target, property) {
      if (property === 'then') {
        return undefined;
      }

      if (property === Symbol.toStringTag) {
        return 'IpcoraEventClient';
      }

      if (typeof property !== 'string') {
        return undefined;
      }

      const path = [...context.path, property];
      if (isEventMethod(property)) {
        return createEventSubscriber(path.join('.'), context.subscribe, context.channel);
      }

      return createEventProxy({
        path,
        subscribe: context.subscribe,
        channel: context.channel,
      });
    },

    apply() {
      throw new TypeError(
        `"${formatPath(context.path)}" is an event namespace and cannot be called`,
      );
    },
  });
}

function isEventMethod(value: string): boolean {
  return /^on(?:Once)?[A-Z]/.test(value);
}

function parseEventMethod(
  eventMethod: string,
  ipcChannel: string,
): {
  event: string;
  channel: string;
  once: boolean;
} {
  const segments = eventMethod.split('.');
  const method = segments.at(-1)!;
  const once = method.startsWith('onOnce');
  const prefixLength = once ? 'onOnce'.length : 'on'.length;
  const eventName = uncapitalize(method.slice(prefixLength));
  const namespace = segments.slice(0, -1).join('.');
  const event = namespace ? `${namespace}.${eventName}` : eventName;

  return {
    event,
    channel: `${ipcChannel}:event:${event}`,
    once,
  };
}

function normalizeResult(value: unknown): { data: unknown; error: unknown } {
  if (isResult(value)) return value;

  if (isWireResponse(value)) {
    return 'error' in value
      ? { data: null, error: value.error }
      : { data: value.data, error: null };
  }

  return { data: value, error: null };
}

function isWireResponse(
  value: unknown,
): value is { data: unknown; error?: undefined } | { data?: undefined; error: unknown } {
  return value !== null && typeof value === 'object' && ('data' in value || 'error' in value);
}

function isResult(value: unknown): value is { data: unknown; error: unknown } {
  return value !== null && typeof value === 'object' && 'data' in value && 'error' in value;
}

function formatPath(path: string[]): string {
  return path.length > 0 ? path.join('.') : '<root>';
}

function uncapitalize(value: string): string {
  return value.length > 0 ? `${value[0]!.toLowerCase()}${value.slice(1)}` : value;
}

async function resolveMetadata(
  context: InvokeProxyContext,
  call: Omit<ClientCall, 'metadata'>,
  perCallMetadata?: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  // Start with static metadata (lowest priority)
  let merged: Record<string, unknown> = { ...context.staticMetadata };

  // Apply onMetadata hook if configured
  if (context.onMetadata) {
    const hookResult = await context.onMetadata(call);
    if (hookResult && typeof hookResult === 'object') {
      merged = { ...merged, ...hookResult };
    }
  }

  // Apply per-call metadata (highest priority)
  if (perCallMetadata) {
    merged = { ...merged, ...perCallMetadata };
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
