/**
 * Shared Voice Session logic — used by both server.js (Cloud Run standalone)
 * and relay.js (embeddable module for local dev).
 *
 * Exports: VoiceSession, verifyJWT, supabaseFetch, handleWSConnection
 */

const crypto = require('crypto');
const speech = require('@google-cloud/speech');
const tts = require('@google-cloud/text-to-speech');

// ── WAV header helper (wraps raw LINEAR16 PCM so browsers can decode it) ────

function wrapPCMInWAV(pcmBuffer, sampleRate = 22050, numChannels = 1, bitsPerSample = 16) {
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);                                    // ChunkID
  header.writeUInt32LE(36 + dataSize, 4);                     // ChunkSize
  header.write('WAVE', 8);                                    // Format
  header.write('fmt ', 12);                                   // Subchunk1ID
  header.writeUInt32LE(16, 16);                               // Subchunk1Size (PCM)
  header.writeUInt16LE(1, 20);                                // AudioFormat (1 = PCM)
  header.writeUInt16LE(numChannels, 22);                      // NumChannels
  header.writeUInt32LE(sampleRate, 24);                       // SampleRate
  header.writeUInt32LE(sampleRate * numChannels * bitsPerSample / 8, 28); // ByteRate
  header.writeUInt16LE(numChannels * bitsPerSample / 8, 32);  // BlockAlign
  header.writeUInt16LE(bitsPerSample, 34);                    // BitsPerSample
  header.write('data', 36);                                   // Subchunk2ID
  header.writeUInt32LE(dataSize, 40);                         // Subchunk2Size
  return Buffer.concat([header, pcmBuffer]);
}

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
- CRITICAL: Write plain conversational text only. NEVER spell out punctuation names like पूर्णविराम, अल्पविराम, विस्मयादिबोधक, प्रश्नवाचक, etc. Do not use special symbols or markdown. Write as if you are speaking naturally.

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

// ── Google Cloud TTS client (shared across sessions) ────────────────────────

let _ttsClient = null;
function getTTSClient() {
  if (!_ttsClient) _ttsClient = new tts.TextToSpeechClient();
  return _ttsClient;
}

// ── Voice Session class ─────────────────────────────────────────────────────

class VoiceSession {
  constructor(clientWs, claims, lead) {
    this.ws = clientWs;
    this.claims = claims;
    this.lead = lead;
    this._sttStream = null;
    this._sttClient = null;
    this.conversationHistory = Array.isArray(lead.conversation_history) ? [...lead.conversation_history] : [];
    this.currentScore = lead.lead_score || 10;
    this.currentStage = lead.stage || 'welcome';
    this.turnCount = lead.turn_count || 0;
    this.isAISpeaking = false;
    this.sttTranscript = '';
    this.llmBuffer = '';
    this.fullLLMResponse = '';
    this.destroyed = false;
    this._ttsQueue = [];
    this._ttsBusy = false;
    const ck = claims.client && claims.client !== 'admin' ? claims.client : 'ather';
    this.voiceLeadsTable = ck === 'apb' ? 'voice_leads_apb' : 'voice_leads';
  }

  debugSend(msg) {
    console.log(`[DEBUG] ${msg}`);
    this.send({ type: 'server_debug', message: msg });
  }

  // ── Initialize upstream connections ────────────────────────────────────

  async init() {
    try {
      this.debugSend('Initializing Google Cloud TTS...');
      // Verify TTS client works
      getTTSClient();
      this.debugSend('TTS ready (Google Cloud Text-to-Speech)');
      this.send({ type: 'ready' });

      if (this.conversationHistory.length === 0) {
        this.debugSend('New lead — sending welcome greeting');
        await this.sendWelcome();
      } else {
        this.debugSend('Returning lead — sending re-greeting');
        const reGreet = `Namaste ${this.lead.name}! Main phir se Ather Energy se bol rahi hoon. Batayein, aapke koi sawaal hain?`;
        this.send({ type: 'ai_text', text: reGreet, done: true });
        this.sendToTTS(reGreet);
      }
      this.debugSend('Init complete');
    } catch (err) {
      this.debugSend('INIT FAILED: ' + err.message);
      this.send({ type: 'error', message: 'Failed to initialize: ' + err.message });
      this.destroy();
    }
  }

  // ── Google Cloud Speech-to-Text streaming ────────────────────────────

  connectSTT() {
    return new Promise((resolve, reject) => {
      this.debugSend('STT connecting to Google Cloud Speech...');

      try {
        const sttClient = new speech.SpeechClient();

        const recognizeStream = sttClient.streamingRecognize({
          config: {
            encoding: 'LINEAR16',
            sampleRateHertz: 16000,
            languageCode: 'hi-IN',
            alternativeLanguageCodes: ['en-IN', 'en-US'],
            model: 'latest_short',
            enableAutomaticPunctuation: true,
          },
          interimResults: true,
          singleUtterance: false,
        });

        recognizeStream.on('data', (response) => {
          if (this.destroyed) return;

          // Clear watchdog on first result
          if (!this._sttGotResult) {
            this._sttGotResult = true;
            if (this._sttWatchdog) { clearTimeout(this._sttWatchdog); this._sttWatchdog = null; }
          }

          const result = response.results?.[0];
          if (!result) return;

          const transcript = result.alternatives?.[0]?.transcript || '';
          if (!transcript) return;

          if (result.isFinal) {
            this.debugSend('STT final: "' + transcript.slice(0, 100) + '"');
            this.sttTranscript += (this.sttTranscript ? ' ' : '') + transcript;
            this.send({ type: 'transcript', text: this.sttTranscript, final: false });
            this._resetSilenceTimer();
          } else {
            this.debugSend('STT interim: "' + transcript.slice(0, 80) + '"');
            const displayText = this.sttTranscript + (this.sttTranscript ? ' ' : '') + transcript;
            this.send({ type: 'transcript', text: displayText, final: false });

            if (this.isAISpeaking && transcript.trim().length > 2) {
              this.handleInterrupt();
            }
          }
        });

        recognizeStream.on('error', (err) => {
          // Suppress "write after destroyed" spam — stream is already dead
          if (err.code === 'ERR_STREAM_DESTROYED' || (err.message && err.message.includes('stream was destroyed'))) {
            this._sttStream = null;
            return;
          }
          if (err.code === 11) {
            this.debugSend('STT stream timed out, restarting...');
            this._restartSTTStream();
            return;
          }
          // Invalid model/config errors
          if (err.code === 3 || (err.message && err.message.includes('Invalid recognition'))) {
            this.debugSend('STT config error: ' + err.message);
            this._sttStream = null;
            this.send({ type: 'error', message: 'STT config error: ' + err.message });
            return;
          }
          this.debugSend('STT ERROR (code=' + (err.code || 'none') + '): ' + err.message);
          this.send({ type: 'error', message: 'STT error: ' + err.message });
          this._sttStream = null;
        });

        recognizeStream.on('end', () => {
          this.debugSend('STT stream ended');
          this._sttStream = null;
        });

        recognizeStream.on('close', () => {
          this._sttStream = null;
        });

        this._sttClient = sttClient;
        this._sttStream = recognizeStream;
        this._silenceTimer = null;
        this._sttGotResult = false;

        // Watchdog: if we've been sending audio but get no STT result in 8s, restart
        this._sttWatchdog = setTimeout(() => {
          if (!this._sttGotResult && this._audioChunkCount > 10) {
            this.debugSend('STT watchdog: no results after ' + this._audioChunkCount + ' chunks — restarting stream');
            this._restartSTTStream();
          }
        }, 8000);

        this.debugSend('STT Google Cloud Speech connected');
        resolve();
      } catch (err) {
        this.debugSend('STT connection failed: ' + err.message);
        reject(err);
      }
    });
  }

  _resetSilenceTimer() {
    if (this._silenceTimer) clearTimeout(this._silenceTimer);
    this._silenceTimer = setTimeout(() => {
      if (this.sttTranscript.trim()) {
        this.debugSend('Silence detected — triggering LLM with: "' + this.sttTranscript.slice(0, 100) + '"');
        this.triggerLLM(this.sttTranscript.trim());
        this.sttTranscript = '';
      }
    }, 1000);
  }

  _restartSTTStream() {
    if (this.destroyed) return;
    if (this._sttWatchdog) { clearTimeout(this._sttWatchdog); this._sttWatchdog = null; }
    if (this._sttStream) {
      try { this._sttStream.destroy(); } catch {}
      this._sttStream = null;
    }
    this._sttConnecting = false;
    this._sttFailed = false;
    this._audioChunkCount = 0;
    this.connectSTT().catch(err => {
      this.debugSend('STT restart failed: ' + err.message);
      this._sttStream = null;
      this._sttFailed = true;
    });
  }

  // ── Google Cloud Text-to-Speech ────────────────────────────────────────

  sendToTTS(text) {
    if (this.destroyed || !text.trim()) return;
    // Strip punctuation symbols that TTS may read aloud as Hindi words
    text = text.replace(/[।!?;:""''—–…*#_~`]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return;

    this.debugSend('TTS queuing: "' + text.slice(0, 80) + '"');
    this.isAISpeaking = true;
    this.send({ type: 'ai_speaking', speaking: true });

    this._ttsQueue.push(text);
    this._processTTSQueue();
  }

  async _processTTSQueue() {
    if (this._ttsBusy || !this._ttsQueue.length) return;
    this._ttsBusy = true;

    while (this._ttsQueue.length > 0) {
      if (this.destroyed) break;
      const text = this._ttsQueue.shift();

      try {
        const client = getTTSClient();
        const [response] = await client.synthesizeSpeech({
          input: { text },
          voice: {
            languageCode: 'hi-IN',
            name: 'hi-IN-Wavenet-A',
            ssmlGender: 'FEMALE',
          },
          audioConfig: {
            audioEncoding: 'MP3',
            speakingRate: 1.1,
          },
        });

        if (this.destroyed) break;

        if (response.audioContent) {
          const audioBase64 = Buffer.from(response.audioContent).toString('base64');
          this.debugSend('TTS audio: ' + audioBase64.length + ' b64 chars (MP3)');
          this.send({ type: 'ai_audio', data: audioBase64 });
        }
      } catch (err) {
        this.debugSend('TTS ERROR: ' + err.message);
        this.send({ type: 'error', message: 'TTS error: ' + err.message });
      }
    }

    this._ttsBusy = false;

    // Signal speaking done when queue is empty
    if (this._ttsQueue.length === 0) {
      this.isAISpeaking = false;
      this.send({ type: 'ai_speaking', speaking: false });
    }
  }

  // ── OpenAI GPT-4o streaming ───────────────────────────────────────────

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

    // Clear any pending TTS from previous response to prevent voice mixing
    this._ttsQueue = [];
    this.isAISpeaking = false;
    this.send({ type: 'clear_audio' });

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
          model: 'gpt-4o-mini',
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

  // ── Welcome message ───────────────────────────────────────────────────

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

  // ── Barge-in / Interruption ───────────────────────────────────────────

  handleInterrupt() {
    this.isAISpeaking = false;
    // Clear pending TTS queue so interrupted speech doesn't continue
    this._ttsQueue = [];
    this.send({ type: 'interrupt' });
    this.send({ type: 'ai_speaking', speaking: false });
  }

  // ── Process audio from browser ────────────────────────────────────────

  async handleAudio(base64Audio) {
    if (!this._sttStream || !this._sttStream.writable) {
      if (this._sttConnecting) return;
      // Allow retry after failure (don't permanently block)
      this._sttStream = null;
      this._sttConnecting = true;
      try {
        this.debugSend('STT lazy-connecting on first audio chunk...');
        await this.connectSTT();
        this._sttConnecting = false;
        this._sttFailed = false;
        this.debugSend('STT lazy-connect succeeded');
      } catch (err) {
        this._sttConnecting = false;
        // Only send error once, not for every audio chunk
        if (!this._sttFailed) {
          const msg = 'STT connection failed: ' + err.message;
          this.debugSend(msg);
          this.send({ type: 'error', message: msg });
        }
        this._sttFailed = true;
        return;
      }
    }

    if (!this._audioChunkCount) this._audioChunkCount = 0;
    this._audioChunkCount++;
    if (this._audioChunkCount <= 3 || this._audioChunkCount % 50 === 0) {
      this.debugSend('Audio chunk #' + this._audioChunkCount + ' forwarded to STT (' + base64Audio.length + ' chars)');
    }

    const audioBuffer = Buffer.from(base64Audio, 'base64');
    try {
      if (this._sttStream && this._sttStream.writable) {
        this._sttStream.write(audioBuffer);
      }
    } catch (err) {
      // Silently handle write-after-destroy — stream will be reconnected on next chunk
      this._sttStream = null;
    }
  }

  handleStop() {
    if (this._silenceTimer) clearTimeout(this._silenceTimer);

    if (this.sttTranscript.trim()) {
      this.triggerLLM(this.sttTranscript.trim());
      this.sttTranscript = '';
    }
  }

  // ── Async DB persistence ──────────────────────────────────────────────

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

  // ── Send message to browser ───────────────────────────────────────────

  send(msg) {
    if (this.ws.readyState === 1) { // WebSocket.OPEN
      this.ws.send(JSON.stringify(msg));
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  destroy() {
    this.destroyed = true;
    this._ttsQueue = [];
    if (this._silenceTimer) clearTimeout(this._silenceTimer);
    if (this._sttWatchdog) { clearTimeout(this._sttWatchdog); this._sttWatchdog = null; }
    if (this._sttStream) {
      try { this._sttStream.destroy(); } catch {}
      this._sttStream = null;
    }
    if (this._sttClient) {
      try { this._sttClient.close(); } catch {}
      this._sttClient = null;
    }
    this.persistToDatabase().catch(() => {});
  }
}

// ── Shared WebSocket connection handler ─────────────────────────────────────

async function handleWSConnection(ws, req) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const token = url.searchParams.get('token');
  const leadId = url.searchParams.get('lead_id');

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

  console.log(`[WS] New session: lead=${leadId}, user=${claims.sub}`);

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
}

// ── Validate API keys on startup ────────────────────────────────────────────

async function validateKeys() {
  // Check Google Cloud STT
  try {
    const testClient = new speech.SpeechClient();
    await testClient.close();
    console.log('[STARTUP] Google Cloud STT: OK (ADC)');
  } catch (err) {
    console.error('[STARTUP] Google Cloud STT init failed: ' + err.message);
  }

  // Check Google Cloud TTS
  try {
    const testClient = new tts.TextToSpeechClient();
    await testClient.close();
    console.log('[STARTUP] Google Cloud TTS: OK (ADC)');
  } catch (err) {
    console.error('[STARTUP] Google Cloud TTS init failed: ' + err.message);
  }
}

module.exports = { VoiceSession, verifyJWT, supabaseFetch, handleWSConnection, validateKeys };
