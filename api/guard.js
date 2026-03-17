// api/guard.js — Server-side auth guard for protected HTML pages.
// Verifies JWT cookie BEFORE serving page content.
// If invalid/missing → 302 redirect to /login.

const { readFileSync } = require('fs');
const { join } = require('path');
const { createHmac, timingSafeEqual } = require('crypto');

const ALLOWED_PAGES = {
  'ev-poc':    'ev-poc.html',
  'admin':     'admin.html',
  'voice-pod': 'voice-pod.html',
};

function verifyJWT(token, secret) {
  if (!token || !secret) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signatureB64] = parts;

    const expected = createHmac('sha256', secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64')
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

    const sigBuf = Buffer.from(signatureB64, 'base64url');
    const expBuf = Buffer.from(expected, 'base64url');
    if (sigBuf.length !== expBuf.length) return null;
    if (!timingSafeEqual(sigBuf, expBuf)) return null;

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k] = v.join('=');
  });
  return cookies;
}

module.exports = (req, res) => {
  try {
    const page = req.query && req.query.page;

    // Validate page parameter against allowlist
    if (!page || !ALLOWED_PAGES[page]) {
      console.error('[guard] Invalid or missing page param:', page);
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }

    const JWT_SECRET = process.env.JWT_SECRET;
    if (!JWT_SECRET) {
      console.error('[guard] JWT_SECRET env var is missing');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'JWT_SECRET not configured' }));
    }

    // Parse JWT from httpOnly cookie
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['raymidi_auth'];

    if (!token) {
      console.error('[guard] No raymidi_auth cookie found');
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }

    const payload = verifyJWT(token, JWT_SECRET);

    if (!payload) {
      console.error('[guard] JWT verification failed for page:', page);
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }

    // Admin page requires admin role
    if (page === 'admin' && payload.role !== 'admin') {
      console.error('[guard] Non-admin user tried to access admin page');
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }

    // Serve the HTML file
    const filePath = join(process.cwd(), ALLOWED_PAGES[page]);
    try {
      const html = readFileSync(filePath, 'utf-8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.writeHead(200);
      res.end(html);
    } catch (fileErr) {
      console.error('[guard] Failed to read file:', filePath, fileErr.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `Page file not found: ${ALLOWED_PAGES[page]}`, path: filePath }));
    }
  } catch (err) {
    console.error('[guard] Unexpected error:', err.message, err.stack);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Guard function crashed: ' + err.message }));
  }
};
