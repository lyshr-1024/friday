import type { Connector } from "./types.js";
import { meegleClient } from "./meegle/index.js";

export const connectors: Connector[] = [meegleClient];
