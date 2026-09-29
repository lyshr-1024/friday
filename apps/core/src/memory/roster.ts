import type { InboxKind, PriorLine } from "@friday/shared";
import { getCursor, listInbox } from "./inbox.js";
import { readMemoryFile } from "./files.js";

/**
 * 搜索接口给的是账号名（jiacheng.zhou），而收件箱里存的是显示名（佳成 (Zhou Jiacheng)）。
 * 同一个人两种叫法，模型对不上。拿收件箱当花名册，把姓名倒过来拼就能认出来——纯本地查表，不多花一次调用。
 */
export function displayNames(): Map<string, string> {
  const out = new Map<string, string>();
  const add = (name: string) => {
    const en = /[（(]([^（）()]+)[）)]\s*$/.exec(name)?.[1];
    if (!en) return;
    const parts = en.toLowerCase().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return;
    out.set(`${parts.slice(1).join("")}.${parts[0]}`, name.trim());
  };
  for (const i of listInbox(true, 500)) add(i.userName);
  for (const m of readMemoryFile("people").matchAll(/^##\s+(.+?)\s*$/gm)) add(m[1]!);
  return out;
}

const ID_SHAPE = /^[UW][A-Z0-9]{8,}$/;

/** userId → 显示名，来自收件箱里发过消息的人 */
export function userNames(): Map<string, string> {
  const out = new Map<string, string>();
  for (const i of listInbox(true, 500)) if (i.userId && i.userName && !ID_SHAPE.test(i.userName)) out.set(i.userId, i.userName);
  return out;
}

export const selfSlackId = () => getCursor("slack:me") ?? "";

export interface PriorContext {
  me: string;
  roster: Map<string, string>;
}

/** 一次请求里建一份，别每段对话各扫一遍收件箱 */
export const priorContext = (): PriorContext => ({ me: selfSlackId(), roster: userNames() });

/**
 * 前文渲染成「人名：内容」。纯本地查表，绝不猜：自己（me 已知才认）→ 花名册 → 入库时认出的名字
 * → 私聊里 userId 恰是对方 → 都没有写「未知成员」，不显示 ID。
 */
export function priorText(lines: PriorLine[], scene: { kind: InboxKind; peer?: string; peerId?: string }, ctx: PriorContext = priorContext()): string[] {
  return lines.map((l) => {
    const stored = l.userName && !ID_SHAPE.test(l.userName) ? l.userName : "";
    const name = l.userId
      ? (ctx.me && l.userId === ctx.me ? "你" : undefined) ??
        ctx.roster.get(l.userId) ??
        (stored || (scene.kind === "dm" && scene.peerId === l.userId ? scene.peer : undefined) || "未知成员")
      : stored;
    return name ? `${name}：${l.text}` : l.text;
  });
}
