import { createIpcError } from "./errors";
import type { AnySchema, HookStore } from "./types";

export const builtInHandlerOptionKeys = new Set([
  "params",
  "output",
  "onRequest",
  "onTransform",
  "derive",
  "resolve",
  "onGuard",
  "onBeforeHandle",
  "onAfterHandle",
  "onMapResponse",
  "onError",
  "onAfterResponse",
]);

export function emptyHooks<TContext extends object, TStore extends object>(): HookStore<
  TContext,
  TStore
> {
  return {
    onRequest: [],
    onTransform: [],
    derive: [],
    resolve: [],
    onGuard: [],
    onBeforeHandle: [],
    onAfterHandle: [],
    onMapResponse: [],
    onError: [],
    onAfterResponse: [],
  };
}

export function cloneHooks<TContext extends object, TStore extends object>(
  hooks: HookStore<TContext, TStore>,
): HookStore<TContext, TStore> {
  return {
    onRequest: [...hooks.onRequest],
    onTransform: [...hooks.onTransform],
    derive: [...hooks.derive],
    resolve: [...hooks.resolve],
    onGuard: [...hooks.onGuard],
    onBeforeHandle: [...hooks.onBeforeHandle],
    onAfterHandle: [...hooks.onAfterHandle],
    onMapResponse: [...hooks.onMapResponse],
    onError: [...hooks.onError],
    onAfterResponse: [...hooks.onAfterResponse],
  };
}

export function joinPath(...parts: string[]): string {
  return parts
    .flatMap(part => part.split("."))
    .map(part => part.trim())
    .filter(Boolean)
    .join(".");
}

export async function parseSchema(schema: AnySchema | undefined, value: unknown): Promise<unknown> {
  if (!schema) return value;
  const result = await schema["~standard"].validate(value);
  if ("issues" in result && result.issues) {
    throw createIpcError("VALIDATION_ERROR", {
      message: result.issues.map(issue => issue.message).join("; "),
      data: result.issues,
    });
  }
  return result.value;
}

export function normalizeObjectParams(keyOrObject: string | object, value: unknown): object {
  if (typeof keyOrObject === "string") return { [keyOrObject]: value };
  return keyOrObject;
}
