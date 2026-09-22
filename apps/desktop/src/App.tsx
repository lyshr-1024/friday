import { Chat } from "./views/Chat";
import { Hud } from "./views/Hud";
import { Settings } from "./views/Settings";
import { applyBackground, applyTheme, cachedBackground, cachedTheme } from "./lib/theme";
import { coreBaseUrl } from "./lib/core";

const cached = cachedTheme();
if (cached) applyTheme(cached);

// 缓存里有背景就先铺上，等 core 那轮回来再校正——否则每次开窗都要先闪一下纯色底
const cachedBg = cachedBackground();
if (cachedBg?.background) void coreBaseUrl().then((url) => applyBackground(cachedBg, url)).catch(() => {});

const view = new URLSearchParams(location.search).get("view");

export function App() {
  if (view === "settings") return <Settings />;
  if (view === "hud") return <Hud />;
  return <Chat />;
}
