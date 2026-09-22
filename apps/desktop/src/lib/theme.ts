import { emit, listen } from "@tauri-apps/api/event";
import type { ThemeId } from "@friday/shared";

const KEY = "friday.theme";
const BG_KEY = "friday.background";

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

export interface BackgroundPrefs {
  /** 空串 = 不用背景图 */
  background: string;
  /** 盖在图上那层底色的不透明度 0-100 */
  backgroundOpacity: number;
}

/**
 * 背景图由 core 从 127.0.0.1 发出来（WebView 读不了 file://，CSP 也没放行 asset:）。
 * 加时间戳是因为换了图路径不变时浏览器会拿缓存。
 */
export function applyBackground(prefs: BackgroundPrefs, baseUrl: string): void {
  const root = document.documentElement;
  if (prefs.background) {
    root.dataset.bg = "on";
    root.style.setProperty("--bg-image", `url("${baseUrl}/background?v=${Date.now()}")`);
  } else {
    delete root.dataset.bg;
    root.style.removeProperty("--bg-image");
  }
  root.style.setProperty("--bg-veil", String(prefs.backgroundOpacity / 100));
  try {
    localStorage.setItem(BG_KEY, JSON.stringify(prefs));
  } catch {
  }
}

export function cachedBackground(): BackgroundPrefs | null {
  try {
    const raw = localStorage.getItem(BG_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<BackgroundPrefs>;
    if (typeof p.background !== "string" || typeof p.backgroundOpacity !== "number") return null;
    return { background: p.background, backgroundOpacity: p.backgroundOpacity };
  } catch {
    return null;
  }
}

export function broadcastBackground(prefs: BackgroundPrefs, baseUrl: string): void {
  applyBackground(prefs, baseUrl);
  void emit("friday://background", prefs).catch(() => {});
}

export function onBackgroundChange(cb: (p: BackgroundPrefs) => void): () => void {
  let stop = () => {};
  void listen<BackgroundPrefs>("friday://background", (e) => cb(e.payload)).then((f) => (stop = f)).catch(() => {});
  return () => stop();
}
