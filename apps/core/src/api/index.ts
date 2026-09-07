import { Hono } from "hono";
import { cors } from "hono/cors";
import { ask } from "./ask.js";
import { attachments } from "./attachments.js";
import { conversation } from "./conversation.js";
import { desk } from "./desk.js";
import { health } from "./health.js";
import { note } from "./note.js";
import { run } from "./run.js";
import { settings } from "./settings.js";
import { threads } from "./threads.js";
import { hot } from "./hot.js";
import { inbox } from "./inbox.js";
import { jobs } from "./jobs.js";
import { memory } from "./memory.js";

// 只放行 Tauri WebView 自己的源；API 虽只监听回环，但浏览器里的任意网页也能打 127.0.0.1，不能用 *。
const ALLOWED_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "http://localhost:1420"];

export const app = new Hono()
  .use(cors({ origin: ALLOWED_ORIGINS, allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"], allowHeaders: ["content-type", "accept"] }))
  .route("/", health)
  .route("/", ask)
  .route("/", note)
  .route("/", hot)
  .route("/", run)
  .route("/", settings)
  .route("/", conversation)
  .route("/", memory)
  .route("/", inbox)
  .route("/", jobs)
  .route("/", attachments)
  .route("/", threads)
  .route("/", desk);
