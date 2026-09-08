import { Chat } from "./views/Chat";
import { Settings } from "./views/Settings";
import { applyTheme, cachedTheme } from "./lib/theme";

const cached = cachedTheme();
if (cached) applyTheme(cached);

const view = new URLSearchParams(location.search).get("view");

export function App() {
  return view === "settings" ? <Settings /> : <Chat />;
}
