export const SLACK_BUNDLE = "com.tinyspeck.slackmacgap";

export const ownsApp = (bundleId: string) => bundleId === SLACK_BUNDLE;

const SLACK_SUFFIX = /\s*-\s*[^-]*-\s*Slack\s*$/;

// 中文界面的标题不带 # 而是跟一个「（频道）」标记，它后面还可能挂别的段：
//   team-fe-bo（频道） - Longbridge - Slack
//   一起养牛（频道） - Longbridge - 1 个新项目 - Slack
// 所以不去数有几段后缀，直接认这个标记——它前面那截就是频道名。
const CHANNEL_TAG = /^(.+?)\s*[（(](?:频道|channel)[）)]/i;

// Slack 左侧那些视图（活动、私信、文件…）会整个占掉标题，它们不是人也不是频道，
// 认成人名只会让 Friday 去找一个叫「活动」的同事
const VIEWS = new Set(["活动", "私信", "文件", "主页", "更多", "草稿和已发送", "留待以后处理", "Activity", "DMs", "Files", "Home", "Later", "Drafts & sent"]);

export function parseTitle(title: string): { channel?: string; person?: string } {
  const tagged = CHANNEL_TAG.exec(title);
  if (tagged) return { channel: tagged[1]!.trim() };
  const head = title.replace(SLACK_SUFFIX, "").replace(/\s*\(\d+(?:\s+new items?)?\)\s*/i, "").trim();
  if (!head || VIEWS.has(head)) return {};
  return head.startsWith("#") ? { channel: head } : { person: head };
}
