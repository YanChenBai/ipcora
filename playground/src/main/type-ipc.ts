import process from "node:process";

import type { Infer } from "type-ipc/main";
import { defineEmitter, defineHandler, registerEmitters, registerHandlers } from "type-ipc/main";

export const testHandler = defineHandler("test", {
  ping: (_event, data: string) => {
    // eslint-disable-next-line no-console
    console.log(data);
  },
  getVersions() {
    const { electron, chrome, node } = process.versions;

    return {
      electron,
      chrome,
      node,
    };
  },
});

export const createTestEmitter = defineEmitter("test", {} as { Update: string });

export const handlers = registerHandlers(testHandler);
export const emitters = registerEmitters(createTestEmitter);

export type Invoke = Infer<typeof handlers>;
export type Message = Infer<typeof emitters>;
