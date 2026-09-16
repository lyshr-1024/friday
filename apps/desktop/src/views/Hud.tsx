import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import type { Snapshot, SummonAction, SummonCard, SummonRules } from "@friday/shared";
import { coreBaseUrl } from "../lib/core";
import { runAction, summonStream } from "../lib/summon";

const HUD_WIDTH = 560;

export function Hud() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [rules, setRules] = useState<SummonRules | null>(null);
  const [card, setCard] = useState<SummonCard | null>(null);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [note, setNote] = useState<{ text: string; err: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const actions = card?.actions.length ? card.actions : rules?.actions ?? [];
  // 键盘不代劳不可逆动作：起 Claude Code 干活、标完成都会真的改东西，
  // 焦点停在 body 时一个回车就执行代价太大，这两类只接受鼠标点击。
  // approve_pending 不在此列——它只会打开确认区，不直接执行。
  const keyboardSafe = (a: SummonAction) => a.kind !== "start_work" && a.kind !== "mark_done";

  // 确认区必须锁住进入时的那个动作：actions 会在模型结果到达时整体替换，
  // 现算的话用户核对的草稿和实际发出的动作会指向不同任务。
  const [pendingAction, setPendingAction] = useState<(SummonAction & { kind: "approve_pending" }) | null>(null);

  function start(snap: Snapshot) {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setSnapshot(snap);
    setRules(null);
    setCard(null);
    setOpen(false);
    setConfirming(false);
    setPendingAction(null);
    setNote(null);
    void (async () => {
      for await (const ev of summonStream(snap, ctrl.signal)) {
        if (ctrl.signal.aborted) return;
        if (ev.type === "rules") setRules(ev.rules);
        else if (ev.type === "card") setCard(ev.card);
        else if (ev.type === "error") setNote({ text: ev.message, err: true });
      }
    })();
  }

  useEffect(() => {
    void invoke<Snapshot | null>("take_pending_summon").then((s) => {
      if (s) start(s);
    });
    const unlisten = listen<Snapshot>("friday://summon", (e) => start(e.payload));
    return () => void unlisten.then((f) => f());
  }, []);

  useLayoutEffect(() => {
    const h = rootRef.current?.scrollHeight;
    if (!h) return;
    void getCurrentWindow().setSize(new LogicalSize(HUD_WIDTH, h));
  }, [rules, card, open, confirming, note]);

  function isEditableFocus(): boolean {
    const el = document.activeElement;
    if (!el || el === document.body) return false;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
    if (el.closest(".hud__confirm")) return true;
    return el.tagName === "BUTTON" || el.tagName === "A" || el.hasAttribute("tabindex");
  }

  async function act(a: SummonAction) {
    if (a.kind === "approve_pending") {
      setPendingAction(a);
      setConfirming(true);
      setReplyText(a.pendingType === "slack_reply" ? (card?.reply ?? "") : "");
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const text = await runAction(a);
      setNote({ text, err: false });
      setTimeout(() => void invoke("hide_hud"), 1500);
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : "执行失败", err: true });
    } finally {
      setBusy(false);
    }
  }

  async function sendReply(a: SummonAction & { kind: "approve_pending" }) {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`${await coreBaseUrl()}/tasks/${a.taskId}/approve/${a.actionId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(a.pendingType === "slack_reply" ? { text: replyText } : {}),
      });
      if (!res.ok) throw new Error(`执行失败 ${res.status}`);
      setConfirming(false);
      setPendingAction(null);
      setNote({ text: "已发出", err: false });
      setTimeout(() => void invoke("hide_hud"), 1500);
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : "执行失败", err: true });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        if (confirming) { setConfirming(false); setPendingAction(null); }
        else void invoke("hide_hud");
        return;
      }
      if (e.key === "Enter" && e.metaKey) {
        e.preventDefault();
        if (confirming && pendingAction) void sendReply(pendingAction);
        else void invoke("open_chat", { conversationId: null, initialPrompt: null });
        return;
      }
      if (confirming) return;
      if (e.metaKey && /^[123]$/.test(e.key)) {
        const a = actions[Number(e.key) - 1];
        if (a && keyboardSafe(a)) {
          e.preventDefault();
          void act(a);
        }
        return;
      }
      if (e.key === "Enter" && !e.metaKey && !e.shiftKey && !e.altKey && !isEditableFocus()) {
        const a = actions[0];
        if (a && keyboardSafe(a)) {
          e.preventDefault();
          void act(a);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, pendingAction, confirming, replyText]);

  function statusDot(status: string): string {
    return ["review", "blocked", "processing", "done"].includes(status) ? status : "processing";
  }

  return (
    <div className="hud" ref={rootRef}>
      <button className="hud__saw" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {rules?.saw ?? "看看你在做什么…"}
      </button>
      {open && snapshot && (
        <div className="hud__raw">
          {snapshot.browser && <div className="hud__raw-row">{snapshot.browser.title || snapshot.browser.url}</div>}
          {snapshot.selection && <div className="hud__raw-row hud__raw-selection">{snapshot.selection}</div>}
          {snapshot.screenshotPath && <img className="hud__shot" src={convertFileSrc(snapshot.screenshotPath)} alt="当前屏幕截图" />}
        </div>
      )}
      {rules?.match && (
        <div className="hud__match">
          <span className={`dot dot--${statusDot(rules.match.status)}`} />
          {rules.match.title}
          <span className="hud__why">{rules.match.why}</span>
        </div>
      )}
      {card?.verdict ? (
        <p className="hud__verdict">{card.verdict}</p>
      ) : (
        rules?.willThink && <p className="hud__verdict hud__verdict--think">正在判断…</p>
      )}
      {card?.reply && !confirming && <pre className="hud__reply">{card.reply}</pre>}
      {confirming ? (
        <div className="hud__confirm">
          <div className="hud__confirm-head">
            <span className="hud__confirm-hint mono">⌘↵ 就这么发 · Esc 取消</span>
          </div>
          {pendingAction?.pendingType === "slack_reply" ? (
            <textarea
              className="hud__confirm-text"
              autoFocus
              rows={4}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
            />
          ) : (
            <p className="hud__confirm-what">{pendingAction?.label ?? "执行这个动作"}</p>
          )}
          <div className="hud__actions">
            <button
              className="b b--primary"
              disabled={busy || (pendingAction?.pendingType === "slack_reply" && !replyText.trim())}
              onClick={() => {
                if (pendingAction) void sendReply(pendingAction);
              }}
            >
              {pendingAction?.pendingType === "slack_reply" ? "就这么发" : "执行"}
              <kbd>⌘↵</kbd>
            </button>
            <button className="b b--text" onClick={() => { setConfirming(false); setPendingAction(null); }}>先不发</button>
          </div>
        </div>
      ) : (
        <div className="hud__actions">
          {actions.map((a, i) => (
            <button key={i} className={i === 0 ? "b b--primary" : "b"} disabled={busy} onClick={() => void act(a)}>
              {a.label}
            </button>
          ))}
        </div>
      )}
      {note && <div className={`hud__note ${note.err ? "hud__note--err" : ""}`}>{note.text}</div>}
    </div>
  );
}
