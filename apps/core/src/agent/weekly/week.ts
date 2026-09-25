export interface Week { id: string; start: Date; end: Date }

const mmdd = (x: Date) => `${String(x.getMonth() + 1).padStart(2, "0")}${String(x.getDate()).padStart(2, "0")}`;
const addDays = (x: Date, n: number) => new Date(x.getFullYear(), x.getMonth(), x.getDate() + n);

export function weekOf(anyDay: Date): Week {
  const start = addDays(anyDay, -((anyDay.getDay() + 6) % 7));
  return { id: `${start.getFullYear()}W${mmdd(start)}-${mmdd(addDays(start, 6))}`, start, end: addDays(start, 7) };
}

export function targetWeek(now: Date): Week {
  const day = now.getDay();
  const thisWeek = (day === 5 && now.getHours() >= 16) || day === 6 || day === 0;
  return weekOf(thisWeek ? now : addDays(now, -7));
}

export function parseWeek(id: string): Week | undefined {
  const m = /^(\d{4})W(\d{2})(\d{2})-\d{4}$/.exec(id);
  if (!m) return undefined;
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (start.getDay() !== 1) return undefined;
  const w = weekOf(start);
  return w.id === id ? w : undefined;
}
