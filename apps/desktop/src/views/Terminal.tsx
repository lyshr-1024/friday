import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import { coreBaseUrl } from "../lib/core";

/** 任务内嵌终端：连 sidecar 的 PTY，输出经 SSE 回放 + 实时推送，按键直接写回去。 */
export function Terminal({ id, height = 360 }: { id: string; height?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const [dead, setDead] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [reopening, setReopening] = useState(false);

  async function reopen() {
    setReopening(true);
    try {
      const base = await coreBaseUrl();
      const res = await fetch(`${base}/pty/${encodeURIComponent(id)}/reopen`, { method: "POST" });
      if (res.ok) {
        setDead(false);
        setAttempt((n) => n + 1);
      }
    } finally {
      setReopening(false);
    }
  }

  useEffect(() => {
    setDead(false);
    const el = host.current;
    if (!el) return;
    const term = new XTerm({
      fontFamily: '"SF Mono", Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: "#0e0f12",
        foreground: "#e8eaee",
        cursor: "#38d6ff",
        selectionBackground: "rgba(56, 214, 255, 0.25)",
        black: "#1a1c21",
        brightBlack: "#585e6a",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => void openUrl(uri)));
    term.open(el);
    fit.fit();

    const ctrl = new AbortController();
    let base = "";
    const post = (path: string, body: unknown) =>
      fetch(`${base}/pty/${encodeURIComponent(id)}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});

    void (async () => {
      base = await coreBaseUrl();
      void post("resize", { cols: term.cols, rows: term.rows });
      const res = await fetch(`${base}/pty/${encodeURIComponent(id)}/stream`, { signal: ctrl.signal }).catch(() => null);
      if (ctrl.signal.aborted) return;
      if (!res?.ok || !res.body) {
        term.writeln("\x1b[2m[这个终端随 Friday 重启一起关掉了，点下面「重新打开」接着聊]\x1b[0m");
        setDead(true);
        return;
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
          if (!data) continue;
          try {
            const msg = JSON.parse(data) as { d?: string };
            if (msg.d) term.write(msg.d);
          } catch {
            /* 忽略坏帧 */
          }
        }
      }
    })();

    const onData = term.onData((d) => void post("input", { data: d }));
    const ro = new ResizeObserver(() => {
      fit.fit();
      void post("resize", { cols: term.cols, rows: term.rows });
    });
    ro.observe(el);
    return () => {
      onData.dispose();
      ro.disconnect();
      ctrl.abort();
      term.dispose();
    };
  }, [id, attempt]);

  return (
    <div className="term">
      <div ref={host} className="xterm-host" style={{ height }} />
      {dead && (
        <div className="term__dead">
          <button className="b b--ghost" disabled={reopening} onClick={() => void reopen()}>{reopening ? "正在重开…" : "重新打开终端，接上之前的 Claude 会话"}</button>
        </div>
      )}
    </div>
  );
}
