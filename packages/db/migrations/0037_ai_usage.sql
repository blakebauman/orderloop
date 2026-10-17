-- Model tokens each person's assistant conversations used, per UTC day (apps/engine/src/usage.ts),
-- held against ASSISTANT_DAILY_TOKENS. Days older than 90 are dropped by the retention sweep.
CREATE TABLE ai_usage (
  principal_id TEXT NOT NULL,
  day TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (principal_id, day)
);
CREATE INDEX ai_usage_day ON ai_usage(day);
