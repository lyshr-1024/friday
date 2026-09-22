import { createReadStream, statSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import { Hono } from "hono";
import { config } from "../config.js";
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
/**
 * 呼出时拍的窗口截图（<dataDir>/summon-shots/<uuid>.png）。
 * WebView 读不了 file://，CSP 也没放行 asset:，所以跟背景图走同一条通道。
 * 只收 uuid、目录写死，路径不来自调用方。
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const background = new Hono()
  .get("/summon-shot/:id", (c) => {
    const id = c.req.param("id");
    if (!UUID.test(id)) return c.json({ error: "无效的截图 id" }, 400);
    const path = join(config.dataDir, "summon-shots", `${id}.png`);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return c.json({ error: "截图不存在" }, 404);
    }
    c.header("content-type", "image/png");
    c.header("content-length", String(size));
    c.header("cache-control", "private, max-age=300");
    return c.body(createReadStream(path) as unknown as ReadableStream);
  })
  .get("/background", (c) => {
  const path = userSettings().background;
  if (!path) return c.json({ error: "没有设置背景图" }, 404);
  const checked = checkBackground(path);
  if ("error" in checked) return c.json(checked, 404);
  c.header("content-type", checked.mime);
  c.header("content-length", String(checked.size));
  c.header("cache-control", "no-cache");
  return c.body(createReadStream(path) as unknown as ReadableStream);
});
