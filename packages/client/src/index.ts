type AnyFunction = (...args: any[]) => any;

type Client<T> = T extends AnyFunction
  ? (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>>
  : T extends object
    ? {
        [K in keyof T]: Client<T[K]>;
      }
    : never;

interface ClientCall {
  /**
   * 完整路径数组。
   *
   * @example ["window", "raw", "move"]
   */
  path: string[];

  /**
   * 拼接后的 IPC channel。
   *
   * @example "window.raw.move"
   */
  channel: string;

  /**
   * 方法所在的命名空间。
   *
   * @example "window.raw"
   */
  namespace: string;

  /**
   * 最终调用的方法名。
   *
   * @example "move"
   */
  method: string;

  /**
   * 调用参数。
   */
  args: unknown[];
}

interface CreateClientOptions {
  invoke(call: ClientCall): unknown | Promise<unknown>;
}

export function createClient<TDefinition extends object>(
  definition: TDefinition,
  options: CreateClientOptions,
): Client<TDefinition> {
  return createProxy({
    node: definition,
    path: [],
    invoke: options.invoke,
  }) as Client<TDefinition>;
}

interface ProxyContext {
  node: unknown;
  path: string[];
  invoke: CreateClientOptions["invoke"];
}

function createProxy(context: ProxyContext): unknown {
  const target = function clientProxyTarget() {};

  return new Proxy(target, {
    get(_target, property) {
      if (property === "then") {
        return undefined;
      }

      if (property === Symbol.toStringTag) {
        return "IpcoraClient";
      }

      if (property === Symbol.for("nodejs.util.inspect.custom")) {
        return () => {
          const channel = context.path.join(".");

          return channel ? `[IpcoraClient ${channel}]` : "[IpcoraClient]";
        };
      }

      if (typeof property !== "string") {
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
      });
    },

    apply(_target, _thisArg, args) {
      if (context.path.length === 0) {
        throw new TypeError("The root client cannot be called directly");
      }

      if (typeof context.node !== "function") {
        throw new TypeError(`"${formatPath(context.path)}" is a namespace and cannot be called`);
      }

      const method = context.path.at(-1)!;
      const namespace = context.path.slice(0, -1).join(".");
      const channel = context.path.join(".");

      return context.invoke({
        path: [...context.path],
        channel,
        namespace,
        method,
        args,
      });
    },
  });
}

function isNamespaceNode(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === "object";
}

function formatPath(path: string[]): string {
  return path.length > 0 ? path.join(".") : "<root>";
}
