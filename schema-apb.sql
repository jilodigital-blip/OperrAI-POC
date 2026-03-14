-- ============================================================
-- APB POC — Separate Tables (mirrors Ather tables with _apb suffix)
-- Run this in Supabase SQL Editor → New Query
-- This creates isolated tables for Airtel Payments Bank data
-- ============================================================

-- ── Messages ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages_apb (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       TEXT,
  question         TEXT         NOT NULL,
  question_hash    TEXT         NOT NULL,
  response         TEXT         NOT NULL,
  response_time_ms INTEGER      NOT NULL,
  sources          JSONB        NOT NULL DEFAULT '[]',
  channel          TEXT         NOT NULL DEFAULT 'chat' CHECK (channel IN ('chat', 'email')),
  client           TEXT         NOT NULL DEFAULT 'apb',
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_apb_hash_idx    ON messages_apb (question_hash);
CREATE INDEX IF NOT EXISTS messages_apb_created_idx ON messages_apb (created_at DESC);
CREATE INDEX IF NOT EXISTS messages_apb_client_idx  ON messages_apb (client);

ALTER TABLE messages_apb ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon can insert messages_apb" ON messages_apb FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon can select messages_apb" ON messages_apb FOR SELECT TO anon USING (true);

-- ── Ratings ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ratings_apb (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id       UUID          NOT NULL REFERENCES messages_apb (id) ON DELETE CASCADE,
  accuracy_score   NUMERIC(4,2)  NOT NULL CHECK (accuracy_score BETWEEN 0 AND 10),
  accuracy_label   TEXT          NOT NULL CHECK (accuracy_label IN ('Excellent','Good','Acceptable','Poor')),
  rating_rationale TEXT,
  rated_by_model   TEXT          NOT NULL DEFAULT 'gemini-2.5-pro',
  rated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ratings_apb_message_unique ON ratings_apb (message_id);

ALTER TABLE ratings_apb ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon can insert ratings_apb" ON ratings_apb FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon can select ratings_apb" ON ratings_apb FOR SELECT TO anon USING (true);

-- ── Service Requests ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS service_requests_apb (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  UUID        REFERENCES messages_apb (id) ON DELETE CASCADE,
  ticket_id   TEXT        NOT NULL,
  question    TEXT        NOT NULL,
  channel     TEXT        NOT NULL DEFAULT 'chat',
  status      TEXT        NOT NULL DEFAULT 'open',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE service_requests_apb ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_sr_apb_insert" ON service_requests_apb FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_sr_apb_select" ON service_requests_apb FOR SELECT TO anon USING (true);

-- ── Feedbacks ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feedbacks_apb (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  TEXT,
  rating      SMALLINT    NOT NULL CHECK (rating BETWEEN 1 AND 5),
  category    TEXT        NOT NULL DEFAULT 'general',
  comment     TEXT        NOT NULL,
  tester_name TEXT,
  client      TEXT        NOT NULL DEFAULT 'apb',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS feedbacks_apb_created_idx ON feedbacks_apb (created_at DESC);
CREATE INDEX IF NOT EXISTS feedbacks_apb_client_idx  ON feedbacks_apb (client);

ALTER TABLE feedbacks_apb ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon can insert feedbacks_apb" ON feedbacks_apb FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon can select feedbacks_apb" ON feedbacks_apb FOR SELECT TO anon USING (true);

-- ── Test Runs ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS test_runs_apb (
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

CREATE INDEX IF NOT EXISTS test_runs_apb_created_idx ON test_runs_apb (created_at DESC);

ALTER TABLE test_runs_apb ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon can insert test_runs_apb" ON test_runs_apb FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon can select test_runs_apb" ON test_runs_apb FOR SELECT TO anon USING (true);

-- ── Voice Leads ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS voice_leads_apb (
  id                    UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  client                TEXT         NOT NULL DEFAULT 'apb',
  name                  TEXT         NOT NULL,
  phone                 TEXT         NOT NULL,
  email                 TEXT         DEFAULT '',
  product_interest      TEXT         NOT NULL,
  source                TEXT         NOT NULL,
  priority              TEXT         NOT NULL DEFAULT 'medium',
  status                TEXT         NOT NULL DEFAULT 'new',
  lead_score            INT          NOT NULL DEFAULT 10,
  conversation_history  JSONB        DEFAULT '[]'::jsonb,
  turn_count            INT          DEFAULT 0,
  stage                 TEXT         DEFAULT 'welcome',
  session_id            TEXT,
  created_at            TIMESTAMPTZ  DEFAULT now(),
  updated_at            TIMESTAMPTZ  DEFAULT now()
);

ALTER TABLE voice_leads_apb ENABLE ROW LEVEL SECURITY;
CREATE POLICY "voice_leads_apb_select" ON voice_leads_apb FOR SELECT USING (true);
CREATE POLICY "voice_leads_apb_insert" ON voice_leads_apb FOR INSERT WITH CHECK (true);
CREATE POLICY "voice_leads_apb_update" ON voice_leads_apb FOR UPDATE USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_voice_leads_apb_client_created ON voice_leads_apb(client, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_leads_apb_status ON voice_leads_apb(status);

CREATE OR REPLACE FUNCTION update_voice_leads_apb_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER voice_leads_apb_updated_at
  BEFORE UPDATE ON voice_leads_apb
  FOR EACH ROW
  EXECUTE FUNCTION update_voice_leads_apb_updated_at();

-- ── Dashboard Summary View (APB) ────────────────────────────────────────────
CREATE OR REPLACE VIEW dashboard_summary_apb AS
SELECT
  COUNT(DISTINCT m.id)                                AS total_questions,
  COUNT(DISTINCT m.question_hash)                     AS unique_questions,
  ROUND(AVG(m.response_time_ms))                      AS avg_response_time_ms,
  ROUND(AVG(r.accuracy_score)::NUMERIC, 2)            AS avg_accuracy_score,
  COUNT(r.id)                                         AS rated_count,
  COUNT(CASE WHEN m.channel = 'chat'  THEN 1 END)     AS chat_questions,
  COUNT(CASE WHEN m.channel = 'email' THEN 1 END)     AS email_questions,
  COUNT(DISTINCT sr.id)                               AS blocked_count
FROM messages_apb m
LEFT JOIN ratings_apb          r  ON r.message_id  = m.id
LEFT JOIN service_requests_apb sr ON sr.message_id = m.id;
