module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({
    OPENAI_API_KEY:    process.env.OPENAI_API_KEY    ? `set (${process.env.OPENAI_API_KEY.slice(0, 6)}...)` : 'MISSING',
    SUPABASE_URL:      process.env.SUPABASE_URL      ? 'set' : 'MISSING',
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ? 'set' : 'MISSING',
    INGEST_SECRET:     process.env.INGEST_SECRET     ? 'set' : 'MISSING',
    NODE_ENV:          process.env.NODE_ENV || 'not set',
  });
};
