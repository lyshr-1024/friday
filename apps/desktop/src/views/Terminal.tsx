import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import { coreBaseUrl } from "../lib/core";
import { AttachFatal, AttachGone, attachSession, clearSession, closeSessionWindow, copyText, markSessionSeen, newSessionWindow, sessionExists, searchSession, selectSessionWindow, sessionWindows, splitSession, terminalPrefs, type TmuxWindow } from "../lib/sessions";

function termTheme(): Record<string, string> {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string) => s.getPropertyValue(`--term-${n}`).trim();
  const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
  const bright = Object.fromEntries(names.map((n) => [`bright${n[0]!.toUpperCase()}${n.slice(1)}`, v(`bright-${n}`)]));
  return { background: v("bg"), foreground: v("fg"), cursor: v("cursor"), cursorAccent: v("bg"), selectionBackground: v("sel"), ...Object.fromEntries(names.map((n) => [n, v(n)])), ...bright };
}

const MAX_MISSES = 30;

export function Terminal({ sessionId }: { sessionId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [windows, setWindows] = useState<TmuxWindow[]>([]);
  const [finding, setFinding] = useState(false);
  const [q, setQ] = useState("");
  const [dead, setDead] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [failed, setFailed] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const windowsRef = useRef<TmuxWindow[]>([]);
  windowsRef.current = windows;

  const refreshWindows = useCallback(() => void sessionWindows(sessionId).then(setWindows).catch(() => setWindows([])), [sessionId]);

  useEffect(() => {
    refreshWindows();
    const t = window.setInterval(refreshWindows, 2000);
    return () => window.clearInterval(t);
  }, [refreshWindows]);

  useEffect(() => {
    const seen = () => { if (document.hasFocus() && document.visibilityState === "visible") void markSessionSeen(sessionId); };
    seen();
    window.addEventListener("focus", seen);
    document.addEventListener("visibilitychange", seen);
    return () => { window.removeEventListener("focus", seen); document.removeEventListener("visibilitychange", seen); };
  }, [sessionId]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    setDead(false);
    setReconnecting(false);
    setFailed(undefined);
    const term = new XTerm({ fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace', fontSize: 13, lineHeight: 1.2, cursorBlink: true, allowProposedApi: true, macOptionClickForcesSelection: true, macOptionIsMeta: false, theme: termTheme() });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => void openUrl(uri)));
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(new ClipboardAddon(undefined, { readText: async () => "", writeText: async (_sel, text) => void (await copyText(text)) }));
    term.open(el);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {}
    void terminalPrefs().then((p) => {
      if (p.fontFamily) term.options.fontFamily = `"${p.fontFamily}", "JetBrains Mono", Menlo, monospace`;
      if (p.fontSize) term.options.fontSize = p.fontSize;
      fit.fit();
    }).catch(() => {});

    // 输入法组合期间 xterm 会把按键先编码发出去，字就丢了；组合结束由 onData 一次性送
    let composing = false;
    const ta = term.textarea;
    const onStart = () => { composing = true; };
    const onEnd = () => { setTimeout(() => { composing = false; }, 0); };
    ta?.addEventListener("compositionstart", onStart);
    ta?.addEventListener("compositionend", onEnd);

    let base = "";
    let attachId = "";
    const ctrl = new AbortController();
    const post = (path: string, body: unknown) => fetch(`${base}/sessions/${encodeURIComponent(sessionId)}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
    let inflight = false;
    let pending = "";
    const drain = async () => {
      if (inflight || !pending || !attachId) return;
      inflight = true;
      while (pending && attachId) {
        const data = pending;
        const id = attachId;
        pending = "";
        const res = await post("input", { attach: id, data });
        if (!res?.ok) {
          pending = data + pending;
          if (res?.status === 404 && attachId === id) attachId = "";
          break;
        }
      }
      inflight = false;
    };
    const onData = term.onData((d) => { pending += d; void drain(); });

    term.attachCustomKeyEventHandler((e) => {
      // 只挡正在组合的按键。keyCode 229 不能一起挡：中文输入法开着时 WebKit 给退格、回车报的都是 229，
      // xterm 自己会比对输入框内容补发删除（CompositionHelper），挡了就删不掉刚打的字（2026-09-30 用户报）
      if (composing || e.isComposing) return false;
      if (e.type !== "keydown" || !e.metaKey) return true;
      if (e.key === "ArrowUp" || e.key === "ArrowDown") return false;
      const k = e.key.toLowerCase();
      const act = (fn: () => unknown) => { e.preventDefault(); void Promise.resolve(fn()).then(refreshWindows); return false; };
      if (k === "t") return act(() => newSessionWindow(sessionId));
      if (k === "w") return act(() => { const w = windowsRef.current.find((x) => x.active); return w ? closeSessionWindow(sessionId, w.index) : undefined; });
      if (k === "d") return act(() => splitSession(sessionId, e.shiftKey ? "v" : "h"));
      if (/^[1-9]$/.test(k)) return act(() => { const w = windowsRef.current[Number(k) - 1]; return w ? selectSessionWindow(sessionId, w.index) : undefined; });
      if (k === "[" || k === "]") return act(() => { const i = windowsRef.current.findIndex((x) => x.active); const w = windowsRef.current[(i + (k === "]" ? 1 : -1) + windowsRef.current.length) % windowsRef.current.length]; return w ? selectSessionWindow(sessionId, w.index) : undefined; });
      if (k === "f") { e.preventDefault(); setFinding(true); return false; }
      if (k === "k") return act(() => clearSession(sessionId));
      if (k === "=" || k === "+") { e.preventDefault(); term.options.fontSize = (term.options.fontSize ?? 13) + 1; fit.fit(); return false; }
      if (k === "-") { e.preventDefault(); term.options.fontSize = Math.max(9, (term.options.fontSize ?? 13) - 1); fit.fit(); return false; }
      if (k === "0") { e.preventDefault(); term.options.fontSize = 13; fit.fit(); return false; }
      if (k === "c" && term.hasSelection()) { e.preventDefault(); void copyText(term.getSelection()); return false; }
      return true;
    });

    let stopped = false;
    let raf = 0;
    let out = "";
    let sleepTimer = 0;
    const flush = () => { raf = 0; if (out && !stopped) { term.write(out); out = ""; } };

    const pump = async (id: string, onData: () => void) => {
      const res = await fetch(`${base}/sessions/${encodeURIComponent(sessionId)}/stream?attach=${encodeURIComponent(id)}`, { signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const data = buf.slice(0, i).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
          buf = buf.slice(i + 2);
          try {
            const msg = JSON.parse(data) as { d?: string };
            if (msg.d) { onData(); out += msg.d; if (!raf) raf = requestAnimationFrame(flush); }
          } catch {}
        }
      }
      flush();
    };

    void (async () => {
      let delay = 500;
      let misses = 0;
      while (!stopped) {
        let got = false;
        try {
          if (!base) base = await coreBaseUrl();
          await new Promise((r) => requestAnimationFrame(r));
          if (stopped) return;
          fit.fit();
          const id = (await attachSession(sessionId, term.cols, term.rows)).attachId;
          if (stopped) return;
          attachId = id;
          setReconnecting(false);
          term.reset();
          void post("resize", { attach: id, cols: term.cols, rows: term.rows });
          void drain();
          await pump(id, () => { delay = 500; got = true; });
        } catch (e) {
          if (e instanceof AttachFatal) { if (!stopped) { setFailed(e.message); setReconnecting(false); } return; }
          if (e instanceof AttachGone) { if (!stopped) { setDead(true); setReconnecting(false); } return; }
        }
        attachId = "";
        if (stopped) return;
        misses = got ? 0 : misses + 1;
        if (misses >= MAX_MISSES) { setFailed("连续多次连不上"); setReconnecting(false); return; }
        const gone = await sessionExists(sessionId).then((x) => !x).catch(() => false);
        if (stopped) return;
        if (gone) { setDead(true); setReconnecting(false); return; }
        setReconnecting(true);
        await new Promise((r) => { sleepTimer = window.setTimeout(r, delay); });
        delay = Math.min(delay * 2, 5000);
      }
    })();

    let resizeTimer = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => fit.fit(), 120);
    });
    ro.observe(el);
    let sizeTimer = 0;
    const onResize = term.onResize(({ cols, rows }) => {
      window.clearTimeout(sizeTimer);
      sizeTimer = window.setTimeout(() => { if (attachId) void post("resize", { attach: attachId, cols, rows }); }, 120);
    });
    return () => {
      ta?.removeEventListener("compositionstart", onStart);
      ta?.removeEventListener("compositionend", onEnd);
      stopped = true;
      onData.dispose();
      onResize.dispose();
      window.clearTimeout(resizeTimer);
      window.clearTimeout(sizeTimer);
      window.clearTimeout(sleepTimer);
      cancelAnimationFrame(raf);
      ro.disconnect();
      ctrl.abort();
      term.dispose();
    };
  }, [sessionId, attempt]);

  return (
    <div className="term">
      <div className="term__tabs" role="tablist" aria-label="终端窗口">
        {windows.map((w) => (
          <button key={w.index} role="tab" className="term__tab" aria-current={w.active} onClick={() => void selectSessionWindow(sessionId, w.index).then(refreshWindows)}>
            {w.index + 1} · {w.name}
          </button>
        ))}
        <button className="term__tab term__tab--add" aria-label="新窗口" onClick={() => void newSessionWindow(sessionId).then(refreshWindows)}>＋</button>
      </div>
      <div className="term__body" style={{ position: "relative" }}>
        <div ref={host} style={{ height: "100%" }} />
        {finding && (
          <form className="term__find" onSubmit={(e) => { e.preventDefault(); if (q.trim()) void searchSession(sessionId, q.trim()); setFinding(false); }}>
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setFinding(false); }} placeholder="在历史里往上找" aria-label="搜索终端历史" />
          </form>
        )}
        {dead ? <div className="term__dead">会话已不在</div> : failed ? (
          <div className="term__dead">终端起不来：{failed} <button className="term__tab" onClick={() => setAttempt((n) => n + 1)}>重试</button></div>
        ) : reconnecting && <div className="term__dead">重新连接中…</div>}
      </div>
    </div>
  );
}
