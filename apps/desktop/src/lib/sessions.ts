import { coreBaseUrl } from "./core";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const base = await coreBaseUrl();
  const res = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}
const post = <T>(path: string, body: unknown = {}) => call<T>(path, { method: "POST", body: JSON.stringify(body) });
const S = (id: string) => `/sessions/${encodeURIComponent(id)}`;

export interface TmuxWindow { index: number; name: string; active: boolean }
export const sessionWindows = (id: string) => call<TmuxWindow[]>(`${S(id)}/windows`);
export const newSessionWindow = (id: string) => post(`${S(id)}/windows`);
export const selectSessionWindow = (id: string, idx: number) => post(`${S(id)}/windows/${idx}/select`);
export const closeSessionWindow = (id: string, idx: number) => call(`${S(id)}/windows/${idx}`, { method: "DELETE" });
export const splitSession = (id: string, dir: "h" | "v") => post(`${S(id)}/split`, { dir });
export const searchSession = (id: string, q: string) => post(`${S(id)}/search`, { q });
export const clearSession = (id: string) => post(`${S(id)}/clear`);
export const markSessionSeen = (id: string) => post(`${S(id)}/seen`).catch(() => undefined);
export const attachSession = (id: string, cols: number, rows: number) => post<{ attachId: string }>(`${S(id)}/attach`, { cols, rows });
export const terminalPrefs = () => call<{ fontFamily?: string; fontSize?: number }>("/terminal/prefs");
export const copyText = (text: string) => post("/clipboard", { text });
