import { describe, expect, it } from "vitest";
import type { Project } from "../../memory/projects.js";
import { parseTerminalTitle, projectByDirName } from "./terminal.js";

describe("parseTerminalTitle", () => {
  it("user@host: /path 格式取路径", () => {
    expect(parseTerminalTitle("me@macbook: /Users/me/work/whale-console")).toBe("/Users/me/work/whale-console");
  });

  it("目录名 — 命令 格式取目录名", () => {
    expect(parseTerminalTitle("whale-console — zsh")).toBe("whale-console");
  });

  it("目录名 - 命令（半角横线）格式取目录名", () => {
    expect(parseTerminalTitle("whale-console - node")).toBe("whale-console");
  });

  it("纯目录名原样返回", () => {
    expect(parseTerminalTitle("whale-console")).toBe("whale-console");
  });

  it("Claude Code 把标题改成任务描述时解析不出", () => {
    expect(parseTerminalTitle("◐ Friday 呼出模式改进")).toBeUndefined();
  });

  it("空标题返回 undefined", () => {
    expect(parseTerminalTitle("")).toBeUndefined();
  });
});

describe("projectByDirName", () => {
  const projects: Project[] = [
    { name: "whale-console", dir: "/Users/me/work/whale-console", aliases: ["鲸鱼后台"], channels: [], urls: [] },
    { name: "friday", dir: "/Users/me/hr-lys/friday", aliases: [], channels: [], urls: [] },
  ];

  it("按目录最后一段匹配", () => {
    expect(projectByDirName("whale-console", projects)?.name).toBe("whale-console");
  });

  it("按项目名匹配", () => {
    expect(projectByDirName("friday", projects)?.name).toBe("friday");
  });

  it("按别名匹配", () => {
    expect(projectByDirName("鲸鱼后台", projects)?.name).toBe("whale-console");
  });

  it("大小写不敏感", () => {
    expect(projectByDirName("Whale-Console", projects)?.name).toBe("whale-console");
  });

  it("对不上返回 undefined", () => {
    expect(projectByDirName("random-dir", projects)).toBeUndefined();
  });
});
