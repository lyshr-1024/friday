import { describe, expect, it } from "vitest";
import { createJob, getJob, reapStaleJobs, setGhosttyId } from "./jobs.js";

const mk = (id: string, ghostty?: string) => {
  createJob({ id, project: "p", dir: "/tmp", logPath: "/tmp/x.log" });
  if (ghostty) setGhosttyId(id, ghostty);
};

describe("启动收尸：外部窗口不跟着 sidecar 死", () => {
  it("窗口还在的留着，没了的才收", async () => {
    mk("alive-1", "G-ALIVE");
    mk("dead-1", "G-DEAD");
    mk("no-id");
    const reaped = await reapStaleJobs(async (id) => id === "G-ALIVE");
    expect(reaped).toBe(2);
    expect(getJob("alive-1")?.status).toBe("running");
    expect(getJob("dead-1")?.status).toBe("done");
    // 没记下 terminal id 的问不了，只能当它死了
    expect(getJob("no-id")?.status).toBe("done");
  });

  it("不给判定函数就全收（Terminal.app 那条路没有 id 可问）", async () => {
    mk("legacy", "G-ALIVE");
    // 上一个 case 留下的 alive-1 还开着，这次不给判定函数，两条一起收
    expect(await reapStaleJobs()).toBe(2);
    expect(getJob("legacy")?.status).toBe("done");
    expect(getJob("alive-1")?.status).toBe("done");
  });
});
