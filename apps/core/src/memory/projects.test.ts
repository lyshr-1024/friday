import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { matchEnv, parseEnvs, parseProjects, projectDetail, resolveProject } from "./projects.js";

const md = `# 项目注册表

## friday
- 目录：~/hr-lys/friday
- 别名：助理、fri
- 状态：开发中
- 说明：个人助理

## whale-console
- 目录: ~/workspace/whale-console
- 别名: 后台, console
- 频道: team-fe-bo, #proj-whale-console

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
    expect(projects[1]!.channels).toEqual(["#team-fe-bo", "#proj-whale-console"]);
  });

  it("别名只按逗号顿号拆，词里的空格留着", () => {
    // 按空格拆会把「Whale 管理后台」拆出「管理后台」这种泛词，命中一切后台工单，归到错的仓库去改代码
    const ps = parseProjects("## p\n- 目录：/p\n- 别名：Whale 管理后台, wealth-admin、财富后台\n");
    expect(ps[0]!.aliases).toEqual(["Whale 管理后台", "wealth-admin", "财富后台"]);
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

  it("未知字段收进 extra 而不是丢掉", () => {
    const ps = parseProjects("## p\n- 目录：/p\n- 发布 tag 与子应用对应：apps/cms-next → release-cms-next-*\n- **强调键**：值\n");
    expect(ps[0]!.extra).toEqual({ "发布 tag 与子应用对应": "apps/cms-next → release-cms-next-*", 强调键: "值" });
  });

  it("同名的自定义字段多行累加", () => {
    const ps = parseProjects("## p\n- 目录：/p\n- 备注：一\n- 备注：二\n");
    expect(ps[0]!.extra["备注"]).toBe("一\n二");
  });

  it("projectDetail 把说明、环境、自定义字段一起给出去", () => {
    const ps = parseProjects("## p\n- 目录：/p\n- 说明：主力项目\n- 环境：测试 console.x/y/\n- 发布：release 分支\n");
    expect(projectDetail(ps[0]!)).toBe("主力项目\n环境：测试 console.x/y\n发布：release 分支");
  });
});

describe("环境解析", () => {
  it("按「名字 地址」拆，名字不做关键字校验", () => {
    expect(parseEnvs("线上 console.longbridge.xyz/、测试 console.longbridge.xyz/x/、SIT https://console.whalesit.xyz/x/")).toEqual([
      { name: "线上", url: "console.longbridge.xyz" },
      { name: "测试", url: "console.longbridge.xyz/x" },
      { name: "SIT", url: "console.whalesit.xyz/x" },
    ]);
    expect(parseEnvs("预发 a.example.com、玩具环境 b.example.com")).toEqual([
      { name: "预发", url: "a.example.com" },
      { name: "玩具环境", url: "b.example.com" },
    ]);
  });

  // 用户实际写的是整句话，认得出几个是几个，认不出的安静丢掉
  it("整句话里只捡「地址前面那个词」，没有名字的地址不要", () => {
    expect(parseEnvs("线上和测试都在 console.longbridge.xyz，SIT 是 console.whalesit.xyz")).toEqual([
      { name: "线上和测试都", url: "console.longbridge.xyz" },
      { name: "SIT", url: "console.whalesit.xyz" },
    ]);
    expect(parseEnvs("console.longbridge.xyz")).toEqual([]);
    expect(parseEnvs("暂时没有环境")).toEqual([]);
  });
});

describe("matchEnv", () => {
  const ps = parseProjects(
    "## whale-console\n- 目录：/w\n- 环境：测试 console.longbridge.xyz/x/、SIT console.whalesit.xyz/x/\n" +
      "## fe-wealth-admin\n- 目录：/f\n- 环境：线上 console.longbridge.xyz/\n" +
      "## 只有地址的\n- 目录：/o\n- 地址：old.example.com\n",
  );

  it("共用域名时按前缀最长归属，并带出环境名", () => {
    expect(matchEnv("https://console.longbridge.xyz/x/wbo/funds", ps)).toMatchObject({ project: { name: "whale-console" }, env: "测试" });
    expect(matchEnv("https://console.longbridge.xyz/next/subjects", ps)).toMatchObject({ project: { name: "fe-wealth-admin" }, env: "线上" });
    expect(matchEnv("https://console.whalesit.xyz/x/a", ps)).toMatchObject({ project: { name: "whale-console" }, env: "SIT" });
  });

  it("没写环境的项目退回 urls 匹配，没有环境名", () => {
    expect(matchEnv("https://old.example.com/a", ps)).toEqual({ project: ps[2] });
  });

  it("谁都对不上返回 undefined", () => {
    expect(matchEnv("https://mail.google.com/", ps)).toBeUndefined();
  });

  // 前缀要落在路径边界上，否则 /x 会吃掉 /xyz
  it("前缀不在路径边界上不算命中", () => {
    expect(matchEnv("https://console.longbridge.xyz/xyz/a", ps)).toMatchObject({ project: { name: "fe-wealth-admin" } });
  });
});
