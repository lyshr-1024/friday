import { Hono } from "hono";
import { ask } from "./ask.js";
import { health } from "./health.js";

export const app = new Hono().route("/", health).route("/", ask);
