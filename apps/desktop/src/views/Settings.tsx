import { useEffect, useState } from "react";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { DEFAULT_HOTKEY } from "@friday/shared";
import { coreBaseUrl, health } from "../lib/core";

export function Settings() {
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [core, setCore] = useState<{ url: string; version?: string; ok: boolean } | null>(null);

  useEffect(() => {
    void isEnabled().then(setAutostart);
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

  return (
    <div className="settings">
      <h1 className="settings__title">
        <span className="wordmark">F.</span> 设置
      </h1>

      <section>
        <h2>通用</h2>
        <Row label="开机自启" hint="登录后在菜单栏静默启动">
          <button
            className={`switch ${autostart ? "switch--on" : ""}`}
            role="switch"
            aria-checked={!!autostart}
            disabled={autostart === null}
            onClick={toggleAutostart}
          />
        </Row>
        <Row label="呼出热键" hint="下一版支持自定义">
          <kbd>{DEFAULT_HOTKEY.replace("Alt", "⌥")}</kbd>
        </Row>
      </section>

      <section>
        <h2>核心</h2>
        <Row label="状态">
          <span className="mono">
            <span className={`dot dot--${core ? (core.ok ? "ok" : "down") : "checking"}`} />
            {core ? (core.ok ? `运行中 ${core.version}` : "未响应") : "检测中"}
          </span>
        </Row>
        <Row label="地址">
          <span className="mono">{core?.url ?? "…"}</span>
        </Row>
      </section>

      <section>
        <h2>系统权限</h2>
        <Row label="自动化" hint="控制其他应用。第一版不需要">
          <span className="mono muted">未申请</span>
        </Row>
        <Row label="辅助功能" hint="模拟键盘输入。第一版不需要">
          <span className="mono muted">未申请</span>
        </Row>
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
