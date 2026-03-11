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

// ── Auth token extraction (httpOnly cookie or Authorization header) ────────────
function extractAuthToken(req) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/(?:^|;\s*)raymidi_auth=([^\s;]+)/);
  if (match) return match[1];
  const authHeader = req.headers['authorization'] || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
}

module.exports = async (req, res) => {
  // Read env vars inside handler to avoid stale module-scope cache on Vercel
  const JWT_SECRET      = process.env.JWT_SECRET      || 'raymidi-poc-secret-change-in-prod';
  const SUPABASE_URL    = process.env.SUPABASE_URL    || '';
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = extractAuthToken(req);
  if (!verifyJWT(token, JWT_SECRET)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // Fetch messages with their ratings joined
    const messages = await supabaseFetch(
      'messages?select=id,question_hash,response_time_ms,sources,created_at,ratings(accuracy_score,accuracy_label)&order=created_at.desc&limit=500',
      SUPABASE_URL,
      SUPABASE_ANON_KEY
    );

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(200).json({
        totalQuestions: 0,
        uniqueQuestions: 0,
        totalResponses: 0,
        avgResponseTimeMs: 0,
        avgAccuracyScore: null,
        accuracyDistribution: { Excellent: 0, Good: 0, Acceptable: 0, Poor: 0 },
        sourceDocs: [],
        recentActivity: [],
      });
    }

    // Aggregate stats
    const totalQuestions = messages.length;
    const uniqueHashes = new Set(messages.map(m => m.question_hash));
    const uniqueQuestions = uniqueHashes.size;

    const avgResponseTimeMs = Math.round(
      messages.reduce((sum, m) => sum + (m.response_time_ms || 0), 0) / totalQuestions
    );

    const ratedMessages = messages.filter(m => m.ratings?.length > 0);
    const avgAccuracyScore = ratedMessages.length > 0
      ? Math.round(
          ratedMessages.reduce((sum, m) => sum + (m.ratings[0]?.accuracy_score || 0), 0) /
          ratedMessages.length * 100
        ) / 100
      : null;

    // Accuracy label distribution
    const distribution = { Excellent: 0, Good: 0, Acceptable: 0, Poor: 0 };
    ratedMessages.forEach(m => {
      const label = m.ratings[0]?.accuracy_label;
      if (label && distribution[label] !== undefined) distribution[label]++;
    });

    // Source documents across all messages
    const docSet = new Set();
    messages.forEach(m => {
      try {
        const sources = typeof m.sources === 'string' ? JSON.parse(m.sources) : (m.sources || []);
        sources.forEach(s => { if (s.doc_name) docSet.add(s.doc_name); });
      } catch { /* ignore */ }
    });

    // Recent activity (last 10 messages, newest first)
    const recentActivity = messages.slice(0, 10).map(m => ({
      id: m.id,
      responseTimeMs: m.response_time_ms,
      accuracyScore: m.ratings?.[0]?.accuracy_score ?? null,
      accuracyLabel: m.ratings?.[0]?.accuracy_label ?? null,
      createdAt: m.created_at,
    }));

    return res.status(200).json({
      totalQuestions,
      uniqueQuestions,
      totalResponses: totalQuestions,
      avgResponseTimeMs,
      avgAccuracyScore,
      accuracyDistribution: distribution,
      sourceDocs: Array.from(docSet),
      recentActivity,
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    return res.status(500).json({ error: 'Failed to load dashboard data' });
  }
};
