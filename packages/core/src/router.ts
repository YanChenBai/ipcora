import { createIpcError, IpcError } from "./errors";
import type {
  AnyMacroDefinition,
  AnyRecord,
  AnySchema,
  Binding,
  BuiltInHandlerOptions,
  DeriveHook,
  Expand,
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
  LifecycleBase,
  LifecyclePhase,
  MacroDefinition,
  MacroDefinitionExtension,
  MacroDefinitionOption,
  MacroRegistry,
  MaybePromise,
  NormalizeMacroOption,
  OnAfterHandleHook,
  OnAfterResponseHook,
  OnBeforeHandleHook,
  OnErrorHook,
  OnGuardHook,
  OnMapResponseHook,
  OnRequestHook,
  OnTransformHook,
  ResolveHook,
  RuntimeContext,
} from "./types";
import {
  builtInHandlerOptionKeys,
  cloneHooks,
  emptyHooks,
  joinPath,
  normalizeObjectParams,
  parseSchema,
} from "./utils";

/**
 * IPC router. It owns route registration, lifecycle execution, transport
 * binding, macros, and Elysia-style context extension.
 */
export class Ipcora<
  TContext extends object = {},
  TStore extends object = {},
  TMacros extends MacroRegistry = {},
> {
  readonly channel: string;

  private readonly routes: Map<string, HandlerDefinition<any, any>>;
  private readonly bindings: Map<number, Binding<any>>;
  private readonly options: Required<Pick<IpcoraOptions, "exposeStack">> & IpcoraOptions;
  private readonly macros: Map<string, AnyMacroDefinition>;
  private prefix = "";
  private hooks: HookStore<any, any>;
  private middleware: IpcMiddleware<any, any>[] = [];
  private decorators: AnyRecord = {};
  private store: AnyRecord = {};
  private installed = false;

  constructor(options: IpcoraOptions = {}) {
    this.channel = options.channel ?? "ipcora:invoke";
    this.options = { exposeStack: false, ...options };
    this.routes = new Map();
    this.bindings = new Map();
    this.macros = new Map();
    this.hooks = emptyHooks();
  }

  private createScope(prefix: string): Ipcora<TContext, TStore, TMacros> {
    const scope = Object.create(Ipcora.prototype) as Ipcora<TContext, TStore, TMacros>;
    Object.assign(scope, this, {
      prefix,
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
  ): Ipcora<TContext, Expand<TStore & Record<TKey, TValue>>, TMacros>;
  state<const TExtension extends object>(
    values: TExtension,
  ): Ipcora<TContext, Expand<TStore & TExtension>, TMacros>;
  state(keyOrObject: string | object, value?: unknown): Ipcora<TContext, any, TMacros> {
    Object.assign(this.store, normalizeObjectParams(keyOrObject, value));
    return this;
  }

  /**
   * Add static properties directly to every lifecycle value.
   */
  decorate<const TKey extends string, TValue>(
    key: TKey,
    value: TValue,
  ): Ipcora<Expand<TContext & Record<TKey, TValue>>, TStore, TMacros>;
  decorate<const TExtension extends object>(
    values: TExtension,
  ): Ipcora<Expand<TContext & TExtension>, TStore, TMacros>;
  decorate(keyOrObject: string | object, value?: unknown): Ipcora<any, TStore, TMacros> {
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
  ): Ipcora<Expand<TContext & HookReturnExtension<TReturn>>, TStore, TMacros> {
    this.hooks.derive.push(hook as DeriveHook<TContext, TStore>);
    return this as unknown as Ipcora<
      Expand<TContext & HookReturnExtension<TReturn>>,
      TStore,
      TMacros
    >;
  }

  /**
   * Run after validation to derive context from parsed params.
   */
  resolve<TReturn>(
    hook: (
      value: LifecycleBase<TContext, TStore> & { params: unknown; rawParams: unknown },
    ) => MaybePromise<TReturn>,
  ): Ipcora<Expand<TContext & HookReturnExtension<TReturn>>, TStore, TMacros> {
    this.hooks.resolve.push(hook as ResolveHook<TContext, TStore>);
    return this as unknown as Ipcora<
      Expand<TContext & HookReturnExtension<TReturn>>,
      TStore,
      TMacros
    >;
  }

  /**
   * Register a custom handler option that expands into lifecycle hooks.
   */
  macro<
    const TName extends string,
    const TDefinition extends MacroDefinition<TContext, TStore, any, any>,
  >(
    name: TName,
    definition: TDefinition,
  ): Ipcora<
    Expand<TContext & MacroDefinitionExtension<TDefinition>>,
    TStore,
    Expand<
      TMacros &
        Record<
          TName,
          MacroDefinition<
            TContext,
            TStore,
            NormalizeMacroOption<MacroDefinitionOption<TDefinition>>,
            MacroDefinitionExtension<TDefinition>
          >
        >
    >
  > {
    this.macros.set(name, definition);
    return this as unknown as Ipcora<
      Expand<TContext & MacroDefinitionExtension<TDefinition>>,
      TStore,
      Expand<
        TMacros &
          Record<
            TName,
            MacroDefinition<
              TContext,
              TStore,
              NormalizeMacroOption<MacroDefinitionOption<TDefinition>>,
              MacroDefinitionExtension<TDefinition>
            >
          >
      >
    >;
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

  /**
   * Compatibility alias for `onTransform`.
   */
  transform(hook: OnTransformHook<TContext, TStore>): this {
    return this.onTransform(hook);
  }

  onGuard<TReturn>(
    hook: (value: LifecycleBase<TContext, TStore> & { params: unknown }) => MaybePromise<TReturn>,
  ): Ipcora<Expand<TContext & HookReturnExtension<TReturn>>, TStore, TMacros> {
    this.hooks.onGuard.push(hook as OnGuardHook<TContext, TStore>);
    return this as unknown as Ipcora<
      Expand<TContext & HookReturnExtension<TReturn>>,
      TStore,
      TMacros
    >;
  }

  /**
   * Compatibility alias for `onGuard`.
   */
  guard<TReturn>(
    hook: (value: LifecycleBase<TContext, TStore> & { params: unknown }) => MaybePromise<TReturn>,
  ): Ipcora<Expand<TContext & HookReturnExtension<TReturn>>, TStore, TMacros> {
    return this.onGuard(hook);
  }

  onBeforeHandle(hook: OnBeforeHandleHook<TContext, TStore>): this {
    this.hooks.onBeforeHandle.push(hook);
    return this;
  }

  beforeHandle(hook: OnBeforeHandleHook<TContext, TStore>): this {
    return this.onBeforeHandle(hook);
  }

  onAfterHandle(hook: OnAfterHandleHook<TContext, TStore>): this {
    this.hooks.onAfterHandle.push(hook);
    return this;
  }

  afterHandle(hook: OnAfterHandleHook<TContext, TStore>): this {
    return this.onAfterHandle(hook);
  }

  onMapResponse(hook: OnMapResponseHook<TContext, TStore>): this {
    this.hooks.onMapResponse.push(hook);
    return this;
  }

  mapResponse(hook: OnMapResponseHook<TContext, TStore>): this {
    return this.onMapResponse(hook);
  }

  onError(hook: OnErrorHook<TContext, TStore>): this {
    this.hooks.onError.push(hook);
    return this;
  }

  onAfterResponse(hook: OnAfterResponseHook<TContext, TStore>): this {
    this.hooks.onAfterResponse.push(hook);
    return this;
  }

  afterResponse(hook: OnAfterResponseHook<TContext, TStore>): this {
    return this.onAfterResponse(hook);
  }

  use<TExtension extends object>(
    middleware: IpcMiddleware<TContext, TStore>,
  ): Ipcora<Expand<TContext & TExtension>, TStore, TMacros> {
    this.middleware.push(middleware);
    return this as unknown as Ipcora<Expand<TContext & TExtension>, TStore, TMacros>;
  }

  group(prefix: string, configure: (ipc: Ipcora<TContext, TStore, TMacros>) => unknown): this {
    configure(this.createScope(joinPath(this.prefix, prefix)));
    return this;
  }

  handler<
    TParamsSchema extends AnySchema | undefined = undefined,
    TOutputSchema extends AnySchema | undefined = undefined,
  >(
    path: string,
    handler: HandlerFunction<
      TParamsSchema extends AnySchema ? InferSchemaOutput<TParamsSchema> : void,
      TOutputSchema extends AnySchema ? InferSchemaOutput<TOutputSchema> : unknown,
      TContext,
      TStore
    >,
    options: HandlerOptions<TParamsSchema, TOutputSchema, TContext, TStore, TMacros> = {},
  ): this {
    const fullPath = joinPath(this.prefix, path);
    if (this.routes.has(fullPath)) {
      throw new Error(`Duplicate IPC handler: ${fullPath}`);
    }

    const hooks = cloneHooks(this.hooks);
    this.appendMacroHooks(hooks, options);
    this.appendHandlerHooks(hooks, options);

    this.routes.set(fullPath, {
      path: fullPath,
      handler: handler as HandlerFunction<any, any, TContext, TStore>,
      paramsSchema: options.params,
      outputSchema: options.output,
      middleware: [...this.middleware],
      hooks,
    });
    return this;
  }

  /**
   * Bind a peer to this router. Only bound peers may dispatch calls.
   */
  bind(peer: IpcPeer, options: { context: Partial<TContext> }): () => void {
    this.installTransport();
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
      this.options.transport?.removeHandler(this.channel);
      this.installed = false;
    }
  }

  private appendMacroHooks(
    hooks: HookStore<TContext, TStore>,
    options: HandlerOptions<any, any, TContext, TStore, TMacros>,
  ): void {
    for (const [key, option] of Object.entries(options)) {
      if (builtInHandlerOptionKeys.has(key) || option === undefined) continue;
      const macro = this.macros.get(key);
      if (!macro) continue;
      this.appendMacroHookSet(hooks, macro, option);
    }
  }

  private appendMacroHookSet(
    hooks: HookStore<TContext, TStore>,
    macro: AnyMacroDefinition,
    option: unknown,
  ): void {
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

  private appendHandlerHooks(
    hooks: HookStore<TContext, TStore>,
    options: BuiltInHandlerOptions<any, any, TContext, TStore>,
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

  private installTransport(): void {
    if (this.installed) return;
    const { transport } = this.options;
    if (!transport) {
      throw new Error(
        "IPC transport is required. Pass a transport to createIpcora({ transport }).",
      );
    }
    if (transport.listenerCount(this.channel) > 0) {
      throw new Error(`IPC channel already registered: ${this.channel}`);
    }
    transport.handle(this.channel, (event, request) => this.dispatch(event, request));
    this.installed = true;
  }

  private async dispatch(event: IpcEvent, request: IpcRequest): Promise<IpcResponse> {
    const binding = this.bindings.get(event.sender.id);
    if (!binding) {
      return this.errorResponse(request?.id ?? "", createIpcError("PEER_NOT_BOUND"));
    }
    const definition = this.routes.get(request.path);
    if (!definition) {
      return this.errorResponse(
        request.id,
        createIpcError("HANDLER_NOT_FOUND", {
          message: `IPC handler not found: ${request.path}`,
        }),
      );
    }

    const startedAt = performance.now();
    const metadata = Object.freeze({ ...request.metadata });
    let phase: LifecyclePhase = "onRequest";
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
      error: createIpcError,
    });

    try {
      for (const hook of definition.hooks.onRequest) {
        await hook({ ...base(), request, rawParams: request.params });
      }

      // Transform and derive run before validation so they can normalize raw params
      // and add request-derived context before schemas are evaluated.
      phase = "onTransform";
      for (const hook of definition.hooks.onTransform) {
        const next = await hook({ ...base(), params });
        if (next !== undefined) params = next;
      }

      phase = "derive";
      for (const hook of definition.hooks.derive) {
        const extension = await hook({ ...base(), params, rawParams: request.params });
        if (extension) context = { ...context, ...extension };
      }

      phase = "validation";
      params = await parseSchema(definition.paramsSchema, params);

      phase = "resolve";
      for (const hook of definition.hooks.resolve) {
        const extension = await hook({ ...base(), params, rawParams: request.params });
        if (extension) context = { ...context, ...extension };
      }

      phase = "onGuard";
      for (const hook of definition.hooks.onGuard) {
        const extension = await hook({ ...base(), params });
        if (extension) context = { ...context, ...extension };
      }

      phase = "onBeforeHandle";
      for (const hook of definition.hooks.onBeforeHandle) {
        await hook({ ...base(), params });
      }

      phase = "handler";
      output = await this.executeMiddleware(definition, params, context, base);

      phase = "onAfterHandle";
      for (const hook of [...definition.hooks.onAfterHandle].reverse()) {
        const next = await hook({ ...base(), params, output });
        if (next !== undefined) output = next;
      }

      phase = "validation";
      output = await parseSchema(definition.outputSchema, output);
      response = { id: request.id, ok: true, data: output };

      phase = "onMapResponse";
      for (const hook of [...definition.hooks.onMapResponse].reverse()) {
        const next = await hook({ ...base(), params, output, response });
        if (next !== undefined) response = next;
      }
    } catch (error) {
      caught = error;
      const failedPhase = phase;
      phase = "onError";
      for (const hook of [...definition.hooks.onError].reverse()) {
        const handled = await hook({
          ...base(),
          params,
          rawParams: request.params,
          cause: error,
          phase: failedPhase,
        });
        if (handled !== undefined) {
          response = handled;
          break;
        }
      }
      response ??= this.errorResponse(request.id, error);
    }

    const duration = performance.now() - startedAt;
    phase = "onAfterResponse";
    for (const hook of [...definition.hooks.onAfterResponse].reverse()) {
      try {
        await hook({
          ...base(),
          params,
          output,
          response: response!,
          cause: caught,
          phase,
          success: response!.ok,
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

  private errorResponse(id: string, error: unknown): IpcResponse {
    if (error instanceof IpcError) {
      return {
        id,
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          data: error.data,
          ...(this.options.exposeStack ? { stack: error.stack } : {}),
        },
      };
    }
    const normalized = error instanceof Error ? error : new Error(String(error));
    return {
      id,
      ok: false,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal IPC error",
        ...(this.options.exposeStack ? { stack: normalized.stack } : {}),
      },
    };
  }
}

export function createIpcora<TContext extends object = {}, TStore extends object = {}>(
  options?: IpcoraOptions,
): Ipcora<TContext, TStore> {
  return new Ipcora<TContext, TStore>(options);
}
