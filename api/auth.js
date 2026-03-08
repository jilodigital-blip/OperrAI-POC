const crypto = require('crypto');

const DEMO_USER = process.env.DEMO_USER || 'ev_demo';
const DEMO_PASS = process.env.DEMO_PASS || 'EV@OperrAI2024';
const JWT_SECRET = process.env.JWT_SECRET || 'operrai-poc-secret-change-in-prod';

// Simple in-memory rate limiter (resets on cold start — fine for a POC)
const attempts = {};

function b64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJWT(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto
    .createHmac('sha256', JWT_SECRET)
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
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

  const body = await readBody(req);
  const { username = '', password = '' } = body;

  const validUser = safeEqual(username, DEMO_USER);
  const validPass = safeEqual(password, DEMO_PASS);

  if (!validUser || !validPass) {
    attempts[ip].push(now);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 8 * 3600; // 8-hour session
  const token = signJWT({ sub: 'ev_demo', client: 'ev_scooter', iat, exp });

  return res.status(200).json({ token, expiresAt: exp });
};
