import { describe, expect, it } from "vitest";
import type { Project } from "../memory/projects.js";
import { identifyUrl, sourceLabel, sourceLine } from "./urlSource.js";

const projects: Project[] = [
  { name: "whale-console", dir: "/w", aliases: [], channels: [], urls: ["console.longbridge.xyz/x"], envs: [{ name: "测试", url: "console.longbridge.xyz/x" }], extra: {} },
  { name: "fe-wealth-admin", dir: "/f", aliases: [], channels: [], urls: ["console.longbridge.xyz"], envs: [{ name: "线上", url: "console.longbridge.xyz" }], extra: {} },
];

describe("identifyUrl", () => {
  it("Lark 云文档 / 知识库按 token 认", () => {
    expect(identifyUrl("https://longbridge-group.jp.larksuite.com/docx/NWpXdmf6zo5QymxyeLVjxfn2pZd", projects)).toMatchObject({ kind: "lark_doc", docType: "docx", token: "NWpXdmf6zo5QymxyeLVjxfn2pZd" });
    expect(identifyUrl("https://longbridge-group.jp.larksuite.com/wiki/DtRCwlEA2io7gck1yj1jqRZ?from=x", projects)).toMatchObject({ kind: "lark_doc", docType: "wiki" });
  });

  it("Meegle 工单", () => {
    expect(identifyUrl("https://project.larksuite.com/saas/story/detail/24487610", projects)).toMatchObject({ kind: "meegle", projectKey: "saas", workItemId: "24487610" });
  });

  it("GitLab MR", () => {
    expect(identifyUrl("https://gitlab.longbridge-inc.com/long-bridge-frontend/whale-console/-/merge_requests/1021", projects)).toMatchObject({ kind: "gitlab_mr", repo: "long-bridge-frontend/whale-console", mr: "1021" });
  });

  it("项目环境页：/x/ 归 whale-console，裸域名归老后台，路径留给终端找文件", () => {
    expect(identifyUrl("https://console.longbridge.xyz/x/wbo/funds?a=1", projects)).toMatchObject({ kind: "project_page", project: "whale-console", env: "测试", path: "/x/wbo/funds" });
    expect(identifyUrl("https://console.longbridge.xyz/opa/next/ai-contest/new", projects)).toMatchObject({ kind: "project_page", project: "fe-wealth-admin", env: "线上" });
  });

  it("认不出的只剩 host；空和坏 URL 返回 undefined", () => {
    expect(identifyUrl("https://news.ycombinator.com/item?id=1", projects)).toEqual({ kind: "other", url: "https://news.ycombinator.com/item?id=1", host: "news.ycombinator.com" });
    expect(identifyUrl(undefined, projects)).toBeUndefined();
    expect(identifyUrl("not a url at all", projects)).toBeUndefined();
  });

  it("标题栏文案和给模型的那句都带泳道", () => {
    const s = identifyUrl("https://console.longbridge.xyz/x/wbo/funds", projects)!;
    expect(sourceLabel(s, "canary2")).toBe("whale-console 测试环境 · 泳道 canary2");
    expect(sourceLine(s, "canary2")).toContain("泳道 canary2");
    expect(sourceLabel(identifyUrl("https://longbridge-group.jp.larksuite.com/docx/abc", projects)!)).toBe("Lark 文档");
  });
});
