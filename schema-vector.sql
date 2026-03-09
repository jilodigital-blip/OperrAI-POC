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
  content    TEXT         NOT NULL,
  metadata   JSONB,
  embedding  vector(1536) NOT NULL,  -- text-embedding-3-small produces 1536-dim vectors
  doc_name   TEXT,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- HNSW index for fast approximate nearest-neighbour search
CREATE INDEX IF NOT EXISTS documents_embedding_idx
  ON documents USING hnsw (embedding vector_cosine_ops);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon can insert documents" ON documents FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon can select documents" ON documents FOR SELECT TO anon USING (true);

-- RPC function used by /api/chat for RAG retrieval
CREATE OR REPLACE FUNCTION match_documents(
  query_embedding vector(1536),
  match_count     int DEFAULT 5
)
RETURNS TABLE (id bigint, doc_name text, content text, metadata jsonb, similarity float)
LANGUAGE sql STABLE
AS $$
  SELECT id, doc_name, content, metadata, 1 - (embedding <=> query_embedding) AS similarity
  FROM documents
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
