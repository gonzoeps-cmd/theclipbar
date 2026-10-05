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

// Whole-video downloads get their own, larger cap, kept separate from MAX_CLIP_SECONDS on purpose:
// a clip is a slice cut out of a long video and stays small whatever the source is, while a download
// is the entire file. So this number is about the worker's temp disk and its ten-minute job budget,
// not about how long a clip may be. Raise the two independently.
const MAX_DOWNLOAD_SECONDS = 1800;

// Where the browser should poll for status / fetch the finished file. The worker is its own Render
// service with its own URL, and the browser talks to it directly (no proxying through this app).
const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/$/, '');

function parseSeconds(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

router.post('/clip', async (req, res) => {
  const { url, start, end, platform, title, whole, duration } = req.body || {};

  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'A valid video "url" is required.' });
  }

  let startSeconds = null;
  let endSeconds = null;

  if (whole) {
    // "Download the whole thing" rather than "cut me a piece". A null range is already how the
    // worker is told to take all of a video (see runYtDlp in src/worker.js — that's the path Twitch
    // live clips use), so there is nothing to compute here beyond checking the length.
    //
    // The length comes from the caller, because this service never touches the video itself and so
    // has no way to measure it. That makes the check a guard against asking for a three-hour VOD,
    // not a security boundary — the worker's own job timeout is what actually stops a runaway
    // download, and it would stop one regardless of what was claimed here.
    const total = parseSeconds(duration);
    if (total === null || total <= 0) {
      return res.status(400).json({
        error: 'A whole-video download needs the video\'s "duration" in seconds.',
      });
    }
    if (total > MAX_DOWNLOAD_SECONDS) {
      return res.status(400).json({
        error: `Whole-video downloads are limited to ${MAX_DOWNLOAD_SECONDS / 60} minutes. `
          + 'Clip the part you want instead.',
      });
    }
  } else {
    startSeconds = parseSeconds(start);
    endSeconds = parseSeconds(end);
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
