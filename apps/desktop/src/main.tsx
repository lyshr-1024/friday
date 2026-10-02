import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// WebView 自带的右键菜单只有「Reload」这类对用户没用的项，点了整个界面刷新、终端断开重连。
// 输入框和选中的文字留着系统菜单（复制、粘贴有用）；Friday 自己的右键菜单（任务、链接）各自 preventDefault，不受影响
window.addEventListener("contextmenu", (e) => {
  const el = e.target as HTMLElement | null;
  if (el?.closest?.(".xterm")) return e.preventDefault();
  if (el?.closest?.("input, textarea, [contenteditable='true']")) return;
  if (window.getSelection()?.toString()) return;
  e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
