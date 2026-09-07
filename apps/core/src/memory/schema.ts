export const SCHEMA = `
CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('local', 'slack', 'meegle')),
  source_id TEXT,
  source_url TEXT,
  due TEXT,
  created_at TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS todos_source_uniq ON todos (source, source_id) WHERE source_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sync_state (
  source TEXT PRIMARY KEY,
  last_synced_at TEXT,
  cursor TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  claude_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  kind TEXT NOT NULL CHECK (kind IN ('ask', 'today', 'note', 'run', 'error')),
  content TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('dm', 'mention')),
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  text TEXT NOT NULL,
  permalink TEXT NOT NULL,
  ts TEXT NOT NULL,
  received_at TEXT NOT NULL,
  triage TEXT,
  done INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS inbox_open ON inbox (done, ts);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  dir TEXT NOT NULL,
  task TEXT,
  conversation_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  exit_code INTEGER,
  last_message TEXT,
  log_path TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('dm', 'mention')),
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  project TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'done', 'ignored')),
  first_ts TEXT NOT NULL,
  last_ts TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  brief TEXT,
  auto_done TEXT
);
CREATE INDEX IF NOT EXISTS threads_open ON threads (status, last_ts);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  prompt TEXT NOT NULL,
  response TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
`;

export const MARKDOWN_TEMPLATES: Record<string, string> = {
  "projects.md": "# 项目注册表\n\n<!-- 每个项目一个二级标题：目录、状态、一句话说明 -->\n",
  "decisions.md": "# 决策记录\n\n<!-- ## YYYY-MM-DD 结论\n一句话理由 -->\n",
  "people.md": "# 人物\n\n<!-- ## 姓名\n- 角色 / 联系方式 / 备注 -->\n",
};
