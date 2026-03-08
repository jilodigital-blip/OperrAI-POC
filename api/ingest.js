const OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || '';
const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://qjajoayybuvxvpgysoih.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const INGEST_SECRET     = process.env.INGEST_SECRET     || '';

async function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = await readBody(req);
  const { secret, doc_name, content } = body;

  // Guard with a secret so only you can ingest
  if (!INGEST_SECRET || secret !== INGEST_SECRET) {
    return res.status(401).json({ error: 'Invalid ingest secret' });
  }
  if (!doc_name?.trim() || !content?.trim()) {
    return res.status(400).json({ error: 'doc_name and content are required' });
  }
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
    const err = await embedResp.text();
    return res.status(502).json({ error: `OpenAI error: ${err}` });
  }
  const embedData = await embedResp.json();
  const embedding = embedData.data[0].embedding;

  // Insert into Supabase (documents table must exist — run schema.sql first)
  const sbResp = await fetch(`${SUPABASE_URL}/rest/v1/documents`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify({ doc_name: doc_name.trim(), content: content.trim(), embedding }),
  });
  if (!sbResp.ok) {
    const err = await sbResp.text();
    return res.status(502).json({ error: `Supabase error: ${err}` });
  }
  const saved = await sbResp.json();
  const id = Array.isArray(saved) ? saved[0]?.id : saved?.id;

  return res.status(200).json({ success: true, id, doc_name: doc_name.trim() });
};
