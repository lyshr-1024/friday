import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cookieDomains, decryptValue } from "./chromeCookies.js";

const key = pbkdf2Sync("peanuts", "saltysalt", 1003, 16, "sha1");
const encrypt = (plain: Buffer) => {
  const c = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  return Buffer.concat([Buffer.from("v10"), c.update(plain), c.final()]);
};

describe("chromeCookies", () => {
  it("查自己和每一级父域，不查顶级域", () => {
    expect(cookieDomains("v.longbridge-inc.com")).toEqual(["v.longbridge-inc.com", ".v.longbridge-inc.com", ".longbridge-inc.com"]);
  });

  it("解密新版带 host 摘要前缀的值", () => {
    const host = "v.longbridge-inc.com";
    const enc = encrypt(Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from("abc.def")]));
    expect(decryptValue(enc, host, key)).toBe("abc.def");
  });

  it("解密旧版没有前缀的值", () => {
    expect(decryptValue(encrypt(Buffer.from("plain-session")), "x.com", key)).toBe("plain-session");
  });
});
