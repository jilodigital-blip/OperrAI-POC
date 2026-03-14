-- ============================================================
-- Voice Pod: Lead Management Table
-- Run in Supabase SQL Editor → New Query
-- ============================================================

CREATE TABLE IF NOT EXISTS voice_leads (
  id                    UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  client                TEXT         NOT NULL DEFAULT 'ather',
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

-- Row Level Security
ALTER TABLE voice_leads ENABLE ROW LEVEL SECURITY;

-- POC-level policies (tighten for production with proper user-based policies)
CREATE POLICY "voice_leads_select" ON voice_leads FOR SELECT USING (true);
CREATE POLICY "voice_leads_insert" ON voice_leads FOR INSERT WITH CHECK (true);
CREATE POLICY "voice_leads_update" ON voice_leads FOR UPDATE USING (true) WITH CHECK (true);

-- Indexes for fast listing
CREATE INDEX IF NOT EXISTS idx_voice_leads_client_created ON voice_leads(client, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_leads_status ON voice_leads(status);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_voice_leads_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER voice_leads_updated_at
  BEFORE UPDATE ON voice_leads
  FOR EACH ROW
  EXECUTE FUNCTION update_voice_leads_updated_at();
