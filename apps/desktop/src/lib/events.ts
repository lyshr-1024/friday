import type { TerminalState } from "@friday/shared";
import { coreBaseUrl } from "./core";

export type FridayEvent =
  | { type: "hello" }
  | { type: "ping" }
  | { type: "tasks" }
  | { type: "terminal"; jobId: string; state: TerminalState }
  | { type: "conversation"; id: string; running: boolean };

/** 连上 core 的 /events，把推送转成 window 事件；断了按退避重连。 */
export function connectEvents(): () => void {
  let es: EventSource | null = null;
  let stopped = false;
  let retry = 1000;
  const open = async () => {
    const base = await coreBaseUrl();
    if (stopped) return;
    es = new EventSource(`${base}/events`);
    es.onopen = () => {
      retry = 1000;
      // 断线期间可能漏了变更，连上就整体对一次
      window.dispatchEvent(new Event("friday:tasks-changed"));
    };
    es.onmessage = (m) => {
      let ev: FridayEvent;
      try {
        ev = JSON.parse(m.data) as FridayEvent;
      } catch {
        return;
      }
      window.dispatchEvent(new CustomEvent<FridayEvent>("friday:event", { detail: ev }));
      if (ev.type === "tasks") window.dispatchEvent(new Event("friday:tasks-changed"));
    };
    es.onerror = () => {
      es?.close();
      es = null;
      if (stopped) return;
      setTimeout(() => void open(), retry);
      retry = Math.min(retry * 2, 15_000);
    };
  };
  void open();
  return () => {
    stopped = true;
    es?.close();
  };
}
