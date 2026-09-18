import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { relayTarget, surfaceContext } from "./surface.js";
import { createTask } from "../memory/tasks.js";
import { createJob, finishJob } from "../memory/jobs.js";

beforeAll(() => {
  writeFileSync(
    join(process.env.FRIDAY_DATA_DIR!, "projects.md"),
    [
      "## whale-console",
      "- 目录：/tmp/wc",
      "- 地址：console.longbridge.xyz/x/, console.whalesit.xyz/x/",
      "",
      "## fe-wealth-admin",
      "- 目录：/tmp/fe",
      "- 地址：console.longbridge.xyz/, console.whalesit.xyz/",
      "",
    ].join("\n"),
  );
});

describe("你在哪个页面", () => {
  // 同域名靠路径区分，/x/ 比 / 长所以先命中——whale-console 之后上 SIT 不用改代码
  it("最长前缀赢：/x/ 归 whale-console，其余归 fe-wealth-admin", () => {
    expect(surfaceContext("https://console.longbridge.xyz/x/menu").project).toBe("whale-console");
    expect(surfaceContext("https://console.longbridge.xyz/opa/cattle").project).toBe("fe-wealth-admin");
    expect(surfaceContext("https://console.whalesit.xyz/x/form").project).toBe("whale-console");
    expect(surfaceContext("https://console.whalesit.xyz/bss/report").project).toBe("fe-wealth-admin");
  });

  it("不认识的地址不硬猜", () => {
    expect(surfaceContext("https://github.com/foo/bar").project).toBeNull();
  });

  it("带出这个项目上还没收工的事", () => {
    createTask({ title: "anyOf 服务端不识别", kind: "verbal", source: {}, project: "whale-console", status: "processing" });
    const ctx = surfaceContext("https://console.longbridge.xyz/x/menu");
    expect(ctx.tasks.map((t) => t.title)).toContain("anyOf 服务端不识别");
  });
});

describe("对着页面说一句话，转给谁", () => {
  it("这个项目上只有一个终端在跑，直接转给它", () => {
    createJob({ id: "sj1", project: "fe-wealth-admin", dir: "/tmp/fe", task: "x", logPath: "/tmp/x.log" });
    createTask({ title: "奖品配置必填校验", kind: "code", source: { jobId: "sj1" }, project: "fe-wealth-admin", status: "processing" });
    const r = relayTarget("https://console.longbridge.xyz/opa/prize");
    expect(r).toMatchObject({ jobId: "sj1" });
  });

  it("有两个在跑就不替你决定，让你点", () => {
    createJob({ id: "sj2", project: "fe-wealth-admin", dir: "/tmp/fe", task: "y", logPath: "/tmp/y.log" });
    createTask({ title: "另一条也在改", kind: "code", source: { jobId: "sj2" }, project: "fe-wealth-admin", status: "processing" });
    const r = relayTarget("https://console.longbridge.xyz/opa/prize");
    expect(r).toHaveProperty("why");
    expect((r as { why: string }).why).toContain("2 个终端");
  });

  it("指定了任务就用它的终端", () => {
    const t = createTask({ title: "指定这条", kind: "code", source: { jobId: "sj1" }, project: "fe-wealth-admin", status: "processing" });
    expect(relayTarget("https://console.longbridge.xyz/opa/prize", t.id)).toMatchObject({ jobId: "sj1" });
  });

  it("认不出地址就说清楚怎么补", () => {
    const r = relayTarget("https://example.com/whatever");
    expect((r as { why: string }).why).toContain("projects.md");
  });

  it("终端已经收工就不转", () => {
    finishJob("sj1", 0);
    finishJob("sj2", 0);
    const r = relayTarget("https://console.longbridge.xyz/opa/prize");
    expect((r as { why: string }).why).toContain("没有终端在跑");
  });
});
