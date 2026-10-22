import type { Task } from "@friday/shared";
import { publish, subscribe } from "../bus.js";
import { addMessage } from "../memory/conversations.js";
import { getCursor, setCursor } from "../memory/inbox.js";
import { mainConversationId } from "../memory/mainConversation.js";
import { listOpenBoardTasks, taskTag } from "../memory/tasks.js";
import { deliveryText } from "./delivery.js";
import { needOf } from "./needs.js";

export function noticeText(t: Task, need: NonNullable<ReturnType<typeof needOf>>): string {
  if (need.kind === "brief") return `${taskTag(t)} · 方案待审\n${need.reason}\n说「#${t.seq} 按这个做」开工，或说哪里要改。`;
  if (need.kind === "review") return `${taskTag(t)} · 待验收\n${deliveryText(t.report!, Boolean(t.source.headless))}`;
  return `${taskTag(t)} · 卡住\n${need.reason}`;
}

/** 升级后第一次只记 key 不发，否则存量任务会一口气在主对话里刷出一排 */
export function postNotices(): number {
  const first = getCursor("notice:init") === undefined || getCursor("notice:init") === "";
  let posted = 0;
  for (const t of listOpenBoardTasks()) {
    const need = needOf(t);
    const cursor = `notice:${t.id}`;
    const seen = getCursor(cursor) ?? "";
    if (!need) {
      if (seen) setCursor(cursor, "");
      continue;
    }
    if (need.key === seen) continue;
    if (!first) {
      const shots = need.kind === "review" ? t.report?.screenshots : undefined;
      addMessage(mainConversationId(), {
        role: "assistant",
        kind: "notice",
        content: noticeText(t, need),
        payload: shots?.length ? { attachments: shots } : undefined,
        taskIds: [t.id],
      });
      posted++;
    }
    setCursor(cursor, need.key);
  }
  if (first) setCursor("notice:init", "1");
  if (posted) publish({ type: "conversation", id: mainConversationId(), running: false });
  return posted;
}

export function startNoticeWatcher(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const off = subscribe((ev) => {
    if (ev.type !== "tasks" || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      try {
        postNotices();
      } catch (e) {
        console.error(`[notices] ${e instanceof Error ? e.message : e}`);
      }
    }, 500);
  });
  return () => {
    off();
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
}
