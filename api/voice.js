// api/voice.js — Voice Pod: Lead CRUD API
// Voice conversation pipeline moved to voice-relay/ (WebSocket streaming)

const crypto = require('crypto');

// ── JWT & Auth helpers (same pattern as chat.js / admin.js) ─────────────────

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

function extractAuthToken(req) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/(?:^|;\s*)raymidi_auth=([^\s;]+)/);
  if (match) return match[1];
  const authHeader = req.headers['authorization'] || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
}

async function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

// ── Supabase helpers ────────────────────────────────────────────────────────

async function supabaseFetch(path, supabaseUrl, supabaseKey) {
  if (!supabaseKey) return [];
  const resp = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
    },
  });
  if (!resp.ok) return [];
  return resp.json();
}

async function supabaseInsert(table, row, supabaseUrl, supabaseKey) {
  if (!supabaseKey) return null;
  const resp = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return Array.isArray(data) ? data[0] : data;
}

async function supabaseUpdate(table, id, updates, supabaseUrl, supabaseKey) {
  if (!supabaseKey) return null;
  const resp = await fetch(`${supabaseUrl}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(updates),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return Array.isArray(data) ? data[0] : data;
}

// ── Main handler ────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  const SUPABASE_URL      = process.env.SUPABASE_URL      || '';
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
  const JWT_SECRET        = process.env.JWT_SECRET         || '';

  const corsOrigin = process.env.CORS_ORIGIN;
  if (!corsOrigin) return res.status(500).json({ error: 'CORS origin not configured' });
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const token = extractAuthToken(req);
  const claims = verifyJWT(token, JWT_SECRET);
  if (!claims) return res.status(401).json({ error: 'Unauthorized' });

  const clientKey = claims.client && claims.client !== 'admin' ? claims.client : 'ather';
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ── GET: List or Get leads ──────────────────────────────────────────────
  if (req.method === 'GET') {
    const action = url.searchParams.get('action') || 'list';
    const id = url.searchParams.get('id');

    if (action === 'get' && id) {
      const leads = await supabaseFetch(
        `voice_leads?id=eq.${encodeURIComponent(id)}&client=eq.${encodeURIComponent(clientKey)}&limit=1`,
        SUPABASE_URL, SUPABASE_ANON_KEY
      );
      if (!leads.length) return res.status(404).json({ error: 'Lead not found' });
      return res.status(200).json(leads[0]);
    }

    // List leads
    const leads = await supabaseFetch(
      `voice_leads?client=eq.${encodeURIComponent(clientKey)}&order=created_at.desc&limit=100`,
      SUPABASE_URL, SUPABASE_ANON_KEY
    );
    return res.status(200).json({ leads });
  }

  // ── POST: Create, Update, or Converse ─────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body && typeof req.body === 'object' ? req.body : await readBody(req);
  const { action } = body;

  // ── Create lead ────────────────────────────────────────────────────────
  if (action === 'create') {
    const { name, phone, email, product_interest, source, priority } = body;
    if (!name?.trim() || !phone?.trim() || !product_interest?.trim() || !source?.trim()) {
      return res.status(400).json({ error: 'Name, phone, product_interest, and source are required' });
    }

    const lead = await supabaseInsert('voice_leads', {
      client: clientKey,
      name: name.trim(),
      phone: phone.trim(),
      email: (email || '').trim(),
      product_interest: product_interest.trim(),
      source: source.trim(),
      priority: priority || 'medium',
      status: 'new',
      lead_score: 10,
      conversation_history: [],
      turn_count: 0,
      stage: 'welcome',
      session_id: crypto.randomUUID(),
    }, SUPABASE_URL, SUPABASE_ANON_KEY);

    if (!lead) return res.status(500).json({ error: 'Failed to create lead' });
    return res.status(201).json(lead);
  }

  // ── Update lead ────────────────────────────────────────────────────────
  if (action === 'update') {
    const { id, status, lead_score, stage, priority } = body;
    if (!id) return res.status(400).json({ error: 'Lead id is required' });

    const updates = {};
    if (status) updates.status = status;
    if (lead_score !== undefined) updates.lead_score = Math.max(0, Math.min(100, lead_score));
    if (stage) updates.stage = stage;
    if (priority) updates.priority = priority;

    const updated = await supabaseUpdate('voice_leads', id, updates, SUPABASE_URL, SUPABASE_ANON_KEY);
    if (!updated) return res.status(500).json({ error: 'Failed to update lead' });
    return res.status(200).json(updated);
  }

  return res.status(400).json({ error: 'Invalid action. Use: create, update, list, get' });
};
