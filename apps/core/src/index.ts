import { serve } from "@hono/node-server";
import { app } from "./api/index.js";
import { config } from "./config.js";

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`friday-core listening on http://${info.address}:${info.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => process.exit(0));
}
