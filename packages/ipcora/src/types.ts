import type { fail, IpcError } from './errors';

export type AnyRecord = Record<string, unknown>;
export type Expand<T> = { [K in keyof T]: T[K] } & {};
type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (
  value: infer TResult,
) => void
  ? TResult
  : never;

/**
 * Deep-merge two object types. When both sides have plain-object values at
 * the same key, the merge recurses; otherwise `TRight` wins (preserving the
 * original flat-replace semantics for primitives, functions, arrays, etc.).
 */
export type Merge<TLeft, TRight> = Expand<
  Omit<TLeft, keyof TRight> & {
    [K in keyof TRight]: K extends keyof TLeft
      ? IsPlainObj<TLeft[K]> extends true
        ? IsPlainObj<TRight[K]> extends true
          ? Merge<TLeft[K], TRight[K]>
          : TRight[K]
        : TRight[K]
      : TRight[K];
  }
>;

/** Distributes over unions and returns `true` when `T` is a plain record. */
type IsPlainObj<T> = [T] extends [never]
  ? false
  : T extends (...args: any[]) => any
    ? false
    : T extends readonly any[]
      ? false
      : T extends object
        ? true
        : false;
export type PathToObject<
  TPath extends string,
  TValue,
> = TPath extends `${infer THead}.${infer TTail}`
  ? { [K in THead]: PathToObject<TTail, TValue> }
  : { [K in TPath]: TValue };
export type JoinPathType<TPrefix extends string, TPath extends string> = TPrefix extends ''
  ? TPath
  : TPath extends ''
    ? TPrefix
    : `${TPrefix}.${TPath}`;

/**
 * A value that can be returned immediately or resolved later.
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Named execution phases used when reporting errors to `onError` hooks.
 */
export type LifecyclePhase =
  | 'onRequest'
  | 'onTransform'
  | 'derive'
  | 'validation'
  | 'resolve'
  | 'onGuard'
  | 'onBeforeHandle'
  | 'handler'
  | 'onAfterHandle'
  | 'onMapResponse'
  | 'onError'
  | 'onAfterResponse';

/**
 * Wire request sent from a renderer-side client to the main process.
 */
export interface IpcRequest {
  id: string;
  path: string;
  params?: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * Wire response returned by the main process dispatcher.
 */
export type IpcResponse<T = unknown> =
  | { data: T; error?: undefined }
  | { data?: undefined; error: IpcErrorPayload };

export type IpcErrorPayload<TName extends string = string, TData = unknown> = {
  name: TName;
  message: string;
  data?: TData;
  stack?: string;
};

export type BuiltInErrorPayload =
  | IpcErrorPayload<'PEER_NOT_BOUND'>
  | IpcErrorPayload<'HANDLER_NOT_FOUND'>
  | IpcErrorPayload<'VALIDATION_ERROR'>
  | IpcErrorPayload<'INTERNAL_SERVER_ERROR'>;

export type IpcResult<TData, TError = IpcErrorPayload> =
  | { data: Awaited<TData>; error: null }
  | { data: null; error: TError };

export type AnyErrorConstructor = abstract new (...args: any[]) => Error;
export type ErrorRegistry = Record<string, AnyErrorConstructor>;
export type ErrorMapper<
  TError extends Error = Error,
  TMapped extends IpcError = IpcError,
> = (value: { fail: typeof fail; error: TError }) => TMapped;
export type ErrorMapPayload<TError extends AnyErrorConstructor, TMapped> =
  TMapped extends IpcError<infer TName, infer TData>
    ? IpcErrorPayload<TName, TData>
    : TMapped extends IpcErrorPayload<infer TName, infer TData>
      ? IpcErrorPayload<TName, TData>
      : IpcErrorPayload<InstanceType<TError>['name'], undefined>;
export type ErrorRegistryPayload<TRegistry extends ErrorRegistry> = {
  [K in keyof TRegistry]: IpcErrorPayload<K & string, undefined>;
}[keyof TRegistry];
export type ErrorReturnPayload<TReturn> =
  Exclude<Awaited<TReturn>, void | undefined> extends infer TValue
    ? TValue extends IpcError<infer TName, infer TData>
      ? IpcErrorPayload<TName, TData>
      : TValue extends IpcResponse
        ? TValue extends { error: infer TError }
          ? TError
          : never
        : never
    : never;
export type OnErrorHookPayload<THook> = THook extends (...args: any[]) => infer TReturn
  ? ErrorReturnPayload<TReturn>
  : never;

/**
 * Minimal Standard Schema v1 shape. Libraries such as ArkType, Zod, Valibot,
 * and TypeBox adapters can be consumed through this shared contract.
 */
export interface StandardSchemaV1<TParams = unknown, TOutput = TParams> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => MaybePromise<
      | { value: TOutput; issues?: undefined }
      | { issues: readonly { message: string; path?: readonly unknown[] }[] }
    >;
    readonly types?: {
      readonly input: TParams;
      readonly output: TOutput;
    };
  };
}

export type AnySchema = StandardSchemaV1<any, any>;
export type InferSchemaOutput<TSchema> =
  TSchema extends StandardSchemaV1<any, infer T> ? T : unknown;
export type EventSchema = Record<string, AnySchema>;
export type EventSchemaInput<TEvents extends Record<string, unknown>> = {
  [K in keyof TEvents]: TEvents[K] extends AnySchema ? TEvents[K] : never;
};
export type EventPayload<TSchema> = InferSchemaOutput<TSchema>;
export interface EventDefinition<TName extends string = string, TPayload = unknown> {
  (listener: (payload: TPayload) => void): () => void;
  readonly __ipcoraEvent: true;
  readonly name: TName;
  readonly channel: string;
  readonly once: boolean;
  readonly payload: TPayload;
}
export type EventDefinitions<TEvents extends EventSchema> = Expand<
  {
    [K in keyof TEvents & string as `on${Capitalize<K>}`]: EventDefinition<
      K,
      EventPayload<TEvents[K]>
    >;
  } & {
    [K in keyof TEvents & string as `onOnce${Capitalize<K>}`]: EventDefinition<
      K,
      EventPayload<TEvents[K]>
    >;
  }
>;
export type EventNames<TDefinition> = TDefinition extends object
  ? {
      [K in keyof TDefinition]: TDefinition[K] extends EventDefinition<infer TName, any>
        ? TName
        : never;
    }[keyof TDefinition]
  : never;
export type EventPayloadByName<TDefinition, TName extends string> = TDefinition extends object
  ? {
      [K in keyof TDefinition]: TDefinition[K] extends EventDefinition<TName, infer TPayload>
        ? TPayload
        : never;
    }[keyof TDefinition]
  : never;
export interface EventEmitOptions {
  peers?: Iterable<IpcPeer | number>;
}
export type EventEmitter<TDefinition> = {
  [K in EventNames<TDefinition> & string]: (
    payload: EventPayloadByName<TDefinition, K>,
    options?: EventEmitOptions,
  ) => Promise<void>;
};
export type HookReturnExtension<TReturn> = [TReturn] extends [never]
  ? {}
  : Exclude<Awaited<TReturn>, void | undefined> extends infer TExtension
    ? [TExtension] extends [never]
      ? {}
      : TExtension extends object
        ? TExtension
        : {}
    : {};

/**
 * Minimal sender shape used by adapters.
 */
export interface IpcSender {
  id: number;
}

/**
 * Minimal event shape passed from an adapter to the router.
 */
export interface IpcEvent<TSender extends IpcSender = IpcSender> {
  sender: TSender;
}

/**
 * Adapter object used to install and remove invoke handlers for a platform.
 */
export interface IpcAdapter<TEvent extends IpcEvent = IpcEvent> {
  handle(
    channel: string,
    handler: (event: TEvent, request: IpcRequest) => MaybePromise<IpcResponse>,
  ): void;
  emit(channel: string, sender: TEvent['sender'], payload: unknown): MaybePromise<void>;
  listenerCount(channel: string): number;
  removeHandler(channel: string): void;
}

/**
 * A bound caller allowed to dispatch requests through this router.
 */
export interface IpcPeer<TSender extends IpcSender = IpcSender> {
  id: number;
  sender: TSender;
  onDispose?: (dispose: () => void) => void;
}

export type RuntimeContext<TContext extends object, TStore extends object> = Expand<
  TContext & { store: TStore; peer: IpcPeer; sender: IpcSender; event: IpcEvent }
>;

/**
 * Fields shared by every lifecycle hook.
 */
export type LifecycleBase<TContext extends object, TStore extends object> = RuntimeContext<
  TContext,
  TStore
> & {
  id: string;
  path: string;
  signal: AbortSignal;
  startedAt: number;
  metadata: Readonly<Record<string, unknown>>;
  fail: typeof fail;
};

export type OnRequestHook<TContext extends object, TStore extends object> = (
  value: LifecycleBase<TContext, TStore> & { request: IpcRequest; rawParams: unknown },
) => MaybePromise<void>;

export type OnTransformHook<TContext extends object, TStore extends object> = (
  value: LifecycleBase<TContext, TStore> & { params: unknown },
) => MaybePromise<unknown | void>;

export type DeriveHook<TContext extends object, TStore extends object> = (
  value: LifecycleBase<TContext, TStore> & { params: unknown; rawParams: unknown },
) => MaybePromise<object | void>;

export type ResolveHook<TContext extends object, TStore extends object> = (
  value: LifecycleBase<TContext, TStore> & { params: unknown; rawParams: unknown },
) => MaybePromise<object | void>;

export type OnGuardHook<TContext extends object, TStore extends object> = (
  value: LifecycleBase<TContext, TStore> & { params: unknown },
) => MaybePromise<object | void>;

export type OnBeforeHandleHook<TContext extends object, TStore extends object> = (
  value: LifecycleBase<TContext, TStore> & { params: unknown },
) => MaybePromise<void>;

export type OnAfterHandleHook<TContext extends object, TStore extends object> = (
  value: LifecycleBase<TContext, TStore> & { params: unknown; output: unknown },
) => MaybePromise<unknown | void>;

export type OnMapResponseHook<TContext extends object, TStore extends object> = (
  value: LifecycleBase<TContext, TStore> & {
    params: unknown;
    output: unknown;
    response: IpcResponse;
  },
) => MaybePromise<IpcResponse | void>;

export type OnErrorHook<TContext extends object, TStore extends object> = (
  value: LifecycleBase<TContext, TStore> & {
    params: unknown;
    rawParams: unknown;
    cause: unknown;
    name: string;
    error: IpcError;
    phase: LifecyclePhase;
  },
) => MaybePromise<IpcResponse | IpcError | void>;

export type OnAfterResponseHook<TContext extends object, TStore extends object> = (
  value: LifecycleBase<TContext, TStore> & {
    params: unknown;
    output: unknown;
    response: IpcResponse;
    cause: unknown;
    phase: LifecyclePhase;
    success: boolean;
    duration: number;
  },
) => MaybePromise<void>;

/**
 * The value received by a route handler.
 */
export type HandlerContext<TParams, TContext extends object, TStore extends object> = LifecycleBase<
  TContext,
  TStore
> & {
  params: TParams;
};

export type HandlerFunction<TParams, TOutput, TContext extends object, TStore extends object> = (
  value: HandlerContext<TParams, TContext, TStore>,
) => TOutput | Promise<TOutput>;

export type RouteHandler<TParams, TOutput, TError = never> = TParams extends void
  ? () => Promise<IpcResult<Awaited<TOutput>, BuiltInErrorPayload | TError>>
  : (params: TParams) => Promise<IpcResult<Awaited<TOutput>, BuiltInErrorPayload | TError>>;

/**
 * Middleware wraps handler execution and can extend the runtime context by
 * passing an object to `next`.
 */
export type IpcMiddleware<TContext extends object = object, TStore extends object = object> = (
  value: LifecycleBase<TContext, TStore> & { params: unknown },
  next: (context?: object) => Promise<unknown>,
) => MaybePromise<unknown>;

export interface HookStore<TContext extends object, TStore extends object> {
  onRequest: OnRequestHook<TContext, TStore>[];
  onTransform: OnTransformHook<TContext, TStore>[];
  derive: DeriveHook<TContext, TStore>[];
  resolve: ResolveHook<TContext, TStore>[];
  onGuard: OnGuardHook<TContext, TStore>[];
  onBeforeHandle: OnBeforeHandleHook<TContext, TStore>[];
  onAfterHandle: OnAfterHandleHook<TContext, TStore>[];
  onMapResponse: OnMapResponseHook<TContext, TStore>[];
  onError: OnErrorHook<TContext, TStore>[];
  onAfterResponse: OnAfterResponseHook<TContext, TStore>[];
}

/**
 * Definition for one custom handler option. When a handler uses the option,
 * the matching lifecycle hooks are appended to that route.
 */
export interface MacroDefinition<
  TContext extends object,
  TStore extends object,
  TOption,
  TExtension extends object = {},
> {
  seed?: unknown;
  params?: AnySchema;
  output?: AnySchema;
  onRequest?: MacroHook<OnRequestHook<TContext, TStore>, TOption>;
  onTransform?: MacroHook<OnTransformHook<TContext, TStore>, TOption>;
  derive?: MacroHook<DeriveHook<TContext, TStore>, TOption>;
  resolve?: MacroHook<ResolveHook<TContext, TStore>, TOption, TExtension>;
  onGuard?: MacroHook<OnGuardHook<TContext, TStore>, TOption, TExtension>;
  onBeforeHandle?: MacroHook<OnBeforeHandleHook<TContext, TStore>, TOption>;
  onAfterHandle?: MacroHook<OnAfterHandleHook<TContext, TStore>, TOption>;
  onMapResponse?: MacroHook<OnMapResponseHook<TContext, TStore>, TOption>;
  onError?: MacroHook<OnErrorHook<TContext, TStore>, TOption>;
  onAfterResponse?: MacroHook<OnAfterResponseHook<TContext, TStore>, TOption>;
}

export type MacroFactory<
  TContext extends object,
  TStore extends object,
  TOption,
  TDefinition extends MacroDefinition<TContext, TStore, TOption, any> | void = MacroDefinition<
    TContext,
    TStore,
    TOption,
    any
  > | void,
> = (option: TOption) => MaybePromise<TDefinition>;

export type MacroHook<THook, TOption, TReturn extends object = object> = THook extends (
  value: infer TValue,
) => MaybePromise<infer TResult>
  ? (value: TValue & { option: TOption }) => MaybePromise<TResult | TReturn>
  : never;

export type AnyMacroDefinition = MacroDefinition<any, any, any, any>;
export type AnyMacroFactory = MacroFactory<any, any, any, AnyMacroDefinition | void>;
export type AnyMacroEntry = AnyMacroDefinition | AnyMacroFactory;
export type MacroRegistry = Record<string, AnyMacroEntry>;
type MacroOption<TMacro> =
  TMacro extends MacroDefinition<any, any, infer TOption, any>
    ? TOption
    : TMacro extends (option: infer TOption) => any
      ? TOption
      : never;
type MacroOptions<TMacros extends MacroRegistry> = {
  [K in keyof TMacros]?: MacroOption<TMacros[K]>;
};
type MacroHookExtension<TMacroHook> = [NonNullable<TMacroHook>] extends [
  (...args: any[]) => infer TReturn,
]
  ? HookReturnExtension<TReturn>
  : {};
export type MacroDefinitionExtension<TDefinition> = TDefinition extends (
  ...args: any[]
) => infer TReturn
  ? MacroDefinitionExtension<Exclude<Awaited<TReturn>, void | undefined>>
  : Expand<
      MacroHookExtension<TDefinition extends { derive?: infer THook } ? THook : never> &
        MacroHookExtension<TDefinition extends { resolve?: infer THook } ? THook : never> &
        MacroHookExtension<TDefinition extends { onGuard?: infer THook } ? THook : never>
    >;
type MacroHookOption<TMacroHook> = [NonNullable<TMacroHook>] extends [(value: infer TValue) => any]
  ? TValue extends { option: infer TOption }
    ? TOption
    : never
  : never;
export type MacroDefinitionOption<TDefinition> =
  | MacroHookOption<TDefinition extends { onRequest?: infer THook } ? THook : never>
  | MacroHookOption<TDefinition extends { onTransform?: infer THook } ? THook : never>
  | MacroHookOption<TDefinition extends { derive?: infer THook } ? THook : never>
  | MacroHookOption<TDefinition extends { resolve?: infer THook } ? THook : never>
  | MacroHookOption<TDefinition extends { onGuard?: infer THook } ? THook : never>
  | MacroHookOption<TDefinition extends { onBeforeHandle?: infer THook } ? THook : never>
  | MacroHookOption<TDefinition extends { onAfterHandle?: infer THook } ? THook : never>
  | MacroHookOption<TDefinition extends { onMapResponse?: infer THook } ? THook : never>
  | MacroHookOption<TDefinition extends { onError?: infer THook } ? THook : never>
  | MacroHookOption<TDefinition extends { onAfterResponse?: infer THook } ? THook : never>;
export type NormalizeMacroOption<TOption> = [TOption] extends [never] ? unknown : TOption;
export type MacroObjectRegistry<
  TContext extends object,
  TStore extends object,
  TDefinitions extends Record<string, AnyMacroEntry>,
> = {
  [K in keyof TDefinitions]: TDefinitions[K] extends AnyMacroFactory
    ? MacroFactory<
        TContext,
        TStore,
        MacroOption<TDefinitions[K]>,
        Exclude<Awaited<ReturnType<TDefinitions[K]>>, void | undefined> extends infer TDefinition
          ? TDefinition extends MacroDefinition<TContext, TStore, MacroOption<TDefinitions[K]>, any>
            ? TDefinition
            : void
          : void
      >
    : TDefinitions[K] extends MacroDefinition<TContext, TStore, any, any>
      ? MacroDefinition<
          TContext,
          TStore,
          NormalizeMacroOption<MacroDefinitionOption<TDefinitions[K]>>,
          MacroDefinitionExtension<TDefinitions[K]>
        >
      : never;
};
export type MacroObjectExtension<TDefinitions extends Record<string, AnyMacroEntry>> = Expand<
  UnionToIntersection<
    {
      [K in keyof TDefinitions]: MacroDefinitionExtension<TDefinitions[K]>;
    }[keyof TDefinitions]
  >
>;

/**
 * Built-in handler options. Macro options are merged into this shape by
 * `HandlerOptions`.
 */
export interface BuiltInHandlerOptions<
  TParamsSchema extends AnySchema | undefined = undefined,
  TOutputSchema extends AnySchema | undefined = undefined,
  TMetadataSchema extends AnySchema | undefined = undefined,
  TContext extends object = object,
  TStore extends object = object,
> {
  params?: TParamsSchema;
  output?: TOutputSchema;
  metadata?: TMetadataSchema;
  onRequest?: OnRequestHook<TContext, TStore>;
  onTransform?: OnTransformHook<TContext, TStore>;
  derive?: DeriveHook<TContext, TStore>;
  resolve?: ResolveHook<TContext, TStore>;
  onGuard?: OnGuardHook<TContext, TStore>;
  onBeforeHandle?: OnBeforeHandleHook<TContext, TStore>;
  onAfterHandle?: OnAfterHandleHook<TContext, TStore>;
  onMapResponse?: OnMapResponseHook<TContext, TStore>;
  onError?: OnErrorHook<TContext, TStore>;
  onAfterResponse?: OnAfterResponseHook<TContext, TStore>;
}

export type HandlerOptions<
  TParamsSchema extends AnySchema | undefined = undefined,
  TOutputSchema extends AnySchema | undefined = undefined,
  TMetadataSchema extends AnySchema | undefined = undefined,
  TContext extends object = object,
  TStore extends object = object,
  TMacros extends MacroRegistry = {},
> = BuiltInHandlerOptions<TParamsSchema, TOutputSchema, TMetadataSchema, TContext, TStore> &
  MacroOptions<TMacros>;

export interface HandlerDefinition<TContext extends object, TStore extends object> {
  path: string;
  handler: HandlerFunction<any, any, TContext, TStore>;
  paramsSchema?: AnySchema;
  outputSchema?: AnySchema;
  metadataSchema?: AnySchema;
  middleware: IpcMiddleware<TContext, TStore>[];
  hooks: HookStore<TContext, TStore>;
}

export interface Binding<TContext extends object> {
  peer: IpcPeer;
  context: Partial<TContext>;
  controller: AbortController;
}

export interface IpcoraOptions {
  /**
   * Unique name for this router. When set, prevents another router with the
   * same name from installing an adapter (deduplication guard).
   */
  name?: string;
  /**
   * When `true`, handler registrations only contribute to the type-level
   * `definition` — no routes are actually registered and no adapter is
   * installed. Useful for composing type-only routers that share schemas
   * without wiring up runtime handlers.
   */
  abstract?: boolean;
  channel?: string;
  adapter?: IpcAdapter;
  exposeStack?: boolean;
  onAfterResponseError?: (error: unknown, path: string) => void;
}
