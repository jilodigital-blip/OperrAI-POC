const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');

// ── Bundled FAQ fallback (used when Supabase documents table is empty) ─────────
let BUNDLED_FAQS = [];
try {
  BUNDLED_FAQS = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../ingest/faqs.json'), 'utf8')
  );
} catch { /* no local fallback available */ }

// ── JWT helpers ────────────────────────────────────────────────────────────────

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

// ── Supabase REST helpers ──────────────────────────────────────────────────────

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

async function supabaseRPC(fn, params, supabaseUrl, supabaseKey) {
  if (!supabaseKey) throw new Error('SUPABASE_ANON_KEY is not configured');
  const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  if (!resp.ok) throw new Error(`Supabase RPC ${fn} returned ${resp.status}`);
  return await resp.json();
}

// ── Agentic pipeline: Embed → RAG → Gemini L1 → OpenAI L2 → Quality Gate ──────

async function callAgenticPipeline(question, channel, { openaiKey, geminiKey, supabaseUrl, supabaseKey }) {
  // ── L0: Embed ──────────────────────────────────────────────────────────────
  if (!openaiKey) throw new Error('OPENAI_API_KEY is not configured');
  const embedResp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openaiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: question }),
    signal: AbortSignal.timeout(15000),
  });
  if (!embedResp.ok) throw new Error(`OpenAI embed returned ${embedResp.status}`);
  const embedData = await embedResp.json();
  const embedding = embedData.data[0].embedding;

  // ── RAG: Vector search ─────────────────────────────────────────────────────
  let chunks = [];
  try {
    chunks = await supabaseRPC('match_documents', {
      query_embedding: embedding,
      match_count: 5,
    }, supabaseUrl, supabaseKey);
  } catch {
    chunks = [];
  }

  // ── Fallback: use bundled FAQs when Supabase returns nothing ───────────────
  // This ensures the demo works even before the knowledge base is seeded.
  if (chunks.length === 0 && BUNDLED_FAQS.length > 0) {
    console.warn('Supabase returned 0 documents — falling back to bundled FAQs');
    const lq = question.toLowerCase();
    const terms = lq.split(/\W+/).filter(t => t.length > 3);
    // Score each FAQ by keyword overlap, then take top 5
    const scored = BUNDLED_FAQS.map(f => {
      const hay = (f.doc_name + ' ' + f.content).toLowerCase();
      const hits = terms.filter(t => hay.includes(t)).length;
      return { ...f, _score: hits };
    }).sort((a, b) => b._score - a._score);
    chunks = scored.slice(0, 5).map(f => ({
      doc_name:   f.doc_name,
      content:    f.content,
      similarity: null,
    }));
  }

  const context = chunks.length > 0
    ? chunks.map((c, i) => `[Source ${i + 1}: ${c.doc_name}]\n${c.content}`).join('\n\n---\n\n')
    : 'No relevant documents found in the knowledge base.';
  const sources = chunks.map(c => ({
    doc_name: c.doc_name,
    relevance_score: c.similarity !== null ? Math.round((c.similarity || 0) * 100) / 100 : null,
  }));

  // ── L1: Gemini Worker ──────────────────────────────────────────────────────
  if (!geminiKey) throw new Error('GEMINI_API_KEY is not configured');
  const formatInstruction = channel === 'email'
    ? 'FORMAT: Write a formal professional email response with greeting and sign-off. Be thorough and warm.'
    : 'FORMAT: Be concise and direct. Under 150 words. No greeting needed.';
  const systemPrompt = `You are an expert customer support agent for Ather Energy EV scooters.
Answer ONLY using the provided knowledge base context. Do not hallucinate.
If the context lacks the answer, say: "I don't have enough information on this topic. Please contact our support team."

${formatInstruction}

Knowledge Base Context:
${context}`;

  const l1Resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: question }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: channel === 'email' ? 1024 : 512,
        },
      }),
      signal: AbortSignal.timeout(30000),
    }
  );
  if (!l1Resp.ok) throw new Error(`Gemini L1 returned ${l1Resp.status}`);
  const l1Data = await l1Resp.json();
  const l1Answer = l1Data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'No response generated.';

  // ── L2: OpenAI GPT-4o Supervisor ──────────────────────────────────────────
  let rating = { score: 5, label: 'Acceptable', rationale: 'Quality evaluator not configured — defaulting to Acceptable.' };
  if (openaiKey) {
    const evalPrompt = `You are a strict QA evaluator for an AI customer support system.
Evaluate whether the AI answer correctly addresses the customer question.
Check for: hallucinations, incorrect facts, missing critical info, or off-topic responses.
IMPORTANT: If the AI answer says it does not have information but the Knowledge Base Context clearly contains relevant information to answer the question, rate this as Poor.

Customer Question:
${question}

AI Answer:
${l1Answer}

Knowledge Base Context Used:
${context}

Respond ONLY with valid JSON (no markdown):
{"score": <integer 0-10>, "label": "<Excellent|Good|Acceptable|Poor>", "rationale": "<one concise sentence>"}

Scoring: 9-10=Excellent, 7-8=Good, 5-6=Acceptable, 0-4=Poor`;

    try {
      const l2Resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openaiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          max_tokens: 256,
          temperature: 0.1,
          messages: [
            { role: 'system', content: 'You are a strict QA evaluator. Respond only with valid JSON.' },
            { role: 'user',   content: evalPrompt },
          ],
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (l2Resp.ok) {
        const l2Data = await l2Resp.json();
        const raw = l2Data?.choices?.[0]?.message?.content?.trim() || '';
        const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
        const parsed = JSON.parse(cleaned);
        rating = {
          score: Math.max(0, Math.min(10, Number(parsed.score) || 5)),
          label: ['Excellent', 'Good', 'Acceptable', 'Poor'].includes(parsed.label)
            ? parsed.label : 'Acceptable',
          rationale: parsed.rationale || '',
        };
      } else {
        console.error('OpenAI L2 evaluator returned HTTP', l2Resp.status);
      }
    } catch (err) {
      console.error('OpenAI L2 evaluation failed:', err.message);
      // Keep default rating on OpenAI failure — do not block the response
    }
  }

  // ── Quality Gate ───────────────────────────────────────────────────────────
  const blocked = rating.label === 'Poor';
  let ticket_id = null;
  if (blocked) {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const rand    = String(Math.floor(Math.random() * 90000) + 10000);
    ticket_id = `SR-${dateStr}-${rand}`;
  }

  return {
    answer:             blocked ? null : l1Answer,
    sources,
    accuracy_score:     rating.score,
    accuracy_label:     rating.label,
    accuracy_rationale: rating.rationale,
    blocked,
    ticket_id,
  };
}

// ── Main handler ───────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  // Read env vars inside handler to avoid stale module-scope cache on Vercel
  const JWT_SECRET        = process.env.JWT_SECRET        || 'operrai-poc-secret-change-in-prod';
  const OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || '';
  const GEMINI_API_KEY    = process.env.GEMINI_API_KEY    || '';
  const SUPABASE_URL      = process.env.SUPABASE_URL      || '';
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth check
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const claims = verifyJWT(token, JWT_SECRET);
  if (!claims) return res.status(401).json({ error: 'Unauthorized' });

  // Vercel pre-parses JSON bodies onto req.body; fall back to manual stream read
  const body = req.body && typeof req.body === 'object' ? req.body : await readBody(req);
  const { question, sessionId, channel: rawChannel } = body;
  const channel = rawChannel === 'email' ? 'email' : 'chat';
  if (!question?.trim()) return res.status(400).json({ error: 'Question is required' });

  const startTime = Date.now();
  const envVars = { openaiKey: OPENAI_API_KEY, geminiKey: GEMINI_API_KEY, supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_ANON_KEY };

  let result;
  try {
    result = await callAgenticPipeline(question.trim(), channel, envVars);
  } catch (err) {
    console.error('Pipeline failed:', err.message);
    return res.status(502).json({ error: 'AI service temporarily unavailable. Please try again.' });
  }

  const { answer, sources, blocked, ticket_id,
          accuracy_score, accuracy_label, accuracy_rationale } = result;
  const responseTimeMs = Date.now() - startTime;

  const questionHash = crypto
    .createHash('sha256')
    .update(question.trim().toLowerCase())
    .digest('hex');

  const messageRow = {
    session_id:       sessionId || null,
    question:         question.trim(),
    question_hash:    questionHash,
    response:         blocked ? '[BLOCKED]' : answer,
    response_time_ms: responseTimeMs,
    sources:          JSON.stringify(sources),
    channel,
  };

  let savedMessage = null;
  try {
    savedMessage = await supabaseInsert('messages', messageRow, SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch {
    // DB logging failure does not block the response
  }

  // Persist accuracy rating (already computed — no extra API call)
  if (savedMessage?.id) {
    supabaseInsert('ratings', {
      message_id:       savedMessage.id,
      accuracy_score,
      accuracy_label,
      rating_rationale: accuracy_rationale,
      rated_by_model:   OPENAI_API_KEY ? 'gpt-4o' : 'default',
    }, SUPABASE_URL, SUPABASE_ANON_KEY).catch(() => {});
  }

  // Persist service request for blocked responses
  if (blocked && ticket_id) {
    supabaseInsert('service_requests', {
      message_id: savedMessage?.id || null,
      ticket_id,
      question:   question.trim(),
      channel,
      status:     'open',
    }, SUPABASE_URL, SUPABASE_ANON_KEY).catch(() => {});
  }

  return res.status(200).json({
    answer:        blocked ? null : answer,
    sources,
    responseTimeMs,
    messageId:     savedMessage?.id || null,
    blocked,
    ticketId:      blocked ? ticket_id : null,
    channel,
    accuracyScore: accuracy_score,
    accuracyLabel: accuracy_label,
  });
};
