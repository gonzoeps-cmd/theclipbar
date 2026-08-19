const express = require('express');
const youtube = require('../services/youtube');
const twitch = require('../services/twitch');

const router = express.Router();

router.get('/lookup', async (req, res) => {
  const { platform, handle, type } = req.query;

  if (!platform || !handle) {
    return res.status(400).json({ error: 'Both "platform" and "handle" query params are required.' });
  }
  if (!['youtube', 'twitch'].includes(platform)) {
    return res.status(400).json({ error: 'platform must be "youtube" or "twitch".' });
  }
  if (!handle.trim()) {
    return res.status(400).json({ error: 'handle cannot be empty.' });
  }

  // For Twitch, "type" picks between full VODs ("videos", the default) and short clips ("clips").
  // Ignored for YouTube, which only has one kind of result.
  const twitchType = type === 'clips' ? 'clips' : 'videos';

  try {
    let result;
    if (platform === 'youtube') {
      result = await youtube.getRecentVideos(handle);
    } else if (twitchType === 'clips') {
      result = await twitch.getRecentClips(handle);
    } else {
      result = await twitch.getRecentVideos(handle);
    }
    res.json({ ...result, type: platform === 'twitch' ? twitchType : 'videos' });
  } catch (err) {
    console.error(`[lookup] ${platform} "${handle}" failed:`, err.message);
    res.status(502).json({ error: err.message || 'Lookup failed.' });
  }
});

module.exports = router;
