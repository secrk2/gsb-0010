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
  status TEXT NOT NULL DEFAULT '申请',      -- 申请/受理/初审/实审/授权/驳回/复审/无效
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

-- 官文：驱动案件状态流转的事实记录；可撤回（withdrawn），撤回后其派生期限一并作废、状态恢复。
CREATE TABLE IF NOT EXISTS office_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  oa_type TEXT NOT NULL,                   -- 见 lib/oaCatalog.js
  doc_no TEXT NOT NULL DEFAULT '',         -- 官方文号
  title TEXT NOT NULL DEFAULT '',
  dispatch_date TEXT NOT NULL,             -- 发文日 YYYY-MM-DD
  receive_date TEXT NULL,                  -- 实际收到/签收日（可空 → 按推定收到日）
  presumed_days INTEGER NOT NULL DEFAULT 15,
  receive_presumed INTEGER NOT NULL DEFAULT 1,
  target_status TEXT NULL,                 -- 该官文驱动到的状态（过程性官文为 NULL）
  status TEXT NOT NULL DEFAULT 'active',   -- active / withdrawn
  withdraw_reason TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER NULL,
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  withdrawn_at TEXT NULL,
  withdrawn_by INTEGER NULL,
  withdrawn_by_name TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_oa_case ON office_actions (case_id);
CREATE INDEX IF NOT EXISTS idx_oa_dispatch ON office_actions (dispatch_date);
CREATE INDEX IF NOT EXISTS idx_oa_status ON office_actions (status);

CREATE TABLE IF NOT EXISTS case_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  from_status TEXT NULL,
  to_status TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id INTEGER NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  event_source TEXT NOT NULL DEFAULT 'manual',  -- manual / office_action / withdraw
  ref_id INTEGER NULL,                          -- 关联官文 id
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_case ON case_events (case_id);

-- 期限：dtype 存事项名称；口径列由登记时的期限引擎快照（界面明示，不靠代理人猜）。
CREATE TABLE IF NOT EXISTS deadlines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  dtype TEXT NOT NULL,
  due_date TEXT NOT NULL,                  -- UTC 日期串 YYYY-MM-DD，展示时按代理所时区换算
  status TEXT NOT NULL DEFAULT '待处理',   -- 待处理 / 已完成（逾期为派生状态）
  note TEXT NOT NULL DEFAULT '',
  completed_at TEXT NULL,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',   -- manual / office_action
  office_action_id INTEGER NULL,
  base_type TEXT NULL,                     -- receive / dispatch / manual
  base_date TEXT NULL,                     -- 实际起算日快照
  day_basis TEXT NULL,                     -- natural / workday / legal
  window_value INTEGER NULL,
  window_unit TEXT NULL,                   -- day / month
  receive_presumed INTEGER NOT NULL DEFAULT 0,
  rolled_forward INTEGER NOT NULL DEFAULT 0,
  voided INTEGER NOT NULL DEFAULT 0,       -- 官文撤回 → 派生期限作废
  voided_reason TEXT NOT NULL DEFAULT '',
  completed_by INTEGER NULL,
  completed_by_name TEXT NOT NULL DEFAULT '',
  overdue_reason TEXT NOT NULL DEFAULT ''  -- 逾期完成必须填写原因，留痕
);
CREATE INDEX IF NOT EXISTS idx_dl_case ON deadlines (case_id);
CREATE INDEX IF NOT EXISTS idx_dl_due ON deadlines (due_date);
CREATE INDEX IF NOT EXISTS idx_dl_oa ON deadlines (office_action_id);

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

-- 法定节假日 / 调休上班日覆盖表（kind: holiday 休 / workday 上班）
CREATE TABLE IF NOT EXISTS holidays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- 所级键值设置（firm.timezone 代理所时区等）
CREATE TABLE IF NOT EXISTS kv_settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by INTEGER NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  ikey TEXT PRIMARY KEY,
  user_id INTEGER NULL,
  method TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  status_code INTEGER NOT NULL DEFAULT 200,
  response TEXT NULL,
  created_at TEXT NOT NULL
);
