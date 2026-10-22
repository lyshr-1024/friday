import { useEffect, useState } from "react";
import type { Message } from "@friday/shared";
import type { FridayEvent } from "../lib/events";
import { taskRelated } from "../lib/core";
import { AssistantBody } from "./shared";
import { MentionText, NoticeCard } from "./Thread";

/** 只读：主对话里提到这条任务的话，加上它旧会话里的消息 */
export function Related({ taskId }: { taskId: string }) {
  const [items, setItems] = useState<Message[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let timer = 0;
    let dead = false;
    const pull = () => void taskRelated(taskId).then((m) => { if (!dead) setItems(m); }).catch(() => {});
    pull();
    const onEvent = (e: Event) => {
      const ev = (e as CustomEvent<FridayEvent>).detail;
      if (ev.type === "tasks" || ev.type === "conversation") { window.clearTimeout(timer); timer = window.setTimeout(pull, 200); }
    };
    window.addEventListener("friday:event", onEvent);
    return () => { dead = true; window.clearTimeout(timer); window.removeEventListener("friday:event", onEvent); };
  }, [taskId]);

  if (items.length === 0) return null;
  return (
    <div className="related">
      <button className="related__head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span>相关对话 {items.length} 条</span>
        <span className="related__fold">{open ? "收起" : "展开"}</span>
      </button>
      {open && (
        <div className="related__list">
          {items.map((m) => (
            <div key={m.id} className={`tm${m.role === "user" ? " tm--user" : ""}`}>
              {m.role !== "user" && <span className="tm__who is-friday">Friday</span>}
              <div className="tm__body">
                {m.role === "user" ? <span className="tm__text"><MentionText text={m.content} /></span> : m.kind === "notice" ? <NoticeCard m={m} readOnly /> : <AssistantBody m={m} />}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
