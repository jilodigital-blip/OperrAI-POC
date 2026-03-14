// api/voice.js — Voice Pod: Lead Management + Voice Pipeline API
// Handles lead CRUD and voice conversation (STT → LLM → TTS)

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

// ── Lead qualification prompt ───────────────────────────────────────────────

const LEAD_QUALIFICATION_PROMPT = `You are an AI sales qualification agent for Ather Energy electric scooters. Your goal is to qualify leads through natural conversation.

CONVERSATION STAGES:
1. WELCOME: Greet the prospect warmly, introduce yourself, ask how you can help
2. PROBING: Ask about their needs — commute distance, budget, current vehicle, timeline
3. QUALIFYING: Assess fit — ask about charging setup, test ride interest, specific model preferences
4. CLOSING: If qualified, suggest next steps (test ride booking, dealer visit, quote request)

SCORING SIGNALS (use these to recommend a score):
- Budget mention (has budget: +15, tight budget: +5)
- Timeline (buying this month: +20, within 3 months: +10, just exploring: +3)
- Charging setup (has home charging: +15, can install: +10, no option: -5)
- Current vehicle dissatisfaction: +10
- Specific model interest: +10
- Test ride request: +15
- Price objection without budget: -5
- Competitor comparison shopping: +5

RULES:
- Keep responses concise (2-3 sentences max for voice)
- Be helpful and not pushy
- Detect language (Hindi/Hinglish/English) and respond in same
- If prospect seems uninterested, gracefully wrap up
- Never make up pricing or specs — say "I'll have our team share exact details"

After your response, add a JSON line at the end:
{"suggested_score_delta": <number>, "suggested_stage": "<stage>", "is_hot": <boolean>}`;

// ── Voice pipeline helpers ──────────────────────────────────────────────────

async function sarvamSTT(audioBase64, sarvamKey) {
  const resp = await fetch('https://api.sarvam.ai/speech-to-text', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-subscription-key': sarvamKey,
    },
    body: JSON.stringify({
      input: audioBase64,
      language_code: 'hi-IN',
      model: 'saarika:v2',
      with_timestamps: false,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Sarvam STT error ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  return data.transcript || '';
}

async function sarvamTTS(text, sarvamKey) {
  const resp = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-subscription-key': sarvamKey,
    },
    body: JSON.stringify({
      input: text,
      target_language_code: 'hi-IN',
      model: 'bulbul:v2',
      speaker: 'meera',
      pitch: 0,
      pace: 1.0,
      loudness: 1.0,
      enable_preprocessing: true,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Sarvam TTS error ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  return data.audios && data.audios[0] ? data.audios[0] : '';
}

async function llmRespond(conversationHistory, openaiKey) {
  const messages = [
    { role: 'system', content: LEAD_QUALIFICATION_PROMPT },
    ...conversationHistory,
  ];

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openaiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages,
      temperature: 0.4,
      max_tokens: 300,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '';

  // Extract scoring JSON from the end of the response
  let aiText = content;
  let scoreDelta = 0;
  let suggestedStage = null;
  let isHot = false;

  const jsonMatch = content.match(/\{[^{}]*"suggested_score_delta"[^{}]*\}\s*$/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      scoreDelta = parsed.suggested_score_delta || 0;
      suggestedStage = parsed.suggested_stage || null;
      isHot = parsed.is_hot || false;
      aiText = content.slice(0, jsonMatch.index).trim();
    } catch { /* ignore parse errors */ }
  }

  return { aiText, scoreDelta, suggestedStage, isHot };
}

// ── Main handler ────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  const SUPABASE_URL      = process.env.SUPABASE_URL      || '';
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
  const JWT_SECRET        = process.env.JWT_SECRET         || '';
  const OPENAI_API_KEY    = process.env.OPENAI_API_KEY     || '';
  const SARVAM_API_KEY    = process.env.SARVAM_API_KEY     || '';

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

  // ── Voice conversation ─────────────────────────────────────────────────
  if (action === 'converse') {
    const { lead_id, audio_base64 } = body;
    if (!lead_id) return res.status(400).json({ error: 'lead_id is required' });

    // Fetch current lead
    const leads = await supabaseFetch(
      `voice_leads?id=eq.${encodeURIComponent(lead_id)}&client=eq.${encodeURIComponent(clientKey)}&limit=1`,
      SUPABASE_URL, SUPABASE_ANON_KEY
    );
    if (!leads.length) return res.status(404).json({ error: 'Lead not found' });
    const lead = leads[0];

    let userText = '';

    // STT: Convert audio to text (or use provided text)
    if (audio_base64) {
      if (!SARVAM_API_KEY) return res.status(500).json({ error: 'Sarvam API key not configured' });
      userText = await sarvamSTT(audio_base64, SARVAM_API_KEY);
    } else if (body.text) {
      userText = body.text;
    } else {
      return res.status(400).json({ error: 'audio_base64 or text is required' });
    }

    if (!userText.trim()) {
      return res.status(400).json({ error: 'Could not transcribe audio. Please try again.' });
    }

    // Build conversation for LLM
    const history = Array.isArray(lead.conversation_history) ? lead.conversation_history : [];
    const llmHistory = history.map(h => ({
      role: h.role === 'user' ? 'user' : 'assistant',
      content: h.content,
    }));
    llmHistory.push({ role: 'user', content: userText });

    // LLM: Generate qualification response
    const { aiText, scoreDelta, suggestedStage, isHot } = await llmRespond(llmHistory, OPENAI_API_KEY);

    // Calculate new score
    const newScore = Math.max(0, Math.min(100, (lead.lead_score || 10) + scoreDelta));
    const newStage = suggestedStage || lead.stage;
    const newStatus = isHot ? 'qualified' : (newScore >= 80 ? 'qualified' : lead.status);

    // TTS: Convert AI response to audio
    let audioResponseBase64 = '';
    if (SARVAM_API_KEY) {
      try {
        audioResponseBase64 = await sarvamTTS(aiText, SARVAM_API_KEY);
      } catch (e) {
        console.error('TTS error (non-fatal):', e.message);
      }
    }

    // Update conversation history
    const updatedHistory = [
      ...history,
      { role: 'user', content: userText, timestamp: new Date().toISOString() },
      { role: 'assistant', content: aiText, timestamp: new Date().toISOString() },
    ];

    // Save to database
    await supabaseUpdate('voice_leads', lead_id, {
      conversation_history: updatedHistory,
      turn_count: (lead.turn_count || 0) + 1,
      lead_score: newScore,
      stage: newStage,
      status: newStatus,
    }, SUPABASE_URL, SUPABASE_ANON_KEY);

    return res.status(200).json({
      transcript: userText,
      aiResponse: aiText,
      audioBase64: audioResponseBase64,
      score: newScore,
      stage: newStage,
      isHot,
      turnCount: (lead.turn_count || 0) + 1,
    });
  }

  // ── Welcome message (first message for new conversation) ──────────────
  if (action === 'welcome') {
    const { lead_id } = body;
    if (!lead_id) return res.status(400).json({ error: 'lead_id is required' });

    const leads = await supabaseFetch(
      `voice_leads?id=eq.${encodeURIComponent(lead_id)}&client=eq.${encodeURIComponent(clientKey)}&limit=1`,
      SUPABASE_URL, SUPABASE_ANON_KEY
    );
    if (!leads.length) return res.status(404).json({ error: 'Lead not found' });
    const lead = leads[0];

    const welcomeText = `Namaste ${lead.name}! Main Ather Energy se bol rahi hoon. Aapne ${lead.product_interest} mein interest dikhaya hai — bahut accha choice hai! Batayein, aap kaise use karna chahte hain — daily commute ke liye ya weekend rides ke liye?`;

    // TTS for welcome message
    let audioBase64 = '';
    if (SARVAM_API_KEY) {
      try {
        audioBase64 = await sarvamTTS(welcomeText, SARVAM_API_KEY);
      } catch (e) {
        console.error('Welcome TTS error (non-fatal):', e.message);
      }
    }

    // Save welcome to conversation history
    const updatedHistory = [
      { role: 'assistant', content: welcomeText, timestamp: new Date().toISOString() },
    ];

    await supabaseUpdate('voice_leads', lead_id, {
      conversation_history: updatedHistory,
      stage: 'probing',
      status: 'contacted',
    }, SUPABASE_URL, SUPABASE_ANON_KEY);

    return res.status(200).json({
      aiResponse: welcomeText,
      audioBase64,
      score: lead.lead_score,
      stage: 'probing',
    });
  }

  return res.status(400).json({ error: 'Invalid action. Use: create, update, list, get, converse, welcome' });
};
