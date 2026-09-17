-- 开发/测试专用（node:sqlite）。与 mysql/init.sql 保持同构，仅类型写法不同。
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  client_id INTEGER NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  short_code TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '已建档',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_no TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '已签署',
  signed_at TEXT NULL,
  created_by INTEGER NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contract_client ON contracts (client_id);

CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no TEXT NOT NULL UNIQUE,
  client_uuid TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL,
  contract_id INTEGER NULL,
  title TEXT NOT NULL,
  ctype TEXT NOT NULL DEFAULT '发明',
  status TEXT NOT NULL DEFAULT '委托中',
  agent_id INTEGER NULL,
  priority TEXT NOT NULL DEFAULT '普通',
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_client ON cases (client_id);
CREATE INDEX IF NOT EXISTS idx_case_status ON cases (status);
CREATE INDEX IF NOT EXISTS idx_case_agent ON cases (agent_id);

CREATE TABLE IF NOT EXISTS case_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  from_status TEXT NULL,
  to_status TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id INTEGER NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_case ON case_events (case_id);

CREATE TABLE IF NOT EXISTS deadlines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  dtype TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '待处理',
  note TEXT NOT NULL DEFAULT '',
  completed_at TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dl_case ON deadlines (case_id);
CREATE INDEX IF NOT EXISTS idx_dl_due ON deadlines (due_date);

CREATE TABLE IF NOT EXISTS fees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '待缴',
  paid_at TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fee_case ON fees (case_id);
CREATE INDEX IF NOT EXISTS idx_fee_due ON fees (due_date);

CREATE TABLE IF NOT EXISTS unmask_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  user_name TEXT NOT NULL,
  client_id INTEGER NOT NULL,
  case_id INTEGER NULL,
  reason TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_unmask_client ON unmask_logs (client_id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  ikey TEXT PRIMARY KEY,
  user_id INTEGER NULL,
  method TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  status_code INTEGER NOT NULL DEFAULT 200,
  response TEXT NULL,
  created_at TEXT NOT NULL
);
