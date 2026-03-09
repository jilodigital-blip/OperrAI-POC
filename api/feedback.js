const crypto = require('crypto');

function verifyJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const sig = crypto
      .createHmac('sha256', secret)
      .update(`${parts[0]}.${parts[1]}`)
      .digest('base64')
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    if (sig !== parts[2]) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

async function supabaseRequest(path, method, body, supabaseUrl, supabaseKey) {
  if (!supabaseKey) throw new Error('Supabase not configured');
  const opts = {
    method,
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : '',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${supabaseUrl}/rest/v1/${path}`, opts);
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Supabase error ${resp.status}: ${errText}`);
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

module.exports = async (req, res) => {
  const JWT_SECRET        = process.env.JWT_SECRET        || 'operrai-poc-secret-change-in-prod';
  const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://qjajoayybuvxvpgysoih.supabase.co';
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Verify JWT (required for both POST and GET)
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const claims = verifyJWT(token, JWT_SECRET);
  if (!claims) return res.status(401).json({ error: 'Unauthorized' });

  // ── POST /api/feedback — submit feedback ──────────────────────────────────
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    const { rating, category = 'general', comment, testerName, sessionId } = parsed;

    if (!rating || typeof rating !== 'number' || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'rating must be an integer between 1 and 5' });
    }
    if (!comment || typeof comment !== 'string' || comment.trim().length === 0) {
      return res.status(400).json({ error: 'comment is required' });
    }

    const VALID_CATEGORIES = ['accuracy', 'speed', 'ui', 'general', 'other'];
    const safeCategory = VALID_CATEGORIES.includes(category) ? category : 'general';

    try {
      const rows = await supabaseRequest(
        'feedbacks',
        'POST',
        {
          session_id:  sessionId  || null,
          rating:      Math.round(rating),
          category:    safeCategory,
          comment:     comment.trim().slice(0, 2000),
          tester_name: (testerName || '').trim().slice(0, 100) || null,
        },
        SUPABASE_URL,
        SUPABASE_ANON_KEY
      );

      const saved = Array.isArray(rows) ? rows[0] : rows;
      return res.status(201).json({ success: true, id: saved?.id });

    } catch (err) {
      console.error('Feedback POST error:', err);
      return res.status(500).json({ error: 'Failed to save feedback' });
    }
  }

  // ── GET /api/feedback — admin-only: list all feedbacks ───────────────────
  if (req.method === 'GET') {
    if (claims.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    try {
      const rows = await supabaseRequest(
        'feedbacks?select=*&order=created_at.desc&limit=200',
        'GET',
        null,
        SUPABASE_URL,
        SUPABASE_ANON_KEY
      );

      return res.status(200).json({ feedbacks: Array.isArray(rows) ? rows : [] });

    } catch (err) {
      console.error('Feedback GET error:', err);
      return res.status(500).json({ error: 'Failed to load feedbacks' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
