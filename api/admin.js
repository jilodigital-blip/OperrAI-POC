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

module.exports = async (req, res) => {
  const JWT_SECRET        = process.env.JWT_SECRET        || 'raymidi-poc-secret-change-in-prod';
  const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://qjajoayybuvxvpgysoih.supabase.co';
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Verify JWT and require admin role
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const claims = verifyJWT(token, JWT_SECRET);
  if (!claims) return res.status(401).json({ error: 'Unauthorized' });
  if (claims.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

  try {
    // Fetch messages with ratings, including channel and session_id
    const messages = await supabaseFetch(
      'messages?select=id,session_id,question,channel,response,response_time_ms,sources,created_at,ratings(accuracy_score,accuracy_label,rating_rationale)&order=created_at.desc&limit=500',
      SUPABASE_URL,
      SUPABASE_ANON_KEY
    );

    // Fetch service requests (escalated tickets)
    const serviceRequests = await supabaseFetch(
      'service_requests?select=*&order=created_at.desc&limit=100',
      SUPABASE_URL,
      SUPABASE_ANON_KEY
    );

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(200).json({
        overview: {
          totalMessages: 0,
          chatMessages: 0,
          emailMessages: 0,
          blockedMessages: 0,
          avgAccuracyScore: null,
          avgResponseTimeMs: 0,
        },
        accuracyDistribution: { Excellent: 0, Good: 0, Acceptable: 0, Poor: 0 },
        sourceDocs: [],
        serviceRequests: [],
        recentMessages: [],
      });
    }

    // Overview aggregation
    const totalMessages   = messages.length;
    const chatMessages    = messages.filter(m => m.channel === 'chat').length;
    const emailMessages   = messages.filter(m => m.channel === 'email').length;
    const blockedMessages = messages.filter(m => m.response === '[BLOCKED]').length;

    const avgResponseTimeMs = Math.round(
      messages.reduce((sum, m) => sum + (m.response_time_ms || 0), 0) / totalMessages
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

    // Source documents
    const docSet = new Set();
    messages.forEach(m => {
      try {
        const sources = typeof m.sources === 'string' ? JSON.parse(m.sources) : (m.sources || []);
        sources.forEach(s => { if (s.doc_name) docSet.add(s.doc_name); });
      } catch { /* ignore */ }
    });

    // Recent messages for the log table (last 100, newest first)
    const recentMessages = messages.slice(0, 100).map(m => ({
      id:             m.id,
      sessionId:      m.session_id,
      question:       m.question,
      response:       m.response,
      channel:        m.channel || 'chat',
      responseTimeMs: m.response_time_ms,
      accuracyScore:     m.ratings?.[0]?.accuracy_score     ?? null,
      accuracyLabel:     m.ratings?.[0]?.accuracy_label     ?? null,
      ratingRationale:   m.ratings?.[0]?.rating_rationale   ?? null,
      createdAt:         m.created_at,
    }));

    return res.status(200).json({
      overview: {
        totalMessages,
        chatMessages,
        emailMessages,
        blockedMessages,
        avgAccuracyScore,
        avgResponseTimeMs,
      },
      accuracyDistribution: distribution,
      sourceDocs: Array.from(docSet),
      serviceRequests: Array.isArray(serviceRequests) ? serviceRequests : [],
      recentMessages,
    });

  } catch (err) {
    console.error('Admin endpoint error:', err);
    return res.status(500).json({ error: 'Failed to load admin data' });
  }
};
