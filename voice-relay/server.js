/**
 * Raymidi Voice Relay — WebSocket streaming pipeline
 *
 * Browser ──wss──► Relay ──wss──► Sarvam STT (streaming)
 *                    │
 *                transcript
 *                    │
 *              OpenAI GPT-4o (streaming)
 *                    │
 *              sentence buffer
 *                    │
 * Browser ◄──wss── Relay ◄──wss── Sarvam TTS (streaming)
 *
 * Deployed on Render (WebSocket support).
 * Vercel stays for static HTML, auth guard, lead CRUD.
 */

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 10000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// ── JWT verification (same as api/guard.js) ─────────────────────────────────

function verifyJWT(token) {
  const secret = process.env.JWT_SECRET;
  if (!token || !secret) return null;
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
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Supabase helpers ────────────────────────────────────────────────────────

async function supabaseFetch(path) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!key) return [];
  const resp = await fetch(`${url}/rest/v1/${path}`, {
    headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
  });
  if (!resp.ok) return [];
  return resp.json();
}

async function supabaseUpdate(table, id, updates) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!key) return null;
  const resp = await fetch(`${url}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
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

// ── Sentence boundary detection ─────────────────────────────────────────────

const SENTENCE_ENDINGS = /[.?!।]\s*$/;
const MIN_WORDS_FOR_FLUSH = 8;

function shouldFlushToTTS(buffer) {
  if (SENTENCE_ENDINGS.test(buffer)) return true;
  const wordCount = buffer.trim().split(/\s+/).length;
  if (wordCount >= MIN_WORDS_FOR_FLUSH) return true;
  return false;
}

// ── Extract scoring JSON from LLM output ────────────────────────────────────

function extractScoring(fullText) {
  let aiText = fullText;
  let scoreDelta = 0;
  let suggestedStage = null;
  let isHot = false;

  const jsonMatch = fullText.match(/\{[^{}]*"suggested_score_delta"[^{}]*\}\s*$/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      scoreDelta = parsed.suggested_score_delta || 0;
      suggestedStage = parsed.suggested_stage || null;
      isHot = parsed.is_hot || false;
      aiText = fullText.slice(0, jsonMatch.index).trim();
    } catch { /* ignore */ }
  }

  return { aiText, scoreDelta, suggestedStage, isHot };
}

// ── Voice Session class ─────────────────────────────────────────────────────

class VoiceSession {
  constructor(clientWs, claims, lead) {
    this.ws = clientWs;       // browser WebSocket
    this.claims = claims;     // JWT payload
    this.lead = lead;         // lead record from Supabase
    this.sttWs = null;        // Sarvam STT WebSocket
    this.ttsWs = null;        // Sarvam TTS WebSocket
    this.conversationHistory = Array.isArray(lead.conversation_history) ? [...lead.conversation_history] : [];
    this.currentScore = lead.lead_score || 10;
    this.currentStage = lead.stage || 'welcome';
    this.turnCount = lead.turn_count || 0;
    this.isAISpeaking = false;
    this.sttTranscript = '';    // accumulated STT text for current turn
    this.llmBuffer = '';        // accumulated LLM tokens for TTS flushing
    this.fullLLMResponse = '';  // complete LLM response for scoring extraction
    this.destroyed = false;
  }

  // ── Initialize upstream connections ────────────────────────────────────

  async init() {
    try {
      await this.connectSTT();
      await this.connectTTS();
      this.send({ type: 'ready' });

      // If no conversation history, send welcome
      if (this.conversationHistory.length === 0) {
        await this.sendWelcome();
      }
    } catch (err) {
      this.send({ type: 'error', message: 'Failed to initialize: ' + err.message });
      this.destroy();
    }
  }

  // ── Sarvam STT WebSocket ──────────────────────────────────────────────

  connectSTT() {
    return new Promise((resolve, reject) => {
      const sarvamKey = process.env.SARVAM_API_KEY;
      if (!sarvamKey) return reject(new Error('SARVAM_API_KEY not configured'));

      const sttUrl = `wss://api.sarvam.ai/speech-to-text/ws?language_code=hi-IN&model=saaras:v3&sample_rate=16000`;
      this.sttWs = new WebSocket(sttUrl, {
        headers: { 'Api-Subscription-Key': sarvamKey },
      });

      this.sttWs.on('open', () => {
        console.log(`[STT] Connected for lead ${this.lead.id}`);
        resolve();
      });

      this.sttWs.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleSTTMessage(msg);
        } catch { /* ignore non-JSON */ }
      });

      this.sttWs.on('error', (err) => {
        console.error('[STT] Error:', err.message);
        this.send({ type: 'error', message: 'STT connection error' });
      });

      this.sttWs.on('close', () => {
        console.log('[STT] Closed');
        // Reconnect if session is still active
        if (!this.destroyed) {
          setTimeout(() => this.connectSTT().catch(() => {}), 1000);
        }
      });

      // Timeout on connection
      setTimeout(() => reject(new Error('STT connection timeout')), 10000);
    });
  }

  handleSTTMessage(msg) {
    // Sarvam sends: { type: "transcript", data: { transcript: "..." } }
    // or { type: "speech_start" }, { type: "speech_end" }
    if (msg.type === 'speech_start') {
      // User started speaking — interrupt AI if speaking
      if (this.isAISpeaking) {
        this.handleInterrupt();
      }
      return;
    }

    if (msg.type === 'speech_end') {
      // User stopped speaking — trigger LLM with accumulated transcript
      if (this.sttTranscript.trim()) {
        this.triggerLLM(this.sttTranscript.trim());
        this.sttTranscript = '';
      }
      return;
    }

    // Transcript data
    const transcript = msg.data?.transcript || msg.transcript || '';
    if (!transcript) return;

    this.sttTranscript = transcript;
    this.send({ type: 'transcript', text: transcript, final: false });
  }

  // ── Sarvam TTS WebSocket ──────────────────────────────────────────────

  connectTTS() {
    return new Promise((resolve, reject) => {
      const sarvamKey = process.env.SARVAM_API_KEY;
      if (!sarvamKey) return reject(new Error('SARVAM_API_KEY not configured'));

      const ttsUrl = `wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v2&send_completion_event=true`;
      this.ttsWs = new WebSocket(ttsUrl, {
        headers: { 'Api-Subscription-Key': sarvamKey },
      });

      this.ttsWs.on('open', () => {
        console.log(`[TTS] Connected for lead ${this.lead.id}`);
        // Send TTS config
        this.ttsWs.send(JSON.stringify({
          type: 'config',
          data: {
            target_language_code: 'hi-IN',
            speaker: 'meera',
            model: 'bulbul:v2',
            pace: 1.0,
            loudness: 1.0,
            enable_preprocessing: true,
            audio_codec: 'wav',
          },
        }));
        resolve();
      });

      this.ttsWs.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleTTSMessage(msg);
        } catch {
          // Binary audio data — send to browser as base64
          if (Buffer.isBuffer(data)) {
            this.send({ type: 'ai_audio', data: data.toString('base64') });
          }
        }
      });

      this.ttsWs.on('error', (err) => {
        console.error('[TTS] Error:', err.message);
      });

      this.ttsWs.on('close', () => {
        console.log('[TTS] Closed');
        if (!this.destroyed) {
          setTimeout(() => this.connectTTS().catch(() => {}), 1000);
        }
      });

      setTimeout(() => reject(new Error('TTS connection timeout')), 10000);
    });
  }

  handleTTSMessage(msg) {
    // Audio chunk
    if (msg.data?.audio || msg.audio) {
      const audioBase64 = msg.data?.audio || msg.audio;
      this.send({ type: 'ai_audio', data: audioBase64 });
      return;
    }

    // Completion event
    if (msg.type === 'completion' || msg.event === 'completion') {
      this.isAISpeaking = false;
      this.send({ type: 'ai_speaking', speaking: false });
    }
  }

  // ── Send text to TTS ──────────────────────────────────────────────────

  sendToTTS(text) {
    if (!this.ttsWs || this.ttsWs.readyState !== WebSocket.OPEN) return;
    this.isAISpeaking = true;
    this.send({ type: 'ai_speaking', speaking: true });

    this.ttsWs.send(JSON.stringify({
      type: 'text',
      data: { text },
    }));

    // Flush to process immediately
    this.ttsWs.send(JSON.stringify({ type: 'flush' }));
  }

  // ── OpenAI GPT-4o streaming ───────────────────────────────────────────

  async triggerLLM(userText) {
    // Send final transcript to browser
    this.send({ type: 'transcript', text: userText, final: true });

    // Add to conversation history
    this.conversationHistory.push({
      role: 'user',
      content: userText,
      timestamp: new Date().toISOString(),
    });

    // Build messages for OpenAI
    const messages = [
      { role: 'system', content: LEAD_QUALIFICATION_PROMPT },
      ...this.conversationHistory.map(h => ({
        role: h.role === 'user' ? 'user' : 'assistant',
        content: h.content,
      })),
    ];

    this.llmBuffer = '';
    this.fullLLMResponse = '';

    try {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages,
          temperature: 0.4,
          max_tokens: 300,
          stream: true,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`OpenAI ${resp.status}: ${errText}`);
      }

      // Process SSE stream
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (this.destroyed) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') {
            this.onLLMDone();
            continue;
          }

          try {
            const chunk = JSON.parse(payload);
            const token = chunk.choices?.[0]?.delta?.content;
            if (token) {
              this.onLLMToken(token);
            }
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (err) {
      console.error('[LLM] Error:', err.message);
      this.send({ type: 'error', message: 'AI response error: ' + err.message });
    }
  }

  onLLMToken(token) {
    this.fullLLMResponse += token;
    this.llmBuffer += token;

    // Send token to browser for live text display
    this.send({ type: 'ai_text', text: token, done: false });

    // Check if we should flush buffer to TTS
    if (shouldFlushToTTS(this.llmBuffer)) {
      // Don't send the scoring JSON to TTS
      const cleanText = this.llmBuffer.replace(/\{[^{}]*"suggested_score_delta"[^{}]*\}\s*$/, '').trim();
      if (cleanText) {
        this.sendToTTS(cleanText);
      }
      this.llmBuffer = '';
    }
  }

  onLLMDone() {
    // Flush any remaining buffer to TTS
    if (this.llmBuffer.trim()) {
      const cleanText = this.llmBuffer.replace(/\{[^{}]*"suggested_score_delta"[^{}]*\}\s*$/, '').trim();
      if (cleanText) {
        this.sendToTTS(cleanText);
      }
      this.llmBuffer = '';
    }

    this.send({ type: 'ai_text', text: '', done: true });

    // Extract scoring from full response
    const { aiText, scoreDelta, suggestedStage, isHot } = extractScoring(this.fullLLMResponse);

    // Update score
    this.currentScore = Math.max(0, Math.min(100, this.currentScore + scoreDelta));
    if (suggestedStage) this.currentStage = suggestedStage;
    this.turnCount++;

    // Add AI response to history
    this.conversationHistory.push({
      role: 'assistant',
      content: aiText,
      timestamp: new Date().toISOString(),
    });

    // Send score update to browser
    this.send({
      type: 'score',
      score: this.currentScore,
      stage: this.currentStage,
      isHot,
      turnCount: this.turnCount,
    });

    // Async DB update (don't block conversation)
    this.persistToDatabase().catch(err => {
      console.error('[DB] Update error:', err.message);
    });
  }

  // ── Welcome message ───────────────────────────────────────────────────

  async sendWelcome() {
    const welcomeText = `Namaste ${this.lead.name}! Main Ather Energy se bol rahi hoon. Aapne ${this.lead.product_interest} mein interest dikhaya hai — bahut accha choice hai! Batayein, aap kaise use karna chahte hain — daily commute ke liye ya weekend rides ke liye?`;

    // Add to history
    this.conversationHistory.push({
      role: 'assistant',
      content: welcomeText,
      timestamp: new Date().toISOString(),
    });

    // Send text to browser
    this.send({ type: 'ai_text', text: welcomeText, done: true });

    // Send to TTS
    this.sendToTTS(welcomeText);

    // Update stage
    this.currentStage = 'probing';
    this.send({
      type: 'score',
      score: this.currentScore,
      stage: this.currentStage,
      isHot: false,
      turnCount: this.turnCount,
    });

    // Persist
    supabaseUpdate('voice_leads', this.lead.id, {
      conversation_history: this.conversationHistory,
      stage: 'probing',
      status: 'contacted',
    }).catch(err => console.error('[DB] Welcome update error:', err.message));
  }

  // ── Barge-in / Interruption ───────────────────────────────────────────

  handleInterrupt() {
    this.isAISpeaking = false;

    // Tell TTS to stop generating
    if (this.ttsWs && this.ttsWs.readyState === WebSocket.OPEN) {
      this.ttsWs.send(JSON.stringify({ type: 'flush' }));
    }

    // Tell browser to stop playback
    this.send({ type: 'interrupt' });
    this.send({ type: 'ai_speaking', speaking: false });
  }

  // ── Process audio from browser ────────────────────────────────────────

  handleAudio(base64Audio) {
    if (!this.sttWs || this.sttWs.readyState !== WebSocket.OPEN) return;

    // Forward audio to Sarvam STT
    this.sttWs.send(JSON.stringify({
      audio: {
        data: base64Audio,
        sample_rate: '16000',
        encoding: 'audio/wav',
      },
    }));
  }

  handleStop() {
    // User explicitly stopped — flush STT
    if (this.sttWs && this.sttWs.readyState === WebSocket.OPEN) {
      this.sttWs.send(JSON.stringify({ type: 'flush' }));
    }

    // If we have accumulated transcript, trigger LLM
    if (this.sttTranscript.trim()) {
      this.triggerLLM(this.sttTranscript.trim());
      this.sttTranscript = '';
    }
  }

  // ── Async DB persistence ──────────────────────────────────────────────

  async persistToDatabase() {
    const newStatus = this.currentScore >= 80 ? 'qualified' : this.lead.status;

    await supabaseUpdate('voice_leads', this.lead.id, {
      conversation_history: this.conversationHistory,
      turn_count: this.turnCount,
      lead_score: this.currentScore,
      stage: this.currentStage,
      status: newStatus,
    });

    console.log(`[DB] Updated lead ${this.lead.id}: score=${this.currentScore}, stage=${this.currentStage}`);
  }

  // ── Send message to browser ───────────────────────────────────────────

  send(msg) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  destroy() {
    this.destroyed = true;
    if (this.sttWs) {
      try { this.sttWs.close(); } catch {}
      this.sttWs = null;
    }
    if (this.ttsWs) {
      try { this.ttsWs.close(); } catch {}
      this.ttsWs = null;
    }
    // Final DB persist
    this.persistToDatabase().catch(() => {});
  }
}

// ── HTTP server (health check + WebSocket upgrade) ──────────────────────────

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, timestamp: Date.now() }));
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket server ────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/voice' });

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const token = url.searchParams.get('token');
  const leadId = url.searchParams.get('lead_id');

  // Verify JWT
  const claims = verifyJWT(token);
  if (!claims) {
    ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
    ws.close(4001, 'Unauthorized');
    return;
  }

  if (!leadId) {
    ws.send(JSON.stringify({ type: 'error', message: 'lead_id required' }));
    ws.close(4002, 'Missing lead_id');
    return;
  }

  // Fetch lead from Supabase
  const clientKey = claims.client && claims.client !== 'admin' ? claims.client : 'ather';
  const leads = await supabaseFetch(
    `voice_leads?id=eq.${encodeURIComponent(leadId)}&client=eq.${encodeURIComponent(clientKey)}&limit=1`
  );

  if (!leads.length) {
    ws.send(JSON.stringify({ type: 'error', message: 'Lead not found' }));
    ws.close(4004, 'Lead not found');
    return;
  }

  console.log(`[WS] New session: lead=${leadId}, user=${claims.sub}`);

  // Create session
  const session = new VoiceSession(ws, claims, leads[0]);

  // Handle messages from browser
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case 'audio':
          session.handleAudio(msg.data);
          break;
        case 'stop':
          session.handleStop();
          break;
        case 'interrupt':
          session.handleInterrupt();
          break;
        case 'end':
          session.destroy();
          ws.close(1000, 'Session ended');
          break;
        default:
          break;
      }
    } catch (err) {
      console.error('[WS] Message parse error:', err.message);
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Session closed: lead=${leadId}`);
    session.destroy();
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error: ${err.message}`);
    session.destroy();
  });

  // Initialize upstream connections
  session.init();
});

// ── Start server ────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Raymidi Voice Relay running on port ${PORT}`);
  console.log(`  Health check: http://localhost:${PORT}/health`);
  console.log(`  WebSocket:    ws://localhost:${PORT}/voice`);
});
