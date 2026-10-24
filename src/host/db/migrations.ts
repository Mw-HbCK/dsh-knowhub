/**
 * 数据库迁移：按版本号顺序执行，版本记录在 settings.schema_version。
 * 只允许追加新迁移，禁止修改已发布的历史迁移。
 */
export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: '001-init',
    sql: `
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_bases (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  scope          TEXT NOT NULL CHECK (scope IN ('user', 'workspace')),
  scope_key      TEXT NOT NULL,
  workspace_id   TEXT,
  model_provider TEXT NOT NULL DEFAULT '',
  model_id       TEXT NOT NULL DEFAULT '',
  model_strategy TEXT NOT NULL CHECK (model_strategy IN ('economy', 'balanced', 'quality')),
  status         TEXT NOT NULL CHECK (status IN ('created', 'indexing', 'ready', 'error', 'disabled')),
  status_detail  TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  deleted_at     INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_kb_name ON knowledge_bases(scope_key, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_kb_scope ON knowledge_bases(scope_key, deleted_at);

CREATE TABLE IF NOT EXISTS documents (
  id                TEXT PRIMARY KEY,
  kb_id             TEXT NOT NULL REFERENCES knowledge_bases(id),
  kind              TEXT NOT NULL CHECK (kind IN ('wiki','memory','decision','convention','issue','todo','preference')),
  slug              TEXT NOT NULL,
  title             TEXT NOT NULL,
  body              TEXT NOT NULL DEFAULT '',
  path              TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('draft','approved','stale','archived')),
  verify_state      TEXT NOT NULL CHECK (verify_state IN ('observed','inferred','assumed','unverified')),
  confidence        REAL,
  tags              TEXT NOT NULL DEFAULT '[]',
  current_version   INTEGER NOT NULL DEFAULT 1,
  source_session_id TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  reviewed_at       INTEGER,
  reviewed_by       TEXT,
  deleted_at        INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_doc_slug ON documents(kb_id, slug) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_doc_kb ON documents(kb_id, deleted_at);
CREATE INDEX IF NOT EXISTS ix_doc_kind ON documents(kind, status);

CREATE TABLE IF NOT EXISTS doc_versions (
  doc_id       TEXT NOT NULL,
  version      INTEGER NOT NULL,
  content      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  change_kind  TEXT NOT NULL CHECK (change_kind IN ('create','update','restore','stale','merge')),
  source       TEXT NOT NULL,
  actor        TEXT,
  reason       TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (doc_id, version)
);

CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  doc_id        TEXT,
  candidate_id  TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('file','session','task','url','commit')),
  ref           TEXT NOT NULL,
  locator       TEXT,
  excerpt_hash  TEXT,
  verified      INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_src_doc ON sources(doc_id);

CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(
  doc_id UNINDEXED,
  title,
  body,
  tags,
  tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS write_intents (
  doc_id     TEXT PRIMARY KEY,
  path       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  kb_id        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  progress     INTEGER NOT NULL DEFAULT 0,
  stage        TEXT,
  cursor       TEXT,
  idem_key     TEXT NOT NULL,
  error_code   TEXT,
  error_detail TEXT,
  started_at   INTEGER,
  finished_at  INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_running ON tasks(idem_key) WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS llm_calls (
  id                TEXT PRIMARY KEY,
  kb_id             TEXT NOT NULL,
  task_id           TEXT,
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  latency_ms        INTEGER,
  finish_kind       TEXT,
  failure_code      TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_llm_kb ON llm_calls(kb_id, created_at);
`,
  },
  {
    version: 2,
    name: '002-m2-tasks-index',
    sql: `
ALTER TABLE tasks ADD COLUMN input TEXT;
ALTER TABLE tasks ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE llm_calls ADD COLUMN purpose TEXT;

CREATE TABLE IF NOT EXISTS task_logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  at      INTEGER NOT NULL,
  level   TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_task_logs ON task_logs(task_id, id);

CREATE TABLE IF NOT EXISTS project_files (
  kb_id        TEXT NOT NULL,
  path         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  language     TEXT,
  content_hash TEXT,
  indexed_at   INTEGER NOT NULL,
  PRIMARY KEY (kb_id, path)
);
CREATE INDEX IF NOT EXISTS ix_pf_kb ON project_files(kb_id);
`,
  },
  {
    version: 3,
    name: '003-m3-review',
    sql: `
CREATE TABLE IF NOT EXISTS proposals (
  id            TEXT PRIMARY KEY,
  kb_id         TEXT NOT NULL,
  doc_id        TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('create','update','restore','stale')),
  title         TEXT,
  body          TEXT NOT NULL,
  base_version  INTEGER,
  doc_kind      TEXT,
  tags          TEXT,
  verify_state  TEXT,
  confidence    REAL,
  sources       TEXT,
  source        TEXT,
  reason        TEXT,
  status        TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','superseded')),
  created_by    TEXT,
  created_at    INTEGER NOT NULL,
  reviewed_at   INTEGER,
  reviewed_by   TEXT,
  review_note   TEXT
);
CREATE INDEX IF NOT EXISTS ix_proposals_status ON proposals(status, created_at);
CREATE INDEX IF NOT EXISTS ix_proposals_kb ON proposals(kb_id, status);

CREATE TABLE IF NOT EXISTS conflicts (
  id             TEXT PRIMARY KEY,
  kb_id          TEXT NOT NULL,
  doc_id         TEXT NOT NULL,
  base_version   INTEGER NOT NULL,
  current_version INTEGER NOT NULL,
  proposed_title TEXT,
  proposed_body  TEXT NOT NULL,
  source         TEXT,
  status         TEXT NOT NULL CHECK (status IN ('pending','keep_current','use_proposed')),
  detected_at    INTEGER NOT NULL,
  resolved_at    INTEGER,
  resolved_by    TEXT,
  note           TEXT
);
CREATE INDEX IF NOT EXISTS ix_conflicts_status ON conflicts(status, detected_at);
CREATE INDEX IF NOT EXISTS ix_conflicts_kb ON conflicts(kb_id, status);

CREATE TABLE IF NOT EXISTS review_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  actor     TEXT,
  action    TEXT NOT NULL,
  item_kind TEXT NOT NULL,
  item_id   TEXT NOT NULL,
  doc_id    TEXT,
  kb_id     TEXT,
  note      TEXT
);
CREATE INDEX IF NOT EXISTS ix_review_log ON review_log(at);
`,
  },
  {
    version: 4,
    name: '004-m4-incremental',
    sql: `
CREATE TABLE IF NOT EXISTS kb_git_state (
  kb_id         TEXT PRIMARY KEY,
  workspace_id  TEXT,
  root          TEXT NOT NULL,
  mode          TEXT NOT NULL CHECK (mode IN ('git','hash')),
  head          TEXT,
  branch        TEXT,
  file_count    INTEGER NOT NULL,
  dirty_count   INTEGER NOT NULL,
  last_scan_at  INTEGER NOT NULL,
  last_task_id  TEXT,
  last_summary  TEXT,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS file_changes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kb_id       TEXT NOT NULL,
  task_id     TEXT,
  path        TEXT NOT NULL,
  change      TEXT NOT NULL CHECK (change IN ('added','modified','deleted')),
  mode        TEXT NOT NULL,
  detected_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_file_changes ON file_changes(kb_id, detected_at);

CREATE TABLE IF NOT EXISTS doc_recheck (
  kb_id      TEXT NOT NULL,
  doc_id     TEXT NOT NULL,
  reason     TEXT NOT NULL,
  task_id    TEXT,
  flagged_at INTEGER NOT NULL,
  PRIMARY KEY (kb_id, doc_id)
);
CREATE INDEX IF NOT EXISTS ix_doc_recheck ON doc_recheck(kb_id, flagged_at);
`,
  },
  {
    version: 5,
    name: '005-m5-product',
    sql: `
CREATE TABLE IF NOT EXISTS backups (
  id             TEXT PRIMARY KEY,
  file           TEXT NOT NULL,
  format_version INTEGER NOT NULL,
  kb_count       INTEGER NOT NULL,
  doc_count      INTEGER NOT NULL,
  bytes          INTEGER NOT NULL,
  note           TEXT,
  actor          TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_backups_at ON backups(created_at);

CREATE TABLE IF NOT EXISTS distill_runs (
  id             TEXT PRIMARY KEY,
  kb_id          TEXT,
  workspace_id   TEXT,
  source         TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('success','failed','skipped')),
  created_count  INTEGER NOT NULL DEFAULT 0,
  skipped_count  INTEGER NOT NULL DEFAULT 0,
  model_provider TEXT,
  model_id       TEXT,
  note           TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_distill_runs ON distill_runs(created_at);
`,
  },
  {
    version: 6,
    name: '006-review-merge',
    sql: `
CREATE TABLE IF NOT EXISTS conflicts_next (
  id             TEXT PRIMARY KEY,
  kb_id          TEXT NOT NULL,
  doc_id         TEXT NOT NULL,
  base_version   INTEGER NOT NULL,
  current_version INTEGER NOT NULL,
  proposed_title TEXT,
  proposed_body  TEXT NOT NULL,
  source         TEXT,
  status         TEXT NOT NULL CHECK (status IN ('pending','keep_current','use_proposed','merge')),
  detected_at    INTEGER NOT NULL,
  resolved_at    INTEGER,
  resolved_by    TEXT,
  note           TEXT
);
INSERT INTO conflicts_next (id, kb_id, doc_id, base_version, current_version, proposed_title, proposed_body, source, status, detected_at, resolved_at, resolved_by, note)
  SELECT id, kb_id, doc_id, base_version, current_version, proposed_title, proposed_body, source, status, detected_at, resolved_at, resolved_by, note FROM conflicts;
DROP TABLE conflicts;
ALTER TABLE conflicts_next RENAME TO conflicts;
CREATE INDEX IF NOT EXISTS ix_conflicts_status ON conflicts(status, detected_at);
CREATE INDEX IF NOT EXISTS ix_conflicts_kb ON conflicts(kb_id, status);
`,
  },
  {
    version: 7,
    name: '007-p2-parent-feedback',
    sql: `
ALTER TABLE documents ADD COLUMN parent_id TEXT;
CREATE INDEX IF NOT EXISTS ix_doc_parent ON documents(kb_id, parent_id);

CREATE TABLE IF NOT EXISTS doc_feedback (
  id         TEXT PRIMARY KEY,
  kb_id      TEXT NOT NULL,
  doc_id     TEXT NOT NULL,
  helpful    INTEGER NOT NULL CHECK (helpful IN (0, 1)),
  reason     TEXT,
  actor      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_doc_feedback_doc ON doc_feedback(doc_id, created_at);
CREATE INDEX IF NOT EXISTS ix_doc_feedback_kb ON doc_feedback(kb_id, created_at);
`,
  },
]

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version
