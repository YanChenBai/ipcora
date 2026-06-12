import { fail, IpcError } from './errors';
import type {
  AnyMacroDefinition,
  AnyMacroEntry,
  AnyRecord,
  AnySchema,
  AnyErrorConstructor,
  Binding,
  BuiltInHandlerOptions,
  DeriveHook,
  EventDefinitions,
  EventEmitOptions,
  EventEmitter,
  EventNames,
  EventPayloadByName,
  EventSchemaInput,
  Expand,
  ErrorMapPayload,
  ErrorMapper,
  ErrorRegistry,
  ErrorRegistryPayload,
  HandlerDefinition,
  HandlerFunction,
  HandlerOptions,
  HookReturnExtension,
  HookStore,
  InferSchemaOutput,
  IpcEvent,
  IpcMiddleware,
  IpcoraOptions,
  IpcPeer,
  IpcRequest,
  IpcResponse,
  JoinPathType,
  LifecycleBase,
  LifecyclePhase,
  MacroDefinition,
  MacroDefinitionExtension,
  MacroDefinitionOption,
  MacroObjectExtension,
  MacroObjectRegistry,
  MacroRegistry,
  MaybePromise,
  Merge,
  NormalizeMacroOption,
  OnAfterHandleHook,
  OnAfterResponseHook,
  OnBeforeHandleHook,
  OnErrorHook,
  OnErrorHookPayload,
  OnGuardHook,
  OnMapResponseHook,
  OnRequestHook,
  OnTransformHook,
  PathToObject,
  ResolveHook,
  RouteHandler,
  RuntimeContext,
} from './types';
import {
  builtInHandlerOptionKeys,
  cloneHooks,
  emptyHooks,
  joinPath,
  normalizeObjectParams,
  parseSchema,
} from './utils';

const isDevMode = (): boolean => {
  try {
    if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') return true;
  } catch {
    /* noop */
  }
  return false;
};

/**
 * IPC router. It owns route registration, lifecycle execution, adapter
 * binding, macros, adapters, and Elysia-style context extension.
 */
export class Ipcora<
  TContext extends object = {},
  TStore extends object = {},
  TMacros extends MacroRegistry = {},
  TRoutes extends object = {},
  TPrefix extends string = '',
  TErrors = never,
> {
  /** IPC channel name used by the adapter. */
  readonly channel: string;
  /** Unique name for this router, used to prevent duplicate adapter installation. */
  readonly name?: string;
  /** When `true`, only type-level definitions are contributed; no runtime routes or adapter. */
  readonly abstract: boolean;
  readonly definition: TRoutes;
  readonly $emit: EventEmitter<TRoutes>;

  /** Tracks which named routers have been installed to guard against double-binding. */
  private static readonly installedNames = new Set<string>();
  /** Tracks which named plugins have been used to guard against double-use. */
  private static readonly usedPluginNames = new Set<string>();

  private readonly routes: Map<string, HandlerDefinition<any, any>>;
  private readonly eventSchemas: Map<string, AnySchema>;
  private readonly bindings: Map<number, Binding<any>>;
  private readonly options: Required<Pick<IpcoraOptions, 'exposeStack'>> & IpcoraOptions;
  private readonly macros: Map<string, AnyMacroEntry>;
  private readonly errorMappers: Map<AnyErrorConstructor, (error: Error) => IpcError>;
  private prefix = '';
  private hooks: HookStore<any, any>;
  private middleware: IpcMiddleware<any, any>[] = [];
  private decorators: AnyRecord = {};
  private store: AnyRecord = {};
  private metadataSchema: AnySchema | undefined = undefined;
  private installed = false;

  constructor(options: IpcoraOptions = {}) {
    this.channel = options.channel ?? 'ipcora:invoke';
    this.name = options.name;
    this.abstract = options.abstract ?? false;
    this.options = { exposeStack: isDevMode(), ...options };
    this.routes = new Map();
    this.eventSchemas = new Map();
    this.bindings = new Map();
    this.macros = new Map();
    this.errorMappers = new Map();
    this.hooks = emptyHooks();
    this.definition = {} as TRoutes;
    this.$emit = createEventEmitter(this) as EventEmitter<TRoutes>;
  }

  private createScope<const TScopePrefix extends string>(
    prefix: TScopePrefix,
  ): Ipcora<TContext, TStore, TMacros, TRoutes, TScopePrefix, TErrors> {
    const scope = Object.create(Ipcora.prototype) as Ipcora<
      TContext,
      TStore,
      TMacros,
      TRoutes,
      TScopePrefix,
      TErrors
    >;
    Object.assign(scope, this, {
      prefix,
      name: this.name,
      abstract: this.abstract,
      hooks: cloneHooks(this.hooks),
      middleware: [...this.middleware],
      decorators: { ...this.decorators },
      store: this.store,
    });
    return scope;
  }

  /**
   * Add shared mutable state exposed as `store`.
   */
  state<const TKey extends string, TValue>(
    key: TKey,
    value: TValue,
  ): Ipcora<TContext, Expand<TStore & Record<TKey, TValue>>, TMacros, TRoutes, TPrefix, TErrors>;
  state<const TExtension extends object>(
    values: TExtension,
  ): Ipcora<TContext, Expand<TStore & TExtension>, TMacros, TRoutes, TPrefix, TErrors>;
  state(
    keyOrObject: string | object,
    value?: unknown,
  ): Ipcora<TContext, any, TMacros, TRoutes, TPrefix, TErrors> {
    Object.assign(this.store, normalizeObjectParams(keyOrObject, value));
    return this;
  }

  /**
   * Add static properties directly to every lifecycle value.
   */
  decorate<const TKey extends string, TValue>(
    key: TKey,
    value: TValue,
  ): Ipcora<Expand<TContext & Record<TKey, TValue>>, TStore, TMacros, TRoutes, TPrefix, TErrors>;
  decorate<const TExtension extends object>(
    values: TExtension,
  ): Ipcora<Expand<TContext & TExtension>, TStore, TMacros, TRoutes, TPrefix, TErrors>;
  decorate(
    keyOrObject: string | object,
    value?: unknown,
  ): Ipcora<any, TStore, TMacros, TRoutes, TPrefix, TErrors> {
    Object.assign(this.decorators, normalizeObjectParams(keyOrObject, value));
    return this;
  }

  /**
   * Run before validation to derive context from raw request data.
   */
  derive<TReturn>(
    hook: (
      value: LifecycleBase<TContext, TStore> & { params: unknown; rawParams: unknown },
    ) => MaybePromise<TReturn>,
  ): Ipcora<
    Expand<TContext & HookReturnExtension<TReturn>>,
    TStore,
    TMacros,
    TRoutes,
    TPrefix,
    TErrors
  > {
    this.hooks.derive.push(hook as DeriveHook<TContext, TStore>);
    return this as unknown as Ipcora<
      Expand<TContext & HookReturnExtension<TReturn>>,
      TStore,
      TMacros,
      TRoutes,
      TPrefix,
      TErrors
    >;
  }

  /**
   * Run after validation to derive context from parsed params.
   */
  resolve<TReturn>(
    hook: (
      value: LifecycleBase<TContext, TStore> & { params: unknown; rawParams: unknown },
    ) => MaybePromise<TReturn>,
  ): Ipcora<
    Expand<TContext & HookReturnExtension<TReturn>>,
    TStore,
    TMacros,
    TRoutes,
    TPrefix,
    TErrors
  > {
    this.hooks.resolve.push(hook as ResolveHook<TContext, TStore>);
    return this as unknown as Ipcora<
      Expand<TContext & HookReturnExtension<TReturn>>,
      TStore,
      TMacros,
      TRoutes,
      TPrefix,
      TErrors
    >;
  }

  /**
   * Register a custom handler option that expands into lifecycle hooks.
   */
  macro<const TName extends string, const TEntry extends AnyMacroEntry>(
    name: TName,
    definition: TEntry,
  ): Ipcora<
    Expand<TContext & MacroDefinitionExtension<TEntry>>,
    TStore,
    Expand<
      TMacros &
        Record<
          TName,
          TEntry extends (...args: any[]) => any
            ? TEntry
            : MacroDefinition<
                TContext,
                TStore,
                NormalizeMacroOption<MacroDefinitionOption<TEntry>>,
                MacroDefinitionExtension<TEntry>
              >
        >
    >,
    TRoutes,
    TPrefix,
    TErrors
  >;

  macro<const TDefinitions extends Record<string, AnyMacroEntry>>(
    definitions: TDefinitions,
  ): Ipcora<
    Expand<TContext & MacroObjectExtension<TDefinitions>>,
    TStore,
    Expand<TMacros & MacroObjectRegistry<TContext, TStore, TDefinitions>>,
    TRoutes,
    TPrefix,
    TErrors
  >;

  macro(
    nameOrDefinitions: string | Record<string, AnyMacroEntry>,
    definition?: AnyMacroEntry,
  ): Ipcora<any, TStore, any, TRoutes, TPrefix, TErrors> {
    if (typeof nameOrDefinitions === 'string') {
      this.macros.set(nameOrDefinitions, definition!);
    } else {
      for (const [name, entry] of Object.entries(nameOrDefinitions)) {
        this.macros.set(name, entry);
      }
    }
    return this as Ipcora<any, TStore, any, TRoutes, TPrefix, TErrors>;
  }

  /**
   * Set a global metadata schema that applies to every handler on this
   * instance (and scoped children). Handlers can override it locally by
   * passing their own `metadata` option.
   */
  metadata<const TSchema extends AnySchema>(
    schema: TSchema,
  ): Ipcora<TContext, TStore, TMacros, TRoutes, TPrefix, TErrors> {
    this.metadataSchema = schema;
    return this;
  }

  onRequest(hook: OnRequestHook<TContext, TStore>): this {
    this.hooks.onRequest.push(hook);
    return this;
  }

  /**
   * Run before params validation. Return a value to replace the params.
   */
  onTransform(hook: OnTransformHook<TContext, TStore>): this {
    this.hooks.onTransform.push(hook);
    return this;
  }

  onGuard<TReturn>(
    hook: (value: LifecycleBase<TContext, TStore> & { params: unknown }) => MaybePromise<TReturn>,
  ): Ipcora<Expand<TContext & HookReturnExtension<TReturn>>, TStore, TMacros, TRoutes, TPrefix> {
    this.hooks.onGuard.push(hook as OnGuardHook<TContext, TStore>);
    return this as unknown as Ipcora<
      Expand<TContext & HookReturnExtension<TReturn>>,
      TStore,
      TMacros,
      TRoutes,
      TPrefix
    >;
  }

  onBeforeHandle(hook: OnBeforeHandleHook<TContext, TStore>): this {
    this.hooks.onBeforeHandle.push(hook);
    return this;
  }

  onAfterHandle(hook: OnAfterHandleHook<TContext, TStore>): this {
    this.hooks.onAfterHandle.push(hook);
    return this;
  }

  onMapResponse(hook: OnMapResponseHook<TContext, TStore>): this {
    this.hooks.onMapResponse.push(hook);
    return this;
  }

  onError<THook extends OnErrorHook<TContext, TStore>>(
    hook: THook,
  ): Ipcora<TContext, TStore, TMacros, TRoutes, TPrefix, TErrors | OnErrorHookPayload<THook>> {
    this.hooks.onError.push(hook);
    return this as unknown as Ipcora<
      TContext,
      TStore,
      TMacros,
      TRoutes,
      TPrefix,
      TErrors | OnErrorHookPayload<THook>
    >;
  }

  onAfterResponse(hook: OnAfterResponseHook<TContext, TStore>): this {
    this.hooks.onAfterResponse.push(hook);
    return this;
  }

  /**
   * Register a plugin (another Ipcora instance) merging its routes, middleware,
   * hooks, macros, error mappers, state, and decorators into this router.
   *
   * Named plugins are singletons — calling `use()` with the same named plugin
   * twice throws. Unnamed plugins can be used multiple times, but duplicate
   * route paths throw regardless.
   */
  use<TPlugin extends Ipcora<any, any, any, any, any, any>>(
    plugin: TPlugin,
  ): Ipcora<
    Expand<TContext & (TPlugin extends Ipcora<infer TC, any, any, any, any, any> ? TC : {})>,
    Expand<TStore & (TPlugin extends Ipcora<any, infer TS, any, any, any, any> ? TS : {})>,
    TMacros & (TPlugin extends Ipcora<any, any, infer TM, any, any, any> ? TM : {}),
    Merge<TRoutes, TPlugin extends Ipcora<any, any, any, infer TR, any, any> ? TR : {}>,
    TPrefix,
    TErrors | (TPlugin extends Ipcora<any, any, any, any, any, infer TE> ? TE : never)
  >;
  /**
   * Register middleware that wraps every handler's execution and can extend
   * the runtime context by passing an object to `next`.
   */
  use<TExtension extends object>(
    middleware: IpcMiddleware<TContext, TStore>,
  ): Ipcora<Expand<TContext & TExtension>, TStore, TMacros, TRoutes, TPrefix, TErrors>;
  use(
    pluginOrMiddleware: Ipcora<any, any, any, any, any, any> | IpcMiddleware<TContext, TStore>,
  ): Ipcora<any, any, any, any, any, any> {
    if (pluginOrMiddleware instanceof Ipcora) {
      return this.usePlugin(pluginOrMiddleware);
    }
    this.middleware.push(pluginOrMiddleware);
    return this as unknown as Ipcora<any, any, any, any, any, any>;
  }

  private usePlugin(plugin: Ipcora<any, any, any, any, any, any>): this {
    // Singleton guard: named plugins can only be used once.
    if (plugin.name) {
      if (Ipcora.usedPluginNames.has(plugin.name)) {
        throw new Error(
          `IPC plugin "${plugin.name}" is already in use. Named plugins can only be used once.`,
        );
      }
      Ipcora.usedPluginNames.add(plugin.name);
    }

    // Merge macros (before routes so macro options resolve correctly).
    for (const [name, entry] of plugin.macros) {
      if (this.macros.has(name)) continue; // parent wins
      this.macros.set(name, entry);
    }

    // Merge error mappers.
    for (const [constructor, mapper] of plugin.errorMappers) {
      if (!this.errorMappers.has(constructor)) {
        this.errorMappers.set(constructor, mapper);
      }
    }

    // Capture parent's original hooks and middleware before adding the
    // plugin's contributions. We need these so we can bake them into the
    // plugin's existing routes without double-counting the plugin's own
    // hooks/middleware (which are already baked into each route definition).
    const hookKeys: (keyof HookStore<any, any>)[] = [
      'onRequest',
      'onTransform',
      'derive',
      'resolve',
      'onGuard',
      'onBeforeHandle',
      'onAfterHandle',
      'onMapResponse',
      'onError',
      'onAfterResponse',
    ];
    const parentHooks = cloneHooks(this.hooks);
    const parentMiddleware = [...this.middleware];

    // Merge global hooks into this instance so that future routes registered
    // on the parent also receive the plugin's hooks (parent first, then plugin).
    for (const key of hookKeys) {
      (this.hooks[key] as unknown[]).push(...(plugin.hooks[key] as unknown[]));
    }

    // Merge global metadata schema (parent wins on conflict).
    if (!this.metadataSchema && plugin.metadataSchema) {
      this.metadataSchema = plugin.metadataSchema;
    }

    // Merge state and decorators (parent wins on conflict).
    this.store = { ...plugin.store, ...this.store };
    this.decorators = { ...plugin.decorators, ...this.decorators };

    // Prepend plugin middleware so future parent routes also run it.
    this.middleware = [...plugin.middleware, ...this.middleware];

    // Merge routes — throw on duplicate paths.
    // Abstract plugins only contribute type definitions and have no runtime
    // handlers, so their routes Map is empty. They are skipped here.
    //
    // Each route's hooks and middleware were baked in at registration time
    // on the plugin (plugin globals + route locals). We merge the parent's
    // ORIGINAL global hooks and middleware (captured above) so the final
    // order is: parent → plugin → route-locals.
    for (const [path, definition] of plugin.routes) {
      if (this.routes.has(path)) {
        throw new Error(`Duplicate IPC handler: ${path}`);
      }
      const mergedHooks = cloneHooks(parentHooks);
      for (const key of hookKeys) {
        (mergedHooks[key] as unknown[]).push(...(definition.hooks[key] as unknown[]));
      }
      const merged: HandlerDefinition<any, any> = {
        ...definition,
        hooks: mergedHooks,
        middleware: [...parentMiddleware, ...definition.middleware],
      };
      this.routes.set(path, merged);
      this.assignRouteDefinition(path, Boolean(definition.paramsSchema));
    }

    // Merge event schemas.
    for (const [name, schema] of plugin.eventSchemas) {
      if (!this.eventSchemas.has(name)) {
        this.eventSchemas.set(name, schema);
      }
    }

    return this;
  }

  error<const TRegistry extends ErrorRegistry>(
    errors: TRegistry,
  ): Ipcora<TContext, TStore, TMacros, TRoutes, TPrefix, TErrors | ErrorRegistryPayload<TRegistry>>;
  error<const TError extends AnyErrorConstructor, TMapped extends IpcError>(
    errors: ReadonlyMap<TError, ErrorMapper<InstanceType<TError>, TMapped>>,
  ): Ipcora<
    TContext,
    TStore,
    TMacros,
    TRoutes,
    TPrefix,
    TErrors | ErrorMapPayload<TError, TMapped>
  >;
  error<const TError extends AnyErrorConstructor, TMapped extends IpcError>(
    error: TError,
    map: (value: { fail: typeof fail; error: InstanceType<TError> }) => TMapped,
  ): Ipcora<
    TContext,
    TStore,
    TMacros,
    TRoutes,
    TPrefix,
    TErrors | ErrorMapPayload<TError, TMapped>
  >;
  error(
    errorsOrError:
      | ErrorRegistry
      | AnyErrorConstructor
      | ReadonlyMap<AnyErrorConstructor, ErrorMapper>,
    map?: (value: { fail: typeof fail; error: Error }) => IpcError,
  ): Ipcora<any, any, any, any, any, any> {
    if (errorsOrError instanceof Map) {
      for (const [constructor, mapper] of errorsOrError) {
        this.errorMappers.set(constructor, error => mapper({ fail, error }));
      }
      return this as Ipcora<any, any, any, any, any, any>;
    }

    if (typeof errorsOrError === 'function') {
      this.errorMappers.set(
        errorsOrError,
        error => map?.({ fail, error }) ?? this.defaultError(errorsOrError, error),
      );
      return this as Ipcora<any, any, any, any, any, any>;
    }

    for (const [name, constructor] of Object.entries(errorsOrError)) {
      this.errorMappers.set(constructor, error => this.defaultError(constructor, error, name));
    }
    return this as Ipcora<any, any, any, any, any, any>;
  }

  handler<
    const TPath extends string,
    TParamsSchema extends AnySchema | undefined = undefined,
    TOutputSchema extends AnySchema | undefined = undefined,
    TMetadataSchema extends AnySchema | undefined = undefined,
    TParams = TParamsSchema extends AnySchema ? InferSchemaOutput<TParamsSchema> : void,
    THandler extends HandlerFunction<TParams, any, TContext, TStore> = HandlerFunction<
      TParams,
      any,
      TContext,
      TStore
    >,
    TOutput = TOutputSchema extends AnySchema
      ? InferSchemaOutput<TOutputSchema>
      : Awaited<ReturnType<THandler>>,
    TOptions extends object = {},
    TLocalErrors = TOptions extends { onError?: infer THook } ? OnErrorHookPayload<THook> : never,
  >(
    path: TPath,
    handler: THandler,
    options: HandlerOptions<
      TParamsSchema,
      TOutputSchema,
      TMetadataSchema,
      TContext,
      TStore,
      TMacros
    > &
      TOptions = {} as HandlerOptions<
      TParamsSchema,
      TOutputSchema,
      TMetadataSchema,
      TContext,
      TStore,
      TMacros
    > &
      TOptions,
  ): Ipcora<
    TContext,
    TStore,
    TMacros,
    Merge<
      TRoutes,
      PathToObject<
        JoinPathType<TPrefix, TPath>,
        RouteHandler<TParams, TOutput, TErrors | TLocalErrors>
      >
    >,
    TPrefix,
    TErrors
  > {
    const fullPath = joinPath(this.prefix, path);

    // Abstract routers only contribute type definitions, no runtime registration.
    if (this.abstract) {
      this.assignRouteDefinition(fullPath, Boolean(options.params));
      return this as unknown as Ipcora<
        TContext,
        TStore,
        TMacros,
        Merge<
          TRoutes,
          PathToObject<
            JoinPathType<TPrefix, TPath>,
            RouteHandler<TParams, TOutput, TErrors | TLocalErrors>
          >
        >,
        TPrefix,
        TErrors
      >;
    }

    if (this.routes.has(fullPath)) {
      throw new Error(`Duplicate IPC handler: ${fullPath}`);
    }

    const hooks = cloneHooks(this.hooks);
    const macroSchemas = this.appendMacroHooks(hooks, options);
    this.appendHandlerHooks(hooks, options);

    const paramsSchema = this.composeSchemas([...macroSchemas.params, options.params]);
    const outputSchema = this.composeSchemas([...macroSchemas.output, options.output]);
    const metadataSchema = options.metadata ?? this.metadataSchema;

    this.routes.set(fullPath, {
      path: fullPath,
      handler: handler as HandlerFunction<any, any, TContext, TStore>,
      paramsSchema,
      outputSchema,
      metadataSchema,
      middleware: [...this.middleware],
      hooks,
    });
    this.assignRouteDefinition(fullPath, Boolean(paramsSchema));
    return this as unknown as Ipcora<
      TContext,
      TStore,
      TMacros,
      Merge<
        TRoutes,
        PathToObject<
          JoinPathType<TPrefix, TPath>,
          RouteHandler<TParams, TOutput, TErrors | TLocalErrors>
        >
      >,
      TPrefix,
      TErrors
    >;
  }

  events<const TEvents extends Record<string, unknown>>(
    schema: TEvents & EventSchemaInput<TEvents>,
  ): Ipcora<
    TContext,
    TStore,
    TMacros,
    Merge<TRoutes, EventDefinitions<TEvents & EventSchemaInput<TEvents>>>,
    TPrefix,
    TErrors
  > {
    for (const [name, eventSchema] of Object.entries(schema)) {
      const channel = this.eventChannel(name);
      this.eventSchemas.set(name, eventSchema);
      this.assignEventDefinition(name, channel, false);
      this.assignEventDefinition(name, channel, true);
    }

    return this as unknown as Ipcora<
      TContext,
      TStore,
      TMacros,
      Merge<TRoutes, EventDefinitions<TEvents & EventSchemaInput<TEvents>>>,
      TPrefix,
      TErrors
    >;
  }

  async emit<const TName extends EventNames<TRoutes> & string>(
    name: TName,
    payload: EventPayloadByName<TRoutes, TName>,
    options: EventEmitOptions = {},
  ): Promise<void> {
    const schema = this.eventSchemas.get(name);
    if (!schema) {
      throw new Error(`IPC event not found: ${name}`);
    }
    const parsedPayload = await parseSchema(schema, payload);
    const adapter = this.options.adapter;
    if (!adapter) {
      throw new Error('IPC adapter is required. Pass an adapter to createIpcora({ adapter }).');
    }

    const bindings = options.peers
      ? this.resolveEventBindings(options.peers)
      : this.bindings.values();
    const channel = this.eventChannel(name);
    await Promise.all(
      [...bindings].map(binding => adapter.emit(channel, binding.peer.sender, parsedPayload)),
    );
  }

  group<const TPath extends string, TGroupRoutes extends object>(
    prefix: TPath,
    configure: (
      ipc: Ipcora<TContext, TStore, TMacros, TRoutes, JoinPathType<TPrefix, TPath>, TErrors>,
    ) => Ipcora<any, any, any, TGroupRoutes, any, any>,
  ): Ipcora<TContext, TStore, TMacros, Merge<TRoutes, TGroupRoutes>, TPrefix, TErrors> {
    configure(this.createScope(joinPath(this.prefix, prefix)));
    return this as unknown as Ipcora<
      TContext,
      TStore,
      TMacros,
      Merge<TRoutes, TGroupRoutes>,
      TPrefix,
      TErrors
    >;
  }

  /**
   * Bind a peer to this router. Only bound peers may dispatch calls.
   */
  bind(peer: IpcPeer, options: { context: Partial<TContext> }): () => void {
    this.installAdapter();
    const controller = new AbortController();
    this.bindings.set(peer.id, { peer, context: options.context, controller });

    const dispose = () => {
      controller.abort();
      this.bindings.delete(peer.id);
    };
    peer.onDispose?.(dispose);
    return dispose;
  }

  dispose(): void {
    for (const binding of this.bindings.values()) binding.controller.abort();
    this.bindings.clear();
    if (this.installed) {
      this.options.adapter?.removeHandler(this.channel);
      if (this.name) Ipcora.installedNames.delete(this.name);
      this.installed = false;
    }
  }

  private appendMacroHooks(
    hooks: HookStore<TContext, TStore>,
    options: HandlerOptions<any, any, any, TContext, TStore, TMacros>,
  ): { params: AnySchema[]; output: AnySchema[] } {
    const schemas: { params: AnySchema[]; output: AnySchema[] } = { params: [], output: [] };
    const seen = new Set<unknown>();

    for (const [key, option] of Object.entries(options)) {
      if (builtInHandlerOptionKeys.has(key) || option === undefined) continue;
      const macro = this.macros.get(key);
      if (!macro) continue;
      this.appendMacroHookSet(hooks, macro, option, schemas, seen, 0);
    }

    return schemas;
  }

  private appendMacroHookSet(
    hooks: HookStore<TContext, TStore>,
    entry: AnyMacroEntry,
    option: unknown,
    schemas: { params: AnySchema[]; output: AnySchema[] },
    seen: Set<unknown>,
    depth: number,
  ): void {
    if (option === false) return;
    if (depth >= 16) {
      throw new Error('Macro expansion depth exceeded. Check for circular macro dependencies.');
    }

    const macro = this.resolveMacroEntry(entry, option);
    if (!macro) return;

    const seed = macro.seed ?? option;
    const dedupeKey = `${seed === undefined ? 'undefined' : JSON.stringify(seed)}:${this.findMacroName(entry) ?? ''}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    for (const [key, nestedOption] of Object.entries(macro)) {
      if (this.isMacroDefinitionKey(key) || nestedOption === undefined) continue;
      const nested = this.macros.get(key);
      if (!nested) continue;
      this.appendMacroHookSet(hooks, nested, nestedOption, schemas, seen, depth + 1);
    }

    if (macro.params) schemas.params.push(macro.params);
    if (macro.output) schemas.output.push(macro.output);

    const wrap = <THook extends (value: any) => MaybePromise<any>>(hook: THook) => {
      return ((value: Parameters<THook>[0]) => hook({ ...value, option })) as THook;
    };
    const asHook = <THook>(hook: unknown) => hook as THook;

    if (macro.onRequest) {
      hooks.onRequest.push(asHook<OnRequestHook<TContext, TStore>>(wrap(macro.onRequest)));
    }
    if (macro.onTransform) {
      hooks.onTransform.push(asHook<OnTransformHook<TContext, TStore>>(wrap(macro.onTransform)));
    }
    if (macro.derive) {
      hooks.derive.push(asHook<DeriveHook<TContext, TStore>>(wrap(macro.derive)));
    }
    if (macro.resolve) {
      hooks.resolve.push(asHook<ResolveHook<TContext, TStore>>(wrap(macro.resolve)));
    }
    if (macro.onGuard) {
      hooks.onGuard.push(asHook<OnGuardHook<TContext, TStore>>(wrap(macro.onGuard)));
    }
    if (macro.onBeforeHandle) {
      hooks.onBeforeHandle.push(
        asHook<OnBeforeHandleHook<TContext, TStore>>(wrap(macro.onBeforeHandle)),
      );
    }
    if (macro.onAfterHandle) {
      hooks.onAfterHandle.push(
        asHook<OnAfterHandleHook<TContext, TStore>>(wrap(macro.onAfterHandle)),
      );
    }
    if (macro.onMapResponse) {
      hooks.onMapResponse.push(
        asHook<OnMapResponseHook<TContext, TStore>>(wrap(macro.onMapResponse)),
      );
    }
    if (macro.onError) {
      hooks.onError.push(asHook<OnErrorHook<TContext, TStore>>(wrap(macro.onError)));
    }
    if (macro.onAfterResponse) {
      hooks.onAfterResponse.push(
        asHook<OnAfterResponseHook<TContext, TStore>>(wrap(macro.onAfterResponse)),
      );
    }
  }

  private resolveMacroEntry(entry: AnyMacroEntry, option: unknown): AnyMacroDefinition | void {
    if (typeof entry !== 'function') return entry;
    const definition = entry(option);
    if (definition && typeof (definition as Promise<unknown>).then === 'function') {
      throw new Error('Async macro factories are not supported during handler registration.');
    }
    return definition as AnyMacroDefinition | void;
  }

  private findMacroName(entry: AnyMacroEntry): string | undefined {
    for (const [name, macro] of this.macros) {
      if (macro === entry) return name;
    }
  }

  private isMacroDefinitionKey(key: string): boolean {
    return builtInHandlerOptionKeys.has(key) || key === 'seed';
  }

  private composeSchemas(schemas: (AnySchema | undefined)[]): AnySchema | undefined {
    const active = schemas.filter((schema): schema is AnySchema => Boolean(schema));
    if (active.length === 0) return undefined;
    if (active.length === 1) return active[0];

    return {
      '~standard': {
        version: 1,
        vendor: 'ipcora',
        validate: async value => {
          let current = value;
          for (const schema of active) {
            const result = await schema['~standard'].validate(current);
            if ('issues' in result && result.issues) return result;
            current = result.value;
          }
          return { value: current };
        },
      },
    };
  }

  private appendHandlerHooks(
    hooks: HookStore<TContext, TStore>,
    options: BuiltInHandlerOptions<any, any, any, TContext, TStore>,
  ): void {
    const append = <T>(list: T[], value: T | undefined) => {
      if (value) list.push(value);
    };

    append(hooks.onRequest, options.onRequest);
    append(hooks.onTransform, options.onTransform);
    append(hooks.derive, options.derive);
    append(hooks.resolve, options.resolve);
    append(hooks.onGuard, options.onGuard);
    append(hooks.onBeforeHandle, options.onBeforeHandle);
    append(hooks.onAfterHandle, options.onAfterHandle);
    append(hooks.onMapResponse, options.onMapResponse);
    append(hooks.onError, options.onError);
    append(hooks.onAfterResponse, options.onAfterResponse);
  }

  private assignRouteDefinition(path: string, hasParams: boolean): void {
    const parts = path.split('.').filter(Boolean);
    let node = this.definition as AnyRecord;

    for (const part of parts.slice(0, -1)) {
      const current = node[part];
      if (!current || typeof current !== 'object') {
        node[part] = {};
      }
      node = node[part] as AnyRecord;
    }

    const method = parts.at(-1);
    if (method) {
      node[method] = hasParams
        ? function ipcoraRouteDefinition(_p: any) {}
        : function ipcoraRouteDefinition() {};
    }
  }

  private assignEventDefinition(name: string, channel: string, once: boolean): void {
    const key = `${once ? 'onOnce' : 'on'}${capitalize(name)}`;
    const definition = function ipcoraEventDefinition() {};
    Object.defineProperties(definition, {
      __ipcoraEvent: { value: true },
      name: { value: name, configurable: true },
      channel: { value: channel },
      once: { value: once },
      payload: { value: undefined },
    });
    (this.definition as AnyRecord)[key] = definition;
  }

  private eventChannel(name: string): string {
    return `${this.channel}:event:${name}`;
  }

  private resolveEventBindings(peers: Iterable<IpcPeer | number>): Binding<any>[] {
    const bindings: Binding<any>[] = [];
    for (const peer of peers) {
      const id = typeof peer === 'number' ? peer : peer.id;
      const binding = this.bindings.get(id);
      if (binding) bindings.push(binding);
    }
    return bindings;
  }

  private installAdapter(): void {
    if (this.abstract) return;
    if (this.installed) return;

    if (this.name && Ipcora.installedNames.has(this.name)) {
      throw new Error(
        `IPC router "${this.name}" is already installed. Each named router can only be bound once.`,
      );
    }

    const { adapter } = this.options;
    if (!adapter) {
      throw new Error('IPC adapter is required. Pass an adapter to createIpcora({ adapter }).');
    }
    if (adapter.listenerCount(this.channel) > 0) {
      throw new Error(`IPC channel already registered: ${this.channel}`);
    }
    adapter.handle(this.channel, (event, request) => this.dispatch(event, request));
    if (this.name) Ipcora.installedNames.add(this.name);
    this.installed = true;
  }

  private async dispatch(event: IpcEvent, request: IpcRequest): Promise<IpcResponse> {
    const binding = this.bindings.get(event.sender.id);
    if (!binding) {
      return this.errorResponse(fail('PEER_NOT_BOUND'));
    }
    const definition = this.routes.get(request.path);
    if (!definition) {
      return this.errorResponse(
        fail('HANDLER_NOT_FOUND', {
          message: `IPC handler not found: ${request.path}`,
        }),
      );
    }

    const startedAt = performance.now();
    let metadata: Readonly<Record<string, unknown>> = Object.freeze({ ...request.metadata });
    let phase: LifecyclePhase = 'onRequest';
    let params: unknown = request.params;
    let output: unknown;
    let response: IpcResponse | undefined;
    let caught: unknown;
    let context: RuntimeContext<TContext, TStore> = {
      ...this.decorators,
      ...binding.context,
      store: this.store as TStore,
      peer: binding.peer,
      sender: event.sender,
      event,
    } as RuntimeContext<TContext, TStore>;

    const base = () => ({
      ...context,
      id: request.id,
      path: definition.path,
      event,
      signal: binding.controller.signal,
      startedAt,
      metadata,
      fail,
    });

    try {
      for (const hook of definition.hooks.onRequest) {
        await hook({ ...base(), request, rawParams: request.params });
      }

      // Transform and derive run before validation so they can normalize raw params
      // and add request-derived context before schemas are evaluated.
      phase = 'onTransform';
      for (const hook of definition.hooks.onTransform) {
        const next = await hook({ ...base(), params });
        if (next !== undefined) params = next;
      }

      phase = 'derive';
      for (const hook of definition.hooks.derive) {
        const extension = await hook({ ...base(), params, rawParams: request.params });
        if (extension) context = { ...context, ...extension };
      }

      // onGuard runs before validation so it can short-circuit early
      // without paying schema validation cost. Guards receive raw params.
      phase = 'onGuard';
      for (const hook of definition.hooks.onGuard) {
        const extension = await hook({ ...base(), params });
        if (extension) context = { ...context, ...extension };
      }

      phase = 'validation';
      const validatedMeta = await parseSchema(definition.metadataSchema, metadata);
      metadata = Object.freeze({ ...(validatedMeta as Record<string, unknown>) });
      params = await parseSchema(definition.paramsSchema, params);

      phase = 'resolve';
      for (const hook of definition.hooks.resolve) {
        const extension = await hook({ ...base(), params, rawParams: request.params });
        if (extension) context = { ...context, ...extension };
      }

      phase = 'onBeforeHandle';
      for (const hook of definition.hooks.onBeforeHandle) {
        await hook({ ...base(), params });
      }

      phase = 'handler';
      output = await this.executeMiddleware(definition, params, context, base);
      if (output instanceof IpcError) {
        throw output;
      }

      phase = 'onAfterHandle';
      for (const hook of [...definition.hooks.onAfterHandle].reverse()) {
        const next = await hook({ ...base(), params, output });
        if (next !== undefined) output = next;
      }

      if (output instanceof IpcError) {
        throw output;
      }

      phase = 'validation';
      output = await parseSchema(definition.outputSchema, output);
      response = { data: output };

      phase = 'onMapResponse';
      for (const hook of [...definition.hooks.onMapResponse].reverse()) {
        const next = await hook({ ...base(), params, output, response });
        if (next !== undefined) response = next;
      }
    } catch (error) {
      caught = error;
      const failedPhase = phase;
      const normalized = this.normalizeError(error);
      phase = 'onError';
      for (const hook of [...definition.hooks.onError].reverse()) {
        const handled = await hook({
          ...base(),
          params,
          rawParams: request.params,
          cause: error,
          name: normalized.name,
          error: normalized,
          phase: failedPhase,
        });
        if (handled !== undefined) {
          response = handled instanceof IpcError ? this.errorResponse(handled) : handled;
          break;
        }
      }
      response ??= this.errorResponse(error);
    }

    const duration = performance.now() - startedAt;
    phase = 'onAfterResponse';
    for (const hook of [...definition.hooks.onAfterResponse].reverse()) {
      try {
        await hook({
          ...base(),
          params,
          output,
          response: response!,
          cause: caught,
          phase,
          success: !response!.error,
          duration,
        });
      } catch (error) {
        this.options.onAfterResponseError?.(error, definition.path);
      }
    }

    return response!;
  }

  private executeMiddleware(
    definition: HandlerDefinition<TContext, TStore>,
    params: unknown,
    initialContext: RuntimeContext<TContext, TStore>,
    base: () => LifecycleBase<TContext, TStore>,
  ): Promise<unknown> {
    const dispatch = async (
      index: number,
      context: RuntimeContext<TContext, TStore>,
    ): Promise<unknown> => {
      const middleware = definition.middleware[index];
      if (!middleware) {
        return definition.handler({ ...base(), ...context, params });
      }
      return middleware({ ...base(), ...context, params }, extension =>
        dispatch(index + 1, { ...context, ...extension }),
      );
    };
    return dispatch(0, initialContext);
  }

  private errorResponse(error: unknown): IpcResponse {
    const mapped = this.normalizeError(error);
    return {
      error: {
        name: mapped.name,
        message: mapped.message,
        data: mapped.data,
        ...(this.options.exposeStack ? { stack: mapped.stack } : {}),
      },
    };
  }

  private normalizeError(error: unknown): IpcError {
    if (error instanceof IpcError) return error;

    if (error instanceof Error) {
      for (const [constructor, mapper] of this.errorMappers) {
        if (error instanceof constructor) return mapper(error);
      }

      return fail(error.name, {
        message: error.message,
        cause: error,
      });
    }

    const normalized = new Error(String(error));
    return fail('INTERNAL_SERVER_ERROR', {
      message: 'Internal IPC error',
      cause: normalized,
    });
  }

  private defaultError(
    constructor: AnyErrorConstructor,
    error: Error,
    name = constructor.name,
  ): IpcError {
    return fail(name, {
      message: error.message,
      cause: error,
    });
  }
}

export function createIpcora<TContext extends object = {}, TStore extends object = {}>(
  options?: IpcoraOptions,
): Ipcora<TContext, TStore> {
  return new Ipcora<TContext, TStore>(options);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function createEventEmitter(ipcora: Ipcora<any, any, any, any, any, any>): unknown {
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === 'then') {
        return undefined;
      }

      if (property === Symbol.toStringTag) {
        return 'IpcoraEventEmitter';
      }

      if (typeof property !== 'string') {
        return undefined;
      }

      return (payload: unknown, options?: EventEmitOptions) =>
        ipcora.emit(property, payload, options);
    },
  });
}
