import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { Attachment } from "@friday/shared";
import { config } from "../config.js";
import { db } from "./db.js";

interface Row {
  id: string;
  name: string;
  mime: string;
  size: number;
  path: string;
  created_at: string;
}

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const dir = () => join(config.dataDir, "attachments");

export function saveAttachment(name: string, mime: string, data: Buffer): Attachment {
  mkdirSync(dir(), { recursive: true });
  const id = randomUUID();
  const path = join(dir(), `${id}${extname(name).slice(0, 10)}`);
  writeFileSync(path, data);
  const createdAt = new Date().toISOString();
  db().prepare("INSERT INTO attachments (id, name, mime, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, name, mime, data.length, path, createdAt);
  return { id, name, mime, size: data.length, createdAt };
}

export function getAttachment(id: string): (Attachment & { path: string }) | undefined {
  const r = db().prepare("SELECT * FROM attachments WHERE id = ?").get(id) as unknown as Row | undefined;
  return r ? { id: r.id, name: r.name, mime: r.mime, size: r.size, path: r.path, createdAt: r.created_at } : undefined;
}

export function readAttachment(id: string): { meta: Attachment & { path: string }; data: Buffer } | undefined {
  const meta = getAttachment(id);
  if (!meta) return undefined;
  try {
    return { meta, data: readFileSync(meta.path) };
  } catch {
    return undefined;
  }
}
