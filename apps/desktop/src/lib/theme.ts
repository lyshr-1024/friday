import { emit, listen } from "@tauri-apps/api/event";
import type { ThemeId } from "@friday/shared";

const KEY = "friday.theme";

/** 主题写在 <html data-theme>；本地缓存一份，启动时先用缓存避免闪一下默认色。 */
export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
  }
}

export function cachedTheme(): ThemeId | null {
  try {
    return (localStorage.getItem(KEY) as ThemeId | null) ?? null;
  } catch {
    return null;
  }
}

/** 设置窗改了主题，广播给其他窗口（工作台）立刻换色。 */
export function broadcastTheme(theme: ThemeId): void {
  applyTheme(theme);
  void emit("friday://theme", theme).catch(() => {});
}

export function onThemeChange(cb: (t: ThemeId) => void): () => void {
  let stop = () => {};
  void listen<ThemeId>("friday://theme", (e) => cb(e.payload)).then((f) => (stop = f)).catch(() => {});
  return () => stop();
}
