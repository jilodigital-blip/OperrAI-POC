-- ============================================================
-- OperrAI POC — Supabase Database Schema  (Part 1 of 2)
-- Run this first in: SQL Editor → New Query
-- Project: [configured via SUPABASE_URL env var]
-- ============================================================

-- Messages: one row per customer question/answer pair
CREATE TABLE IF NOT EXISTS messages (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       TEXT,                         -- browser session identifier
  question         TEXT         NOT NULL,
  question_hash    TEXT         NOT NULL,         -- SHA-256 of normalised question (for dedup)
  response         TEXT         NOT NULL,
  response_time_ms INTEGER      NOT NULL,
  sources          JSONB        NOT NULL DEFAULT '[]',
  -- sources format: [{"doc_name": "Manual.pdf", "relevance_score": 0.91}, ...]
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_hash_idx    ON messages (question_hash);
CREATE INDEX IF NOT EXISTS messages_created_idx ON messages (created_at DESC);

-- Ratings: accuracy assessment by Gemini 2.5 Pro (inserted asynchronously)
CREATE TABLE IF NOT EXISTS ratings (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id       UUID          NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  accuracy_score   NUMERIC(4,2)  NOT NULL CHECK (accuracy_score BETWEEN 0 AND 10),
  accuracy_label   TEXT          NOT NULL CHECK (accuracy_label IN ('Excellent','Good','Acceptable','Poor')),
  rating_rationale TEXT,
  rated_by_model   TEXT          NOT NULL DEFAULT 'gemini-2.5-pro',
  rated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ratings_message_unique ON ratings (message_id);

-- ── Row Level Security ────────────────────────────────────────────────────────
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratings  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon can insert messages" ON messages FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon can select messages" ON messages FOR SELECT TO anon USING (true);
CREATE POLICY "anon can insert ratings"  ON ratings  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon can select ratings"  ON ratings  FOR SELECT TO anon USING (true);

-- ── Channel column ─────────────────────────────────────────────────────────────
ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'chat'
  CHECK (channel IN ('chat', 'email'));

-- ── Service requests ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS service_requests (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  UUID        REFERENCES messages (id) ON DELETE CASCADE,
  ticket_id   TEXT        NOT NULL,
  question    TEXT        NOT NULL,
  channel     TEXT        NOT NULL DEFAULT 'chat',
  status      TEXT        NOT NULL DEFAULT 'open',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE service_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_sr_insert" ON service_requests FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_sr_select" ON service_requests FOR SELECT TO anon USING (true);

-- ── Tester feedbacks ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feedbacks (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  TEXT,                         -- browser session identifier
  rating      SMALLINT    NOT NULL CHECK (rating BETWEEN 1 AND 5),
  category    TEXT        NOT NULL DEFAULT 'general',
  -- category: 'accuracy' | 'speed' | 'ui' | 'general' | 'other'
  comment     TEXT        NOT NULL,
  tester_name TEXT,                         -- optional tester name
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS feedbacks_created_idx ON feedbacks (created_at DESC);

-- ── Client column (multi-tenant feedback isolation) ──────────────────────────
ALTER TABLE feedbacks ADD COLUMN IF NOT EXISTS client TEXT NOT NULL DEFAULT 'ather';
CREATE INDEX IF NOT EXISTS feedbacks_client_idx ON feedbacks (client);

ALTER TABLE feedbacks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon can insert feedbacks" ON feedbacks FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon can select feedbacks" ON feedbacks FOR SELECT TO anon USING (true);

-- ── AI Test Runs ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS test_runs (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              TEXT          NOT NULL UNIQUE,
  session_id          TEXT          NOT NULL,
  total_questions     INTEGER       NOT NULL,
  chat_results        JSONB         NOT NULL DEFAULT '{}',
  email_results       JSONB         NOT NULL DEFAULT '{}',
  overall_confidence  NUMERIC(5,2)  NOT NULL,
  pass_threshold      NUMERIC(5,2)  NOT NULL DEFAULT 80,
  passed              BOOLEAN       NOT NULL,
  duration_ms         INTEGER,
  question_details    JSONB         NOT NULL DEFAULT '[]',
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS test_runs_created_idx ON test_runs (created_at DESC);

ALTER TABLE test_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon can insert test_runs" ON test_runs FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon can select test_runs" ON test_runs FOR SELECT TO anon USING (true);

-- ── Client column (multi-tenant support) ─────────────────────────────────────
ALTER TABLE messages ADD COLUMN IF NOT EXISTS client TEXT NOT NULL DEFAULT 'ather';
CREATE INDEX IF NOT EXISTS messages_client_idx ON messages (client);

-- ── Dashboard view ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW dashboard_summary AS
SELECT
  COUNT(DISTINCT m.id)                                AS total_questions,
  COUNT(DISTINCT m.question_hash)                     AS unique_questions,
  ROUND(AVG(m.response_time_ms))                      AS avg_response_time_ms,
  ROUND(AVG(r.accuracy_score)::NUMERIC, 2)            AS avg_accuracy_score,
  COUNT(r.id)                                         AS rated_count,
  COUNT(CASE WHEN m.channel = 'chat'  THEN 1 END)     AS chat_questions,
  COUNT(CASE WHEN m.channel = 'email' THEN 1 END)     AS email_questions,
  COUNT(DISTINCT sr.id)                               AS blocked_count
FROM messages m
LEFT JOIN ratings          r  ON r.message_id  = m.id
LEFT JOIN service_requests sr ON sr.message_id = m.id;
