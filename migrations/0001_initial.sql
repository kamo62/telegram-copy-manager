-- Historical bootstrap snapshot, not the current runtime schema.
-- The runtime schema is created by AppStore in apps/api/src/app.ts and includes
-- newer tables and columns. Keep this file labelled stale until a complete D1 migration is generated.
-- A partial refresh would falsely present an incomplete schema as deployable.

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
  provider_config_json TEXT NOT NULL DEFAULT '{}',
  last_message_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_config_history (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL
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

CREATE INDEX IF NOT EXISTS idx_logical_trades_account_provider_created
  ON logical_trades(account_id, provider_id, status, created_at);

CREATE TABLE IF NOT EXISTS queue_items (
  id TEXT PRIMARY KEY,
  parsed_signal_id TEXT NOT NULL,
  logical_trade_id TEXT,
  account_id TEXT,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  lease_count INTEGER NOT NULL DEFAULT 0,
  leased_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mt5_accounts (
  id TEXT PRIMARY KEY,
  account_number TEXT NOT NULL,
  nickname TEXT,
  server TEXT NOT NULL,
  company TEXT NOT NULL,
  currency TEXT NOT NULL,
  balance REAL NOT NULL,
  equity REAL NOT NULL,
  initial_balance REAL NOT NULL DEFAULT 0,
  margin_mode TEXT NOT NULL,
  heartbeat_status TEXT NOT NULL,
  available_symbols_json TEXT NOT NULL,
  ea_version TEXT,
  ea_capabilities_json TEXT NOT NULL DEFAULT '[]',
  last_heartbeat_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_slots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  link_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  account_id TEXT,
  account_number TEXT,
  server TEXT,
  broker TEXT,
  currency TEXT,
  balance REAL,
  equity REAL,
  last_heartbeat_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_provider_links (
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, provider_id)
);

CREATE TABLE IF NOT EXISTS equity_guardians (
  account_id TEXT PRIMARY KEY,
  threshold REAL NOT NULL,
  current_drawdown REAL NOT NULL,
  paused INTEGER NOT NULL,
  breach_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
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

CREATE TABLE IF NOT EXISTS app_secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mt5_snapshots (
  account_id TEXT PRIMARY KEY,
  positions_json TEXT NOT NULL,
  orders_json TEXT NOT NULL,
  symbols_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS equity_curve_points (
  scope TEXT NOT NULL,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL DEFAULT '',
  bucket_start TEXT NOT NULL,
  open_value REAL NOT NULL,
  high_value REAL NOT NULL,
  low_value REAL NOT NULL,
  close_value REAL NOT NULL,
  balance REAL,
  broker_profit REAL,
  external_floating_pnl REAL,
  realized_pnl REAL,
  floating_pnl REAL,
  net_pnl REAL,
  drawdown_amount REAL NOT NULL DEFAULT 0,
  drawdown_pct REAL NOT NULL DEFAULT 0,
  sample_count INTEGER NOT NULL DEFAULT 1,
  open_trade_ids_json TEXT NOT NULL DEFAULT '[]',
  position_tickets_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, account_id, provider_id, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_equity_curve_points_scope_account_time
  ON equity_curve_points(scope, account_id, provider_id, bucket_start DESC);

CREATE TABLE IF NOT EXISTS equity_curve_state (
  scope TEXT NOT NULL,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL DEFAULT '',
  peak_value REAL NOT NULL,
  latest_value REAL NOT NULL,
  max_drawdown_amount REAL NOT NULL,
  max_drawdown_pct REAL NOT NULL,
  max_drawdown_at TEXT,
  contributor_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, account_id, provider_id)
);

CREATE TABLE IF NOT EXISTS drawdown_events (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL DEFAULT '',
  sampled_at TEXT NOT NULL,
  value REAL NOT NULL,
  peak_value REAL NOT NULL,
  drawdown_amount REAL NOT NULL,
  drawdown_pct REAL NOT NULL,
  contributor_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_drawdown_events_scope_account_time
  ON drawdown_events(scope, account_id, provider_id, sampled_at DESC);

CREATE TABLE IF NOT EXISTS execution_reports (
  id TEXT PRIMARY KEY,
  queue_item_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL,
  retcode INTEGER NOT NULL,
  retcode_external INTEGER NOT NULL,
  broker_comment TEXT NOT NULL,
  order_ticket TEXT,
  position_ticket TEXT,
  deal_ticket TEXT,
  requested_price REAL,
  filled_price REAL,
  volume REAL,
  requested_volume REAL,
  filled_volume REAL,
  remaining_volume REAL,
  error_text TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_execution_reports_created
  ON execution_reports(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_execution_reports_account_created
  ON execution_reports(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS broker_orders (
  id TEXT PRIMARY KEY,
  logical_trade_id TEXT NOT NULL,
  leg_id TEXT NOT NULL,
  action TEXT NOT NULL,
  queue_item_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  order_ticket TEXT,
  position_ticket TEXT,
  deal_ticket TEXT,
  requested_volume REAL,
  filled_volume REAL,
  requested_price REAL,
  filled_price REAL,
  retcode INTEGER NOT NULL,
  retcode_external INTEGER NOT NULL,
  broker_comment TEXT NOT NULL,
  pnl_currency REAL,
  pnl_pips REAL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_broker_orders_deal_ticket ON broker_orders(deal_ticket);
CREATE INDEX IF NOT EXISTS idx_broker_orders_account_created ON broker_orders(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_broker_orders_trade_created ON broker_orders(logical_trade_id, created_at);
CREATE INDEX IF NOT EXISTS idx_broker_orders_position_created ON broker_orders(position_ticket, created_at);
CREATE INDEX IF NOT EXISTS idx_broker_orders_order_created ON broker_orders(order_ticket, created_at);

CREATE TABLE IF NOT EXISTS external_closes (
  account_id TEXT NOT NULL,
  position_ticket TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  volume REAL,
  open_price REAL,
  open_at TEXT,
  open_deal_ticket TEXT,
  close_price REAL,
  close_at TEXT,
  close_deal_ticket TEXT,
  pnl_currency REAL,
  pnl_pips REAL,
  source TEXT,
  magic INTEGER NOT NULL DEFAULT 0,
  comment TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, position_ticket)
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

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_id
  ON audit_logs(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_event_created_id
  ON audit_logs(event_type, created_at DESC, id DESC);
