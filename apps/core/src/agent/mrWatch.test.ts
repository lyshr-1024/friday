import { describe, expect, it } from "vitest";
import { listAudit } from "../memory/audit.js";
import { createTask, getTask } from "../memory/tasks.js";
import { mrWatchTick, type MrLookup } from "./mrWatch.js";

const merged = (iid: number, target: string, mergedAt: string): MrLookup => async () => [{ iid, target, mergedAt }];

describe("MR 合了就收工", () => {
  it("待验收、有自己分支的任务：MR 合进 sit 也算，标完成、记账写 MR 号和目标分支", async () => {
    const t = createTask({ title: "修养牛 SIT 缺陷", kind: "code", status: "review", project: "demo", source: { branch: "fix/cattle-mr-1", repoDir: "/repo" } });
    const seen: string[][] = [];
    const lookup: MrLookup = async (dir, branch) => {
      seen.push([dir, branch]);
      return branch === "fix/cattle-mr-1" ? [{ iid: 10362, target: "sit", mergedAt: new Date(Date.now() + 1000).toISOString() }] : [];
    };
    await mrWatchTick(lookup);
    expect(seen).toContainEqual(["/repo", "fix/cattle-mr-1"]);
    expect(getTask(t.id)!.status).toBe("done");
    const e = listAudit({ taskId: t.id }).find((x) => x.action === "mr_merged")!;
    expect(e.how).toContain("!10362");
    expect(e.how).toContain("sit");
  });

  it("同名分支以前合过的旧 MR（合并时间早于任务）不算", async () => {
    const t = createTask({ title: "复用分支名", kind: "code", status: "review", project: "demo", source: { branch: "fix/reused-mr", repoDir: "/repo" } });
    await mrWatchTick(merged(1, "master", "2020-01-01T00:00:00.000Z"));
    expect(getTask(t.id)!.status).toBe("review");
  });

  it("交代进需求会话的缺陷借的是需求的分支，不单独查；主干上的不查", async () => {
    const story = createTask({ title: "需求", kind: "meegle", status: "review", project: "demo", source: { branch: "feat/story-mr", repoDir: "/repo" } });
    const bug = createTask({ title: "缺陷", kind: "meegle", status: "review", project: "demo", source: { rootId: story.id, handedAt: new Date().toISOString(), branch: "feat/story-mr", repoDir: "/repo" } });
    const onMain = createTask({ title: "在主干上", kind: "code", status: "review", project: "demo", source: { branch: "main", repoDir: "/repo" } });
    const seen: string[] = [];
    await mrWatchTick(async (_d, b) => {
      seen.push(b);
      return [];
    });
    expect(seen.filter((b) => b === "feat/story-mr")).toHaveLength(1);
    expect(seen).not.toContain("main");
    expect(getTask(bug.id)!.status).toBe("review");
    expect(getTask(onMain.id)!.status).toBe("review");
  });

  it("需求的 MR 合了：名下缺陷一起收", async () => {
    const story = createTask({ title: "需求带缺陷", kind: "meegle", status: "review", project: "demo", source: { branch: "feat/with-bugs-mr", repoDir: "/repo" } });
    const bug = createTask({ title: "名下缺陷", kind: "meegle", status: "review", project: "demo", source: { rootId: story.id, handedAt: new Date().toISOString() } });
    await mrWatchTick(async (_d, b) => (b === "feat/with-bugs-mr" ? [{ iid: 7, target: "master", mergedAt: new Date(Date.now() + 1000).toISOString() }] : []));
    expect(getTask(story.id)!.status).toBe("done");
    expect(getTask(bug.id)!.status).toBe("done");
  });

  it("查不到（glab 没装、没登录）就跳过，不动卡", async () => {
    const t = createTask({ title: "查不到", kind: "code", status: "review", project: "demo", source: { branch: "fix/no-glab", repoDir: "/repo" } });
    await mrWatchTick(async () => undefined);
    expect(getTask(t.id)!.status).toBe("review");
  });
});
