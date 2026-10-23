import { listMessages } from "../memory/conversations.js";

export function consents(said: string, forms: string[]): boolean {
  if (/[？?]/.test(said)) return false;
  return forms.includes(said.replace(/[。！!～~\s]+$/, "").trim());
}

/** 用户原话句首的 #N 点名（句中的不算）；said 是去掉点名后的部分 */
export function leadingRef(raw: string): { seq?: number; said: string } {
  const m = /^#(\d+)\s*/.exec(raw);
  return m ? { seq: Number(m[1]), said: raw.slice(m[0].length) } : { said: raw };
}

export function lastUserMessage(conversationId?: string): { id: string | null; text: string } {
  if (!conversationId) return { id: null, text: "" };
  const m = listMessages(conversationId).filter((x) => x.role === "user").at(-1);
  return { id: m?.id ?? null, text: (m?.content ?? "").trim() };
}

export type ConsentGate = (conversationId: string | undefined, key: string, forms: string[]) => { ok: true; said: string } | { ok: false };

// key 要把被问的对象写全（路径、参数）：同意只对被问的那个有效，且必须是问完之后用户新说的一句
export function consentGate(): ConsentGate {
  const asked = new Map<string, { key: string; after: string | null }>();
  return (conversationId, key, forms) => {
    const { id, text } = lastUserMessage(conversationId);
    const slot = conversationId ?? "";
    const prior = asked.get(slot);
    if (conversationId && id !== null && prior?.key === key && id !== prior.after && consents(text, forms)) {
      asked.delete(slot);
      return { ok: true, said: text };
    }
    asked.set(slot, { key, after: id });
    return { ok: false };
  };
}
