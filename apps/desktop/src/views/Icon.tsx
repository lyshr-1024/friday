/** 线性图标：统一 1.5px 描边、currentColor、随字号缩放（1em）。
    只画界面真正用到的那十几个，不引图标库。 */
const PATHS: Record<string, string> = {
  refresh: "M13.5 8a5.5 5.5 0 1 1-1.61-3.89M13.5 2.5V5H11",
  sparkle: "M8 2.2c.5 2.6 1.2 3.3 3.8 3.8-2.6.5-3.3 1.2-3.8 3.8-.5-2.6-1.2-3.3-3.8-3.8 2.6-.5 3.3-1.2 3.8-3.8zM12.4 10.2c.25 1.2.6 1.55 1.8 1.8-1.2.25-1.55.6-1.8 1.8-.25-1.2-.6-1.55-1.8-1.8 1.2-.25 1.55-.6 1.8-1.8z",
  star: "M8 2.6l1.76 3.57 3.94.57-2.85 2.78.67 3.92L8 11.6l-3.52 1.84.67-3.92L2.3 6.74l3.94-.57z",
  check: "M3.5 8.5l3 3 6-7",
  cross: "M4 4l8 8M12 4l-8 8",
  chevronRight: "M6 3.5l5 4.5-5 4.5",
  chevronDown: "M3.5 6l4.5 5 4.5-5",
  arrowDown: "M8 3v10M4 9l4 4 4-4",
  arrowUp: "M8 13V3M4 7l4-4 4 4",
  enter: "M13 3v4.5a1.5 1.5 0 0 1-1.5 1.5H3.5M6.5 12L3 8.5 6.5 5",
  terminal: "M4 5.5L6.5 8 4 10.5M8.5 11h4",
  message: "M2.5 4.5h11v7h-6l-3 2.5v-2.5h-2z",
  clock: "M8 4.5V8l2.5 1.5M8 2.2a5.8 5.8 0 1 0 0 11.6 5.8 5.8 0 0 0 0-11.6z",
  link: "M6.5 9.5l3-3M7 4.5l1.2-1.2a2.5 2.5 0 0 1 3.5 3.5L10.5 8M9 11.5l-1.2 1.2a2.5 2.5 0 0 1-3.5-3.5L5.5 8",
  pin: "M8 10v3.5M5 3h6l-.8 4.2 1.3 1.3H4.5l1.3-1.3z",
  plus: "M8 3.5v9M3.5 8h9",
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, className, filled }: { name: IconName; className?: string; filled?: boolean }) {
  return (
    <svg className={`icon${className ? ` ${className}` : ""}`} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
