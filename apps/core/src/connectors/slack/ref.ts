import type { ExternalRef } from "@friday/shared";

/** 关联图里这段对话的类型：老库遗留的线程引用当年记成 thread 边，迁过去是 slack:thread */
export const linkType = (ext: ExternalRef): "thread" | "conversation" => (ext.attrs?.legacy === "thread" ? "thread" : "conversation");
