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

-- ── Channel column (added for chat vs email tracking) ─────────────────────────
ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'chat'
  CHECK (channel IN ('chat', 'email'));

-- ── Service requests: created when L2 Supervisor rates a response "Poor" ───────
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

-- ── Update rated_by_model default (now Gemini 2.5 Pro) ────────────────────────
ALTER TABLE ratings ALTER COLUMN rated_by_model SET DEFAULT 'gemini-2.5-pro';

-- ── Convenience view (optional, for direct SQL inspection) ────────────────────
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

-- ── Vector knowledge base (RAG documents) ─────────────────────────────────────
-- Requires the pgvector extension. Enable it first in Supabase:
-- Dashboard → Database → Extensions → search "vector" → Enable

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
  id         BIGSERIAL   PRIMARY KEY,
  doc_name   TEXT        NOT NULL,
  content    TEXT        NOT NULL,
  embedding  vector(1536) NOT NULL,  -- text-embedding-3-small produces 1536-dim vectors
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- HNSW index for fast approximate nearest-neighbour search
CREATE INDEX IF NOT EXISTS documents_embedding_idx
  ON documents USING hnsw (embedding vector_cosine_ops);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon can insert documents"
  ON documents FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "anon can select documents"
  ON documents FOR SELECT TO anon USING (true);

-- RPC function used by /api/chat for RAG retrieval
CREATE OR REPLACE FUNCTION match_documents(
  query_embedding vector(1536),
  match_count     int DEFAULT 5
)
RETURNS TABLE (
  id         bigint,
  doc_name   text,
  content    text,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    id,
    doc_name,
    content,
    1 - (embedding <=> query_embedding) AS similarity
  FROM documents
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
