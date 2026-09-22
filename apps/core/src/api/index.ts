import { Hono } from "hono";
import { cors } from "hono/cors";
import { activity } from "./activity.js";
import { ask } from "./ask.js";
import { attachments } from "./attachments.js";
import { background } from "./background.js";
import { conversation } from "./conversation.js";
import { desk } from "./desk.js";
import { health } from "./health.js";
import { note } from "./note.js";
import { route } from "./route.js";
import { mcp } from "./mcp.js";
import { events } from "./events.js";
import { run } from "./run.js";
import { settings } from "./settings.js";
import { tasks } from "./tasks.js";
import { hot } from "./hot.js";
import { inbox } from "./inbox.js";
import { jobs } from "./jobs.js";
import { links } from "./links.js";
import { memory } from "./memory.js";
import { searchApi } from "./search.js";
import { slack } from "./slack.js";
import { usage } from "./usage.js";
import { summonApi } from "./summon.js";

// 只放行 Tauri WebView 自己的源；API 虽只监听回环，但浏览器里的任意网页也能打 127.0.0.1，不能用 *。
// core 只监听回环，任何本机页面（vite 任意端口、截图验收）都可以访问
const isLocalOrigin = (origin: string) => /^(tauri:\/\/localhost|http:\/\/tauri\.localhost|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(origin) ? origin : "";

export const app = new Hono()
  .use(cors({ origin: isLocalOrigin, allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"], allowHeaders: ["content-type", "accept"] }))
  .route("/", health)
  .route("/", ask)
  .route("/", note)
  .route("/", hot)
  .route("/", run)
  .route("/", settings)
  .route("/", conversation)
  .route("/", memory)
  .route("/", searchApi)
  .route("/", inbox)
  .route("/", jobs)
  .route("/", attachments)
  .route("/", background)
  .route("/", desk)
  .route("/", tasks)
  .route("/", route)
  .route("/", mcp)
  .route("/", events)
  .route("/", links)
  .route("/", slack)
  .route("/", usage)
  .route("/", activity)
  .route("/", summonApi);
