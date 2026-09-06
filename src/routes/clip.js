// Clip creation endpoint (Phase 2). This only ENQUEUES work — it never downloads or cuts anything
// itself. The actual yt-dlp/ffmpeg work happens in the worker service (src/worker.js), which polls
// the same Redis queue. See src/queue.js for why the split exists.

const express = require('express');
const { getQueue } = require('../queue');

const router = express.Router();

// Hard cap on clip length. The worker runs on a small instance and only downloads the requested
// section, so a short cap keeps both the download and the disk footprint sane. Raise this only
// alongside a bigger worker plan.
const MAX_CLIP_SECONDS = 300;

// Where the browser should poll for status / fetch the finished file. The worker is its own Render
// service with its own URL, and the browser talks to it directly (no proxying through this app).
const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/$/, '');

function parseSeconds(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

router.post('/clip', async (req, res) => {
  const { url, start, end, platform, title } = req.body || {};

  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'A valid video "url" is required.' });
  }

  const startSeconds = parseSeconds(start);
  const endSeconds = parseSeconds(end);
  if (startSeconds === null || endSeconds === null) {
    return res.status(400).json({ error: '"start" and "end" must be numbers (seconds).' });
  }
  if (endSeconds <= startSeconds) {
    return res.status(400).json({ error: 'The end time must be after the start time.' });
  }
  if (endSeconds - startSeconds > MAX_CLIP_SECONDS) {
    return res.status(400).json({
      error: `Clips are limited to ${MAX_CLIP_SECONDS / 60} minutes for now.`,
    });
  }

  const queue = getQueue();
  if (!queue) {
    return res.status(503).json({ error: 'Clipping is not configured on this server (no REDIS_URL).' });
  }
  if (!WORKER_URL) {
    return res.status(503).json({ error: 'Clipping is not configured on this server (no WORKER_URL).' });
  }

  try {
    const job = await queue.add('clip', {
      url,
      startSeconds,
      endSeconds,
      platform: platform || null,
      title: title || null,
    });

    res.status(202).json({
      jobId: job.id,
      statusUrl: `${WORKER_URL}/status/${job.id}`,
      downloadUrl: `${WORKER_URL}/clips/${job.id}.mp4`,
    });
  } catch (err) {
    console.error('[clip] failed to enqueue:', err.message);
    res.status(502).json({ error: 'Could not queue the clip job.' });
  }
});

module.exports = router;
