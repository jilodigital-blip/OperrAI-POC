/**
 * Voice Relay module — attaches a WebSocket server to an existing HTTP server.
 * Used by the root server.js for local development (shares port with Vercel routes).
 *
 * All session logic lives in session.js (shared with standalone server.js).
 */

const { WebSocketServer } = require('ws');
const { handleWSConnection, validateKeys } = require('./session');

function initVoiceRelay(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/voice' });
  wss.on('connection', handleWSConnection);

  console.log('[Voice Relay] WebSocket server attached on /voice');
  validateKeys();
}

module.exports = { initVoiceRelay };
