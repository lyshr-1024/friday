import { MODEL_OPTIONS, type ModelId } from "@friday/shared";

export function ModelSelect({ value, onChange, compact = false }: { value: ModelId | null; onChange: (m: ModelId) => void; compact?: boolean }) {
  return (
    <select
      className={`model-select ${compact ? "model-select--compact" : ""}`}
      value={value ?? ""}
      disabled={value === null}
      onChange={(e) => onChange(e.target.value as ModelId)}
      title="模型"
    >
      {MODEL_OPTIONS.map((m) => (
        <option key={m.id} value={m.id}>
          {compact && m.id === "" ? "默认模型" : m.label}
        </option>
      ))}
    </select>
  );
}

export function modelLabel(id: ModelId | null | undefined): string {
  return MODEL_OPTIONS.find((m) => m.id === (id ?? ""))?.label ?? id ?? "";
}
