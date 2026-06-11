type AnyFunction = (...args: any[]) => any;
type DefinitionOf<T> = T extends { readonly definition: infer TDefinition } ? TDefinition : T;
type ResultOf<T> =
  Awaited<T> extends { data: unknown; error: unknown }
    ? Awaited<T>
    : { data: Awaited<T>; error: null };

type ClientMetadata = Record<string, unknown>;

type Client<T> = T extends AnyFunction
  ? Parameters<T> extends []
    ? (metadata?: ClientMetadata) => Promise<ResultOf<ReturnType<T>>>
    : (...args: [...Parameters<T>, metadata?: ClientMetadata]) => Promise<ResultOf<ReturnType<T>>>
  : T extends object
    ? {
        [K in keyof T]: Client<T[K]>;
      }
    : never;

interface ClientCall {
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

interface CreateClientOptions {
  invoke(call: ClientCall): unknown | Promise<unknown>;

  /** Static metadata merged into every call (lowest priority). */
  metadata?: Record<string, unknown>;

  /** Per-call hook that returns dynamic metadata (overrides static, overridden by per-call). */
  onMetadata?: MetadataHook;
}

export function createClient<TDefinition extends object>(
  definition: TDefinition,
  options: CreateClientOptions,
): Client<DefinitionOf<TDefinition>> {
  return createProxy({
    node: getDefinitionNode(definition),
    path: [],
    invoke: options.invoke,
    staticMetadata: options.metadata,
    onMetadata: options.onMetadata,
  }) as Client<DefinitionOf<TDefinition>>;
}

interface ProxyContext {
  node: unknown;
  path: string[];
  invoke: CreateClientOptions['invoke'];
  staticMetadata?: Record<string, unknown>;
  onMetadata?: MetadataHook;
}

function createProxy(context: ProxyContext): unknown {
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

      return createProxy({
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

function getDefinitionNode(definition: object): object {
  if ('definition' in definition) {
    const node = definition.definition;
    if (node && typeof node === 'object') return node;
  }
  return definition;
}

function isNamespaceNode(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === 'object';
}

function formatPath(path: string[]): string {
  return path.length > 0 ? path.join('.') : '<root>';
}

async function resolveMetadata(
  context: ProxyContext,
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
