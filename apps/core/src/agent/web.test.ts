import { describe, expect, it } from "vitest";
import { needsLogin } from "./web.js";

const page = (url: string, title: string, text: string) => ({ url, title, text });

describe("needsLogin", () => {
  it("VibeClub 的 401 无权页算要登录", () => {
    const url = "https://v.longbridge-inc.com/p/jiacheng.zhou/refactoring-ui-zh";
    expect(needsLogin(url, page(url, "Access restricted — VibeClub", "VibeClub\n401 UNAUTHORIZED\nAccess restricted\nSign in to request access"))).toBe(true);
  });

  it("被重定向到 SSO 登录页算要登录", () => {
    expect(needsLogin("https://gitlab.longbridge-inc.com/a/b", page("https://accounts.longbridge-inc.com/realms/x/protocol/openid-connect/auth?x=1", "Sign in", "很长的表单"))).toBe(true);
    expect(needsLogin("https://gitlab.longbridge-inc.com/a/b", page("https://gitlab.longbridge-inc.com/users/sign_in", "Sign in · GitLab", "x".repeat(2000)))).toBe(true);
  });

  it("正文够长的页面导航里带「登录」不算", () => {
    const url = "https://example.com/post";
    expect(needsLogin(url, page(url, "一篇文章", `登录 注册\n${"正文".repeat(500)}`))).toBe(false);
  });

  it("本来就打开的是登录页，不当成被拦", () => {
    const url = "https://example.com/login";
    expect(needsLogin(url, page(url, "Login", "x".repeat(2000)))).toBe(false);
  });
});
