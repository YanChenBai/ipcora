import { createElectronIpcora } from "@ipcora/electron";
import { type } from "arktype";
import { randomUUID } from "crypto";

import type { InferDefinition } from "ipcora/client";
import { defineEventSchema } from "ipcora/event";

const userEvents = defineEventSchema({
  created: type({
    name: "string",
  }),
});

export const ipc = createElectronIpcora()
  .state("users", new Map<string, string>())
  .events("user", userEvents)
  .handler("ping", () => "pong")
  .handler(
    "user.get",
    ({ params, store }) => {
      return store.users.get(params.id);
    },
    {
      params: type({
        id: "string",
      }),
      metadata: type({
        accessToken: type("string"),
      }),
    },
  )
  .handler(
    "user.register",
    ({ params, store }) => {
      store.users.set(randomUUID(), params.name);
    },
    {
      params: type({
        name: "string",
      }),
    },
  );

export type Ipc = InferDefinition<typeof ipc>;
