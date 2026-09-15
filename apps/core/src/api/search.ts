import { Hono } from "hono";
import { search } from "../memory/search.js";

export const searchApi = new Hono().get("/search", (c) => c.json(search(c.req.query("q") ?? "")));
