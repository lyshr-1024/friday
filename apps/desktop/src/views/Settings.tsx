import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import type { MemoryFile, SettingsResponse } from "@friday/shared";
import { MEMORY_FILES, MemoryEditor } from "./MemoryEditor";
import { coreBaseUrl, health, settings, updateSettings } from "../lib/core";
import { ModelSelect } from "./ModelSelect";

export function Settings() {
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [core, setCore] = useState<{ url: string; version?: string; ok: boolean } | null>(null);
  const [hotkey, setHotkey] = useState("");
  const [prefs, setPrefs] = useState<SettingsResponse | null>(null);
  const [editing, setEditing] = useState<MemoryFile | null>(null);

  useEffect(() => {
    void isEnabled().then(setAutostart);
    void invoke<string>("current_hotkey").then(setHotkey);
    void settings().then(setPrefs).catch(() => setPrefs(null));
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
        <Row label="跑 Claude 用的终端" hint="settings.json 的 terminal：ghostty 或 terminal">
          <span className="mono">{prefs ? (prefs.terminal === "ghostty" ? "Ghostty" : "Terminal") : "…"}</span>
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
