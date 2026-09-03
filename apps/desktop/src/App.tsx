import { Palette } from "./views/Palette";
import { Settings } from "./views/Settings";

const view = new URLSearchParams(location.search).get("view");

export function App() {
  return view === "settings" ? <Settings /> : <Palette />;
}
