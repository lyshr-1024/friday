import { createReadStream, statSync } from "node:fs";
import { extname, isAbsolute } from "node:path";
import { Hono } from "hono";
import { userSettings } from "../settings.js";

const MAX_BYTES = 10 * 1024 * 1024;
const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** 背景图的类型和大小，路径合法才返回；设置页存之前也用它验一遍 */
export function checkBackground(path: string): { mime: string; size: number } | { error: string } {
  if (!isAbsolute(path)) return { error: "需要绝对路径" };
  const mime = TYPES[extname(path).toLowerCase()];
  if (!mime) return { error: "只支持 png / jpg / webp" };
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) return { error: "不是文件" };
    size = st.size;
  } catch {
    return { error: "找不到这个文件" };
  }
  if (size > MAX_BYTES) return { error: "图片超过 10MB" };
  return { mime, size };
}

/**
 * 路径只认 settings.json 里存的那一条，不接受调用方传——
 * 否则这就是个任意文件读取接口。
 */
export const background = new Hono().get("/background", (c) => {
  const path = userSettings().background;
  if (!path) return c.json({ error: "没有设置背景图" }, 404);
  const checked = checkBackground(path);
  if ("error" in checked) return c.json(checked, 404);
  c.header("content-type", checked.mime);
  c.header("content-length", String(checked.size));
  c.header("cache-control", "no-cache");
  return c.body(createReadStream(path) as unknown as ReadableStream);
});
