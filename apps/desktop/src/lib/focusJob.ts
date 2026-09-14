/** 「聚焦终端」：内嵌终端没有窗口可以拉到前台，改为跳到工作台里这条任务并把光标放进它的 xterm。 */
let pending: string | null = null;

export function requestFocusJob(jobId: string): void {
  pending = jobId;
  window.dispatchEvent(new CustomEvent("friday:focus-job", { detail: jobId }));
}

export function peekFocusJob(): string | null {
  return pending;
}

export function takeFocusJob(jobId: string): boolean {
  if (pending !== jobId) return false;
  pending = null;
  return true;
}
