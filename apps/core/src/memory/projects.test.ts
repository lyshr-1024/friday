import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { parseProjects, resolveProject } from "./projects.js";

const md = `# 项目注册表

## friday
- 目录：~/hr-lys/friday
- 别名：助理、fri
- 状态：开发中
- 说明：个人助理

## whale-console
- 目录: ~/workspace/whale-console
- 别名: 后台, console

## whale-console-crypto
- 目录：~/workspace/whale-console-crypto

## 没有目录的
- 状态：废弃
`;

describe("项目注册表", () => {
  const projects = parseProjects(md);

  it("解析标题与字段，忽略没有目录的项目，展开 ~", () => {
    expect(projects.map((p) => p.name)).toEqual(["friday", "whale-console", "whale-console-crypto"]);
    expect(projects[0]).toMatchObject({ dir: `${homedir()}/hr-lys/friday`, aliases: ["助理", "fri"], status: "开发中", note: "个人助理" });
  });

  it("精确名优先，其次唯一的部分匹配，多个则返回候选", () => {
    expect(resolveProject("Friday", projects)).toMatchObject({ kind: "match", project: { name: "friday" } });
    expect(resolveProject("whale-console", projects)).toMatchObject({ kind: "match", project: { name: "whale-console" } });
    expect(resolveProject("crypto", projects)).toMatchObject({ kind: "match", project: { name: "whale-console-crypto" } });
    expect(resolveProject("whale", projects)).toMatchObject({ kind: "ambiguous" });
    expect(resolveProject("后台", projects)).toMatchObject({ kind: "match", project: { name: "whale-console" } });
    expect(resolveProject("FRI", projects)).toMatchObject({ kind: "match", project: { name: "friday" } });
    expect(resolveProject("nope", projects)).toEqual({ kind: "none" });
  });

  it("未登记但存在的目录路径可直接使用", () => {
    expect(resolveProject("~", projects)).toMatchObject({ kind: "match", project: { dir: homedir() } });
  });
});
