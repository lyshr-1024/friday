// 用户在会话里明确说了「强推」才有：只认这条任务、这个分支，一次有效，过期作废。只放在内存里，core 重启就没了，要强推再说一次
export const FORCE_GRANT_MS = 10 * 60_000;

const grants = new Map<string, { branch: string; until: number }>();

export function grantForcePush(taskId: string, branch: string, now = Date.now()): void {
  grants.set(taskId, { branch, until: now + FORCE_GRANT_MS });
}

export function hasForcePush(taskId: string, branch: string, now = Date.now()): boolean {
  const g = grants.get(taskId);
  return Boolean(g && g.until > now && g.branch === branch);
}

export function takeForcePush(taskId: string, branch: string, now = Date.now()): boolean {
  if (!hasForcePush(taskId, branch, now)) return false;
  grants.delete(taskId);
  return true;
}
