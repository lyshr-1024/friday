import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FRIDAY_DATA_DIR = mkdtempSync(join(tmpdir(), "friday-test-"));
process.env.FRIDAY_NO_SCHEDULER = "1";
// 用户的 ~/.claude/settings.json 不参与测试：语言等偏好由各测试自己写临时文件
process.env.FRIDAY_CLAUDE_SETTINGS = join(process.env.FRIDAY_DATA_DIR, "claude-settings.json");
