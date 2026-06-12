import type { EventDefinition } from './types';

type AnyFunction = (...args: any[]) => any;
type NoInferType<T> = [T][T extends any ? 0 : never];
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
    ? (metadata?: ClientMetadata) => Promise<ResultOf<ReturnType<T>>>
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
      [K in keyof T as T[K] extends EventDefinitionLike ? K : never]: T[K] extends {
        readonly payload: infer TPayload;
      }
        ? EventSubscriber<TPayload>
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
  definition: NoInferType<TDefinition>,
  options: CreateClientOptions,
): Client<TDefinition> {
  return {
    invoke: createInvokeProxy({
      node: definition,
      path: [],
      invoke: options.invoke,
      staticMetadata: options.metadata,
      onMetadata: options.onMetadata,
    }),
    event: createEventProxy({
      node: definition,
      path: [],
      subscribe: options.subscribe,
    }),
  } as Client<TDefinition>;
}

interface InvokeProxyContext {
  node: unknown;
  path: string[];
  invoke: CreateClientOptions['invoke'];
  staticMetadata?: Record<string, unknown>;
  onMetadata?: MetadataHook;
}

interface EventProxyContext {
  node: unknown;
  path: string[];
  subscribe?: CreateClientOptions['subscribe'];
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

      if (!isNamespaceNode(context.node)) {
        throw new TypeError(`"${formatPath(context.path)}" is not a namespace`);
      }

      if (!(property in context.node)) {
        throw new TypeError(`Unknown client path: "${formatPath([...context.path, property])}"`);
      }

      const childNode = Reflect.get(context.node, property);

      if (isEventDefinition(childNode)) {
        throw new TypeError(`"${formatPath([...context.path, property])}" is an IPC event`);
      }

      return createInvokeProxy({
        node: childNode,
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

      if (typeof context.node !== 'function') {
        throw new TypeError(`"${formatPath(context.path)}" is a namespace and cannot be called`);
      }

      const method = context.path.at(-1)!;
      const namespace = context.path.slice(0, -1).join('.');
      const channel = context.path.join('.');

      // Determine whether this route expects params by checking
      // the placeholder function's arity (set by Ipcora.assignRouteDefinition).
      const hasParams = (context.node as Function).length > 0;

      let callArgs: unknown[];
      let perCallMetadata: Record<string, unknown> | undefined;

      if (hasParams) {
        // (params, metadata?)
        callArgs = args.length > 0 ? [args[0]] : [undefined];
        perCallMetadata =
          args.length > 1 && isPlainObject(args[1])
            ? (args[1] as Record<string, unknown>)
            : undefined;
      } else {
        // (metadata?)
        callArgs = [];
        perCallMetadata =
          args.length > 0 && isPlainObject(args[0])
            ? (args[0] as Record<string, unknown>)
            : undefined;
      }

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
  definition: EventDefinitionLike,
  subscribe: CreateClientOptions['subscribe'],
): (listener: (payload: unknown) => void) => Unsubscribe {
  return listener => {
    if (!subscribe) {
      throw new TypeError('Client subscribe adapter is required for IPC events');
    }

    let unsubscribe: Unsubscribe = () => {};
    const wrappedListener = definition.once
      ? (payload: unknown) => {
          unsubscribe();
          listener(payload);
        }
      : listener;

    unsubscribe = subscribe({
      event: definition.name,
      channel: definition.channel,
      once: definition.once,
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

      if (!isNamespaceNode(context.node)) {
        throw new TypeError(`"${formatPath(context.path)}" is not an event namespace`);
      }

      if (!(property in context.node)) {
        throw new TypeError(`Unknown event path: "${formatPath([...context.path, property])}"`);
      }

      const childNode = Reflect.get(context.node, property);

      if (isEventDefinition(childNode)) {
        return createEventSubscriber(childNode, context.subscribe);
      }

      return createEventProxy({
        node: childNode,
        path: [...context.path, property],
        subscribe: context.subscribe,
      });
    },

    apply() {
      throw new TypeError(
        `"${formatPath(context.path)}" is an event namespace and cannot be called`,
      );
    },
  });
}

function isEventDefinition(value: unknown): value is EventDefinitionLike {
  return (
    value !== null &&
    typeof value === 'function' &&
    (value as { __ipcoraEvent?: unknown }).__ipcoraEvent === true
  );
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

function isNamespaceNode(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === 'object';
}

function formatPath(path: string[]): string {
  return path.length > 0 ? path.join('.') : '<root>';
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
