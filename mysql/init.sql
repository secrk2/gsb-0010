-- 专利云 · 库表结构（MySQL 8，utf8mb4）
-- 种子数据由后端首次启动时写入（backend/src/seed.js），便于运行时生成密码散列与相对日期。

CREATE DATABASE IF NOT EXISTS patent_cloud CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE patent_cloud;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL,
  name VARCHAR(50) NOT NULL,
  role VARCHAR(20) NOT NULL,
  client_id INT NULL,
  created_at VARCHAR(19) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS clients (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(200) NOT NULL,
  short_code VARCHAR(10) NOT NULL,
  contact_name VARCHAR(50) NOT NULL DEFAULT '',
  contact_phone VARCHAR(30) NOT NULL DEFAULT '',
  contact_email VARCHAR(100) NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT '已建档',
  created_at VARCHAR(19) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS contracts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  contract_no VARCHAR(30) NOT NULL UNIQUE,
  client_id INT NOT NULL,
  title VARCHAR(200) NOT NULL,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT '已签署',
  signed_at VARCHAR(19) NULL,
  created_by INT NULL,
  created_at VARCHAR(19) NOT NULL,
  INDEX idx_contract_client (client_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cases (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_no VARCHAR(40) NOT NULL UNIQUE,
  client_uuid VARCHAR(64) NOT NULL UNIQUE,
  client_id INT NOT NULL,
  contract_id INT NULL,
  title VARCHAR(200) NOT NULL,
  ctype VARCHAR(20) NOT NULL DEFAULT '发明',
  status VARCHAR(20) NOT NULL DEFAULT '申请',       -- 申请/受理/初审/实审/授权/驳回/复审/无效
  agent_id INT NULL,
  priority VARCHAR(10) NOT NULL DEFAULT '普通',
  version INT NOT NULL DEFAULT 1,
  created_by INT NULL,
  created_at VARCHAR(19) NOT NULL,
  updated_at VARCHAR(19) NOT NULL,
  INDEX idx_case_client (client_id),
  INDEX idx_case_status (status),
  INDEX idx_case_agent (agent_id)
) ENGINE=InnoDB;

-- 官文：驱动案件状态流转的事实记录；可撤回，撤回后派生期限作废、状态恢复
CREATE TABLE IF NOT EXISTS office_actions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  oa_type VARCHAR(40) NOT NULL,
  doc_no VARCHAR(60) NOT NULL DEFAULT '',
  title VARCHAR(200) NOT NULL DEFAULT '',
  dispatch_date VARCHAR(10) NOT NULL,             -- 发文日
  receive_date VARCHAR(10) NULL,                  -- 实际收到/签收日（空=按推定收到日）
  presumed_days INT NOT NULL DEFAULT 15,
  receive_presumed TINYINT NOT NULL DEFAULT 1,
  target_status VARCHAR(20) NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'active',   -- active / withdrawn
  withdraw_reason VARCHAR(500) NOT NULL DEFAULT '',
  note VARCHAR(500) NOT NULL DEFAULT '',
  created_by INT NULL,
  created_by_name VARCHAR(50) NOT NULL DEFAULT '',
  created_at VARCHAR(19) NOT NULL,
  withdrawn_at VARCHAR(19) NULL,
  withdrawn_by INT NULL,
  withdrawn_by_name VARCHAR(50) NOT NULL DEFAULT '',
  INDEX idx_oa_case (case_id),
  INDEX idx_oa_dispatch (dispatch_date),
  INDEX idx_oa_status (status)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS case_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  from_status VARCHAR(20) NULL,
  to_status VARCHAR(20) NOT NULL,
  action VARCHAR(50) NOT NULL,
  actor_id INT NULL,
  actor_name VARCHAR(50) NOT NULL DEFAULT '',
  reason VARCHAR(500) NOT NULL DEFAULT '',
  event_source VARCHAR(20) NOT NULL DEFAULT 'manual',
  ref_id INT NULL,
  created_at VARCHAR(19) NOT NULL,
  INDEX idx_event_case (case_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS deadlines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  dtype VARCHAR(100) NOT NULL,
  due_date VARCHAR(10) NOT NULL,                  -- UTC 日期串，展示按代理所时区换算
  status VARCHAR(10) NOT NULL DEFAULT '待处理',
  note VARCHAR(300) NOT NULL DEFAULT '',
  completed_at VARCHAR(19) NULL,
  created_at VARCHAR(19) NOT NULL,
  source VARCHAR(20) NOT NULL DEFAULT 'manual',
  office_action_id INT NULL,
  base_type VARCHAR(10) NULL,                     -- receive / dispatch / manual
  base_date VARCHAR(10) NULL,
  day_basis VARCHAR(10) NULL,                    -- natural / workday / legal
  window_value INT NULL,
  window_unit VARCHAR(10) NULL,
  receive_presumed TINYINT NOT NULL DEFAULT 0,
  rolled_forward TINYINT NOT NULL DEFAULT 0,
  voided TINYINT NOT NULL DEFAULT 0,
  voided_reason VARCHAR(500) NOT NULL DEFAULT '',
  completed_by INT NULL,
  completed_by_name VARCHAR(50) NOT NULL DEFAULT '',
  overdue_reason VARCHAR(500) NOT NULL DEFAULT '',
  INDEX idx_dl_case (case_id),
  INDEX idx_dl_due (due_date),
  INDEX idx_dl_oa (office_action_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS fees (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  kind VARCHAR(50) NOT NULL,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  due_date VARCHAR(10) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT '待缴',
  paid_at VARCHAR(19) NULL,
  created_at VARCHAR(19) NOT NULL,
  INDEX idx_fee_case (case_id),
  INDEX idx_fee_due (due_date)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS unmask_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  user_name VARCHAR(50) NOT NULL,
  client_id INT NOT NULL,
  case_id INT NULL,
  reason VARCHAR(500) NOT NULL,
  ip VARCHAR(64) NOT NULL DEFAULT '',
  created_at VARCHAR(19) NOT NULL,
  INDEX idx_unmask_client (client_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS holidays (
  id INT AUTO_INCREMENT PRIMARY KEY,
  date VARCHAR(10) NOT NULL UNIQUE,
  kind VARCHAR(10) NOT NULL,                      -- holiday / workday
  name VARCHAR(50) NOT NULL DEFAULT '',
  created_at VARCHAR(19) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS kv_settings (
  k VARCHAR(50) PRIMARY KEY,
  v VARCHAR(500) NOT NULL,
  updated_at VARCHAR(19) NOT NULL,
  updated_by INT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  ikey VARCHAR(80) PRIMARY KEY,
  user_id INT NULL,
  method VARCHAR(10) NOT NULL DEFAULT '',
  path VARCHAR(200) NOT NULL DEFAULT '',
  status_code INT NOT NULL DEFAULT 200,
  response MEDIUMTEXT NULL,
  created_at VARCHAR(19) NOT NULL
) ENGINE=InnoDB;
