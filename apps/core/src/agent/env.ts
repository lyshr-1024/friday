/**
 * Friday 若是从某个 Claude Code 会话里被拉起的，会继承 CLAUDECODE / CLAUDE_CODE_* 环境变量；
 * 带着它们跑 claude 会被当成子会话、不保存 transcript，重开时 --resume 就接不上。
 */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !(k === "CLAUDECODE" || k === "CLAUDE_PID" || k.startsWith("CLAUDE_CODE_"))));
}
