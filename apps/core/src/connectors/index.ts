import type { Connector } from "./types.js";
import { MeegleConnector } from "./meegle.js";

// Slack 第一版不接（拿不到 app 权限），接入时在这里加一项即可。
export const connectors: Connector[] = [new MeegleConnector()];
