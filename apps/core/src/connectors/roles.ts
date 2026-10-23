import { userSettings } from "../settings.js";
import { getTool } from "./registry.js";
import type { Chunk } from "./web/index.js";
import type { LarkDoc } from "./lark/index.js";
import type { InboxItem, InboxKind, PriorLine, StateTransition } from "@friday/shared";
import type { NewInboxItem } from "../memory/inbox.js";
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
export interface ChatLine { ts: string; threadTs?: string; userId?: string; userName: string; text: string }
export interface ChatRole {
  configured(): Promise<boolean>;
  /** 当前登录的账号；拿不到凭证返回 undefined */
  self(): Promise<{ id: string; teamId?: string; url?: string } | undefined>;
  pull(me: string, cursors: Record<string, string | undefined>, now: number, teamUrl?: string): Promise<{ items: NewInboxItem[]; cursors: Record<string, string> }>;
  context(item: InboxItem): Promise<ChatLine[]>;
  /** 每轮同步取一次已读游标，返回判定函数：已读或我已回 */
  settledChecker(me: string): Promise<(item: InboxItem) => Promise<boolean>>;
  post(args: { channel: string; text: string; threadTs?: string }, caller: Caller): Promise<{ ts: string; permalink?: string }>;
  remove(args: { channel: string; ts: string }, caller: Caller): Promise<void>;
  live(channel?: string, person?: string): Promise<{ channelId?: string; lines: ChatLine[]; me?: string }>;
  parseTitle(title: string): { channel?: string; person?: string };
  ownsApp(bundleId: string): boolean;
  renderPrior(lines: PriorLine[], scene: { kind: InboxKind; peer?: string; peerId?: string }): string[];
  displayNames(): Map<string, string>;
  warm(): Promise<void>;
  /** 凭证失效（invalid_auth 等）时丢掉缓存，下一轮重读钥匙串 */
  resetAuth(): void;
}

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
