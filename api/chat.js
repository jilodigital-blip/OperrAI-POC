const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'operrai-poc-secret-change-in-prod';
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qjajoayybuvxvpgysoih.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

// ── JWT helpers ────────────────────────────────────────────────────────────────

function verifyJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const sig = crypto
      .createHmac('sha256', JWT_SECRET)
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

// ── Body parsing ───────────────────────────────────────────────────────────────

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

// ── Supabase REST helper ───────────────────────────────────────────────────────

async function supabaseInsert(table, row) {
  if (!SUPABASE_ANON_KEY) return null;
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return Array.isArray(data) ? data[0] : data;
}

async function supabasePatch(table, id, row) {
  if (!SUPABASE_ANON_KEY) return;
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(row),
  });
}

// ── n8n call ───────────────────────────────────────────────────────────────────

async function callN8N(question, sessionId) {
  const resp = await fetch(N8N_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, sessionId }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`n8n returned ${resp.status}`);
  return await resp.json();
  // Expected: { answer: string, sources: [{doc_name, relevance_score}] }
}

// ── Claude direct fallback (when n8n not configured) ──────────────────────────

async function callClaudeDirect(question) {
  if (!ANTHROPIC_API_KEY) {
    return {
      answer: "The AI service is not yet configured. Please set up n8n or provide an Anthropic API key.",
      sources: [],
    };
  }
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: `You are a helpful customer support agent for an EV scooter manufacturer in India.
Answer questions about EV scooters, charging, maintenance, warranties, and general usage.
Be concise, friendly, and accurate. If you are unsure, say so honestly.
Note: This is a POC demo. Full RAG integration with product-specific documents will be enabled via n8n.`,
      messages: [{ role: 'user', content: question }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Claude API returned ${resp.status}`);
  const data = await resp.json();
  return {
    answer: data.content?.[0]?.text || 'No response received.',
    sources: [{ doc_name: 'General EV Knowledge (RAG not yet connected)', relevance_score: null }],
  };
}

// ── Async accuracy rating via Claude Opus (fire-and-forget) ───────────────────

async function rateAccuracy(messageId, question, answer, context) {
  if (!ANTHROPIC_API_KEY || !messageId) return;
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 256,
        system: `You are an expert QA evaluator for an AI customer support system.
Rate the accuracy and helpfulness of AI responses on a scale of 0–10.
Respond ONLY with valid JSON: {"score": <number 0-10>, "label": "<Excellent|Good|Acceptable|Poor>", "rationale": "<one sentence>"}`,
        messages: [{
          role: 'user',
          content: `Question: ${question}\n\nAI Answer: ${answer}\n\nContext available: ${context || 'General knowledge only (no RAG documents)'}`,
        }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const text = data.content?.[0]?.text || '';
    const rating = JSON.parse(text);
    await supabaseInsert('ratings', {
      message_id: messageId,
      accuracy_score: rating.score,
      accuracy_label: rating.label,
      rating_rationale: rating.rationale,
      rated_by_model: 'claude-opus-4-6',
    });
  } catch {
    // Silently fail — rating is non-critical
  }
}

// ── Main handler ───────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth check
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const claims = verifyJWT(token);
  if (!claims) return res.status(401).json({ error: 'Unauthorized' });

  const body = await readBody(req);
  const { question, sessionId } = body;
  if (!question?.trim()) return res.status(400).json({ error: 'Question is required' });

  const startTime = Date.now();

  let answer, sources;
  try {
    if (N8N_WEBHOOK_URL) {
      const result = await callN8N(question.trim(), sessionId);
      answer = result.answer;
      sources = result.sources || [];
    } else {
      const result = await callClaudeDirect(question.trim());
      answer = result.answer;
      sources = result.sources || [];
    }
  } catch (err) {
    console.error('AI call failed:', err.message);
    return res.status(502).json({ error: 'AI service temporarily unavailable. Please try again.' });
  }

  const responseTimeMs = Date.now() - startTime;

  // Deduplicate question by hash
  const questionHash = crypto
    .createHash('sha256')
    .update(question.trim().toLowerCase())
    .digest('hex');

  // Persist to Supabase (non-blocking for response time)
  const messageRow = {
    session_id: sessionId || null,
    question: question.trim(),
    question_hash: questionHash,
    response: answer,
    response_time_ms: responseTimeMs,
    sources: JSON.stringify(sources),
  };

  let savedMessage = null;
  try {
    savedMessage = await supabaseInsert('messages', messageRow);
  } catch {
    // DB logging failure should not block the response
  }

  // Fire-and-forget accuracy rating
  const contextStr = sources.map(s => s.doc_name).join(', ');
  rateAccuracy(savedMessage?.id, question.trim(), answer, contextStr).catch(() => {});

  return res.status(200).json({
    answer,
    sources,
    responseTimeMs,
    messageId: savedMessage?.id || null,
  });
};
