import { z } from "zod";
import { untrusted } from "../../agent/fence.js";
import { defineBuiltin } from "../builtin.js";
import { invokeTool, type Caller } from "../invoke.js";
import { implementRole, type WorkItem } from "../roles.js";
import { MeegleConnector, type MeegleWorkItem } from "./client.js";
import { idFromUrl, idsIn, kindOf, ownsHost, parseRef, stateOf } from "./rules.js";

export const meegleClient = new MeegleConnector();

const normalize = (w: MeegleWorkItem): WorkItem => ({ ...w, kind: kindOf(w.typeKey), state: stateOf(w.statusKey, w.status) });

// 这些值原样进 meegle CLI 的参数：工单号只能是数字，其余不许 - 开头被当成选项
const key = z.string().regex(/^[A-Za-z0-9_][\w-]*$/);
const ref = { space: z.string().regex(/^[A-Za-z0-9_-]+$/).refine((s) => !s.startsWith("-"), "不能以 - 开头").describe("空间 project key，链接里 /<空间>/story/detail/<工单号> 那段"), id: z.string().regex(/^\d+$/, "工单号只能是数字").describe("工单号") };
const node = { ...ref, nodeKey: key.describe("节点 key，如 state_16") };

const excerpt = (text: string | undefined, max = 2000) => (text && text.length > max ? `${text.slice(0, max)}…（截断）` : text);

defineBuiltin({
  name: "meegle",
  scenario: "飞书项目（Meegle）的需求与缺陷：取一条工单、状态流转、完成当前节点",
  roles: ["workItems"],
  binaries: ["meegle"],
  ops: [
    {
      name: "get",
      description: "取一条 Meegle 工单：标题、状态、类型、关联需求、描述节选",
      input: ref,
      level: "read",
      async run(args) {
        const w = normalize(await meegleClient.fetchOne(String(args.space), String(args.id)));
        const lines = [
          `#${w.id} ${w.name}`,
          `类型：${w.typeName}（${w.kind}）`,
          `状态：${w.status}（${w.state}）`,
          w.priority ? `优先级：${w.priority}` : "",
          w.linkedStory ? `关联需求：#${w.linkedStory.id} ${w.linkedStory.name}` : "",
          `链接：${w.url}`,
          w.description ? `\n描述：\n${excerpt(w.description)}` : "",
        ].filter(Boolean);
        return { text: untrusted("Meegle 工单", lines.join("\n")), value: { id: w.id, name: w.name, kind: w.kind, state: w.state, stateLabel: w.status, linkedStory: w.linkedStory } };
      },
    },
    {
      name: "transition",
      description: "按流转 id 改工单状态（流转 id 来自工单当前能走的流转）；撤销时转回原状态",
      input: {
        ...ref,
        transitionId: key,
        stateKey: z.string().optional().describe("目标状态 key，只用于记账"),
        from: z.string().optional().describe("现在的状态 key；读不到线上状态时撤销转回它"),
      },
      level: "reversible",
      audit: "meegle_transition",
      async run(args) {
        const space = String(args.space);
        const id = String(args.id);
        const live = (await meegleClient.getWorkItem(space, id).catch(() => undefined))?.statusKey;
        const from = live || (typeof args.from === "string" ? args.from : "");
        await meegleClient.transitionState(space, id, String(args.transitionId));
        const to = typeof args.stateKey === "string" ? args.stateKey : undefined;
        return {
          text: `#${id} 已流转${to ? `到 ${to}` : ""}`,
          evidence: { meegleId: id, from, ...(to ? { to } : {}) },
          ...(from ? { undo: { kind: "meegle_state" as const, projectKey: space, workItemId: id, backTo: from } } : {}),
        };
      },
    },
    {
      name: "confirm_node",
      description: "完成工单的当前节点，推给下游；撤销时回滚这个节点",
      input: node,
      level: "reversible",
      audit: "meegle_node_confirm",
      async run(args) {
        const [space, id, nodeKey] = [String(args.space), String(args.id), String(args.nodeKey)];
        await meegleClient.transitionNode(space, id, nodeKey, "confirm");
        return { text: `#${id} 的节点 ${nodeKey} 已完成`, evidence: { meegleId: id, nodeKey }, undo: { kind: "meegle_node", projectKey: space, workItemId: id, nodeKey } };
      },
    },
    {
      name: "rollback_node",
      description: "回滚工单的一个节点（撤销「完成节点」）；撤销时重新完成它",
      input: node,
      level: "reversible",
      audit: "meegle_node_rollback",
      async run(args) {
        const [space, id, nodeKey] = [String(args.space), String(args.id), String(args.nodeKey)];
        await meegleClient.transitionNode(space, id, nodeKey, "rollback", "Friday 撤销了这次流转");
        return { text: `#${id} 的节点 ${nodeKey} 已回滚`, evidence: { meegleId: id, nodeKey }, undo: { kind: "tool_undo", tool: "meegle", op: "confirm_node", args: { space, id, nodeKey } } };
      },
    },
  ],
});

async function call(caller: Caller, op: string, args: Record<string, unknown>): Promise<void> {
  const r = await invokeTool(caller, "meegle", op, args);
  if (r.kind !== "ok") throw new Error(r.kind === "refused" ? r.why : `meegle.${op} 没有执行（${r.kind}）`);
}

const IN_PROGRESS = "IN PROGRESS";

implementRole("workItems", "meegle", {
  listMine: async () => (await meegleClient.fetchWorkItems()).map(normalize),
  fetchOne: async (r) => normalize(await meegleClient.fetchOne(r.space, r.id)),
  async get(r) {
    const w = await meegleClient.getWorkItem(r.space, r.id);
    return w && { name: w.name, typeKey: w.typeKey, stateKey: w.statusKey, stateLabel: w.status, state: stateOf(w.statusKey, w.status) };
  },
  released: (r) => meegleClient.feReleased(r.space, r.id),
  transitions: (r) => meegleClient.listTransitions(r.space, r.id),
  transitionFor: async (r) => (await meegleClient.listTransitions(r.space, r.id)).find((t) => t.stateKey === IN_PROGRESS),
  transition: (r, to, caller, from) => call(caller, "transition", { space: r.space, id: r.id, transitionId: to.id, stateKey: to.stateKey, ...(from ? { from } : {}) }),
  nodeReadiness: (r, nodeKey) => meegleClient.nodeReadiness(r.space, r.id, nodeKey),
  confirmNode: (r, nodeKey, caller) => call(caller, "confirm_node", { space: r.space, id: r.id, nodeKey }),
  rollbackNode: (r, nodeKey, caller) => call(caller, "rollback_node", { space: r.space, id: r.id, nodeKey }),
  async undoTransition(r, backTo, caller) {
    const back = (await meegleClient.listRawTransitions(r.space, r.id)).find((x) => x.state_key === backTo);
    if (!back) return false;
    await call(caller, "transition", { space: r.space, id: r.id, transitionId: String(back.id), stateKey: backTo });
    return true;
  },
  parseRef,
  idFromUrl,
  idsIn,
  stateOf,
  kindOf,
  ownsHost,
});
