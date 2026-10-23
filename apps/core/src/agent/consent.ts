import { listMessages } from "../memory/conversations.js";

// 否定、条件、追问、还要改：出现就不算同意（「执行之前先给我看看」「先别执行」「执行吗」「发吧，语气再软点」「合并前先跑下测试」）
const HOLD = /别|不要|不用|不行|等等|等一下|等下|稍等|算了|取消|暂停|先|前|再|改|但是|不过|吗|呢|[？?]/;
// 通用肯定词要独立成词：「好像不对」「可以看看」不算
const YES = ["好的", "好啊", "好", "可以", "行", "确认", "同意", "没问题", "ok", "嗯"];
const BOUNDARY = /^($|[，,。.!！~～\s])/;

/**
 * 用户这句算不算同意：以这个动作的词或通用肯定词开头、没有否定 / 条件 / 追问就算（「执行我看看」「好，提交吧」）。
 * 2026-10-23 前只认一字不差的整句，用户说「执行我看看」被拒，Friday 还让他背口令。
 * 动作词两个字以上开头就算；单字（「删」「发」）和通用肯定词要独立成词。
 * generic 为 false 只认动作自己的说法（有未提交改动的 worktree 要说「连改动一起删」，一句「好」不够）
 */
export function consents(said: string, forms: string[], generic = true): boolean {
  const s = said.replace(/[。！!～~\s]+$/, "").trim();
  const lower = s.toLowerCase();
  // 拦截词只查同意词后面那截：「连改动一起删掉」本身带「改」
  const lead = (w: string, strict: boolean) => {
    if (!lower.startsWith(w.toLowerCase())) return false;
    const rest = s.slice(w.length);
    return (!strict || BOUNDARY.test(rest)) && !HOLD.test(rest);
  };
  return forms.some((f) => lead(f, [...f].length < 2)) || (generic && YES.some((w) => lead(w, true)));
}

/** 用户原话句首的 #N 点名（句中的不算）；said 是去掉点名后的部分 */
export function leadingRef(raw: string): { seq?: number; said: string } {
  const m = /^#(\d+)\s*/.exec(raw);
  return m ? { seq: Number(m[1]), said: raw.slice(m[0].length) } : { said: raw };
}

export function lastUserMessage(conversationId?: string): { id: string | null; prevId: string | null; text: string } {
  if (!conversationId) return { id: null, prevId: null, text: "" };
  const users = listMessages(conversationId).filter((x) => x.role === "user");
  const m = users.at(-1);
  return { id: m?.id ?? null, prevId: users.at(-2)?.id ?? null, text: (m?.content ?? "").trim() };
}

export type ConsentGate = (conversationId: string | undefined, key: string, forms: string[]) => { ok: true; said: string } | { ok: false };

// key 要把被问的对象写全（路径、参数）：同意只对被问的那个有效，且必须是问完之后用户新说的一句
/**
 * 不可逆动作的两步同意：先调一次只登记「问过」，用户下一句同意再调才放行。
 * 一段会话按 key 各记一条：Friday 一轮问了 7 条，用户一句同意 7 条都放行（原来只记一个，被逐个覆盖成最后那条，一句只放一条）。
 * 同意只认紧接在问之后的那一句：同一轮连调两次不会自己批准，问完隔了一句别的再同意也不算
 */
export function consentGate(): ConsentGate {
  const asked = new Map<string, Map<string, string | null>>();
  return (conversationId, key, forms) => {
    const { id, prevId, text } = lastUserMessage(conversationId);
    const slot = conversationId ?? "";
    const round = asked.get(slot) ?? new Map<string, string | null>();
    asked.set(slot, round);
    const after = round.get(key);
    if (conversationId && id !== null && after != null && after === prevId && consents(text, forms)) {
      round.delete(key);
      return { ok: true, said: text };
    }
    round.set(key, id);
    return { ok: false };
  };
}
