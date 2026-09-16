import { Chat } from "./views/Chat";
import { Hud } from "./views/Hud";
import { Settings } from "./views/Settings";
import { applyTheme, cachedTheme } from "./lib/theme";

const cached = cachedTheme();
if (cached) applyTheme(cached);

const view = new URLSearchParams(location.search).get("view");

export function App() {
  if (view === "settings") return <Settings />;
  if (view === "hud") return <Hud />;
  return <Chat />;
}
