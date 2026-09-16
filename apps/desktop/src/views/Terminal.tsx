import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import { coreBaseUrl } from "../lib/core";
import { peekFocusJob, takeFocusJob } from "../lib/focusJob";

/**
 * 终端配色取自 CSS 变量，跟着主题走。ANSI 16 色一个都不能少：漏掉的 xterm.js
 * 会用它内置的 Tango 默认值，那套配的是紫底，在我们的深灰底上蓝紫两色几乎看不见。
 */
function termTheme(): Record<string, string> {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    background: v("--term-bg"),
    foreground: v("--term-fg"),
    cursor: v("--term-cursor"),
    cursorAccent: v("--term-bg"),
    selectionBackground: v("--term-sel"),
    black: v("--term-black"),
    red: v("--term-red"),
    green: v("--term-green"),
    yellow: v("--term-yellow"),
    blue: v("--term-blue"),
    magenta: v("--term-magenta"),
    cyan: v("--term-cyan"),
    white: v("--term-white"),
    brightBlack: v("--term-bright-black"),
    brightRed: v("--term-bright-red"),
    brightGreen: v("--term-bright-green"),
    brightYellow: v("--term-bright-yellow"),
    brightBlue: v("--term-bright-blue"),
    brightMagenta: v("--term-bright-magenta"),
    brightCyan: v("--term-bright-cyan"),
    brightWhite: v("--term-bright-white"),
  };
}

/** 任务内嵌终端：连 sidecar 的 PTY，输出经 SSE 回放 + 实时推送，按键直接写回去。 */
export function Terminal({ id }: { id: string }) {
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
      theme: termTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => void openUrl(uri)));
    term.open(el);
    // Claude Code 这种全屏 TUI 每秒重绘几十次，DOM 渲染器扛不住；WebGL 不可用（上下文丢失）时自动退回
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
    }
    // 容器刚展开时可能还没布局完，这一次 fit 会算出错的列数；下一帧再补一次
    fit.fit();
    const fitFrame = requestAnimationFrame(() => fit.fit());
    // 延后再取标记：StrictMode 下第一次挂载会立刻被清理，取走标记却没来得及聚焦
    const focusTimer = peekFocusJob() === id ? window.setTimeout(() => { if (takeFocusJob(id)) term.focus(); }, 80) : 0;

    const ctrl = new AbortController();
    let base = "";
    const post = (path: string, body: unknown) =>
      fetch(`${base}/pty/${encodeURIComponent(id)}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});

    // 按键必须按顺序到 PTY：并发 POST 会乱序，Shift 组合键（?、大写、Shift+Enter）就像没按到。
    // 一次只飞一个请求，飞行途中攒下的按键合并成下一个。
    let inflight = false;
    let queued = "";
    const drain = async () => {
      if (inflight || !queued) return;
      inflight = true;
      while (queued) {
        const data = queued;
        queued = "";
        await post("input", { data });
      }
      inflight = false;
    };
    const send = (d: string) => {
      queued += d;
      void drain();
    };

    void (async () => {
      base = await coreBaseUrl();
      // 必须等尺寸真的生效再订阅。PTY 默认 120 列，前端多半不是这个宽度；不等的话
      // 回放的是旧宽度写下的字节，xterm 按新宽度渲染，折行位置全错、新旧内容叠在一起。
      await new Promise((r) => requestAnimationFrame(r));
      fit.fit();
      await post("resize", { cols: term.cols, rows: term.rows });
      const res = await fetch(`${base}/pty/${encodeURIComponent(id)}/stream`, { signal: ctrl.signal }).catch(() => null);
      if (ctrl.signal.aborted) return;
      if (!res?.ok || !res.body) {
        term.writeln("\x1b[2m[这个终端随 Friday 重启一起关掉了，点下面「重新打开」接着聊]\x1b[0m");
        setDead(true);
        return;
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      // 输出按帧合并再写进终端：一次 write 比几十次小 write 便宜得多
      let pendingOut = "";
      let raf = 0;
      const flush = () => {
        raf = 0;
        if (!pendingOut) return;
        const out = pendingOut;
        pendingOut = "";
        term.write(out);
      };
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
            if (msg.d) {
              pendingOut += msg.d;
              if (!raf) raf = requestAnimationFrame(flush);
            }
          } catch {
            /* 忽略坏帧 */
          }
        }
      }
      if (raf) cancelAnimationFrame(raf);
      flush();
    })();

    const onData = term.onData(send);
    // 聚焦就回到底部：终端是用来接着聊的，不是用来翻历史的
    const toBottom = () => term.scrollToBottom();
    term.textarea?.addEventListener("focus", toBottom);
    el.addEventListener("mousedown", toBottom);
    // 拖窗口时 ResizeObserver 一秒能触发几十次，每次 resize 都让 Ink 全量重绘，攒一下再发
    let resizeTimer = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        fit.fit();
        void post("resize", { cols: term.cols, rows: term.rows });
      }, 120);
    });
    ro.observe(el);
    // 设置窗换了主题，已经开着的终端也要跟着换，不然白底卡片里留一块黑。
    // 盯 data-theme 而不是主题事件：变量此刻一定已经是新值，也不用管谁先收到事件。
    const themeWatch = new MutationObserver(() => {
      term.options.theme = termTheme();
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      term.textarea?.removeEventListener("focus", toBottom);
      el.removeEventListener("mousedown", toBottom);
      onData.dispose();
      window.clearTimeout(resizeTimer);
      window.clearTimeout(focusTimer);
      cancelAnimationFrame(fitFrame);
      ro.disconnect();
      themeWatch.disconnect();
      ctrl.abort();
      term.dispose();
    };
  }, [id, attempt]);

  return (
    <div className="term">
      <div ref={host} className="xterm-host" />
      {dead && (
        <div className="term__dead">
          <button className="b b--ghost" disabled={reopening} onClick={() => void reopen()}>{reopening ? "正在重开…" : "重新打开终端，接上之前的 Claude 会话"}</button>
        </div>
      )}
    </div>
  );
}
