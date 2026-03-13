-- ============================================================
-- OperrAI POC — Vector Knowledge Base  (Part 2 of 2)
-- Run this AFTER Part 1 in: SQL Editor → New Query
--
-- IMPORTANT: Enable the pgvector extension first:
--   Dashboard → Database → Extensions → search "vector" → Enable
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
  id         BIGSERIAL    PRIMARY KEY,
  doc_id     TEXT         UNIQUE,              -- stable slug for upsert deduplication
  content    TEXT         NOT NULL,
  metadata   JSONB,
  embedding  vector(1536) NOT NULL,            -- text-embedding-3-small produces 1536-dim vectors
  doc_name   TEXT,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- If upgrading an existing table (skip if creating fresh):
-- ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_id TEXT;
-- CREATE UNIQUE INDEX IF NOT EXISTS documents_doc_id_idx ON documents (doc_id) WHERE doc_id IS NOT NULL;

-- HNSW index for fast approximate nearest-neighbour search
CREATE INDEX IF NOT EXISTS documents_embedding_idx
  ON documents USING hnsw (embedding vector_cosine_ops);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon can insert documents" ON documents FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon can select documents" ON documents FOR SELECT TO anon USING (true);

-- ── Client column (multi-tenant knowledge base isolation) ────────────────────
ALTER TABLE documents ADD COLUMN IF NOT EXISTS client TEXT NOT NULL DEFAULT 'ather';
CREATE INDEX IF NOT EXISTS documents_client_idx ON documents (client);

-- RPC function used by /api/chat for RAG retrieval
-- client_key param filters by tenant; NULL returns all documents (backward compatible)
CREATE OR REPLACE FUNCTION match_documents(
  query_embedding vector(1536),
  match_count     int  DEFAULT 5,
  client_key      text DEFAULT NULL
)
RETURNS TABLE (id bigint, doc_id text, doc_name text, content text, metadata jsonb, similarity float)
LANGUAGE sql STABLE
AS $$
  SELECT id, doc_id, doc_name, content, metadata, 1 - (embedding <=> query_embedding) AS similarity
  FROM documents
  WHERE (client_key IS NULL OR client = client_key)
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
