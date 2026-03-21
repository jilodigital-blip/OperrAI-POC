/**
 * Voice Relay module — attaches a WebSocket server to an existing HTTP server.
 * Extracted from voice-relay/server.js so it can run on the same port as the main app.
 */

const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

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
    this.ws = clientWs;
    this.claims = claims;
    this.lead = lead;
    this.sttWs = null;
    this.ttsWs = null;
    this.conversationHistory = Array.isArray(lead.conversation_history) ? [...lead.conversation_history] : [];
    this.currentScore = lead.lead_score || 10;
    this._debugToClient = true; // Send server debug info to client
    this.currentStage = lead.stage || 'welcome';
    this.turnCount = lead.turn_count || 0;
    this.isAISpeaking = false;
    this.sttTranscript = '';
    this.llmBuffer = '';
    this.fullLLMResponse = '';
    this.destroyed = false;
    const ck = claims.client && claims.client !== 'admin' ? claims.client : 'ather';
    this.voiceLeadsTable = ck === 'apb' ? 'voice_leads_apb' : 'voice_leads';
  }

  // Send debug info to client so it shows in the debug panel
  debugSend(msg) {
    console.log(`[DEBUG] ${msg}`);
    this.send({ type: 'server_debug', message: msg });
  }

  async init() {
    try {
      // Only connect TTS eagerly (needed for welcome greeting).
      // STT connects lazily on first audio chunk to avoid idle-timeout loop.
      console.log(`[INIT] Connecting TTS for lead ${this.lead.id}...`);
      await this.connectTTS();
      console.log(`[INIT] TTS connected, sending ready to client`);
      this.send({ type: 'ready' });

      if (this.conversationHistory.length === 0) {
        console.log(`[INIT] New lead — sending welcome greeting`);
        await this.sendWelcome();
      } else {
        console.log(`[INIT] Returning lead (${this.conversationHistory.length} msgs) — sending re-greeting`);
        // Returning lead — send a short re-greeting so the AI starts talking
        const reGreet = `Namaste ${this.lead.name}! Main phir se Ather Energy se bol rahi hoon. Batayein, aapke koi sawaal hain?`;
        this.send({ type: 'ai_text', text: reGreet, done: true });
        this.sendToTTS(reGreet);
      }
      console.log(`[INIT] Init complete for lead ${this.lead.id}`);
    } catch (err) {
      this.send({ type: 'error', message: 'Failed to initialize: ' + err.message });
      this.destroy();
    }
  }

  connectSTT() {
    return new Promise((resolve, reject) => {
      const sarvamKey = process.env.SARVAM_API_KEY;
      if (!sarvamKey) return reject(new Error('SARVAM_API_KEY not configured'));

      // Auth: query param + subprotocol + header (belt and suspenders)
      const sttUrl = `wss://api.sarvam.ai/speech-to-text/ws?language-code=hi-IN&model=saaras:v3&api-subscription-key=${encodeURIComponent(sarvamKey)}`;
      this.debugSend('STT connecting...');
      this.sttWs = new WebSocket(sttUrl, [`api-subscription-key.${sarvamKey}`], {
        headers: { 'api-subscription-key': sarvamKey },
      });

      this.sttWs.on('open', () => {
        this.debugSend('STT WebSocket connected to Sarvam');
        resolve();
      });

      this.sttWs.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.debugSend('STT msg: ' + JSON.stringify(msg).slice(0, 200));
          this.handleSTTMessage(msg);
        } catch { /* ignore non-JSON */ }
      });

      this.sttWs.on('error', (err) => {
        const detail = err.message || String(err);
        this.debugSend('STT ERROR: ' + detail);
        this.send({ type: 'error', message: 'STT error: ' + detail });
      });

      this.sttWs.on('unexpected-response', (req, res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          let diagnosis;
          if (res.statusCode === 403 || res.statusCode === 401) {
            diagnosis = 'Sarvam API key is missing or invalid';
          } else if (res.statusCode === 429) {
            diagnosis = 'Sarvam rate limit exceeded';
          } else {
            diagnosis = 'Sarvam rejected connection';
          }
          const fullError = `${diagnosis} (HTTP ${res.statusCode}): ${body.slice(0, 200)}`;
          this.debugSend('STT REJECTED: ' + fullError);
          this.send({ type: 'error', message: 'STT error: ' + fullError });
          reject(new Error(fullError));
        });
      });

      this.sttWs.on('close', (code, reason) => {
        this.debugSend('STT CLOSED: code=' + code + ' reason=' + (reason || 'none'));
        this.sttWs = null;
      });

      setTimeout(() => reject(new Error('STT connection timeout (10s)')), 10000);
    });
  }

  handleSTTMessage(msg) {
    // Sarvam STT response: { type: "data", vad_response_type: "speech_start"|"speech_end"|..., data: { transcript: "..." } }
    const vadType = msg.vad_response_type || '';

    if (vadType === 'speech_start' || msg.type === 'speech_start') {
      this.debugSend('VAD: speech_start');
      if (this.isAISpeaking) {
        this.handleInterrupt();
      }
      return;
    }

    if (vadType === 'speech_end' || msg.type === 'speech_end') {
      this.debugSend('VAD: speech_end, transcript: "' + this.sttTranscript.slice(0, 100) + '"');
      if (this.sttTranscript.trim()) {
        this.triggerLLM(this.sttTranscript.trim());
        this.sttTranscript = '';
      }
      return;
    }

    const transcript = msg.data?.transcript || msg.transcript || '';
    if (!transcript) return;

    this.debugSend('STT transcript: "' + transcript.slice(0, 100) + '"');
    this.sttTranscript = transcript;
    this.send({ type: 'transcript', text: transcript, final: false });
  }

  connectTTS() {
    return new Promise((resolve, reject) => {
      const sarvamKey = process.env.SARVAM_API_KEY;
      if (!sarvamKey) return reject(new Error('SARVAM_API_KEY not configured'));

      // Auth: query param + subprotocol + header (belt and suspenders)
      const ttsUrl = `wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v2&send_completion_event=true&api-subscription-key=${encodeURIComponent(sarvamKey)}`;
      this.debugSend('TTS connecting...');
      this.ttsWs = new WebSocket(ttsUrl, [`api-subscription-key.${sarvamKey}`], {
        headers: { 'api-subscription-key': sarvamKey },
      });

      this.ttsWs.on('open', () => {
        this.debugSend('TTS WebSocket connected to Sarvam');
        this.ttsWs.send(JSON.stringify({
          type: 'config',
          data: {
            target_language_code: 'hi-IN',
            speaker: 'anushka',
            model: 'bulbul:v2',
            pace: 1.0,
            loudness: 1.0,
            enable_preprocessing: true,
            output_audio_codec: 'wav',
            speech_sample_rate: '22050',
          },
        }));
        this.debugSend('TTS config sent');
        resolve();
      });

      this.ttsWs.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.debugSend('TTS JSON msg: ' + (msg.type || msg.event || JSON.stringify(msg).slice(0, 200)));
          this.handleTTSMessage(msg);
        } catch {
          if (Buffer.isBuffer(data)) {
            this.debugSend('TTS binary audio: ' + data.length + ' bytes');
            this.send({ type: 'ai_audio', data: data.toString('base64') });
          } else {
            this.debugSend('TTS unknown msg type: ' + typeof data);
          }
        }
      });

      this.ttsWs.on('error', (err) => {
        this.debugSend('TTS ERROR: ' + err.message);
      });

      this.ttsWs.on('unexpected-response', (req, res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          let diagnosis;
          if (res.statusCode === 403 || res.statusCode === 401) {
            diagnosis = 'Sarvam API key is missing or invalid';
          } else if (res.statusCode === 429) {
            diagnosis = 'Sarvam rate limit exceeded';
          } else {
            diagnosis = 'Sarvam rejected connection';
          }
          this.debugSend('TTS REJECTED: ' + diagnosis + ' (HTTP ' + res.statusCode + '): ' + body.slice(0, 200));
          this.send({ type: 'error', message: `TTS error: ${diagnosis}`, code: res.statusCode });
          reject(new Error(`${diagnosis} (HTTP ${res.statusCode})`));
        });
      });

      this.ttsWs.on('close', (code, reason) => {
        this.debugSend('TTS CLOSED: code=' + code + ' reason=' + (reason || 'none'));
        if (!this.destroyed) {
          setTimeout(() => this.connectTTS().catch(() => {}), 1000);
        }
      });

      setTimeout(() => reject(new Error('TTS connection timeout')), 10000);
    });
  }

  handleTTSMessage(msg) {
    if (msg.data?.audio || msg.audio) {
      const audioBase64 = msg.data?.audio || msg.audio;
      this.send({ type: 'ai_audio', data: audioBase64 });
      return;
    }

    if (msg.type === 'completion' || msg.event === 'completion' ||
        (msg.type === 'event' && msg.data?.event_type === 'final')) {
      this.debugSend('TTS synthesis complete');
      this.isAISpeaking = false;
      this.send({ type: 'ai_speaking', speaking: false });
    }

    if (msg.type === 'error') {
      this.debugSend('TTS ERROR response: ' + JSON.stringify(msg.data || msg).slice(0, 300));
    }
  }

  sendToTTS(text) {
    if (!this.ttsWs || this.ttsWs.readyState !== WebSocket.OPEN) {
      this.debugSend('TTS Cannot send — WS not open (state=' + (this.ttsWs?.readyState ?? 'null') + ')');
      return;
    }
    this.debugSend('TTS sending text (' + text.length + ' chars): ' + text.slice(0, 80) + '...');
    this.isAISpeaking = true;
    this.send({ type: 'ai_speaking', speaking: true });

    this.ttsWs.send(JSON.stringify({
      type: 'text',
      data: { text },
    }));

    this.ttsWs.send(JSON.stringify({ type: 'flush' }));
    this.debugSend('TTS text+flush sent, waiting for audio response...');
  }

  async triggerLLM(userText) {
    this.send({ type: 'transcript', text: userText, final: true });

    this.conversationHistory.push({
      role: 'user',
      content: userText,
      timestamp: new Date().toISOString(),
    });

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

    this.send({ type: 'ai_text', text: token, done: false });

    if (shouldFlushToTTS(this.llmBuffer)) {
      const cleanText = this.llmBuffer.replace(/\{[^{}]*"suggested_score_delta"[^{}]*\}\s*$/, '').trim();
      if (cleanText) {
        this.sendToTTS(cleanText);
      }
      this.llmBuffer = '';
    }
  }

  onLLMDone() {
    if (this.llmBuffer.trim()) {
      const cleanText = this.llmBuffer.replace(/\{[^{}]*"suggested_score_delta"[^{}]*\}\s*$/, '').trim();
      if (cleanText) {
        this.sendToTTS(cleanText);
      }
      this.llmBuffer = '';
    }

    this.send({ type: 'ai_text', text: '', done: true });

    const { aiText, scoreDelta, suggestedStage, isHot } = extractScoring(this.fullLLMResponse);

    this.currentScore = Math.max(0, Math.min(100, this.currentScore + scoreDelta));
    if (suggestedStage) this.currentStage = suggestedStage;
    this.turnCount++;

    this.conversationHistory.push({
      role: 'assistant',
      content: aiText,
      timestamp: new Date().toISOString(),
    });

    this.send({
      type: 'score',
      score: this.currentScore,
      stage: this.currentStage,
      isHot,
      turnCount: this.turnCount,
    });

    this.persistToDatabase().catch(err => {
      console.error('[DB] Update error:', err.message);
    });
  }

  async sendWelcome() {
    const welcomeText = `Namaste ${this.lead.name}! Main Ather Energy se bol rahi hoon. Aapne ${this.lead.product_interest} mein interest dikhaya hai — bahut accha choice hai! Batayein, aap kaise use karna chahte hain — daily commute ke liye ya weekend rides ke liye?`;

    this.conversationHistory.push({
      role: 'assistant',
      content: welcomeText,
      timestamp: new Date().toISOString(),
    });

    this.send({ type: 'ai_text', text: welcomeText, done: true });
    this.sendToTTS(welcomeText);

    this.currentStage = 'probing';
    this.send({
      type: 'score',
      score: this.currentScore,
      stage: this.currentStage,
      isHot: false,
      turnCount: this.turnCount,
    });

    supabaseUpdate(this.voiceLeadsTable, this.lead.id, {
      conversation_history: this.conversationHistory,
      stage: 'probing',
      status: 'contacted',
    }).catch(err => console.error('[DB] Welcome update error:', err.message));
  }

  handleInterrupt() {
    this.isAISpeaking = false;

    if (this.ttsWs && this.ttsWs.readyState === WebSocket.OPEN) {
      this.ttsWs.send(JSON.stringify({ type: 'flush' }));
    }

    this.send({ type: 'interrupt' });
    this.send({ type: 'ai_speaking', speaking: false });
  }

  async handleAudio(base64Audio) {
    // Lazy-connect STT on first audio chunk
    if (!this.sttWs || this.sttWs.readyState !== WebSocket.OPEN) {
      if (this._sttConnecting) return;
      this._sttConnecting = true;
      try {
        this.debugSend('STT lazy-connecting on first audio chunk...');
        await this.connectSTT();
        this._sttConnecting = false;
        this.debugSend('STT lazy-connect succeeded');
      } catch (err) {
        this._sttConnecting = false;
        this.debugSend('STT lazy-connect FAILED: ' + err.message);
        return;
      }
    }

    if (!this._audioChunkCount) this._audioChunkCount = 0;
    this._audioChunkCount++;
    if (this._audioChunkCount <= 3 || this._audioChunkCount % 50 === 0) {
      this.debugSend('Audio chunk #' + this._audioChunkCount + ' forwarded to STT (' + base64Audio.length + ' chars)');
    }

    this.sttWs.send(JSON.stringify({
      audio: {
        data: base64Audio,
        encoding: 'audio/wav',
        sample_rate: 16000,
      },
    }));
  }

  handleStop() {
    if (this.sttWs && this.sttWs.readyState === WebSocket.OPEN) {
      this.sttWs.send(JSON.stringify({ type: 'flush' }));
    }

    if (this.sttTranscript.trim()) {
      this.triggerLLM(this.sttTranscript.trim());
      this.sttTranscript = '';
    }
  }

  async persistToDatabase() {
    const newStatus = this.currentScore >= 80 ? 'qualified' : this.lead.status;

    await supabaseUpdate(this.voiceLeadsTable, this.lead.id, {
      conversation_history: this.conversationHistory,
      turn_count: this.turnCount,
      lead_score: this.currentScore,
      stage: this.currentStage,
      status: newStatus,
    });

    console.log(`[DB] Updated lead ${this.lead.id}: score=${this.currentScore}, stage=${this.currentStage}`);
  }

  send(msg) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

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
    this.persistToDatabase().catch(() => {});
  }
}

// ── Exported initializer — attaches WebSocket server to existing HTTP server ─

function initVoiceRelay(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/voice' });

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
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
    const leadsTable = clientKey === 'apb' ? 'voice_leads_apb' : 'voice_leads';
    const leads = await supabaseFetch(
      `${leadsTable}?id=eq.${encodeURIComponent(leadId)}&client=eq.${encodeURIComponent(clientKey)}&limit=1`
    );

    if (!leads.length) {
      ws.send(JSON.stringify({ type: 'error', message: 'Lead not found' }));
      ws.close(4004, 'Lead not found');
      return;
    }

    console.log(`[WS] New voice session: lead=${leadId}, user=${claims.sub}`);

    const session = new VoiceSession(ws, claims, leads[0]);

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

    session.init();
  });

  console.log('[Voice Relay] WebSocket server attached on /voice');
  validateSarvamKey();
}

async function validateSarvamKey() {
  const sarvamKey = process.env.SARVAM_API_KEY;
  if (!sarvamKey) {
    console.error('[STARTUP] SARVAM_API_KEY is not set — STT/TTS will fail');
    return;
  }

  const keyPreview = `${sarvamKey.slice(0, 4)}...${sarvamKey.slice(-4)} (len=${sarvamKey.length})`;
  console.log(`[STARTUP] SARVAM_API_KEY: ${keyPreview}`);

  try {
    const resp = await fetch('https://api.sarvam.ai/translate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-subscription-key': sarvamKey,
      },
      body: JSON.stringify({
        input: 'test',
        source_language_code: 'en-IN',
        target_language_code: 'hi-IN',
        model: 'mayura:v1',
      }),
    });

    if (resp.status === 403 || resp.status === 401) {
      console.error(`[STARTUP] Sarvam API key is INVALID (HTTP ${resp.status}). STT/TTS will fail.`);
      const body = await resp.text();
      console.error(`[STARTUP] Response: ${body.slice(0, 300)}`);
    } else if (resp.ok) {
      console.log('[STARTUP] Sarvam API key validated successfully');
    } else {
      console.warn(`[STARTUP] Sarvam key check returned HTTP ${resp.status} (may still work for WS)`);
    }
  } catch (err) {
    console.warn(`[STARTUP] Could not validate Sarvam API key: ${err.message}`);
  }
}

module.exports = { initVoiceRelay };
