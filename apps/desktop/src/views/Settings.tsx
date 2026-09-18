import { useEffect, useState, cloneElement, isValidElement, useId, type ReactElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { THEME_OPTIONS, type PermissionStatus, type SettingsResponse } from "@friday/shared";
import { applyTheme, broadcastTheme } from "../lib/theme";
import { MEMORY_FILES, MemoryEditor, type EditTarget } from "./MemoryEditor";
import { coreBaseUrl, health, learnHistory, listHandbooks, reviewNow, settings, testNotification, updateSettings } from "../lib/core";
import { ModelSelect } from "./ModelSelect";

export function Settings() {
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [core, setCore] = useState<{ url: string; version?: string; ok: boolean } | null>(null);
  const [hotkey, setHotkey] = useState("");
  const [prefs, setPrefs] = useState<SettingsResponse | null>(null);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [review, setReview] = useState<string | null>(null);
  const [notified, setNotified] = useState(false);
  const [handbooks, setHandbooks] = useState<string[]>([]);
  const [learning, setLearning] = useState(false);
  const [learnNote, setLearnNote] = useState("");
  const [perms, setPerms] = useState<PermissionStatus | null>(null);

  function refreshPerms() {
    void invoke<PermissionStatus>("permission_status").then(setPerms);
  }

  async function runReview() {
    setReviewing(true);
    try {
      const r = await reviewNow();
      setReview(r.skipped ?? `重写了 ${r.categories?.length ?? 0} 份手册`);
    } catch {
      setReview("复盘失败");
    } finally {
      setReviewing(false);
      setTimeout(() => setReview(null), 5000);
    }
  }

  useEffect(() => {
    void isEnabled().then(setAutostart);
    void listHandbooks().then(setHandbooks).catch(() => {});
    void invoke<string>("current_hotkey").then(setHotkey);
    void settings().then((p) => { setPrefs(p); applyTheme(p.theme); }).catch(() => setPrefs(null));
    refreshPerms();
    void (async () => {
      const url = await coreBaseUrl();
      try {
        const h = await health();
        setCore({ url, version: h.version, ok: true });
      } catch {
        setCore({ url, ok: false });
      }
    })();
  }, []);

  async function runLearn() {
    setLearning(true);
    setLearnNote("");
    try {
      const r = await learnHistory();
      setLearnNote(r.skipped ? "没学到新的" : `提炼了 ${r.groups} 份，去「待我决定」过目`);
      await listHandbooks().then(setHandbooks);
    } catch {
      setLearnNote("出错了");
    } finally {
      setLearning(false);
      setTimeout(() => setLearnNote(""), 6000);
    }
  }

  async function toggleAutostart() {
    if (autostart === null) return;
    if (autostart) await disable();
    else await enable();
    setAutostart(await isEnabled());
  }

  if (editing) {
    return (
      <MemoryEditor
        target={editing}
        onBack={() => {
          setEditing(null);
          void settings().then(setPrefs).catch(() => {});
          void listHandbooks().then(setHandbooks).catch(() => {});
        }}
      />
    );
  }

  return (
    <div className="settings">
      <h1 className="settings__title">Friday 设置</h1>

      <section>
        <h2>记忆库</h2>
        <div className="group">
          {MEMORY_FILES.map((f) => (
            <Row key={f.name} label={f.label} hint={f.name === "projects" ? `${prefs?.projects.length ?? "…"} 个项目，别名在这里改` : f.hint}>
              <button className="btn" onClick={() => setEditing({ kind: "memory", name: f.name })}>编辑…</button>
            </Row>
          ))}
        </div>
      </section>

      <section>
        <h2>项目手册</h2>
        <div className="group">
          {handbooks.length === 0 ? (
            <Row label="还没有手册" hint="从 Claude Code 历史学一轮，会按项目提炼出「在这里怎么干活」，每条带你的原话出处">
              <button className="btn" disabled={learning} onClick={() => void runLearn()}>{learning ? "提炼中…" : learnNote || "现在学一轮"}</button>
            </Row>
          ) : (
            <>
              {handbooks.map((slug) => (
                <Row key={slug} label={slug === "_global" ? "通用习惯" : slug} hint="派去终端干活的 Claude 会先读这份；学错了直接删掉那一行">
                  <button className="btn" onClick={() => setEditing({ kind: "handbook", slug })}>编辑…</button>
                </Row>
              ))}
              <Row label="再学一轮" hint="扫上次之后的 Claude Code 会话，提炼结果会挂成待审任务，点头才写进来">
                <button className="btn" disabled={learning} onClick={() => void runLearn()}>{learning ? "提炼中…" : learnNote || "现在学一轮"}</button>
              </Row>
            </>
          )}
        </div>
      </section>

      <section>
        <h2>外观</h2>
        <div className="group">
          <Row label="主题" hint={THEME_OPTIONS.find((t) => t.id === prefs?.theme)?.hint ?? "三套深色 + 一套浅色，切换即生效"}>
            <div className="seg">
              {THEME_OPTIONS.map((t) => (
                <button
                  key={t.id}
                  className={`seg__item ${prefs?.theme === t.id ? "on" : ""}`}
                  disabled={!prefs}
                  onClick={() => { broadcastTheme(t.id); void updateSettings({ theme: t.id }).then(setPrefs); }}
                >
                  <span className={`seg__swatch seg__swatch--${t.id}`} />
                  {t.label}
                </button>
              ))}
            </div>
          </Row>
        </div>
      </section>

      <section>
        <h2>通用</h2>
        <div className="group">
        <Row label="开机自启" hint="登录后在菜单栏静默启动">
          <button
            className={`switch ${autostart ? "switch--on" : ""}`}
            role="switch"
            aria-checked={!!autostart}
            disabled={autostart === null}
            onClick={toggleAutostart}
          />
        </Row>
        <Row label="呼出热键" hint="改 ~/Library/Application Support/Friday/settings.json 的 hotkey 后重启生效">
          <kbd>{formatHotkey(hotkey)}</kbd>
        </Row>
        <Row label="怎么称呼你" hint="启动器与工作台问候用">
          <input
            className="side__edit"
            style={{ width: 160 }}
            defaultValue={prefs?.name ?? ""}
            key={prefs?.name}
            onBlur={(e) => { const v = e.target.value.trim(); if (prefs && v && v !== prefs.name) void updateSettings({ name: v }).then(setPrefs); }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          />
        </Row>
        <Row label="模型" hint="对话与热点摘要都用它，切换即生效">
          <ModelSelect value={prefs?.model ?? null} onChange={(model) => void updateSettings({ model }).then(setPrefs)} />
        </Row>
        <Row label="Skill 模式" hint="会话里可直接调用 ~/.claude 的 skill，放行 Bash/Read，不开 Edit/Write。开着时每轮都要读 skill 文档、最多跑 30 轮，一次提问可能到 $1；不常用 skill 就关掉">
          <button
            className={`switch ${prefs?.skills ? "switch--on" : ""}`}
            role="switch"
            aria-checked={!!prefs?.skills}
            disabled={!prefs}
            onClick={() => prefs && void updateSettings({ skills: !prefs.skills }).then(setPrefs)}
          />
        </Row>
        <Row label="复盘人工处理" hint="看你怎么处置它判过的消息（直接忽略 / 自己回的）、哪些话你绕过它自己敲进终端，重写经验手册，下次判得更准。只在你点的时候跑">
          <button className="b" disabled={reviewing} onClick={() => void runReview()}>
            {reviewing ? "复盘中…" : review ?? "现在复盘"}
          </button>
        </Row>
        <Row label="从 Claude Code 学" hint="每周扫一次你在 Claude Code 里说过的话，提炼成项目手册挂成待审；一轮约 $0.2，冷启动那次约 $1">
          <button
            className={`switch ${prefs?.learnHistory ? "switch--on" : ""}`}
            role="switch"
            aria-checked={!!prefs?.learnHistory}
            disabled={!prefs}
            onClick={() => prefs && void updateSettings({ learnHistory: !prefs.learnHistory }).then(setPrefs)}
          />
        </Row>
        <Row label="跑 Claude 用的终端" hint="内嵌：在任务详情里直接看和聊；Ghostty / Terminal：弹外部窗口">
          <select className="model-select" value={prefs?.terminal ?? "embedded"} disabled={!prefs} onChange={(e) => void updateSettings({ terminal: e.target.value as "embedded" | "ghostty" | "terminal" }).then(setPrefs)}>
            <option value="embedded">内嵌终端</option>
            <option value="ghostty">Ghostty</option>
            <option value="terminal">Terminal</option>
          </select>
        </Row>
        </div>
      </section>

      <section>
        <h2>核心</h2>
        <div className="group">
        <Row label="状态">
          <span className="mono">
            <span className={`dot dot--${core ? (core.ok ? "ok" : "down") : "checking"}`} />
            {core ? (core.ok ? `运行中 ${core.version}` : "未响应") : "检测中"}
          </span>
        </Row>
        <Row label="地址">
          <span className="mono">{core?.url ?? "…"}</span>
        </Row>
        </div>
      </section>

      <section>
        <h2>系统权限</h2>
        <div className="group">
        <Row label="系统通知" hint={notified ? "已发出，20 秒内应弹出；没弹就去 系统设置 › 通知 里允许 Friday" : "Slack 待回复消息靠它提醒"}>
          <button className="btn" onClick={() => void testNotification().then(() => setNotified(true))}>测试通知</button>
        </Row>
        </div>
      </section>

      <section>
        <h2>呼出模式</h2>
        <div className="group">
        <Row label="辅助功能" hint="读取浏览器地址栏与选中文字要用到">
          <PermissionRow granted={perms?.accessibility} onGrant={() => { void invoke("open_permission_pane", { kind: "accessibility" }); }} />
        </Row>
        <Row label="自动化" hint="向浏览器 / Finder 询问当前标签页或选中内容">
          <PermissionRow granted={perms?.automation} onGrant={() => { void invoke("open_permission_pane", { kind: "automation" }); }} />
        </Row>
        <Row label="屏幕录制" hint="拿不到窗口信息时兜底截图">
          <PermissionRow granted={perms?.screen} onGrant={() => { void invoke("open_permission_pane", { kind: "screen" }); }} />
        </Row>
        <Row label="没拿到内容时截图兜底" hint="辅助功能/自动化都拿不到 URL 或选中文字时，退而截一张前台窗口给 Friday 看">
          <button
            className={`switch ${prefs?.summon.screenshotFallback ? "switch--on" : ""}`}
            role="switch"
            aria-checked={!!prefs?.summon.screenshotFallback}
            disabled={!prefs}
            onClick={() => prefs && void updateSettings({ summon: { screenshotFallback: !prefs.summon.screenshotFallback } }).then(setPrefs)}
          />
        </Row>
        </div>
      </section>
    </div>
  );
}

function PermissionRow({ granted, onGrant }: { granted: boolean | undefined; onGrant: () => void }) {
  return (
    <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: "var(--s-2)" }}>
      <span className={`dot dot--${granted ? "ok" : "down"}`} />
      {granted === undefined ? "检测中" : granted ? "已授权" : "未授权"}
      {!granted && <button className="btn" onClick={onGrant}>去授权</button>}
    </span>
  );
}

/** 设置项一行。label 与控件用 aria-labelledby 程序关联——视觉靠近不等于
    可访问性关联，屏幕阅读器读空按钮只会说「switch, checked」。 */
function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <div className="row">
      <div className="row__text">
        <div className="row__label" id={`${id}-label`}>{label}</div>
        {hint && <div className="row__hint" id={`${id}-hint`}>{hint}</div>}
      </div>
      <div className="row__ctl">
        {isValidElement(children)
          ? cloneElement(children as ReactElement<{ "aria-labelledby"?: string; "aria-describedby"?: string }>, {
              "aria-labelledby": `${id}-label`,
              ...(hint ? { "aria-describedby": `${id}-hint` } : {}),
            })
          : children}
      </div>
    </div>
  );
}

function formatHotkey(k: string): string {
  return k
    .replace(/CmdOrCtrl|Super|Command/g, "⌘")
    .replace(/Shift/g, "⇧")
    .replace(/Alt|Option/g, "⌥")
    .replace(/Control|Ctrl/g, "⌃")
    .replace(/\+/g, " ");
}
