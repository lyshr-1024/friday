import { z } from "zod";
import type { ExternalRef, InboxItem } from "@friday/shared";
import { untrusted } from "../../agent/fence.js";
import { listInbox, CONV_SCAN_LIMIT } from "../../memory/inbox.js";
import { conversationKey } from "../../memory/infer.js";
import { defineBuiltin } from "../builtin.js";
import { invokeTool, type Caller } from "../invoke.js";
import { implementRole, type ChatLine } from "../roles.js";
import {
  deleteMessage,
  fetchContext,
  fetchLastRead,
  fetchSlack,
  isRead,
  loadSlackCreds,
  lookupUserName,
  postMessage,
  repliedSince,
  slackCaller,
  slackConfigured,
  warmSlack,
  type SlackCreds,
} from "./client.js";
import { liveConversation } from "./live.js";
import { displayNames, priorContext, priorText, userNames, type PriorContext } from "./roster.js";
import { ownsApp, parseTitle } from "./title.js";

export const SLACK_NOT_CONNECTED = "Slack 未接入";

// 同步链路缓存登录态，失效时 resetAuth 丢掉；发送、撤回、呼出每次现读钥匙串
let creds: SlackCreds | undefined;

async function syncApi() {
  creds ??= await loadSlackCreds();
  return creds && slackCaller(creds);
}

async function freshApi() {
  const c = await loadSlackCreds();
  if (!c) throw new Error(SLACK_NOT_CONNECTED);
  return slackCaller(c);
}

async function context(item: Pick<InboxItem, "channelId" | "ts" | "threadTs">): Promise<ChatLine[]> {
  const call = await syncApi();
  if (!call) return [];
  const roster = userNames();
  return fetchContext(call, item, async (id) => roster.get(id) ?? (await lookupUserName(call, id)) ?? "");
}

// 一次请求里渲染几十段前文，共用一份花名册，别每段各扫一遍收件箱
let ctx: PriorContext | undefined;
function sharedCtx(): PriorContext {
  if (!ctx) {
    ctx = priorContext();
    setImmediate(() => {
      ctx = undefined;
    });
  }
  return ctx;
}

defineBuiltin({
  name: "slack",
  scenario: "Slack 私聊和 @ 我的消息：收件、取对话前文、审核通过后发回复",
  roles: ["chat"],
  binaries: [],
  ops: [
    {
      name: "context",
      description: "取一段 Slack 对话的前文（thread 里取整个 thread，否则取它前面若干条），按「人名：内容」逐行返回",
      input: { conversation: z.string().min(1).describe("对话键 channelId:thread_ts 或 channelId:ts") },
      level: "read",
      async run(args) {
        const conv = String(args.conversation);
        const items = listInbox(true, CONV_SCAN_LIMIT).filter((i) => conversationKey(i) === conv).sort((a, b) => Number(a.ts) - Number(b.ts));
        const last = items.at(-1);
        if (!last) return { text: `收件箱里没有对话 ${conv}` };
        const lines = await context(last);
        const shown = priorText(lines, { kind: last.kind, peer: last.userName, peerId: last.userId });
        return { text: untrusted("Slack 对话前文", shown.join("\n") || "（没有前文）"), value: lines };
      },
    },
    {
      name: "post",
      description: "以用户身份往频道或私聊发一条消息，带 threadTs 就回在原 thread 里；发出去撤不回",
      input: { channel: z.string().min(1), text: z.string().min(1), threadTs: z.string().optional() },
      level: "irreversible",
      audit: "slack_reply_sent",
      async run(args) {
        const channel = String(args.channel);
        const text = String(args.text);
        const res = await postMessage(await freshApi(), channel, text, typeof args.threadTs === "string" ? args.threadTs : undefined);
        // 没有 ts 就没法撤回，也说明发送结果不可信，不能记成已发出
        if (!res.ts) throw new Error("Slack 没有返回消息 ts，发送结果不可信");
        return {
          text: `已发到 ${channel}`,
          value: res,
          evidence: { channel, text, ts: res.ts, permalink: res.permalink ?? null },
          undo: { kind: "delete_slack_message", channel, ts: res.ts },
        };
      },
    },
    {
      name: "delete",
      description: "删掉一条自己发的 Slack 消息",
      input: { channel: z.string().min(1), ts: z.string().min(1) },
      level: "irreversible",
      async run(args) {
        await deleteMessage(await freshApi(), String(args.channel), String(args.ts));
        return { text: `已删掉 ${String(args.channel)} 里 ${String(args.ts)} 那条` };
      },
    },
  ],
});

async function call(caller: Caller, op: string, args: Record<string, unknown>): Promise<unknown> {
  const r = await invokeTool(caller, "slack", op, args);
  if (r.kind !== "ok") throw new Error(r.kind === "refused" ? r.why : `slack.${op} 没有执行（${r.kind}）`);
  return r.value;
}

/** 对话引用：id 是对话键，频道和 thread 进 attrs，只有这里解释 */
function external(item: InboxItem): ExternalRef {
  return {
    tool: "slack",
    type: "conversation",
    id: conversationKey(item),
    ...(item.userName ? { author: item.userName } : {}),
    attrs: { channelId: item.channelId, ...(item.threadTs ? { threadTs: item.threadTs } : {}) },
  };
}

implementRole("chat", "slack", {
  configured: slackConfigured,
  async self() {
    const api = await syncApi();
    if (!api) return undefined;
    const auth = (await api("auth.test", {})) as { user_id?: string; team_id?: string; url?: string };
    return { id: String(auth.user_id ?? ""), ...(auth.team_id ? { teamId: auth.team_id } : {}), ...(auth.url ? { url: auth.url } : {}) };
  },
  async pull(me, cursors, now, teamUrl) {
    const api = await syncApi();
    if (!api) throw new Error(SLACK_NOT_CONNECTED);
    return fetchSlack(api, me, cursors, now, teamUrl);
  },
  context,
  async settledChecker(me) {
    const api = await syncApi();
    if (!api) throw new Error(SLACK_NOT_CONNECTED);
    const lastRead = await fetchLastRead(api);
    return async (item) => isRead(item, lastRead, item.channelId) || (await repliedSince(api, me, item));
  },
  external,
  replyable: (to) => Boolean(to.attrs?.channelId),
  async post({ to, text }, caller) {
    const channel = to.attrs?.channelId;
    if (!channel) throw new Error("这段对话没有记频道，发不了");
    const threadTs = to.attrs?.threadTs;
    return (await call(caller, "post", { channel, text, ...(threadTs ? { threadTs } : {}) })) as { ts: string; permalink?: string };
  },
  async remove(args, caller) {
    await call(caller, "delete", { channel: args.channel, ts: args.ts });
  },
  live: liveConversation,
  parseTitle,
  ownsApp,
  renderPrior: (lines, scene) => priorText(lines, scene, sharedCtx()),
  displayNames,
  warm: warmSlack,
  resetAuth() {
    creds = undefined;
  },
});
