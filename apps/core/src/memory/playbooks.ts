import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PlaybookCategory } from "@friday/shared";
import { config } from "../config.js";

export const playbookDir = () => join(config.dataDir, "playbooks");
export const playbookPath = (category: PlaybookCategory) => join(playbookDir(), `${category}.md`);

export function readPlaybook(category: PlaybookCategory): string {
  try {
    return readFileSync(playbookPath(category), "utf8");
  } catch {
    return "";
  }
}

export function writePlaybook(category: PlaybookCategory, content: string): void {
  mkdirSync(playbookDir(), { recursive: true });
  const path = playbookPath(category);
  writeFileSync(`${path}.tmp`, content);
  renameSync(`${path}.tmp`, path);
}
