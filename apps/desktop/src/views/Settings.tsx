import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { THEME_OPTIONS, type MemoryFile, type SettingsResponse } from "@friday/shared";
import { applyTheme, broadcastTheme } from "../lib/theme";
import { MEMORY_FILES, MemoryEditor } from "./MemoryEditor";
import { coreBaseUrl, health, settings, testNotification, updateSettings } from "../lib/core";
import { ModelSelect } from "./ModelSelect";

export function Settings() {
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [core, setCore] = useState<{ url: string; version?: string; ok: boolean } | null>(null);
  const [hotkey, setHotkey] = useState("");
  const [prefs, setPrefs] = useState<SettingsResponse | null>(null);
  const [editing, setEditing] = useState<MemoryFile | null>(null);
  const [notified, setNotified] = useState(false);

  useEffect(() => {
    void isEnabled().then(setAutostart);
    void invoke<string>("current_hotkey").then(setHotkey);
    void settings().then((p) => { setPrefs(p); applyTheme(p.theme); }).catch(() => setPrefs(null));
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

  async function toggleAutostart() {
    if (autostart === null) return;
    if (autostart) await disable();
    else await enable();
    setAutostart(await isEnabled());
  }

  if (editing) {
    return (
      <MemoryEditor
        name={editing}
        onBack={() => {
          setEditing(null);
          void settings().then(setPrefs).catch(() => {});
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
              <button className="btn" onClick={() => setEditing(f.name)}>编辑</button>
            </Row>
          ))}
        </div>
      </section>

      <section>
        <h2>外观</h2>
        <div className="group">
          <Row label="主题" hint={THEME_OPTIONS.find((t) => t.id === prefs?.theme)?.hint ?? "三套深色预设，切换即生效"}>
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
        <Row label="Skill 模式" hint="会话里可直接调用 ~/.claude 的 skill，放行 Bash/Read，不开 Edit/Write">
          <button
            className={`switch ${prefs?.skills ? "switch--on" : ""}`}
            role="switch"
            aria-checked={!!prefs?.skills}
            disabled={!prefs}
            onClick={() => prefs && void updateSettings({ skills: !prefs.skills }).then(setPrefs)}
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
        <Row label="自动化" hint="控制其他应用。第一版不需要">
          <span className="mono muted">未申请</span>
        </Row>
        <Row label="辅助功能" hint="模拟键盘输入。第一版不需要">
          <span className="mono muted">未申请</span>
        </Row>
        </div>
      </section>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <div className="row__text">
        <div className="row__label">{label}</div>
        {hint && <div className="row__hint">{hint}</div>}
      </div>
      <div className="row__ctl">{children}</div>
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
