import { describe, expect, it } from "vitest";
import { alreadyAsking, containerDone, myRoles } from "./meegle.js";
import { updateTaskFromChat } from "./taskUpdate.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { handOffToStory } from "./pipeline.js";
import { createJob, finishJob, setGhosttyId } from "../memory/jobs.js";
import { createTask, getTask, updateTask } from "../memory/tasks.js";
import { initMemory } from "../memory/db.js";

describe("需求里我担哪些角色", () => {
  const roles = [
    { role: "QA", memberKeys: ["k-qa"] },
    { role: "Admin Frontend", memberKeys: ["k-me"] },
    { role: "Server developer", memberKeys: ["k-be", "k-me"] },
  ];

  it("按 user_key 精确匹配，不靠名字", async () => {
    expect(myRoles(roles, "k-me")).toEqual(["Admin Frontend", "Server developer"]);
    expect(myRoles(roles, "k-qa")).toEqual(["QA"]);
    expect(myRoles(roles, "k-nobody")).toEqual([]);
    expect(myRoles([], "k-me")).toEqual([]);
  });
});

describe("同需求共用一个终端", () => {
  it("需求有活着的终端时，缺陷转达给它而不是另起一个", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const story = createTask({ title: "猜涨跌兜底开奖", kind: "meegle", source: { meegleId: "S1", meegleType: "story" }, status: "processing" });
    createJob({ id: "J1", project: "p", dir: "/d", logPath: "/l" });
    setGhosttyId("J1", "ghostty-J1"); // 有窗口 id 才转达得进去
    updateTask(story.id, { source: { jobId: "J1" } });

    const bug = createTask({ title: "开关没有二次确认", kind: "meegle", source: { meegleId: "B1", linkedStoryId: "S1" }, status: "understood" });
    expect(await handOffToStory(bug, "把开关加上二次确认")).toBe(true);
    const after = getTask(bug.id)!;
    // 挂到需求那个 job 上，不是新的
    expect(after.source.jobId).toBe("J1");
    expect(after.status).toBe("processing");
    expect(after.progress).toContain("共用一个终端和分支");
  });

  it("终端已经退出就不转达，让它自己开", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const story = createTask({ title: "需求", kind: "meegle", source: { meegleId: "S2", meegleType: "story" }, status: "review" });
    createJob({ id: "J2", project: "p", dir: "/d", logPath: "/l" });
    updateTask(story.id, { source: { jobId: "J2" } });
    finishJob("J2", 0);
    const bug = createTask({ title: "缺陷", kind: "meegle", source: { meegleId: "B2", linkedStoryId: "S2" }, status: "understood" });
    expect(await handOffToStory(bug, "改点东西")).toBe(false);
  });

  it("没有关联需求、或需求还没开终端，都不转达", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const lone = createTask({ title: "独立缺陷", kind: "meegle", source: { meegleId: "B3" }, status: "understood" });
    expect(await handOffToStory(lone, "x")).toBe(false);
    createTask({ title: "还没开工的需求", kind: "meegle", source: { meegleId: "S4", meegleType: "story" }, status: "understood" });
    const bug = createTask({ title: "缺陷", kind: "meegle", source: { meegleId: "B4", linkedStoryId: "S4" }, status: "understood" });
    expect(await handOffToStory(bug, "x")).toBe(false);
  });
});

describe("需求容器的收尾判据", () => {
  const t = (status: string) => ({ status }) as never;

  it("名下还有没完的就不收", async () => {
    expect(containerDone([t("understood"), t("done")])).toBe(false);
    expect(containerDone([t("processing")])).toBe(false);
  });

  it("全部 done 或 ignored 才收", async () => {
    expect(containerDone([t("done"), t("ignored")])).toBe(true);
    expect(containerDone([t("done")])).toBe(true);
  });

  it("一条缺陷都没有时不收——刚建出来还没挂上就被收掉了", async () => {
    expect(containerDone([])).toBe(false);
  });
});

describe("同需求只问一次归属", () => {
  it("已经有一条在问，同需求的其他条不再重复问", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const a = createTask({ title: "缺陷 A", kind: "meegle", status: "understood", source: { meegleId: "QA1", linkedStoryId: "ST1" } });
    updateTask(a.id, { attention: "intake", progress: "这条是哪个项目的？" });
    const b = createTask({ title: "缺陷 B", kind: "meegle", status: "understood", source: { meegleId: "QA2", linkedStoryId: "ST1" } });
    expect(alreadyAsking(b)?.id).toBe(a.id);
  });

  it("没挂在需求下的各问各的", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const a = createTask({ title: "独立 A", kind: "meegle", status: "understood", source: { meegleId: "QB1" } });
    updateTask(a.id, { attention: "intake", progress: "问一句" });
    const b = createTask({ title: "独立 B", kind: "meegle", status: "understood", source: { meegleId: "QB2" } });
    expect(alreadyAsking(b)).toBeUndefined();
  });

  it("答一条归属，同需求其他条一起归、提问一起清", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    writeFileSync(join(process.env.FRIDAY_DATA_DIR!, "projects.md"), "# 项目\n\n## fe-wealth-admin\n- 目录：~/f\n");
    const a = createTask({ title: "【邀请达标不发奖】缺陷 A", kind: "meegle", status: "understood", source: { meegleId: "QC1", linkedStoryId: "ST2" } });
    const b = createTask({ title: "【邀请达标不发奖】缺陷 B", kind: "meegle", status: "understood", source: { meegleId: "QC2", linkedStoryId: "ST2" } });
    const c = createTask({ title: "【邀请达标不发奖】缺陷 C", kind: "meegle", status: "understood", source: { meegleId: "QC3", linkedStoryId: "ST2" } });
    for (const t of [a, b, c]) updateTask(t.id, { attention: "intake", progress: "哪个项目？" });

    const r = updateTaskFromChat(a.id, { project: "fe-wealth-admin" })!;
    expect(r.changed.some((x) => x.includes("同需求另外 2 条"))).toBe(true);
    for (const t of [b, c]) {
      const after = getTask(t.id)!;
      expect(after.project).toBe("fe-wealth-admin");
      expect(after.attention).toBeUndefined();
    }
  });
});
