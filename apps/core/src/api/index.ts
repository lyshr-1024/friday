import { Hono } from "hono";
import { health } from "./health.js";

export const app = new Hono().route("/", health);
