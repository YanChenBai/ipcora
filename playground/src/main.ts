import { createIpcoraClient } from "@ipcora/electron/renderer";
import type { Ipc } from "./renderer.ts";

export const ipc = createIpcoraClient<Ipc>();
