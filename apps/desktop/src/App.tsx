import { Chat } from "./views/Chat";
import { Palette } from "./views/Palette";
import { Settings } from "./views/Settings";

const view = new URLSearchParams(location.search).get("view");

export function App() {
  if (view === "settings") return <Settings />;
  if (view === "chat") return <Chat />;
  return <Palette />;
}
