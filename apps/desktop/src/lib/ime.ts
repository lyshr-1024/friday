import { useRef } from "react";

// WebKit 里输入法用回车上屏时，那次 keydown 的 isComposing 已经是 false，
// 单靠它会把"上屏"误判成"发送"。自己跟踪 composition，并忽略 compositionend 后同一拍的回车。
export function useImeGuard() {
  const composing = useRef(false);
  const justEnded = useRef(false);

  const handlers = {
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: () => {
      composing.current = false;
      justEnded.current = true;
      setTimeout(() => {
        justEnded.current = false;
      }, 0);
    },
  };

  const isImeEnter = (e: React.KeyboardEvent) =>
    e.key === "Enter" && (composing.current || justEnded.current || e.nativeEvent.isComposing || e.keyCode === 229);

  return { handlers, isImeEnter };
}
