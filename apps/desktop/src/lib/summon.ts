import type { RunResponse, Snapshot, SummonAction, SummonEvent } from "@friday/shared";
import { coreBaseUrl, conversationToTask, queryConversation } from "./core";

export async function* summonStream(snapshot: Snapshot, signal: AbortSignal): AsyncGenerator<SummonEvent> {
  // core 连不上或中途断流时必须吐 error + done，否则界面永远停在「正在判断」
  try {
    const res = await fetch(`${await coreBaseUrl()}/summon`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ snapshot }),
      signal,
    });
    if (!res.ok || !res.body) {
      yield { type: "error", message: `core 返回 ${res.status}` };
      yield { type: "done" };
      return;
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
        if (data) yield JSON.parse(data) as SummonEvent;
      }
    }
  } catch (e) {
    // 取消是正常结果不是故障：signal.aborted 有时滞后，名字和 Tauri 的
    // 「Operation aborted」一起判，免得把取消当错误显示给用户
    const msg = e instanceof Error ? e.message : String(e);
    if (signal.aborted || (e instanceof Error && e.name === "AbortError") || /abort/i.test(msg)) return;
    yield { type: "error", message: msg || "连不上 Friday" };
    yield { type: "done" };
  }
}

/** 执行一个动作，返回给用户看的一句话。 */
/** 动作的结果：一句提示；带 focus 时 HUD 不停留，直接跳到工作台选中那条任务 */
export interface ActionOutcome {
  text: string;
  focus?: string;
}

export async function runAction(action: SummonAction): Promise<ActionOutcome> {
  const base = await coreBaseUrl();
  switch (action.kind) {
    case "open_task":
      return { text: "已打开任务", focus: action.taskId };
    case "approve_pending": {
      const res = await fetch(`${base}/tasks/${action.taskId}/approve/${action.actionId}`, { method: "POST" });
      if (!res.ok) throw new Error(`执行失败 ${res.status}`);
      return { text: "已执行" };
    }
    case "start_work": {
      const res = await fetch(`${base}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: action.project, task: action.prompt }),
      });
      if (!res.ok) throw new Error(`开工失败 ${res.status}`);
      const body = (await res.json()) as RunResponse;
      if (body.status === "ambiguous") throw new Error(`项目名有歧义：${body.candidates.map((c) => c.name).join("、")}`);
      return { text: `已在 ${action.project} 开工` };
    }
    case "copy":
      await navigator.clipboard.writeText(action.text);
      return { text: "已复制" };
    case "slack_query":
      // 后台查询不弹窗口（用户定），查完结果进任务卡
      await queryConversation(action.conv);
      return { text: "已在工作台里查" };
    case "slack_task": {
      const task = await conversationToTask(action.conv);
      return { text: "已建成任务", focus: task.id };
    }
    default: {
      const res = await fetch(`${base}/summon/act`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = (await res.json()) as { ok?: boolean; message?: string; error?: string; taskId?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? "执行失败");
      // 建成任务 / 加进任务板：建完直接跳过去，不然人还停在原来的 app 里、不知道去哪找
      const created = action.kind === "create_task" || action.kind === "meegle_add";
      return { text: body.message ?? "已完成", ...(created && body.taskId ? { focus: body.taskId } : {}) };
    }
  }
}
