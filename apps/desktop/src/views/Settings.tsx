import { useEffect, useState, cloneElement, isValidElement, useId, type ReactElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { DEFAULT_SKILL_LIST, THEME_OPTIONS, type PermissionStatus, type SettingsResponse } from "@friday/shared";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { applyBackground, applyTheme, broadcastBackground, broadcastTheme } from "../lib/theme";
import { MEMORY_FILES, MemoryEditor, type EditTarget } from "./MemoryEditor";
import { RulesEditor } from "./RulesEditor";
import { autostartPreview, coreBaseUrl, health, learnHistory, leftoverWorktrees, listHandbooks, okrWeeklyNow, removeWorktree, settings, testNotification, updateSettings, type LeftoverWorktree } from "../lib/core";
import { ModelSelect } from "./ModelSelect";
import { useImeGuard } from "../lib/ime";
import { AUTOSTART_CONFIDENCE } from "@friday/shared";

export function Settings() {
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [core, setCore] = useState<{ url: string; version?: string; ok: boolean; tmux?: string | null } | null>(null);
  const [leftover, setLeftover] = useState<LeftoverWorktree[]>([]);
  const [confirmDrop, setConfirmDrop] = useState<LeftoverWorktree | null>(null);
  const [dropNote, setDropNote] = useState("");
  const [hotkey, setHotkey] = useState("");
  const [prefs, setPrefs] = useState<SettingsResponse | null>(null);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [notified, setNotified] = useState(false);
  const [handbooks, setHandbooks] = useState<string[]>([]);
  const [learning, setLearning] = useState(false);
  const [learnNote, setLearnNote] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftNote, setDraftNote] = useState("");
  const [perms, setPerms] = useState<PermissionStatus | null>(null);
  const [bgNote, setBgNote] = useState("");
  const [coreUrl, setCoreUrl] = useState("");
  const [gate, setGate] = useState<{ pass: number; candidates: number } | null>(null);
  const ime = useImeGuard();

  // 拖门槛时跟着看「按这个值能放进几条」，停手 250ms 再问 core，不必每一格都请求
  const minConfidence = prefs?.autonomousMinConfidence;
  useEffect(() => {
    if (minConfidence === undefined) return;
    const timer = window.setTimeout(() => {
      autostartPreview(minConfidence).then((r) => setGate(r)).catch(() => setGate(null));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [minConfidence]);

  /** 存背景图；core 会校验类型/大小，失败就把原因显示出来，不动当前设置。 */
  async function saveBackground(path: string) {
    setBgNote("");
    try {
      const next = await updateSettings({ background: path });
      setPrefs(next);
      broadcastBackground({ background: next.background, backgroundOpacity: next.backgroundOpacity }, coreUrl);
    } catch (e) {
      setBgNote(e instanceof Error ? e.message : "存不了这张图");
    }
  }

  async function pickBackground() {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (typeof picked === "string") await saveBackground(picked);
  }

  function refreshPerms() {
    void invoke<PermissionStatus>("permission_status").then(setPerms);
  }

  useEffect(() => {
    void isEnabled().then(setAutostart);
    void listHandbooks().then(setHandbooks).catch(() => {});
    void invoke<string>("current_hotkey").then(setHotkey);
    void settings().then(async (p) => { setPrefs(p); applyTheme(p.theme); applyBackground(p, await coreBaseUrl()); }).catch(() => setPrefs(null));
    refreshPerms();
    void leftoverWorktrees().then(setLeftover).catch(() => {});
    void (async () => {
      const url = await coreBaseUrl();
      setCoreUrl(url);
      try {
        const h = await health();
        setCore({ url, version: h.version, ok: true, tmux: h.tmux });
      } catch {
        setCore({ url, ok: false });
      }
    })();
  }, []);

  async function dropWorktree(w: LeftoverWorktree) {
    setConfirmDrop(null);
    try {
      const r = await removeWorktree(w.path, w.dirty);
      setDropNote(
        !r.removed ? `没删：${r.kept ?? "未知原因"}` : r.branch && !r.branchDeleted ? `目录删了，分支 ${r.branch} 没合并留着` : r.branch ? `目录和分支 ${r.branch} 都删了` : "目录删了",
      );
    } catch (e) {
      setDropNote(e instanceof Error ? e.message : "删不了");
    }
    setLeftover(await leftoverWorktrees().catch(() => []));
  }

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

  async function runOkrDraft() {
    setDrafting(true);
    setDraftNote("");
    try {
      const r = await okrWeeklyNow();
      setDraftNote(r.skipped ? r.skipped : `起草好了：${r.drafted} 条，去任务里审`);
    } catch {
      setDraftNote("出错了");
    } finally {
      setDrafting(false);
      setTimeout(() => setDraftNote(""), 6000);
    }
  }

  async function toggleAutostart() {
    if (autostart === null) return;
    if (autostart) await disable();
    else await enable();
    setAutostart(await isEnabled());
  }

  if (editing?.kind === "handbook") {
    return <RulesEditor project={editing.slug} onBack={() => setEditing(null)} />;
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
        <h2>自主开工</h2>
        <div className="group">
          <Row label="让 Friday 自己开工" hint="Meegle 同步时，描述够具体（有复现步骤、把握不低于下面的门槛）、项目归属明确的缺陷，Friday 直接在 worktree 里自主改完交你审。只接缺陷不接需求；同时只跑 1 条，跑完再接下一条；合并前照旧要你点头">
            <button
              className={`switch ${prefs?.autonomous ? "switch--on" : ""}`}
              role="switch"
              aria-checked={!!prefs?.autonomous}
              disabled={!prefs}
              onClick={() => prefs && void updateSettings({ autonomous: !prefs.autonomous }).then(setPrefs)}
            />
          </Row>
          {prefs && (
            <Row
              label="把握门槛"
              hint={`Friday 判断「照工单描述一次就能改对」的把握不低于这个值才自己开工。调低放进来的多、白干的也多；${
                gate ? (gate.candidates ? `排队里判成能开工的缺陷 ${gate.candidates} 条，按 ${prefs.autonomousMinConfidence} 能放进 ${gate.pass} 条` : "排队里现在没有判成能开工的缺陷") : "正在数排队的缺陷…"
              }`}
            >
              <div className="bgpick">
                <input
                  type="range"
                  className="bgpick__range"
                  aria-label="自主开工的把握门槛"
                  min={AUTOSTART_CONFIDENCE.min}
                  max={AUTOSTART_CONFIDENCE.max}
                  value={prefs.autonomousMinConfidence}
                  onChange={(e) => setPrefs({ ...prefs, autonomousMinConfidence: Number(e.target.value) })}
                  onPointerUp={() => { void updateSettings({ autonomousMinConfidence: prefs.autonomousMinConfidence }); }}
                  onKeyUp={() => { void updateSettings({ autonomousMinConfidence: prefs.autonomousMinConfidence }); }}
                />
                <span className="bgpick__val">{prefs.autonomousMinConfidence}</span>
              </div>
            </Row>
          )}
        </div>
      </section>

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
                <Row key={slug} label={slug === "_global" ? "通用习惯" : slug} hint="派去终端干活的 Claude 会先读这份；学错了点「退役」写一句为什么，你改过的 Friday 不会再动">
                  <button className="btn" onClick={() => setEditing({ kind: "handbook", slug })}>规则…</button>
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
        <h2>OKR 周报</h2>
        <div className="group">
          <Row label="每周自动起草" hint="每周五 16:00 后用本周 git 提交和任务起草，挂成审核卡，你点了才提交">
            <button
              className={`switch ${prefs?.okrWeekly ? "switch--on" : ""}`}
              role="switch"
              aria-checked={!!prefs?.okrWeekly}
              disabled={!prefs}
              onClick={() => prefs && void updateSettings({ okrWeekly: !prefs.okrWeekly }).then(setPrefs)}
            />
          </Row>
          <Row label="现在起草一份" hint="不等到周五，立刻按本周内容起草一份待审">
            <button className="btn" disabled={drafting} onClick={() => void runOkrDraft()}>{drafting ? "起草中…" : draftNote || "现在起草一份"}</button>
          </Row>
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
          <Row label="背景图" hint={prefs?.background ? prefs.background : "工作台和呼出浮窗的底图，支持 png / jpg / webp，10MB 以内"}>
            <div className="bgpick">
              <button
                className="b"
                disabled={!prefs}
                onClick={() => { void pickBackground(); }}
              >
                选文件…
              </button>
              {prefs?.background ? (
                <button className="b" onClick={() => { void saveBackground(""); }}>清除</button>
              ) : null}
            </div>
          </Row>
          {prefs?.background ? (
            <Row label="背景浓度" hint="往右图越淡。为了二级文字还能读，实际浓度不会低于 62%，再往左拖只是图更显但字不会更糊">
              <div className="bgpick">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={prefs.backgroundOpacity}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setPrefs({ ...prefs, backgroundOpacity: v });
                    broadcastBackground({ background: prefs.background, backgroundOpacity: v }, coreUrl);
                  }}
                  onPointerUp={() => { void updateSettings({ backgroundOpacity: prefs.backgroundOpacity }); }}
                  onKeyUp={() => { void updateSettings({ backgroundOpacity: prefs.backgroundOpacity }); }}
                />
                <span className="bgpick__val">{prefs.backgroundOpacity}%</span>
              </div>
            </Row>
          ) : null}
          {bgNote ? <Row label=""><span className="bgpick__err">{bgNote}</span></Row> : null}
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
            {...ime.handlers}
            onKeyDown={(e) => { if (e.key === "Enter") { if (ime.isImeEnter(e)) return; (e.target as HTMLInputElement).blur(); } }}
          />
        </Row>
        <Row label="模型" hint="对话与热点摘要都用它，切换即生效">
          <ModelSelect value={prefs?.model ?? null} onChange={(model) => void updateSettings({ model }).then(setPrefs)} />
        </Row>
        <Row label="Skill 模式" hint="会话里可直接调用 ~/.claude 的 skill，放行 Bash/Read，不开 Edit/Write。开着时每轮都要读 skill 文档、最多跑 30 轮，比关掉贵不少；不常用 skill 就关掉">
          <button
            className={`switch ${prefs?.skills ? "switch--on" : ""}`}
            role="switch"
            aria-checked={!!prefs?.skills}
            disabled={!prefs}
            onClick={() => prefs && void updateSettings({ skills: !prefs.skills }).then(setPrefs)}
          />
        </Row>
        {prefs?.skills && (
          <Row label="放行哪些 skill" hint="全放会把本机每个 skill 的描述都塞进每轮上下文（实测 51KB，占注入量六成）。精选只放助理类那几个（飞书、Meegle、浏览器），改代码的 skill 归终端">
            <select
              className="model-select"
              value={prefs.skillList === "all" ? "all" : "curated"}
              onChange={(e) => void updateSettings({ skillList: e.target.value === "all" ? "all" : [...DEFAULT_SKILL_LIST] }).then(setPrefs)}
            >
              <option value="curated">精选 {DEFAULT_SKILL_LIST.length} 个</option>
              <option value="all">全部（贵）</option>
            </select>
          </Row>
        )}
        <Row label="从 Claude Code 学" hint="每周扫一次你在 Claude Code 里说过的话，提炼成项目手册挂成待审；一轮约 $0.2，冷启动那次约 $1">
          <button
            className={`switch ${prefs?.learnHistory ? "switch--on" : ""}`}
            role="switch"
            aria-checked={!!prefs?.learnHistory}
            disabled={!prefs}
            onClick={() => prefs && void updateSettings({ learnHistory: !prefs.learnHistory }).then(setPrefs)}
          />
        </Row>
        </div>
      </section>

      <section>
        <h2>终端</h2>
        <div className="group">
        <Row label="tmux" hint={core?.tmux === null ? "内嵌终端靠 tmux 持有进程，关掉 Friday 任务也不会断" : "任务的终端跑在 tmux 里，退出 Friday 也不会断"}>
          <span className="mono">
            <span className={`dot dot--${core ? (core.tmux ? "ok" : "down") : "checking"}`} />
            {core ? (core.tmux ? `${core.tmux} · 已就绪` : "没装 tmux，内嵌终端不可用：在终端里跑 brew install tmux") : "检测中"}
          </span>
        </Row>
        <Row label="从外部终端接回同一个会话" hint="会话名在任务详情的分支那行">
          <code className="mono" style={{ userSelect: "all" }}>tmux -L friday attach -t &lt;会话名&gt;</code>
        </Row>
        <Row label="快捷键" hint="按住 Option 拖选走系统选区；⌘ 组合在终端聚焦时归终端">
          <span className="mono">⌘T 新窗口 · ⌘W 关窗口 · ⌘1…9 切窗口 · ⌘D / ⌘⇧D 分屏 · ⌘F 搜历史 · ⌘K 清屏 · ⌘+ / ⌘- / ⌘0 字号</span>
        </Row>
        {leftover.length === 0 ? (
          <Row label="遗留的 worktree" hint={dropNote || "已完成或忽略的任务留在磁盘上的 worktree，没有遗留"}>
            <span className="mono">0 个</span>
          </Row>
        ) : (
          leftover.map((w) => (
            <Row key={w.path} label={w.title ?? w.path.split("/").pop() ?? w.path} hint={`${w.path.replace(/^\/Users\/[^/]+/, "~")}${w.branch ? ` · ${w.branch}` : ""}${w.dirty ? " · 有未提交改动" : ""}`}>
              <button className="btn" onClick={() => (w.dirty ? setConfirmDrop(w) : void dropWorktree(w))}>{w.dirty ? "删掉（会丢改动）" : "删掉"}</button>
            </Row>
          ))
        )}
        {leftover.length > 0 && dropNote && <Row label="上一次删除" hint={dropNote}><span /></Row>}
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
        <Row label="系统通知" hint={notified ? "已发出，20 秒内应弹出；没弹就去 系统设置 › 通知 里允许 Friday" : "任务结束、终端在等你回答时提醒你"}>
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
      {confirmDrop && (
        <div className="modal" onMouseDown={() => setConfirmDrop(null)} onKeyDown={(e) => { if (e.key === "Escape") setConfirmDrop(null); }}>
          <div className="modal__box modal__box--ask" onMouseDown={(e) => e.stopPropagation()} role="alertdialog" aria-label="删掉 worktree">
            <strong className="modal__title">删掉这个 worktree，没提交的改动会丢</strong>
            <p className="modal__note">{confirmDrop.path.replace(/^\/Users\/[^/]+/, "~")} 里有还没提交的改动，删了找不回来。分支{confirmDrop.branch ? ` ${confirmDrop.branch} ` : ""}只在合并过时才会一起删。</p>
            <div className="modal__foot">
              <button className="b b--danger" onClick={() => void dropWorktree(confirmDrop)}>连改动一起删掉</button>
              <button className="b b--text" autoFocus onClick={() => setConfirmDrop(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
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
