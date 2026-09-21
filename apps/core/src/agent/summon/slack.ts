/** people.md 里某人的条目（"## 姓名" 到下一个 "## " 之前）。找不到返回 undefined。 */
export function personEntry(markdown: string, name: string): string | undefined {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${name}`);
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const section = end < 0 ? rest : rest.slice(0, end);
  const body = section.find((l) => l.trim().length > 0);
  return body ? `${name}：${body.trim().replace(/^-\s*/, "")}` : undefined;
}

/**
 * Slack 场景的一段上下文：这个频道/这个人最近找过我什么事。
 * 线程那套删掉后暂时不给上下文，下一步按收件箱重建。
 */
export function slackContext(channel: string | undefined, person: string | undefined): string | undefined {
  void channel;
  void person;
  return undefined;
}
