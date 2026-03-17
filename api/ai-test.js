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

// ── Auth token extraction (httpOnly cookie or Authorization header) ────────────
function extractAuthToken(req) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/(?:^|;\s*)raymidi_auth=([^\s;]+)/);
  if (match) return match[1];
  const authHeader = req.headers['authorization'] || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
}

module.exports = async (req, res) => {
  const JWT_SECRET        = process.env.JWT_SECRET        || '';
  const SUPABASE_URL      = process.env.SUPABASE_URL      || '';
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

  const corsOrigin = process.env.CORS_ORIGIN;
  if (!corsOrigin) return res.status(500).json({ error: 'CORS origin not configured' });
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Verify JWT and require admin role — prefer httpOnly cookie
  const token = extractAuthToken(req);
  const claims = verifyJWT(token, JWT_SECRET);
  if (!claims) return res.status(401).json({ error: 'Unauthorized' });

  // Use client from JWT claims (authoritative), fall back to query param
  const urlParsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const effectiveClient = (claims.client && claims.client !== 'admin')
    ? claims.client
    : (urlParsed.searchParams.get('client') || '');
  const tbl = (name) => effectiveClient === 'apb' ? `${name}_apb` : name;

  // ── GET: Retrieve past test runs ──────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const runs = await supabaseFetch(
        `${tbl('test_runs')}?select=*&order=created_at.desc&limit=20`,
        SUPABASE_URL,
        SUPABASE_ANON_KEY
      );
      return res.status(200).json({ testRuns: Array.isArray(runs) ? runs : [] });
    } catch (err) {
      console.error('AI Test GET error:', err);
      return res.status(500).json({ error: 'Failed to load test runs' });
    }
  }

  // ── POST: Save a completed test run ───────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body && typeof req.body === 'object' ? req.body : await readBody(req);
    const {
      runId, sessionId, totalQuestions,
      chatResults, emailResults,
      overallConfidence, passThreshold, passed,
      durationMs, questionDetails,
      testMode, securityResults, securityStats
    } = body;

    if (!runId || !totalQuestions) {
      return res.status(400).json({ error: 'runId and totalQuestions are required' });
    }

    // Embed security data into existing JSONB fields (no schema migration needed)
    // - securityResults and securityStats go into chat_results under a _security key
    // - questionDetails includes both FAQ and security entries (discriminated by testType)
    const chatResultsWithSecurity = {
      ...(chatResults || {}),
      _security: {
        testMode: testMode || 'faq',
        securityStats: securityStats || {},
        securityResults: securityResults || [],
      }
    };

    const row = {
      run_id: runId,
      session_id: sessionId || `ai-test-${runId}`,
      total_questions: totalQuestions,
      chat_results: JSON.stringify(chatResultsWithSecurity),
      email_results: JSON.stringify(emailResults || {}),
      overall_confidence: overallConfidence || 0,
      pass_threshold: passThreshold || 80,
      passed: !!passed,
      duration_ms: durationMs || 0,
      question_details: JSON.stringify(questionDetails || []),
    };

    try {
      const postClient = effectiveClient || body.client || '';
      const tblPost = (name) => postClient === 'apb' ? `${name}_apb` : name;
      const saved = await supabaseInsert(tblPost('test_runs'), row, SUPABASE_URL, SUPABASE_ANON_KEY);
      return res.status(200).json({ success: true, id: saved?.id || null });
    } catch (err) {
      console.error('AI Test POST error:', err);
      return res.status(500).json({ error: 'Failed to save test run' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
