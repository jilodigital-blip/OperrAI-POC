/**
 * Raymidi Voice Relay — Standalone server for Cloud Run deployment.
 *
 * Browser ──wss──► Relay ──gRPC──► Google Cloud STT (streaming)
 *                    │
 *                transcript
 *                    │
 *              OpenAI GPT-4o (streaming)
 *                    │
 *              sentence buffer
 *                    │
 * Browser ◄──wss── Relay ◄──wss── Sarvam TTS (streaming)
 *
 * All session logic lives in session.js (shared with relay.js).
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const speech = require('@google-cloud/speech');
const { handleWSConnection, validateKeys } = require('./session');

const PORT = process.env.PORT || 8080;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// ── HTTP server (health check + WebSocket upgrade) ──────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, timestamp: Date.now() }));
  }

  if (req.url === '/debug/sarvam') {
    const sarvamKey = process.env.SARVAM_API_KEY;
    const keyPreview = sarvamKey
      ? `${sarvamKey.slice(0, 4)}...${sarvamKey.slice(-4)} (len=${sarvamKey.length})`
      : 'NOT SET';
    const results = { sttProvider: 'Google Cloud Speech-to-Text', ttsProvider: 'Sarvam', sarvamKeyPreview: keyPreview, tests: {} };

    try {
      const testClient = new speech.SpeechClient();
      await testClient.close();
      results.tests.googleSTT = { status: 'ok', message: 'Client initialized successfully (ADC)' };
    } catch (err) {
      results.tests.googleSTT = { status: 'error', message: err.message };
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(results, null, 2));
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket server ────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/voice' });
wss.on('connection', handleWSConnection);

// ── Start server ────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Raymidi Voice Relay running on port ${PORT}`);
  console.log(`  Health check: http://localhost:${PORT}/health`);
  console.log(`  WebSocket:    ws://localhost:${PORT}/voice`);
  validateKeys();
});
