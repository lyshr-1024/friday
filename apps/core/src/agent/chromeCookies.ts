import { execFile } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 同 memory/db.ts：esbuild 会把 node:sqlite 的前缀剥掉，打包后启动就找不到包
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

// 从你 Chrome 的 Cookie 库里取某个站点的 Cookie，给 Friday 的无头浏览器用：你在 Chrome 里登着什么，Friday 就是什么。
const CHROME_DIR = process.env.FRIDAY_CHROME_DIR || join(process.env.HOME ?? "", "Library/Application Support/Google/Chrome");

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "None" | "Lax" | "Strict";
}

interface Row {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array;
  path: string;
  /** Unix 秒，会话 Cookie 为 0 */
  expires: number;
  is_secure: number;
  is_httponly: number;
  samesite: number;
  last_access: number;
}

/** 会带上这个站点 Cookie 的 host_key：自己（host-only 和 .host）加上每一级父域。只按精确值查，公共后缀上不会有 Cookie */
export function cookieDomains(host: string): string[] {
  const labels = host.split(".");
  const out = [host, `.${host}`];
  for (let i = 1; i < labels.length - 1; i++) out.push(`.${labels.slice(i).join(".")}`);
  return out;
}

let key: Buffer | undefined;
function safeStorageKey(): Promise<Buffer> {
  if (key) return Promise.resolve(key);
  // 第一次会弹钥匙串授权框，点「始终允许」后不再问
  return new Promise((resolve, reject) =>
    execFile("/usr/bin/security", ["find-generic-password", "-w", "-s", "Chrome Safe Storage"], { timeout: 60_000 }, (err, stdout) => {
      if (err) return reject(new Error("读不到 Chrome 的 Cookie 密钥（钥匙串「Chrome Safe Storage」没授权）"));
      key = pbkdf2Sync(stdout.trim(), "saltysalt", 1003, 16, "sha1");
      resolve(key);
    }),
  );
}

export function decryptValue(enc: Uint8Array, host: string, k: Buffer): string {
  const buf = Buffer.from(enc);
  if (buf.subarray(0, 3).toString() !== "v10") return buf.toString("utf8");
  const d = createDecipheriv("aes-128-cbc", k, Buffer.alloc(16, " "));
  const plain = Buffer.concat([d.update(buf.subarray(3)), d.final()]);
  // 新版 Chrome 在明文前加了 32 字节的 SHA256(host_key)，防止把 Cookie 搬到别的域名下
  const digest = createHash("sha256").update(host).digest();
  return (plain.length >= 32 && plain.subarray(0, 32).equals(digest) ? plain.subarray(32) : plain).toString("utf8");
}

const SAME_SITE = { 0: "None", 1: "Lax", 2: "Strict" } as const;

// Chrome 的时间是 1601 年起的微秒，超出 JS 安全整数，在 SQL 里先换成 Unix 秒
const UNIX = (col: string) => `CASE WHEN ${col} = 0 THEN 0 ELSE ${col} / 1000000 - 11644473600 END`;

/** Chrome 开着时 Cookie 库被锁、还可能有没落盘的 journal，拷一份再读 */
function readRows(profileDir: string, domains: string[]): Row[] {
  const tmp = mkdtempSync(join(tmpdir(), "friday-ck-"));
  try {
    copyFileSync(join(profileDir, "Cookies"), join(tmp, "Cookies"));
    if (existsSync(join(profileDir, "Cookies-journal"))) copyFileSync(join(profileDir, "Cookies-journal"), join(tmp, "Cookies-journal"));
    const db = new DatabaseSync(join(tmp, "Cookies"), { readOnly: true });
    try {
      const marks = domains.map(() => "?").join(",");
      return db.prepare(`SELECT host_key, name, value, encrypted_value, path, is_secure, is_httponly, samesite, ${UNIX("expires_utc")} AS expires, ${UNIX("last_access_utc")} AS last_access FROM cookies WHERE host_key IN (${marks})`).all(...domains) as unknown as Row[];
    } finally {
      db.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 所有 profile 里找这个站点的 Cookie，取最近用过的那个 profile 的（你多半有工作 / 个人两个 profile） */
export async function chromeCookies(url: string): Promise<Cookie[]> {
  if (!existsSync(CHROME_DIR)) return [];
  const host = new URL(url).hostname;
  const domains = cookieDomains(host);
  const profiles = readdirSync(CHROME_DIR).filter((d) => (d === "Default" || d.startsWith("Profile ")) && existsSync(join(CHROME_DIR, d, "Cookies")));
  const now = Date.now() / 1000;
  let best: { rows: Row[]; last: number } | undefined;
  for (const p of profiles) {
    const rows = readRows(join(CHROME_DIR, p), domains).filter((r) => r.expires === 0 || r.expires > now);
    if (!rows.length) continue;
    const last = Math.max(...rows.map((r) => r.last_access));
    if (!best || last > best.last) best = { rows, last };
  }
  if (!best) return [];
  const k = await safeStorageKey();
  return best.rows.map((r) => ({
    name: r.name,
    value: r.value || decryptValue(r.encrypted_value, r.host_key, k),
    domain: r.host_key,
    path: r.path,
    expires: r.expires === 0 ? -1 : r.expires,
    httpOnly: !!r.is_httponly,
    secure: !!r.is_secure,
    ...(r.samesite in SAME_SITE ? { sameSite: SAME_SITE[r.samesite as 0 | 1 | 2] } : {}),
  }));
}
