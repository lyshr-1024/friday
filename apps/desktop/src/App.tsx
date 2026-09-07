import { Chat } from "./views/Chat";
import { Settings } from "./views/Settings";

const view = new URLSearchParams(location.search).get("view");

export function App() {
  return view === "settings" ? <Settings /> : <Chat />;
}
