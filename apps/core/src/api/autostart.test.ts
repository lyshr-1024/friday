import { describe, expect, it } from "vitest";
import { app } from "./index.js";
import { createTask } from "../memory/tasks.js";

const old = new Date(Date.now() - 3600_000).toISOString();
const queued = (id: string, confidence: number) =>
  createTask({
    title: `缺陷 ${id}`,
    kind: "meegle",
    status: "understood",
    project: "whale-console",
    source: { meegleId: id, meegleType: "issue", intake: { kind: "start", confidence, project: "whale-console", detail: "x", why: "y", at: old } },
  });

describe("GET /autostart/preview：按某个门槛，排队的缺陷里有几条能过", () => {
  it("只数判成可以开工的缺陷；门槛不传用设置里的", async () => {
    queued("pv-1", 78);
    queued("pv-2", 60);
    const at = async (q: string) => (await (await app.request(`/autostart/preview${q}`)).json()) as { min: number; pass: number; candidates: number };
    // 新建任务的 createdAt 是现在，还在「等描述稳定」期；预览不看这条，只看把握和归属
    expect(await at("?min=75")).toMatchObject({ min: 75, pass: 1, candidates: 2 });
    expect(await at("?min=55")).toMatchObject({ pass: 2 });
    expect((await at("")).min).toBe(80);
  });
});
