-- ============================================================
-- OperrAI POC — Supabase Database Schema
-- Run this in your Supabase project: SQL Editor → New Query
-- Project: https://qjajoayybuvxvpgysoih.supabase.co
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

-- Ratings: accuracy assessment by Claude Opus 4.6 (inserted asynchronously)
CREATE TABLE IF NOT EXISTS ratings (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id       UUID          NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  accuracy_score   NUMERIC(4,2)  NOT NULL CHECK (accuracy_score BETWEEN 0 AND 10),
  accuracy_label   TEXT          NOT NULL CHECK (accuracy_label IN ('Excellent','Good','Acceptable','Poor')),
  rating_rationale TEXT,
  rated_by_model   TEXT          NOT NULL DEFAULT 'claude-opus-4-6',
  rated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ratings_message_unique ON ratings (message_id);

-- ── Row Level Security ────────────────────────────────────────────────────────
-- The anon key used by the Vercel functions has INSERT + SELECT access.
-- Enable RLS and add policies so the anon role can read/write these tables.

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratings  ENABLE ROW LEVEL SECURITY;

-- Allow the anon role (used by SUPABASE_ANON_KEY) to insert + select messages
CREATE POLICY "anon can insert messages"
  ON messages FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "anon can select messages"
  ON messages FOR SELECT TO anon USING (true);

-- Allow the anon role to insert + select ratings
CREATE POLICY "anon can insert ratings"
  ON ratings FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "anon can select ratings"
  ON ratings FOR SELECT TO anon USING (true);

-- ── Convenience view (optional, for direct SQL inspection) ────────────────────
CREATE OR REPLACE VIEW dashboard_summary AS
SELECT
  COUNT(DISTINCT m.id)                           AS total_questions,
  COUNT(DISTINCT m.question_hash)                AS unique_questions,
  ROUND(AVG(m.response_time_ms))                 AS avg_response_time_ms,
  ROUND(AVG(r.accuracy_score)::NUMERIC, 2)       AS avg_accuracy_score,
  COUNT(r.id)                                    AS rated_count
FROM messages m
LEFT JOIN ratings r ON r.message_id = m.id;
