ALTER TABLE usage_logs ADD COLUMN estimated_cost_usd_new REAL;
UPDATE usage_logs SET estimated_cost_usd_new = estimated_cost_usd;
ALTER TABLE usage_logs DROP COLUMN estimated_cost_usd;
ALTER TABLE usage_logs RENAME COLUMN estimated_cost_usd_new TO estimated_cost_usd;

CREATE TABLE IF NOT EXISTS daily_usage (
  user_id TEXT NOT NULL REFERENCES users(id),
  usage_date TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, usage_date)
);

CREATE TABLE IF NOT EXISTS model_pricing (
  model TEXT PRIMARY KEY,
  input_usd_per_million REAL NOT NULL CHECK (input_usd_per_million >= 0),
  output_usd_per_million REAL NOT NULL CHECK (output_usd_per_million >= 0),
  updated_at TEXT NOT NULL
);
