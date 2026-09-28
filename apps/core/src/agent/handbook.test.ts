import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GLOBAL, handbookPath } from "../memory/handbooks.js";
import { createRun, finishRun, setRunOutcome } from "../memory/runs.js";
import { activeRules, addRule, getRule, restoreRules, retireRule, setRuleText } from "../memory/rules.js";
import { createTask } from "../memory/tasks.js";
import {
  HISTORY_EVERY_DAYS,
  applyHandbookDraft,
  distillPrompt,
  draftSummary,
  historyDue,
  outcomeCandidates,
  parseOps,
  restoreMemorySnapshot,
  type Candidate,
  type GroupDraft,
} from "./handbook.js";

const cands = (n: number): Candidate[] =>
  Array.from({ length: n }, (_, i) => ({ n: i + 1, at: `2026-09-2${i}T00:00:00Z`, text: `原话 ${i + 1}`, kind: "utterance" as const, ref: `sess-${i + 1}` }));

const ev = (quote: string) => ({ quote, at: "2026-09-01T00:00:00Z", kind: "utterance" as const });

describe("parseOps：模型只能引用候选编号，不能自己写引文", () => {
  const hist = addRule({ project: "p-parse", section: "约定", text: "先说方案", origin: "history", evidence: [ev("先说方案")] });
  const manual = addRule({ project: "p-parse", section: "约定", text: "只改指定范围", origin: "manual", evidence: [ev("只改这一处")] });
  const active = new Map([hist, manual].map((r) => [r.id, r]));
  const raw = (o: unknown) => `好的：\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;

  it("四种操作都能解析，编号越界 / 非整数 / 空证据的整条丢掉并计数", () => {
    const d = parseOps(
      raw({
        ops: [
          { op: "add", section: "流程", text: "提交前跑测试", evidence: [1, 2], why: "说了两次" },
          { op: "add", section: "流程", text: "没证据", evidence: [], why: "x" },
          { op: "add", section: "流程", text: "越界", evidence: [4], why: "x" },
          { op: "add", section: "流程", text: "零号", evidence: [0], why: "x" },
          { op: "add", section: "流程", text: "小数", evidence: [1.5], why: "x" },
          { op: "confirm", id: hist.id, evidence: [3] },
          { op: "confirm", id: "r-00000000", evidence: [3] },
          { op: "revise", id: hist.id, text: "先说方案，等确认再动手", evidence: [2], why: "更具体" },
          { op: "retire", id: hist.id },
        ],
        conflicts: [{ text: "提交后建 draft MR", with: "推送要你审核" }],
      }),
      3,
      active,
    )!;
    expect(d.ops.map((o) => o.op)).toEqual(["add", "confirm", "revise"]);
    expect(d.dropped).toBe(6);
    expect(d.conflicts).toEqual([{ text: "提交后建 draft MR", with: "推送要你审核" }]);
  });

  it("你手改过的规则，模型改写或退役都丢掉", () => {
    const d = parseOps(raw({ ops: [{ op: "revise", id: manual.id, text: "别的", evidence: [1], why: "x" }, { op: "retire", id: manual.id, why: "过时" }] }), 3, active)!;
    expect(d.ops).toEqual([]);
    expect(d.dropped).toBe(2);
  });

  it("文字截到 60 字；分区不认识的归「约定」", () => {
    const d = parseOps(raw({ ops: [{ op: "add", section: "乱写", text: "长".repeat(80), evidence: [1], why: "x" }] }), 3, active)!;
    expect(d.ops[0]).toMatchObject({ op: "add", section: "约定" });
    expect((d.ops[0] as { text: string }).text).toHaveLength(60);
  });

  it("解析不了返回 undefined", () => {
    expect(parseOps("我没法完成", 3, active)).toBeUndefined();
  });
});

describe("applyHandbookDraft：按操作落表，证据从候选里取，可整体撤销", () => {
  it("add / confirm / revise / retire 落表并重新渲染手册；快照还原回去", () => {
    const keep = addRule({ project: "p-apply", section: "约定", text: "旧规则", origin: "history", evidence: [ev("旧")] });
    const drop = addRule({ project: "p-apply", section: "约定", text: "要退役的", origin: "history", evidence: [ev("临时")] });
    const group: GroupDraft = {
      project: "p-apply",
      candidates: cands(2),
      ops: [
        { op: "add", section: "流程", text: "提交前跑测试", evidence: [1, 2], why: "x" },
        { op: "revise", id: keep.id, text: "旧规则改写", evidence: [2], why: "x" },
        { op: "retire", id: drop.id, why: "新口径推翻" },
      ],
      conflicts: [],
      stale: [],
      dropped: 0,
      decisions: [],
      people: [],
      aliases: [],
      sources: 2,
    };
    const { snapshot } = applyHandbookDraft({ groups: [group] });
    const added = activeRules("p-apply").find((r) => r.text === "提交前跑测试")!;
    expect(added.evidence.map((e) => [e.quote, e.ref])).toEqual([["原话 1", "sess-1"], ["原话 2", "sess-2"]]);
    expect(getRule(keep.id)!.text).toBe("旧规则改写");
    expect(getRule(drop.id)!.status).toBe("retired");
    const md = readFileSync(handbookPath("p-apply"), "utf8");
    expect(md).toContain("提交前跑测试");
    expect(md).not.toContain("要退役的");

    restoreRules(snapshot.rules!);
    expect(activeRules("p-apply").map((r) => r.text).sort()).toEqual(["旧规则", "要退役的"]);
  });

  it("卡挂着期间你手改或退役了的规则，通过时不再被覆盖，跳过数写进结果", () => {
    const edited = addRule({ project: "p-late", section: "约定", text: "原样", origin: "history", evidence: [ev("原")] });
    const gone = addRule({ project: "p-late", section: "约定", text: "已退", origin: "history", evidence: [ev("退")] });
    const group: GroupDraft = {
      project: "p-late",
      candidates: cands(1),
      ops: [
        { op: "revise", id: edited.id, text: "模型改写", evidence: [1], why: "x" },
        { op: "confirm", id: gone.id, evidence: [1] },
      ],
      conflicts: [],
      stale: [],
      dropped: 0,
      decisions: [],
      people: [],
      aliases: [],
      sources: 1,
    };
    // 审核卡生成之后、点通过之前，你在设置页动了这两条
    setRuleText(edited.id, "我改的");
    retireRule(gone.id, "不算了");
    const { wrote } = applyHandbookDraft({ groups: [group] });
    expect(getRule(edited.id)!.text).toBe("我改的");
    expect(getRule(gone.id)!.evidence).toHaveLength(1);
    expect(wrote.join(" ")).toContain("跳过 2 条");
  });

  it("撤销只还原这次动过的规则：之后你手改的别的规则、别的轮次加的规则都留着", () => {
    const touched = addRule({ project: "p-undo", section: "约定", text: "会被改写", origin: "history", evidence: [ev("旧")] });
    const other = addRule({ project: "p-undo", section: "约定", text: "没被这轮碰", origin: "history", evidence: [ev("别的")] });
    const group: GroupDraft = {
      project: "p-undo",
      candidates: cands(1),
      ops: [
        { op: "add", section: "流程", text: "这轮新加的", evidence: [1], why: "x" },
        { op: "revise", id: touched.id, text: "改写后", evidence: [1], why: "x" },
      ],
      conflicts: [],
      stale: [],
      dropped: 0,
      decisions: [],
      people: [],
      aliases: [],
      sources: 1,
    };
    const { snapshot } = applyHandbookDraft({ groups: [group] });
    setRuleText(other.id, "之后我手改的");
    const later = addRule({ project: "p-undo", section: "约定", text: "下一轮加的", origin: "history", evidence: [ev("后")] });
    restoreMemorySnapshot(snapshot);
    expect(getRule(touched.id)).toMatchObject({ text: "会被改写" });
    expect(getRule(touched.id)!.evidence).toHaveLength(1);
    expect(activeRules("p-undo").some((r) => r.text === "这轮新加的")).toBe(false);
    expect(getRule(other.id)).toMatchObject({ text: "之后我手改的", origin: "manual" });
    expect(getRule(later.id)?.status).toBe("active");
  });

  it("来自结果的证据记成 outcome，指回任务", () => {
    const group: GroupDraft = {
      project: "p-out",
      candidates: [{ n: 1, at: "2026-09-28T00:00:00Z", text: "【Friday 的交付被你打回】改错页面了", kind: "outcome", ref: "task-1" }],
      ops: [{ op: "add", section: "别踩的坑", text: "改之前先确认是哪个页面", evidence: [1], why: "被打回过" }],
      conflicts: [],
      stale: [],
      dropped: 0,
      decisions: [],
      people: [],
      aliases: [],
      sources: 1,
    };
    applyHandbookDraft({ groups: [group] });
    const r = activeRules("p-out")[0]!;
    expect(r.origin).toBe("outcome");
    expect(r.evidence[0]).toMatchObject({ kind: "outcome", ref: "task-1" });
  });
});

describe("distillPrompt：带上规则 id、手改标记、久未确认、Friday 的硬约束", () => {
  it("输入里能看到这些，候选按编号列", () => {
    const man = addRule({ project: "p-prompt", section: "约定", text: "只改指定范围", origin: "manual", evidence: [ev("只改")] });
    const old = addRule({ project: "p-prompt", section: "流程", text: "老规矩", origin: "history", evidence: [ev("老")] });
    const { system, prompt } = distillPrompt("p-prompt", cands(2), activeRules("p-prompt"), new Set([old.id]));
    expect(prompt).toContain(`${man.id} | 约定 | 只改指定范围`);
    expect(prompt).toContain("[手改]");
    expect(prompt).toContain("⚠ 久未确认");
    expect(prompt).toMatch(/\[1\] 2026-09-20 原话 1/);
    expect(system).toContain("Friday 的硬约束");
    expect(system).toContain("推送要你审核");
  });
});

describe("outcomeCandidates：Friday 的交付被打回、被你改过，也是要学的", () => {
  it("取水位之后的打回原因和「又提交了几次」，带任务标题；原样收下的不算", () => {
    const t = createTask({ title: "修上市日", kind: "meegle", source: {}, project: "whale-console", status: "review" });
    createRun({ id: "oc-1", jobId: "oc-1", taskId: t.id, project: "whale-console", kind: "autonomous", trigger: "retry" });
    finishRun("oc-1", { exit: "report" });
    setRunOutcome("oc-1", "rejected", "改错页面了");
    createRun({ id: "oc-2", jobId: "oc-2", taskId: t.id, project: "whale-console", kind: "autonomous", trigger: "retry" });
    setRunOutcome("oc-2", "merged_as_is");
    const got = outcomeCandidates("2000-01-01T00:00:00Z");
    const mine = got.filter((m) => m.ref === t.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ project: "whale-console", kind: "outcome" });
    expect(mine[0]!.text).toContain("改错页面了");
    expect(mine[0]!.text).toContain("修上市日");
  });
});

describe("historyDue", () => {
  const now = Date.parse("2026-09-15T00:00:00Z");

  it("从没跑过就该跑", () => {
    expect(historyDue(undefined, now)).toBe(true);
  });

  it("刚跑过不重复跑", () => {
    expect(historyDue(new Date(now - 86_400_000).toISOString(), now)).toBe(false);
  });

  it("满一周就跑，不看是星期几——机器关着也不会整周漏掉", () => {
    expect(historyDue(new Date(now - HISTORY_EVERY_DAYS * 86_400_000).toISOString(), now)).toBe(true);
  });

  it("存的时间坏了就当没跑过", () => {
    expect(historyDue("not-a-date", now)).toBe(true);
  });
});

describe("draftSummary：审核卡按增删改展示", () => {
  it("每个项目分新增 / 改写 / 退役 / 确认，下面是冲突、久未确认、丢弃数", () => {
    const r = addRule({ project: "p-sum", section: "约定", text: "旧写法", origin: "history", evidence: [ev("旧")] });
    const gone = addRule({ project: "p-sum", section: "约定", text: "被推翻的", origin: "history", evidence: [ev("x")] });
    const md = draftSummary({
      groups: [
        {
          project: "p-sum",
          candidates: cands(2),
          ops: [
            { op: "add", section: "流程", text: "提交前跑测试", evidence: [1], why: "说过" },
            { op: "revise", id: r.id, text: "新写法", evidence: [2], why: "更准" },
            { op: "retire", id: gone.id, why: "新口径推翻" },
            { op: "confirm", id: r.id, evidence: [2] },
          ],
          conflicts: [{ text: "提交后建 draft MR", with: "推送要你审核" }],
          stale: [{ id: r.id, text: "旧写法", lastConfirmedAt: "2026-07-01T00:00:00Z" }],
          dropped: 2,
          decisions: [{ text: "决策一" }],
          people: [],
          aliases: ["wbo"],
          sources: 2,
        },
        { project: GLOBAL, candidates: [], ops: [], conflicts: [], stale: [], dropped: 0, decisions: [], people: [], aliases: [], sources: 0 },
      ],
    });
    expect(md).toContain("## p-sum（依据 2 条）");
    expect(md).toContain("新增 1");
    expect(md).toContain("+ 提交前跑测试");
    expect(md).toContain("旧写法 → 新写法");
    expect(md).toContain("- 被推翻的（新口径推翻）");
    expect(md).toContain("确认 1");
    expect(md).toContain("提交后建 draft MR ⟂ 推送要你审核");
    expect(md).toContain("久未确认 1");
    expect(md).toContain("因引证无效丢弃 2");
    expect(md).toContain("决策 1 条：决策一");
    expect(md).not.toContain("## 通用习惯");
  });
});
