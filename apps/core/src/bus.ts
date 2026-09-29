import { EventEmitter } from "node:events";

/** 进程内事件总线：状态一变就推给前端（GET /events），前端不用轮询猜。 */
export type BusEvent =
  | { type: "tasks" }
  | { type: "conversation"; id: string; running: boolean };

const em = new EventEmitter();
em.setMaxListeners(200);

export function publish(ev: BusEvent): void {
  em.emit("ev", ev);
}

export function subscribe(cb: (ev: BusEvent) => void): () => void {
  em.on("ev", cb);
  return () => em.off("ev", cb);
}
