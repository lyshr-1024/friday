import { describe, expect, it } from "vitest";
import { myRoles } from "./meegle.js";
import { handOffToStory } from "./pipeline.js";
import { createJob, finishJob } from "../memory/jobs.js";
import { createTask, getTask, updateTask } from "../memory/tasks.js";
import { initMemory } from "../memory/db.js";

describe("需求里我担哪些角色", () => {
  const roles = [
    { role: "QA", memberKeys: ["k-qa"] },
    { role: "Admin Frontend", memberKeys: ["k-me"] },
    { role: "Server developer", memberKeys: ["k-be", "k-me"] },
  ];

  it("按 user_key 精确匹配，不靠名字", () => {
    expect(myRoles(roles, "k-me")).toEqual(["Admin Frontend", "Server developer"]);
    expect(myRoles(roles, "k-qa")).toEqual(["QA"]);
    expect(myRoles(roles, "k-nobody")).toEqual([]);
    expect(myRoles([], "k-me")).toEqual([]);
  });
});

describe("同需求共用一个终端", () => {
  it("需求有活着的终端时，缺陷转达给它而不是另起一个", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const story = createTask({ title: "猜涨跌兜底开奖", kind: "meegle", source: { meegleId: "S1", meegleType: "story" }, status: "processing" });
    createJob({ id: "J1", project: "p", dir: "/d", logPath: "/l" });
    updateTask(story.id, { source: { jobId: "J1" } });

    const bug = createTask({ title: "开关没有二次确认", kind: "meegle", source: { meegleId: "B1", linkedStoryId: "S1" }, status: "understood" });
    expect(handOffToStory(bug, "把开关加上二次确认")).toBe(true);
    const after = getTask(bug.id)!;
    // 挂到需求那个 job 上，不是新的
    expect(after.source.jobId).toBe("J1");
    expect(after.status).toBe("processing");
    expect(after.progress).toContain("共用一个终端和分支");
  });

  it("终端已经退出就不转达，让它自己开", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const story = createTask({ title: "需求", kind: "meegle", source: { meegleId: "S2", meegleType: "story" }, status: "review" });
    createJob({ id: "J2", project: "p", dir: "/d", logPath: "/l" });
    updateTask(story.id, { source: { jobId: "J2" } });
    finishJob("J2", 0);
    const bug = createTask({ title: "缺陷", kind: "meegle", source: { meegleId: "B2", linkedStoryId: "S2" }, status: "understood" });
    expect(handOffToStory(bug, "改点东西")).toBe(false);
  });

  it("没有关联需求、或需求还没开终端，都不转达", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const lone = createTask({ title: "独立缺陷", kind: "meegle", source: { meegleId: "B3" }, status: "understood" });
    expect(handOffToStory(lone, "x")).toBe(false);
    createTask({ title: "还没开工的需求", kind: "meegle", source: { meegleId: "S4", meegleType: "story" }, status: "understood" });
    const bug = createTask({ title: "缺陷", kind: "meegle", source: { meegleId: "B4", linkedStoryId: "S4" }, status: "understood" });
    expect(handOffToStory(bug, "x")).toBe(false);
  });
});
