import { Icon } from "./Icon";
import { useEffect, useRef, useState } from "react";
import type { MemoryFile } from "@friday/shared";
import { readHandbook, readMemory, writeHandbook, writeMemory } from "../lib/core";

export const MEMORY_FILES: Array<{ name: MemoryFile; label: string; hint: string }> = [
  { name: "projects", label: "项目注册表", hint: "## 名称 / - 目录 / - 别名 / - 状态 / - 说明" },
  { name: "decisions", label: "决策记录", hint: "## 日期 结论，下一行写理由" },
  { name: "people", label: "人物", hint: "## 姓名 / - 角色 / - 联系 / - 备注" },
];

/** 编辑记忆库的三个 md，或 handbooks/ 下的某一份项目手册 */
export type EditTarget = { kind: "memory"; name: MemoryFile } | { kind: "handbook"; slug: string };

export function MemoryEditor({ target, onBack }: { target: EditTarget; onBack: () => void }) {
  const meta =
    target.kind === "memory"
      ? MEMORY_FILES.find((f) => f.name === target.name)!
      : { label: target.slug === "_global" ? "通用习惯" : target.slug, hint: "## 约定 / ## 技术口径 / ## 流程，每条下面一行 > 原话出处" };
  const key = target.kind === "memory" ? target.name : `handbook:${target.slug}`;
  const [content, setContent] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void (target.kind === "memory" ? readMemory(target.name) : readHandbook(target.slug)).then((r) => {
      setContent(r.content);
      setSaved(r.content);
      setPath(r.path);
      setTimeout(() => ref.current?.focus(), 0);
    });
  }, [key]);

  const dirty = content !== null && content !== saved;

  async function save() {
    if (content === null || !dirty) return;
    setStatus("saving");
    try {
      const r = target.kind === "memory" ? await writeMemory(target.name, content) : await writeHandbook(target.slug, content);
      setSaved(r.content);
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 1500);
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.metaKey && e.key === "s") {
      e.preventDefault();
      void save();
    }
    if (e.key === "Escape" && !dirty) onBack();
  }

  return (
    <div className="editor" onKeyDown={onKeyDown}>
      <header className="editor__head">
        <button className="editor__back" onClick={onBack}><Icon name="chevronRight" className="icon--flip" />设置</button>
        <span className="editor__title">{meta.label}</span>
        <span className="editor__status mono">
          {status === "saving" && "保存中…"}
          {status === "saved" && "已保存"}
          {status === "error" && error}
          {status === "idle" && dirty && "未保存"}
        </span>
        <button className="editor__save" disabled={!dirty || status === "saving"} onClick={() => void save()}>
          保存 <kbd>⌘S</kbd>
        </button>
      </header>
      <textarea
        ref={ref}
        className="editor__text"
        value={content ?? ""}
        placeholder={content === null ? "读取中…" : meta.hint}
        spellCheck={false}
        onChange={(e) => setContent(e.target.value)}
      />
      <footer className="editor__foot mono">{path}</footer>
    </div>
  );
}
