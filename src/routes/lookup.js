const express = require('express');
const youtube = require('../services/youtube');
const twitch = require('../services/twitch');

const router = express.Router();

router.get('/lookup', async (req, res) => {
  const { platform, handle } = req.query;

  if (!platform || !handle) {
    return res.status(400).json({ error: 'Both "platform" and "handle" query params are required.' });
  }
  if (!['youtube', 'twitch'].includes(platform)) {
    return res.status(400).json({ error: 'platform must be "youtube" or "twitch".' });
  }
  if (!handle.trim()) {
    return res.status(400).json({ error: 'handle cannot be empty.' });
  }

  try {
    const result =
      platform === 'youtube'
        ? await youtube.getRecentVideos(handle)
        : await twitch.getRecentVideos(handle);
    res.json(result);
  } catch (err) {
    console.error(`[lookup] ${platform} "${handle}" failed:`, err.message);
    res.status(502).json({ error: err.message || 'Lookup failed.' });
  }
});

module.exports = router;
