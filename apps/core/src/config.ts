import { DEFAULT_CORE_PORT } from "@friday/shared";

export const config = {
  host: "127.0.0.1",
  port: Number(process.env.FRIDAY_PORT ?? DEFAULT_CORE_PORT),
  version: process.env.npm_package_version ?? "0.1.0",
};
