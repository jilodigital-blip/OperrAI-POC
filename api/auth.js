const crypto = require('crypto');

// Simple in-memory rate limiter (resets on cold start — fine for a POC)
const attempts = {};

function b64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJWT(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${header}.${body}.${sig}`;
}

function safeEqual(a, b) {
  try {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
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

// ── Multi-tenant client credentials ─────────────────────────────────────────
// Each client has its own demo user and maps to a unique client key.
// Admin credentials are shared across all clients.
function getClientCredentials() {
  return [
    {
      client: 'ather',
      label: 'Ather Energy',
      username: process.env.DEMO_USER,
      password: process.env.DEMO_PASS,
    },
    {
      client: 'apb',
      label: 'Airtel Payments Bank',
      username: process.env.APB_DEMO_USER,
      password: process.env.APB_DEMO_PASS,
    },
  ];
}

module.exports = async (req, res) => {
  // Validate required env vars
  const requiredEnvVars = ['DEMO_USER', 'DEMO_PASS', 'ADMIN_USER', 'ADMIN_PASS', 'JWT_SECRET'];
  const missing = requiredEnvVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error('Missing required env vars:', missing.join(', '));
    return res.status(500).json({ error: 'Server configuration incomplete' });
  }

  // Read env vars inside handler to avoid stale module-scope cache on Vercel
  const ADMIN_USER  = process.env.ADMIN_USER;
  const ADMIN_PASS  = process.env.ADMIN_PASS;
  const JWT_SECRET  = process.env.JWT_SECRET;
  const clients     = getClientCredentials();

  const corsOrigin = process.env.CORS_ORIGIN;
  if (!corsOrigin) {
    return res.status(500).json({ error: 'CORS origin not configured' });
  }
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Logout: clear httpOnly auth cookie ────────────────────────────────────
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', 'raymidi_auth=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limiting: 5 attempts per IP per 15 minutes
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim();
  const now = Date.now();
  if (!attempts[ip]) attempts[ip] = [];
  attempts[ip] = attempts[ip].filter(t => now - t < 15 * 60 * 1000);
  if (attempts[ip].length >= 5) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }

  // Vercel pre-parses JSON bodies onto req.body; fall back to manual stream read
  const body = req.body && typeof req.body === 'object' ? req.body : await readBody(req);
  const { username = '', password = '' } = body;

  // Check admin credentials first
  const isAdmin = safeEqual(username, ADMIN_USER) && safeEqual(password, ADMIN_PASS);

  // Check each client's demo credentials
  let matchedClient = null;
  if (!isAdmin) {
    for (const c of clients) {
      if (safeEqual(username, c.username) && safeEqual(password, c.password)) {
        matchedClient = c;
        break;
      }
    }
  }

  if (!isAdmin && !matchedClient) {
    attempts[ip].push(now);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const role   = isAdmin ? 'admin' : 'user';
  const client = isAdmin ? 'admin' : matchedClient.client;
  const iat    = Math.floor(Date.now() / 1000);
  const exp    = iat + 8 * 3600; // 8-hour session
  const token  = signJWT({ sub: username, client, role, iat, exp }, JWT_SECRET);

  // Set httpOnly cookie — invisible to JavaScript / browser console
  const isSecure = (req.headers['x-forwarded-proto'] || '').includes('https');
  const cookieFlags = `HttpOnly; ${isSecure ? 'Secure; ' : ''}SameSite=Strict; Path=/; Max-Age=28800`;
  res.setHeader('Set-Cookie', `raymidi_auth=${token}; ${cookieFlags}`);

  // Return session metadata (no token) — frontend uses cookie for auth
  return res.status(200).json({ expiresAt: exp, role, client });
};
