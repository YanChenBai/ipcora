import { createClient, type Client, type CreateClientOptions } from 'ipcora/client';
import type { InferDefinition } from 'ipcora/client';

import { ELECTRON_IPCORA_CHANNEL } from './constants';
import type { IpcoraBridge } from './preload';

export type { Client, CreateClientOptions, InferDefinition };

/**
 * Options for {@link createIpcoraClient}.
 */
export type CreateIpcoraClientOptions = Pick<CreateClientOptions, 'metadata' | 'onMetadata'>;

function getBridge(): IpcoraBridge {
  const bridge = (window as unknown as Window).__IPCORA__;
  if (!bridge) {
    throw new Error(
      'Ipcora bridge not found at window.__IPCORA__. ' +
        'Ensure exposeIpcoraBridge() was called in your preload script.',
    );
  }
  return bridge;
}

/**
 * Create a typed IPC client backed by the preload bridge.
 *
 * @param options — Optional static metadata and metadata hook.
 *
 * @example
 * ```ts
 * // renderer.ts
 * import { createIpcoraClient, type InferDefinition } from "@ipcora/electron/renderer";
 * import type { appIpcora } from "../main/ipc"; // import type only — no runtime dependency
 *
 * const client = createIpcoraClient<InferDefinition<typeof appIpcora>>();
 *
 * const user = await client.invoke.user.get({ id: "1" });
 * //    ^ typed as { data: { id: string; name: string } | null; error: ... }
 * ```
 */
export function createIpcoraClient<TDefinition extends object>(
  options?: CreateIpcoraClientOptions,
): Client<TDefinition> {
  const bridge = getBridge();

  return createClient<TDefinition>({
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
    channel: ELECTRON_IPCORA_CHANNEL,
    metadata: options?.metadata,
    onMetadata: options?.onMetadata,
  });
}
