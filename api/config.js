module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).json({
    relayHost: process.env.VOICE_RELAY_HOST || '',
  });
};
