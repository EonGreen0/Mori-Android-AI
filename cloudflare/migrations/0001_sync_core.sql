CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  project_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload_json TEXT,
  revision INTEGER NOT NULL,
  deleted_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, entity_type, entity_id),
  FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mutation_receipts (
  op_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS change_log (
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_json TEXT,
  device_id TEXT,
  op_id TEXT NOT NULL,
  server_timestamp INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (project_id, revision),
  UNIQUE (op_id),
  FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_entities_project_revision
  ON entities(project_id, revision);

CREATE INDEX IF NOT EXISTS idx_entities_asset_lookup
  ON entities(entity_type, entity_id, deleted_at, revision DESC);

CREATE INDEX IF NOT EXISTS idx_change_log_project_revision
  ON change_log(project_id, revision);

CREATE INDEX IF NOT EXISTS idx_receipts_project_created
  ON mutation_receipts(project_id, created_at);
