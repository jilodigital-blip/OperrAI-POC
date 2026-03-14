/**
 * Local development server for Raymidi POC.
 * Serves static HTML files and routes /api/* to the Vercel-style handlers.
 *
 * Usage:  node server.js
 * Then open: http://localhost:3000
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Map URL paths → static files
const STATIC_ROUTES = {
  '/':          'index.html',
  '/login':     'login.html',
  '/ev-poc':    'ev-poc.html',
  '/ingest':    'ingest.html',
  '/voice-pod': 'voice-pod.html',
  '/admin':     'admin.html',
};

// Map /api/* → handler modules
const API_HANDLERS = {
  '/api/auth':      './api/auth.js',
  '/api/chat':      './api/chat.js',
  '/api/dashboard': './api/dashboard.js',
  '/api/ingest':    './api/ingest.js',
  '/api/admin':     './api/admin.js',
  '/api/feedback':  './api/feedback.js',
  '/api/ai-test':   './api/ai-test.js',
  '/api/voice':     './api/voice.js',
};

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0].replace(/\/$/, '') || '/';

  // ── API routes ────────────────────────────────────────────────────────────
  if (url.startsWith('/api/')) {
    const handlerPath = API_HANDLERS[url];
    if (!handlerPath) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'API endpoint not found' }));
    }
    try {
      // Clear require cache in dev so edits reload without restart
      delete require.cache[require.resolve(handlerPath)];
      const handler = require(handlerPath);
      // Shim Express-style helpers onto the plain Node res object
      if (!res.status) {
        res.status = (code) => { res._statusCode = code; res.statusCode = code; return res; };
      }
      if (!res.json) {
        res.json = (obj) => {
          if (!res.headersSent) {
            res.writeHead(res.statusCode || 200, { 'Content-Type': 'application/json' });
          }
          res.end(JSON.stringify(obj));
        };
      }
      await handler(req, res);
    } catch (err) {
      console.error(`[API error] ${url}:`, err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error', detail: err.message }));
      }
    }
    return;
  }

  // ── Static routes ─────────────────────────────────────────────────────────
  const filePath = STATIC_ROUTES[url]
    ? path.join(__dirname, STATIC_ROUTES[url])
    : path.join(__dirname, url); // fallback: serve file directly

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext  = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Raymidi POC running at http://localhost:${PORT}`);
  console.log('');
  console.log('  Login page :  http://localhost:' + PORT + '/login');
  console.log('  Demo page  :  http://localhost:' + PORT + '/ev-poc');
  console.log('  Ingest page:  http://localhost:' + PORT + '/ingest');
  console.log('');
  console.log('Make sure your .env or environment variables are set:');
  console.log('  OPENAI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, INGEST_SECRET');
});
