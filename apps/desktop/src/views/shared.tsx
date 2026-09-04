import { openUrl } from "@tauri-apps/plugin-opener";
import type { Message, RunResponse, TodayResponse, Todo } from "@friday/shared";

export function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <ul className="todos">
      {todos.map((t) => (
        <li key={t.id} className={`todo todo--${t.source}`}>
          <span className="todo__source mono">{t.source}</span>
          {t.sourceUrl ? (
            <a href={t.sourceUrl} onClick={(e) => { e.preventDefault(); void openUrl(t.sourceUrl!); }}>
              {t.text}
            </a>
          ) : (
            <span>{t.text}</span>
          )}
          {t.due && <span className="todo__due mono">{t.due}</span>}
        </li>
      ))}
    </ul>
  );
}

export function AssistantBody({ m }: { m: Message }) {
  if (m.kind === "error") return <div className="err">{m.content}</div>;
  if (m.kind === "today" && m.payload) {
    const res = m.payload as TodayResponse;
    return (
      <>
        <div className="answer">{m.content}</div>
        {res.todos.length > 0 && (
          <details className="todos-fold">
            <summary>{res.todos.length} 条待办</summary>
            <TodoList todos={res.todos} />
          </details>
        )}
      </>
    );
  }
  if (m.kind === "run" && m.payload && (m.payload as RunResponse).status === "ambiguous") {
    const res = m.payload as Extract<RunResponse, { status: "ambiguous" }>;
    return (
      <>
        <div className="answer">{m.content}</div>
        <ul className="todos">
          {res.candidates.map((c) => (
            <li key={c.dir} className="todo">
              <span>{c.name}</span>
              <span className="todo__due mono">{c.dir}</span>
            </li>
          ))}
        </ul>
      </>
    );
  }
  return <div className="answer">{m.content}</div>;
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
