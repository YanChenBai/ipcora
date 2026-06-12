import { createClient, type Client, type CreateClientOptions } from 'ipcora/client';
import type { InferDefinition } from 'ipcora/client';

import type { IpcoraBridge } from './preload';

export type { Client, CreateClientOptions, InferDefinition };

/**
 * Options for {@link createIpcoraClient}.
 */
export interface CreateIpcoraClientOptions extends Pick<
  CreateClientOptions,
  'metadata' | 'onMetadata'
> {
  /** Key on `window` where the preload bridge is exposed. @default "__IPCORA__" */
  apiKey?: string;
}

function getBridge(apiKey: string): IpcoraBridge {
  const bridge = (window as unknown as Record<string, unknown>)[apiKey] as IpcoraBridge | undefined;
  if (!bridge) {
    throw new Error(
      `Ipcora bridge not found at window.${apiKey}. ` +
        `Ensure exposeIpcoraBridge({ apiKey: "${apiKey}" }) was called in your preload script.`,
    );
  }
  return bridge;
}

/**
 * Create a typed IPC client backed by the preload bridge.
 *
 * @param definition — The router's `definition` object, used purely for type inference.
 * @param options    — Optional API key, static metadata, and metadata hook.
 *
 * @example
 * ```ts
 * // renderer.ts
 * import { createIpcoraClient, type InferDefinition } from "@ipcora/electron/renderer";
 * import type { appIpcora } from "../main/ipc"; // import type only — no runtime dependency
 *
 * // definition is a type-level placeholder; pass the shape at runtime for proxy navigation
 * const client = createIpcoraClient<InferDefinition<typeof appIpcora>>(
 *   {} as InferDefinition<typeof appIpcora>,
 * );
 *
 * const user = await client.invoke.user.get({ id: "1" });
 * //    ^ typed as { data: { id: string; name: string } | null; error: ... }
 * ```
 */
export function createIpcoraClient<TDefinition extends object>(
  definition: TDefinition,
  options?: CreateIpcoraClientOptions,
): Client<TDefinition> {
  const apiKey = options?.apiKey ?? '__IPCORA__';
  const bridge = getBridge(apiKey);

  return createClient<TDefinition>(definition, {
    invoke(call) {
      return bridge.invoke({
        id: `${call.channel}-${Date.now()}`,
        path: call.channel,
        params: call.args.length > 0 ? call.args[0] : undefined,
        metadata: call.metadata,
      });
    },
    subscribe(call) {
      return bridge.subscribe(call.channel, call.listener);
    },
    metadata: options?.metadata,
    onMetadata: options?.onMetadata,
  });
}
