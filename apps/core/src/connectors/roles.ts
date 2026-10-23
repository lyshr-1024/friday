import { userSettings } from "../settings.js";
import { getTool } from "./registry.js";
import type { Chunk } from "./web/index.js";
import type { LarkDoc } from "./lark/index.js";
import type { StateTransition } from "@friday/shared";
import type { MeegleWorkItem } from "./meegle/client.js";
import type { Caller } from "./invoke.js";

export type RoleName = "workItems" | "chat" | "docs" | "web";

export interface DocsRole {
  owns(url: string): boolean;
  read(url: string, opts?: { timeoutMs?: number }): Promise<LarkDoc | undefined>;
  excerpt(doc: LarkDoc, selection?: string, max?: number): string;
  title(url: string): Promise<string | undefined>;
}

export interface WebRole { readChunk(url: string, offset?: number): Promise<Chunk> }

// 由 workItems / chat 的搬家任务补上成员
export interface WorkItemRef { space: string; id: string }
export type WorkItemState = "open" | "in_progress" | "testing" | "done" | "reopened";
export type WorkItemKind = "story" | "defect" | "other";
/** 同步链路的一条工单：原 MeegleWorkItem 的全部字段 + 归一化的 kind / state */
export type WorkItem = MeegleWorkItem & { kind: WorkItemKind; state: WorkItemState };

export interface WorkItemsRole {
  listMine(): Promise<WorkItem[]>;
  fetchOne(ref: WorkItemRef): Promise<WorkItem>;
  get(ref: WorkItemRef): Promise<{ name: string; typeKey?: string; stateKey: string; stateLabel: string; state: WorkItemState } | undefined>;
  released(ref: WorkItemRef): Promise<boolean>;
  transitions(ref: WorkItemRef): Promise<StateTransition[]>;
  /** 按意图找流转：in_progress = 「开始处理」那条；没有就 undefined */
  transitionFor(ref: WorkItemRef, intent: "in_progress"): Promise<StateTransition | undefined>;
  transition(ref: WorkItemRef, to: StateTransition, caller: Caller): Promise<void>;
  nodeReadiness(ref: WorkItemRef, nodeKey: string): Promise<{ missing: string[] }>;
  confirmNode(ref: WorkItemRef, nodeKey: string, caller: Caller): Promise<void>;
  rollbackNode(ref: WorkItemRef, nodeKey: string, caller: Caller): Promise<void>;
  undoTransition(ref: WorkItemRef, backTo: string, caller: Caller): Promise<boolean>;
  parseRef(input: string): WorkItemRef | undefined;
  idFromUrl(url: string): string | undefined;
  idsIn(text: string): string[];
  stateOf(stateKey: string, stateLabel?: string): WorkItemState;
  kindOf(typeKey?: string): WorkItemKind;
  ownsHost(host: string): boolean;
}
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
