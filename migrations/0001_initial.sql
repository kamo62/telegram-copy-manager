CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_sessions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  api_id_hint TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  dialog_id TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  parser_mode TEXT NOT NULL,
  risk_profile TEXT NOT NULL DEFAULT 'balanced',
  lot_size REAL NOT NULL DEFAULT 0.1,
  last_message_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_messages (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  telegram_message_id TEXT NOT NULL,
  message_date TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  classification TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parsed_signals (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  raw_message_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  review_required INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logical_trades (
  id TEXT PRIMARY KEY,
  provider_id TEXT,
  account_id TEXT,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queue_items (
  id TEXT PRIMARY KEY,
  parsed_signal_id TEXT NOT NULL,
  logical_trade_id TEXT,
  account_id TEXT,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  leased_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mt5_accounts (
  id TEXT PRIMARY KEY,
  account_number TEXT NOT NULL,
  server TEXT NOT NULL,
  company TEXT NOT NULL,
  currency TEXT NOT NULL,
  balance REAL NOT NULL,
  equity REAL NOT NULL,
  margin_mode TEXT NOT NULL,
  heartbeat_status TEXT NOT NULL,
  available_symbols_json TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_symbol_mappings (
  account_id TEXT PRIMARY KEY,
  mapping_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS symbol_aliases (
  scope TEXT NOT NULL,
  provider_id TEXT NOT NULL DEFAULT '',
  raw_symbol TEXT NOT NULL,
  canonical_symbol TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, provider_id, raw_symbol)
);

CREATE TABLE IF NOT EXISTS app_settings (
  id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mt5_snapshots (
  account_id TEXT PRIMARY KEY,
  positions_json TEXT NOT NULL,
  orders_json TEXT NOT NULL,
  symbols_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_reports (
  id TEXT PRIMARY KEY,
  queue_item_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL,
  retcode INTEGER NOT NULL,
  retcode_external INTEGER NOT NULL,
  broker_comment TEXT NOT NULL,
  order_ticket TEXT,
  deal_ticket TEXT,
  requested_price REAL,
  filled_price REAL,
  volume REAL,
  error_text TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parser_fixtures (
  id TEXT PRIMARY KEY,
  provider_label TEXT NOT NULL,
  raw_message_id TEXT,
  telegram_message_id TEXT,
  message_date TEXT,
  classification TEXT NOT NULL DEFAULT 'unknown',
  raw_text TEXT NOT NULL,
  expected_command_type TEXT NOT NULL,
  expected_symbol TEXT,
  expected_json TEXT NOT NULL DEFAULT '{}',
  redacted INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
