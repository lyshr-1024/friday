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

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  prompt TEXT NOT NULL,
  response TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
