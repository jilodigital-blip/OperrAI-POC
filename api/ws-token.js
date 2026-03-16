// api/ws-token.js — Returns the JWT from the httpOnly cookie so the frontend
// can pass it as a query-param when opening a cross-origin WebSocket to the
// voice-relay service (JavaScript cannot read httpOnly cookies directly).

const crypto = require('crypto');

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

module.exports = (req, res) => {
  const JWT_SECRET = process.env.JWT_SECRET || '';
  const corsOrigin = process.env.CORS_ORIGIN;
  if (corsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Extract token from httpOnly cookie
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/(?:^|;\s*)raymidi_auth=([^\s;]+)/);
  const token = match ? match[1] : '';

  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  // Verify it's valid before handing it out
  const claims = verifyJWT(token, JWT_SECRET);
  if (!claims) return res.status(401).json({ error: 'Invalid or expired token' });

  return res.status(200).json({ token });
};
