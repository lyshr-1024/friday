import { db } from "./db.js";

export interface SignalScore {
  confirmed: number;
  rejected: number;
}

export function signalScore(signal: string): SignalScore {
  const r = db().prepare("SELECT confirmed, rejected FROM stage_signals WHERE signal = ?").get(signal) as unknown as SignalScore | undefined;
  return r ?? { confirmed: 0, rejected: 0 };
}

export function bumpSignal(signal: string, which: "confirmed" | "rejected"): SignalScore {
  const cur = signalScore(signal);
  const next = { ...cur, [which]: cur[which] + 1 };
  db()
    .prepare(
      "INSERT INTO stage_signals (signal, confirmed, rejected, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(signal) DO UPDATE SET confirmed = excluded.confirmed, rejected = excluded.rejected, updated_at = excluded.updated_at",
    )
    .run(signal, next.confirmed, next.rejected, new Date().toISOString());
  return next;
}

export function listSignals(): Array<SignalScore & { signal: string }> {
  return db().prepare("SELECT signal, confirmed, rejected FROM stage_signals ORDER BY confirmed + rejected DESC").all() as unknown as Array<SignalScore & { signal: string }>;
}
