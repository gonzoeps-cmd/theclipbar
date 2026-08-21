const express = require('express');
const youtube = require('../services/youtube');
const twitch = require('../services/twitch');
const tiktok = require('../services/tiktok');

const router = express.Router();

const VALID_CLIP_RANGES = ['all', '24h', '7d', '30d'];

router.get('/lookup', async (req, res) => {
  const { platform, handle, type, range, page, channelId, skipLive } = req.query;

  if (!platform || !handle) {
    return res.status(400).json({ error: 'Both "platform" and "handle" query params are required.' });
  }
  if (!['youtube', 'twitch', 'tiktok'].includes(platform)) {
    return res.status(400).json({ error: 'platform must be "youtube", "twitch", or "tiktok".' });
  }
  if (!handle.trim()) {
    return res.status(400).json({ error: 'handle cannot be empty.' });
  }

  // For Twitch, "type" picks between full VODs ("videos", the default) and short clips ("clips").
  // Ignored for YouTube, which only has one kind of result.
  const twitchType = type === 'clips' ? 'clips' : 'videos';
  // "range" only applies to Twitch clips: all / 24h / 7d / 30d (defaults to 30d).
  const clipRange = VALID_CLIP_RANGES.includes(range) ? range : '30d';

  try {
    let result;
    if (platform === 'youtube') {
      result = await youtube.getRecentVideos(handle, 12, page || null, {
        channelId: channelId || null,
        skipLive: skipLive === '1',
      });
    } else if (platform === 'tiktok') {
      result = await tiktok.getChannel(handle);
    } else if (twitchType === 'clips') {
      const offset = page ? parseInt(page, 10) || 0 : 0;
      result = await twitch.getRecentClips(handle, 12, clipRange, offset);
    } else {
      result = await twitch.getRecentVideos(handle, 12, page || null);
    }
    res.json({
      ...result,
      type: platform === 'twitch' ? twitchType : 'videos',
      ...(platform === 'twitch' && twitchType === 'clips' ? { range: clipRange } : {}),
    });
  } catch (err) {
    console.error(`[lookup] ${platform} "${handle}" failed:`, err.message);
    res.status(502).json({ error: err.message || 'Lookup failed.' });
  }
});

module.exports = router;
