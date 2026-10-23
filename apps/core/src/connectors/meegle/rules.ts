import type { WorkItemKind, WorkItemRef, WorkItemState } from "../roles.js";

/**
 * 终态，跟你 Meegle 视图里勾掉的那几个一致（2026-09-29：已解决 / 已关闭 / 已终止 / WON'T FIX）。
 * 自定义状态的 key 是随机码（WON'T FIX 是 TPivPPL9-，已终止是 systemEnded），所以名称和 key 都认，中英文界面都认。
 */
const DONE_KEYS = new Set(["closed", "resolved", "done", "cancelled", "systemended"]);
const DONE_NAMES = /^(closed|resolved|done|cancelled|terminated|won'?t fix|已关闭|已解决|已终止)$/i;
/** 缺陷流到测试手上了：不是你的待办了，但也还没完 */
const TESTING_NAMES = /^(in testing|测试中)$/i;

export function stateOf(stateKey: string, stateLabel = ""): WorkItemState {
  const label = stateLabel.trim();
  if (DONE_KEYS.has(stateKey.toLowerCase()) || DONE_NAMES.test(label)) return "done";
  if (TESTING_NAMES.test(label)) return "testing";
  if (/reopen/i.test(label)) return "reopened";
  if (stateKey === "IN PROGRESS") return "in_progress";
  return "open";
}

export function kindOf(typeKey?: string): WorkItemKind {
  if (typeKey === "story") return "story";
  if (typeKey === "issue" || typeKey === "defect" || typeKey === "bug") return "defect";
  return "other";
}

/**
 * 从 Meegle 链接里拆出 project key 和工单号：
 * https://project.larksuite.com/projectlb/story/detail/24487610 → projectlb / 24487610
 * 光给一串数字不行——project key 只能从链接来。
 */
export function parseMeegleRef(input: string): { projectKey: string; workItemId: string } | undefined {
  const m = /\/([A-Za-z0-9_-]+)\/[A-Za-z0-9_]+\/detail\/(\d+)/.exec(input.trim());
  return m ? { projectKey: m[1]!, workItemId: m[2]! } : undefined;
}

export function parseRef(input: string): WorkItemRef | undefined {
  const r = parseMeegleRef(input);
  return r ? { space: r.projectKey, id: r.workItemId } : undefined;
}

export function idFromUrl(url: string): string | undefined {
  return /\/(?:issue|story|detail)\/(?:detail\/)?(\d{3,})/.exec(url)?.[1];
}

/** 工单号：链接里的 /detail/24440539，或裸的 8 位以上数字 */
const MEEGLE_URL = /(?:project\.(?:larksuite\.com|feishu\.cn)|[a-z0-9-]+\.meegle\.com)\/[^\s)]*?\/(?:detail|issue|story)\/(\d{6,})/gi;
const TICKET_IN_TEXT = /\b(\d{8})\b/g;

export function idsIn(text: string): string[] {
  if (!text) return [];
  const ids = new Set<string>();
  for (const m of text.matchAll(MEEGLE_URL)) if (m[1]) ids.add(m[1]);
  for (const m of text.matchAll(TICKET_IN_TEXT)) if (m[1]) ids.add(m[1]);
  return [...ids];
}

/** Meegle / 飞书自己的地址：工单描述里的这类链接不是出问题的页面，也不能学成项目地址 */
export const SELF_HOSTS = /(feishu\.cn|larksuite\.com|larkoffice\.com|bytedance\.)/i;

export const ownsHost = (hostOrUrl: string): boolean => SELF_HOSTS.test(hostOrUrl);
