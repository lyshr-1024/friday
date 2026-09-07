import type { MessageParam } from "@anthropic-ai/sdk/resources";
import type { Attachment } from "@friday/shared";
import { readAttachment } from "../memory/attachments.js";

type Block = Exclude<MessageParam["content"], string>[number];

const IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_LIKE = /^(text\/|application\/(json|xml|javascript|typescript|x-yaml|yaml|toml|x-sh))/;
const TEXT_EXT = /\.(md|txt|json|ya?ml|toml|csv|log|ts|tsx|js|jsx|py|go|rs|rb|sh|zsh|sql|html|css|scss|vue|swift|kt|java|c|h|cpp|hpp)$/i;
const MAX_TEXT = 100_000;

/** 把用户文字和附件组装成 Anthropic 消息内容：图片走 image 块、PDF 走 document 块、文本类文件内联成 text 块。 */
export function buildUserContent(prompt: string, attachmentIds: string[]): { content: MessageParam["content"]; attached: Attachment[] } {
  const blocks: Block[] = [];
  const attached: Attachment[] = [];
  for (const id of attachmentIds) {
    const found = readAttachment(id);
    if (!found) continue;
    const { meta, data } = found;
    attached.push({ id: meta.id, name: meta.name, mime: meta.mime, size: meta.size, createdAt: meta.createdAt });
    if (IMAGE.has(meta.mime)) {
      blocks.push({ type: "image", source: { type: "base64", media_type: meta.mime as "image/png", data: data.toString("base64") } });
    } else if (meta.mime === "application/pdf") {
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") }, title: meta.name });
    } else if (TEXT_LIKE.test(meta.mime) || TEXT_EXT.test(meta.name)) {
      const text = data.toString("utf8");
      blocks.push({ type: "text", text: `文件「${meta.name}」内容：\n\`\`\`\n${text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…（已截断）` : text}\n\`\`\`` });
    } else {
      blocks.push({ type: "text", text: `（用户附了文件「${meta.name}」，类型 ${meta.mime}，${meta.size} 字节，这种类型我读不了内容）` });
    }
  }
  blocks.push({ type: "text", text: prompt });
  return { content: blocks.length === 1 ? prompt : blocks, attached };
}
