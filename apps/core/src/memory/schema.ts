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
  thread_ts TEXT,
  received_at TEXT NOT NULL,
  prior TEXT,
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

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  project TEXT,
  status TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  understanding TEXT,
  plan TEXT,
  progress TEXT,
  report TEXT,
  pending TEXT,
  due TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status, updated_at);


CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  ts TEXT NOT NULL,
  action TEXT NOT NULL,
  why TEXT NOT NULL,
  how TEXT NOT NULL,
  evidence TEXT NOT NULL,
  risk TEXT NOT NULL,
  reversible INTEGER NOT NULL,
  status TEXT NOT NULL,
  undo TEXT
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts);
CREATE INDEX IF NOT EXISTS audit_task ON audit (task_id, ts);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  prompt TEXT NOT NULL,
  response TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  at TEXT NOT NULL,
  label TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  turns INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_at ON usage (at);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('shell')),
  cwd TEXT NOT NULL,
  branch TEXT,
  cmd TEXT,
  exit_code INTEGER
);
CREATE INDEX IF NOT EXISTS activity_ts ON activity (ts);

-- 四端之间的关联：一条边一行。Friday 唯一不可替代的东西就是这张表——
-- Slack / Meegle / 终端 / 浏览器各自都有完整的客户端，但它们彼此不知道对方的存在。
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  -- 边的两端，kind 是实体类型，ref 是它在那一端的标识
  from_kind TEXT NOT NULL CHECK (from_kind IN ('task', 'meegle', 'thread', 'branch', 'url', 'project', 'slack')),
  from_ref TEXT NOT NULL,
  to_kind TEXT NOT NULL CHECK (to_kind IN ('task', 'meegle', 'thread', 'branch', 'url', 'project', 'slack')),
  to_ref TEXT NOT NULL,
  -- user 是你纠正过的，查表必中且永不被自动推翻；rule 查表推出来；guess 模型猜的，界面要标出来
  source TEXT NOT NULL CHECK (source IN ('user', 'rule', 'guess')),
  -- 凭什么这么连的，出了错你能看出是哪条规则的锅
  why TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 同一条边只留一行，重复推断走 UPSERT 而不是堆行
CREATE UNIQUE INDEX IF NOT EXISTS links_edge ON links (from_kind, from_ref, to_kind, to_ref);
CREATE INDEX IF NOT EXISTS links_from ON links (from_kind, from_ref);
CREATE INDEX IF NOT EXISTS links_to ON links (to_kind, to_ref);
`;

export const MARKDOWN_TEMPLATES: Record<string, string> = {
  "projects.md": "# 项目注册表\n\n<!-- 每个项目一个二级标题：目录、状态、一句话说明 -->\n",
  "decisions.md": "# 决策记录\n\n<!-- ## YYYY-MM-DD 结论\n一句话理由 -->\n",
  "people.md": "# 人物\n\n<!-- ## 姓名\n- 角色 / 联系方式 / 备注 -->\n",
};
