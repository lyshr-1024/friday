import { userSettings } from "../settings.js";
import { getTool } from "./registry.js";
import type { Chunk } from "./web/index.js";
import type { LarkDoc } from "./lark/index.js";
import type { ExternalRef, InboxItem, InboxKind, PriorLine, StateTransition } from "@friday/shared";
import type { Undo } from "../memory/audit.js";
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

export type WorkItemState = "open" | "in_progress" | "testing" | "done" | "reopened";
export type WorkItemKind = "story" | "defect" | "other";
/** 同步链路的一条工单：原 MeegleWorkItem 的全部字段 + 归一化的 kind / state */
export type WorkItem = MeegleWorkItem & { kind: WorkItemKind; state: WorkItemState };
/** 撤销说明里工具自己的那几种，只有工具解释 */
export type WorkItemUndo = Extract<Undo, { kind: "meegle_state" | "meegle_node" }>;

/** ext 一律是卡上的 external：attrs 里空间、节点这些只有工具自己认，业务侧原样递过来 */
export interface WorkItemsRole {
  listMine(): Promise<WorkItem[]>;
  fetchOne(ext: ExternalRef): Promise<WorkItem>;
  get(ext: ExternalRef): Promise<{ name: string; typeKey?: string; stateKey: string; stateLabel: string; state: WorkItemState } | undefined>;
  released(ext: ExternalRef): Promise<boolean>;
  transitions(ext: ExternalRef): Promise<StateTransition[]>;
  /** 按意图找流转：in_progress = 「开始处理」那条；没有就 undefined */
  transitionFor(ext: ExternalRef, intent: "in_progress"): Promise<StateTransition | undefined>;
  /** from：调用方记得的当前状态，线上读不到时撤销转回它 */
  transition(ext: ExternalRef, to: StateTransition, caller: Caller, from?: string): Promise<void>;
  nodeReadiness(ext: ExternalRef): Promise<{ missing: string[] }>;
  confirmNode(ext: ExternalRef, caller: Caller): Promise<void>;
  /** 执行工具自己记的撤销说明；工单不让转回去时 false */
  undo(plan: WorkItemUndo, caller: Caller): Promise<boolean>;
  /** 同步链路的一条工单在卡上的引用 */
  external(item: MeegleWorkItem): ExternalRef;
  /** 所属需求的引用（跟着缺陷的空间走）；没挂需求或查不了时 undefined */
  parentRef(ext: ExternalRef): ExternalRef | undefined;
  /** 凭这个引用能不能去工具里查（老卡可能没记空间） */
  addressable(ext: ExternalRef): boolean;
  /** 当前节点：流转要 key，展示只要名字；都没记时 undefined */
  node(ext: ExternalRef): { key?: string; name?: string } | undefined;
  parseRef(input: string): ExternalRef | undefined;
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

/**
 * 按引用自己的工具找解释方：attrs 只有登记它的那个工具认得，跟设置里选的是谁、开没开无关。
 * 给只读的展示用（节点名这类），工具没装就 undefined
 */
export function workItemsFor(ext: ExternalRef): WorkItemsRole | undefined {
  const hit = impls.get("workItems");
  return hit && hit.tool === ext.tool ? (hit.impl as WorkItemsRole) : undefined;
}

export function role<R extends RoleName>(name: R): RoleImpl[R] {
  const tool = userSettings().roles[name];
  const hit = impls.get(name);
  const reg = tool ? getTool(tool) : undefined;
  if (!hit || hit.tool !== tool || !reg || !reg.enabled || reg.draft) throw new Error(`角色 ${name} 没有可用的工具`);
  return hit.impl as RoleImpl[R];
}
