const crypto = require('crypto');

// ── Bundled FAQ fallback ─────────────────────────────────────────────────────
const BUNDLED_FAQS = {};
try { BUNDLED_FAQS.ather = require('../ingest/faqs-ather.json'); } catch { BUNDLED_FAQS.ather = []; }
try { BUNDLED_FAQS.apb   = require('../ingest/faqs-apb.json');   } catch { BUNDLED_FAQS.apb   = []; }

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

// ── Extract questions from FAQ entries (handles both formats) ────────────────
function extractQuestions(faqs) {
  const questions = [];
  faqs.forEach(faq => {
    // APB local format: direct "question" field
    if (faq.question) {
      const q = faq.question.trim();
      if (q) questions.push(q);
      return;
    }
    // Ather / Supabase format: "content" field with embedded "Question: ..." lines
    if (faq.content) {
      const matches = faq.content.match(/Question:\s*(.+?)(?:\n|$)/g);
      if (matches) {
        matches.forEach(m => {
          const q = m.replace(/^Question:\s*/, '').trim();
          if (q) questions.push(q);
        });
      }
    }
  });
  return questions;
}

module.exports = async (req, res) => {
  const JWT_SECRET        = process.env.JWT_SECRET        || '';
  const SUPABASE_URL      = process.env.SUPABASE_URL      || '';
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

  const corsOrigin = process.env.CORS_ORIGIN;
  if (!corsOrigin) return res.status(500).json({ error: 'CORS origin not configured' });
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Verify JWT — any authenticated user (admin or demo) may fetch FAQ questions
  const token = extractAuthToken(req);
  const claims = verifyJWT(token, JWT_SECRET);
  if (!claims) return res.status(401).json({ error: 'Unauthorized' });

  const clientKey = (req.query?.client || 'ather').toLowerCase();
  if (!['ather', 'apb'].includes(clientKey)) {
    return res.status(400).json({ error: 'Invalid client' });
  }

  try {
    let questions = [];

    if (clientKey === 'apb') {
      // APB: primary source is Supabase documents_apb table
      const rows = await supabaseFetch(
        'documents_apb?select=content',
        SUPABASE_URL,
        SUPABASE_ANON_KEY
      );
      if (Array.isArray(rows) && rows.length > 0) {
        questions = extractQuestions(rows);
      }
      // Fallback to bundled JSON if Supabase returned nothing
      if (questions.length === 0 && BUNDLED_FAQS.apb.length > 0) {
        questions = extractQuestions(BUNDLED_FAQS.apb);
      }
    } else {
      // Ather: use bundled JSON file
      questions = extractQuestions(BUNDLED_FAQS.ather);
    }

    return res.status(200).json({ questions });
  } catch (err) {
    console.error('faq-questions error:', err);
    // On error, attempt bundled fallback
    const fallback = extractQuestions(BUNDLED_FAQS[clientKey] || []);
    return res.status(200).json({ questions: fallback });
  }
};
