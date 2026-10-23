import { userSettings } from "../settings.js";
import { getTool } from "./registry.js";
import type { Chunk } from "./web/index.js";
import type { LarkDoc } from "./lark/index.js";

export type RoleName = "workItems" | "chat" | "docs" | "web";

export interface DocsRole {
  owns(url: string): boolean;
  read(url: string, opts?: { timeoutMs?: number }): Promise<LarkDoc | undefined>;
  excerpt(doc: LarkDoc, selection?: string, max?: number): string;
  title(url: string): Promise<string | undefined>;
}

export interface WebRole { readChunk(url: string, offset?: number): Promise<Chunk> }

// 由 workItems / chat 的搬家任务补上成员
export interface WorkItemsRole {}
export interface ChatRole {}

export interface RoleImpl { workItems: WorkItemsRole; chat: ChatRole; docs: DocsRole; web: WebRole }

const impls = new Map<RoleName, { tool: string; impl: RoleImpl[RoleName] }>();

export function implementRole<R extends RoleName>(name: R, tool: string, impl: RoleImpl[R]): void {
  impls.set(name, { tool, impl });
}

export function role<R extends RoleName>(name: R): RoleImpl[R] {
  const tool = userSettings().roles[name];
  const hit = impls.get(name);
  const reg = tool ? getTool(tool) : undefined;
  if (!hit || hit.tool !== tool || !reg || !reg.enabled || reg.draft) throw new Error(`角色 ${name} 没有可用的工具`);
  return hit.impl as RoleImpl[R];
}
