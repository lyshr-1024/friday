import { describe, expect, it, vi } from "vitest";
import { resolveLocalDev, type Exec } from "./localDev.js";

describe("本地 dev server 的目录", () => {
  it("端口 → pid → cwd", async () => {
    const exec = vi.fn<Exec>(async (args) => {
      if (args.includes("-iTCP:5173")) return "p48213\nf12\n";
      if (args.includes("-p") && args.includes("48213")) return "p48213\nfcwd\nn/Users/me/workspace/whale-console-funds-params\n";
      return "";
    });
    expect(await resolveLocalDev(5173, exec)).toEqual({ port: 5173, dir: "/Users/me/workspace/whale-console-funds-params" });
    expect(exec.mock.calls[0]![0]).toEqual(["-nP", "-iTCP:5173", "-sTCP:LISTEN", "-Fp"]);
  });

  it("没人监听返回 undefined；第一个 pid 查不到 cwd 看下一个", async () => {
    expect(await resolveLocalDev(9999, async () => "")).toBeUndefined();
    const exec: Exec = async (args) => {
      if (args.includes("-iTCP:3000")) return "p1\np2\n";
      if (args.includes("1")) throw new Error("gone");
      return "n/Users/me/workspace/foxden\n";
    };
    expect(await resolveLocalDev(3000, exec)).toEqual({ port: 3000, dir: "/Users/me/workspace/foxden" });
  });

  it("端口不合法直接返回", async () => {
    const exec = vi.fn<Exec>(async () => "");
    expect(await resolveLocalDev(0, exec)).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });
});
