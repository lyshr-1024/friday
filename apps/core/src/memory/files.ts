import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryFile } from "@friday/shared";
import { config } from "../config.js";

export const MEMORY_FILES: Record<MemoryFile, string> = { projects: "projects.md", decisions: "decisions.md", people: "people.md" };

export function memoryPath(name: MemoryFile): string {
  return join(config.dataDir, MEMORY_FILES[name]);
}

export function readMemoryFile(name: MemoryFile): string {
  try {
    return readFileSync(memoryPath(name), "utf8");
  } catch {
    return "";
  }
}

// 先写临时文件再改名，避免写一半被读到。
export function writeMemoryFile(name: MemoryFile, content: string): void {
  const path = memoryPath(name);
  writeFileSync(`${path}.tmp`, content);
  renameSync(`${path}.tmp`, path);
}
