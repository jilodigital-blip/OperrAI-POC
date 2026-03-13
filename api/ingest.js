async function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = async (req, res) => {
  const OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || '';
  const SUPABASE_URL      = process.env.SUPABASE_URL      || '';
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
  const INGEST_SECRET     = process.env.INGEST_SECRET     || '';

  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Vercel pre-parses JSON bodies onto req.body; fall back to manual read
  const body = req.body && typeof req.body === 'object' ? req.body : await readBody(req);
  const { secret, doc_id, doc_name, content, client } = body;

  // Guard with a secret so only you can ingest
  if (!INGEST_SECRET || secret !== INGEST_SECRET) {
    return res.status(401).json({ error: 'Invalid ingest secret' });
  }
  if (!doc_name?.trim() || !content?.trim()) {
    return res.status(400).json({ error: 'doc_name and content are required' });
  }

  // Validate client against allowlist — defaults to 'ather'
  const VALID_CLIENTS = ['ather', 'apb'];
  const safeClient = VALID_CLIENTS.includes(client) ? client : 'ather';

  // Use provided doc_id or generate a slug from doc_name for upsert deduplication
  const stableDocId = (doc_id?.trim()) ||
    doc_name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
  if (!SUPABASE_ANON_KEY) return res.status(500).json({ error: 'SUPABASE_ANON_KEY not configured' });

  // Generate embedding
  const embedResp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: content.trim() }),
  });
  if (!embedResp.ok) {
    return res.status(502).json({ error: 'Embedding service error. Please try again.' });
  }
  const embedData = await embedResp.json();
  const embedding = embedData.data[0].embedding;

  // Upsert into client-specific table — on_conflict=doc_id prevents duplicates when re-ingesting
  const tableName = safeClient === 'apb' ? 'documents_apb' : 'documents';
  const sbResp = await fetch(`${SUPABASE_URL}/rest/v1/${tableName}?on_conflict=doc_id`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify({ doc_id: stableDocId, doc_name: doc_name.trim(), content: content.trim(), embedding }),
  });
  if (!sbResp.ok) {
    return res.status(502).json({ error: 'Database error. Please try again.' });
  }
  const saved = await sbResp.json();
  const id = Array.isArray(saved) ? saved[0]?.id : saved?.id;

  return res.status(200).json({ success: true, id, doc_id: stableDocId, doc_name: doc_name.trim(), client: safeClient });
};
