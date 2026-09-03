// 操作分级（第二版启用，第一版仅定义类型）：
// - read：只读操作（查记忆库、拉 Slack/Meegle），自动放行。
// - reversible：可逆写操作（记待办、写 markdown、git commit），自动放行但写入审计日志。
// - irreversible：不可逆操作（删文件、push、发消息、付款），必须弹窗让用户确认后才执行。
// 分级由工具声明，由 agent 循环在调用工具前统一检查，而不是散落在各连接器里。
export type PermissionLevel = "read" | "reversible" | "irreversible";

export interface PermissionDecision {
  level: PermissionLevel;
  allowed: boolean;
  reason?: string;
}

export function decide(level: PermissionLevel): PermissionDecision {
  return { level, allowed: level !== "irreversible" };
}
