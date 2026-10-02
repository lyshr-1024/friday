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
import { clearSession, closeSessionWindow, copyText, markSessionSeen, newSessionWindow, searchSession, selectSessionWindow, sessionWindows, splitSession, terminalPrefs, type TmuxWindow } from "../lib/sessions";

function termTheme(): Record<string, string> {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string) => s.getPropertyValue(`--term-${n}`).trim();
  const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
  const bright = Object.fromEntries(names.map((n) => [`bright${n[0]!.toUpperCase()}${n.slice(1)}`, v(`bright-${n}`)]));
  return { background: v("bg"), foreground: v("fg"), cursor: v("cursor"), cursorAccent: v("bg"), selectionBackground: v("sel"), ...Object.fromEntries(names.map((n) => [n, v(n)])), ...bright };
}

const MAX_MISSES = 30;

export function Terminal({ sessionId, preparing = false }: { sessionId: string; preparing?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const preparingRef = useRef(preparing);
  preparingRef.current = preparing;
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
    // 不开 cursorBlink：Claude Code 空闲时状态栏也在刷新，每帧都隐藏 / 显示光标、挪来挪去，闪烁节拍被不断重置，看着是高频乱闪（2026-10-02 用户报）
    const term = new XTerm({ fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace', fontSize: 13, lineHeight: 1.2, allowProposedApi: true, macOptionClickForcesSelection: true, macOptionIsMeta: false, theme: termTheme() });
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
    let ws: WebSocket | null = null;
    let pending = "";
    const send = (m: unknown): boolean => {
      if (ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(m));
      return true;
    };
    const flushInput = () => {
      // 准备段期间窗格里是 claude -p，tty 会缓存按键，等干活的 Claude 起来后被它当输入读走
      if (preparingRef.current) { pending = ""; return; }
      if (pending && send({ i: pending })) pending = "";
    };
    const onData = term.onData((d) => { pending += d; flushInput(); });

    // 终端在眼前时 ↑↓ 归它：焦点不在终端里（刚点过任务列表、刚切回窗口）时，原来被任务列表拿去切任务，
    // 终端里 Claude 弹的选择题一按就跳走了（2026-10-02 用户报）。捕获阶段先于 Board 的监听；切任务用 ⌘↑↓
    const onArrow = (e: KeyboardEvent) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing || !el.offsetParent) return;
      const a = document.activeElement as HTMLElement | null;
      if (a && (a.closest('.xterm, [role="menu"], [role="dialog"]') || a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)) return;
      e.preventDefault();
      e.stopPropagation();
      term.focus();
      term.input(e.key === "ArrowUp" ? "\x1b[A" : "\x1b[B");
    };
    window.addEventListener("keydown", onArrow, true);

    // xterm 在 keydown 里记一个「见过 keydown」，随后的 input 事件（输入法直接交的字符）在这个状态下一律丢掉，等 keyup 才清。
    // WebKit 里输入法是先交字符、后发字符键的 keydown，于是先按下的 Shift 让第一个 ？@ 这类字符被丢，要多按几下才出来
    // （2026-09-30 用户真机按键记录：Shift → input「？」→ keydown 229 → keyup）。单按修饰键不产生字符，不该算「见过」
    const xtermCore = (term as unknown as { _core?: { _keyDownSeen?: boolean } })._core;
    const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && MODIFIERS.has(e.key) && xtermCore && "_keyDownSeen" in xtermCore) xtermCore._keyDownSeen = false;
      // 只挡正在组合的按键。keyCode 229 不能一起挡：中文输入法开着时 WebKit 给退格、回车报的都是 229，
      // xterm 自己会比对输入框内容补发删除（CompositionHelper），挡了就删不掉刚打的字（2026-09-30 用户报）
      if (composing || e.isComposing) return false;
      // xterm 把 Shift+Enter 发成 \r，跟回车一样，Claude Code 分不出来——想换行却直接发出去了（2026-09-30 用户报）。
      // 改发 ESC + CR（Meta+Enter，Claude Code 当换行；VS Code 里 /terminal-setup 配的也是它）。keypress 也要拦，不然 xterm 在那儿再补一个 \r
      if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.type === "keydown") { e.preventDefault(); pending += "\x1b\r"; flushInput(); }
        return false;
      }
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
    let sleepTimer = 0;
    let watchdog = 0;
    type End = "gone" | "retry" | "closed" | { fatal: string };

    /**
     * 连一次，连接结束时给出原因。输出和按键都走这一条 WebSocket（原来是 SSE + 每个按键一次 POST，
     * WebKit 里中断的流式 fetch 不一定马上释放连接，同一地址 6 条的上限被占满后画面卡住、打字没反应）。
     * 输出收到就写，不等动画帧：WebKit 在窗口被遮挡时会停掉动画帧回调。
     */
    const once = () =>
      new Promise<{ end: End; got: boolean }>((resolve) => {
        fit.fit();
        const sock = new WebSocket(`${base.replace(/^http/, "ws")}/sessions/${encodeURIComponent(sessionId)}/ws?cols=${term.cols}&rows=${term.rows}`);
        ws = sock;
        let end: End = "closed";
        let got = false;
        let last = Date.now();
        sock.onopen = () => {
          setReconnecting(false);
          term.reset();
          send({ r: [term.cols, term.rows] });
          flushInput();
        };
        sock.onmessage = (e) => {
          last = Date.now();
          let m: { d?: string; gone?: boolean; retry?: boolean; fatal?: boolean; error?: string };
          try {
            m = JSON.parse(String(e.data)) as typeof m;
          } catch {
            return;
          }
          if (m.d) { got = true; term.write(m.d); }
          else if (m.gone) end = "gone";
          else if (m.retry) end = "retry";
          else if (m.fatal) end = { fatal: m.error ?? "未知原因" };
        };
        // 服务端 15 秒一次心跳；40 秒什么都没收到就当连接卡死，主动断开重连
        watchdog = window.setInterval(() => { if (Date.now() - last > 40_000) sock.close(); }, 5000);
        sock.onclose = () => {
          window.clearInterval(watchdog);
          if (ws === sock) ws = null;
          resolve({ end, got });
        };
      });

    void (async () => {
      let delay = 500;
      let misses = 0;
      while (!stopped) {
        if (!base) base = await coreBaseUrl().catch(() => "");
        // 等地址的时候组件可能已经卸了（切任务、开发模式下 React 挂两次）：这时再连就是一条没人关的连接，tmux 上多挂一个客户端
        if (stopped) return;
        const r = base ? await once() : { end: "closed" as End, got: false };
        if (stopped) return;
        if (r.end === "gone") { setDead(true); setReconnecting(false); return; }
        if (typeof r.end === "object") { setFailed(r.end.fatal); setReconnecting(false); return; }
        misses = r.got ? 0 : misses + 1;
        if (r.got) delay = 500;
        if (misses >= MAX_MISSES) { setFailed("连续多次连不上"); setReconnecting(false); return; }
        setReconnecting(true);
        await new Promise((res) => { sleepTimer = window.setTimeout(res, delay); });
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
      sizeTimer = window.setTimeout(() => void send({ r: [cols, rows] }), 120);
    });
    return () => {
      ta?.removeEventListener("compositionstart", onStart);
      ta?.removeEventListener("compositionend", onEnd);
      stopped = true;
      window.removeEventListener("keydown", onArrow, true);
      onData.dispose();
      onResize.dispose();
      window.clearTimeout(resizeTimer);
      window.clearTimeout(sizeTimer);
      window.clearTimeout(sleepTimer);
      window.clearInterval(watchdog);
      ro.disconnect();
      ws?.close();
      term.dispose();
    };
  }, [sessionId, attempt]);

  return (
    <div className="term">
      <div className="term__tabs" role="tablist" aria-label="终端窗口">
        {windows.map((w) => (
          <span key={w.index} className="term__tabwrap" aria-current={w.active}>
            <button role="tab" className="term__tab" aria-selected={w.active} onClick={() => void selectSessionWindow(sessionId, w.index).then(refreshWindows)}>
              {w.index + 1} · {w.name}
            </button>
            {/* 跑着 Claude 的那个窗口不给关：关了 Claude 跟着没，这条任务的会话就断了。最后一个窗口后端也不让关 */}
            {windows.length > 1 && w.name !== "claude" && (
              <button className="term__close" aria-label={`关闭窗口 ${w.index + 1} · ${w.name}`} title="关闭这个窗口" onClick={() => void closeSessionWindow(sessionId, w.index).then(refreshWindows)}>×</button>
            )}
          </span>
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
        {preparing && !dead && !failed && (
          <div className="term__prep" role="status">
            <span className="side__spin" aria-hidden />
            <div className="term__prep-t">正在准备工作区</div>
            <div className="term__prep-d">按项目规则建分支和 worktree、装依赖，好了 Claude 会在这里启动</div>
          </div>
        )}
        {dead ? <div className="term__dead">会话已不在</div> : failed ? (
          <div className="term__dead">终端起不来：{failed} <button className="term__tab" onClick={() => setAttempt((n) => n + 1)}>重试</button></div>
        ) : reconnecting && <div className="term__dead">重新连接中…</div>}
      </div>
    </div>
  );
}
