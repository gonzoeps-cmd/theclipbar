// Clip worker (Phase 2). Runs as its own Render service — see src/queue.js for why the work is
// split off from the web service.
//
// It does two things in one process:
//   1. Consumes "clip-jobs" from Redis and produces an mp4 for each (yt-dlp downloads just the
//      requested section, then hands off to ffmpeg to cut it cleanly).
//   2. Serves a tiny HTTP API so the browser can poll job status and download the finished file.
//      The HTTP part also exists because Render web services must bind a port to stay alive.
//
// Storage is deliberately temporary: finished clips live in the system temp dir and are swept after
// CLIP_TTL_MS. This instance has no persistent disk, so a redeploy or restart also clears them —
// clips are meant to be downloaded soon after they're made, not stored here.

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const express = require('express');
const cors = require('cors');
const { Worker } = require('bullmq');
const { QUEUE_NAME, createConnection, getQueue } = require('./queue');

const PORT = process.env.PORT || 3001;
const BIN_DIR = path.join(__dirname, '..', 'bin');
const YTDLP_PATH = path.join(BIN_DIR, 'yt-dlp');
const FFMPEG_PATH = path.join(BIN_DIR, 'ffmpeg');
const CLIPS_DIR = path.join(os.tmpdir(), 'theclipbar-clips');
const CLIP_TTL_MS = 60 * 60 * 1000; // sweep finished clips after an hour
const JOB_TIMEOUT_MS = 10 * 60 * 1000; // don't let a stuck download run forever

fs.mkdirSync(CLIPS_DIR, { recursive: true });

// --- clip production -------------------------------------------------------

// yt-dlp's own error text is long and mostly noise. These map the failures worth explaining to
// something a person can act on. The YouTube one is by far the most common on a cloud host:
// YouTube gates downloads coming from datacenter IPs.
function friendlyError(stderr) {
  const text = stderr || '';
  if (/confirm you'?re not a bot|sign in to confirm/i.test(text)) {
    return 'YouTube blocked this download (it flags requests coming from servers). This is a YouTube restriction, not a problem with the video or the clip settings.';
  }
  if (/video unavailable|private video|members-only/i.test(text)) {
    return 'That video is unavailable, private, or members-only.';
  }
  if (/unsupported url|no video formats/i.test(text)) {
    return "Couldn't read that link as a downloadable video.";
  }
  if (/subscribe to this channel|requires authentication|login required/i.test(text)) {
    return 'That video requires being signed in to view.';
  }
  return 'The download failed. The source may be unavailable or blocked.';
}

function runYtDlp(job, outputTemplate) {
  const { url, startSeconds, endSeconds } = job.data;

  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    // Download ONLY the requested range instead of the whole video. Critical on a small instance:
    // a full multi-hour VOD would blow past both the disk and the time budget.
    '--download-sections', `*${startSeconds}-${endSeconds}`,
    '--force-keyframes-at-cuts',
    // Cap resolution to keep file size and memory reasonable on this instance size.
    '-f', 'bv*[height<=720]+ba/b[height<=720]/b',
    '--merge-output-format', 'mp4',
    // Point at the directory so yt-dlp finds ffprobe alongside ffmpeg.
    '--ffmpeg-location', BIN_DIR,
    '-o', outputTemplate,
    url,
  ];

  return new Promise((resolve, reject) => {
    execFile(
      YTDLP_PATH,
      args,
      { timeout: JOB_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          console.error(`[worker] job ${job.id} yt-dlp failed:`, (stderr || err.message).slice(-2000));
          const wrapped = new Error(friendlyError(stderr || err.message));
          return reject(wrapped);
        }
        resolve(stdout);
      }
    );
  });
}

async function processClip(job) {
  if (!fs.existsSync(YTDLP_PATH)) {
    throw new Error('The clip downloader is not installed on the server (yt-dlp missing).');
  }
  if (!fs.existsSync(FFMPEG_PATH)) {
    throw new Error('ffmpeg is not installed on the server.');
  }

  await job.updateProgress(5);
  const outputTemplate = path.join(CLIPS_DIR, `${job.id}.%(ext)s`);
  await runYtDlp(job, outputTemplate);
  await job.updateProgress(90);

  // yt-dlp fills in the real extension, so find whatever it actually wrote.
  const produced = fs
    .readdirSync(CLIPS_DIR)
    .find((name) => name.startsWith(`${job.id}.`));
  if (!produced) {
    throw new Error('The clip finished downloading but no file was produced.');
  }

  const finalPath = path.join(CLIPS_DIR, `${job.id}.mp4`);
  if (produced !== `${job.id}.mp4`) {
    fs.renameSync(path.join(CLIPS_DIR, produced), finalPath);
  }

  const { size } = fs.statSync(finalPath);
  await job.updateProgress(100);
  console.log(`[worker] job ${job.id} done (${size} bytes)`);
  return { file: `${job.id}.mp4`, bytes: size };
}

// --- sweeper ---------------------------------------------------------------

// Clips are throwaway. Without this the temp dir grows until the instance runs out of room.
function sweepOldClips() {
  const cutoff = Date.now() - CLIP_TTL_MS;
  let removed = 0;
  for (const name of fs.readdirSync(CLIPS_DIR)) {
    const full = path.join(CLIPS_DIR, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed += 1;
      }
    } catch {
      // file vanished mid-sweep; nothing to do
    }
  }
  if (removed) console.log(`[worker] swept ${removed} expired clip(s)`);
}

// --- http api --------------------------------------------------------------

const app = express();
app.use(cors());

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    ytdlp: fs.existsSync(YTDLP_PATH),
    ffmpeg: fs.existsSync(FFMPEG_PATH),
    redis: Boolean(process.env.REDIS_URL),
  });
});

app.get('/status/:jobId', async (req, res) => {
  const queue = getQueue();
  if (!queue) return res.status(503).json({ error: 'Queue not configured.' });

  try {
    const job = await queue.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'No such clip job.' });

    const state = await job.getState();
    res.json({
      jobId: job.id,
      state, // waiting | active | completed | failed | delayed
      progress: typeof job.progress === 'number' ? job.progress : 0,
      error: state === 'failed' ? job.failedReason || 'The clip failed.' : null,
      ready: state === 'completed',
    });
  } catch (err) {
    console.error('[worker] status lookup failed:', err.message);
    res.status(502).json({ error: 'Could not read job status.' });
  }
});

app.get('/clips/:file', (req, res) => {
  // Only ever serve <jobId>.mp4 out of the clips dir — never an arbitrary path.
  const name = path.basename(req.params.file);
  if (!/^[A-Za-z0-9_-]+\.mp4$/.test(name)) {
    return res.status(400).json({ error: 'Bad clip name.' });
  }
  const full = path.join(CLIPS_DIR, name);
  if (!fs.existsSync(full)) {
    return res.status(404).json({ error: 'That clip is not available (it may have expired).' });
  }
  res.download(full, name);
});

app.listen(PORT, () => {
  console.log(`[worker] http listening on ${PORT}`);
  console.log(`[worker] yt-dlp: ${fs.existsSync(YTDLP_PATH) ? 'ready' : 'MISSING'} | ffmpeg: ${fs.existsSync(FFMPEG_PATH) ? 'ready' : 'MISSING'}`);
});

// --- queue consumer --------------------------------------------------------

const connection = createConnection();
if (!connection) {
  console.error('[worker] REDIS_URL is not set — the queue consumer will not start.');
} else {
  const worker = new Worker(QUEUE_NAME, processClip, { connection, concurrency: 1 });
  worker.on('failed', (job, err) => {
    console.error(`[worker] job ${job?.id} failed: ${err.message}`);
  });
  worker.on('ready', () => console.log('[worker] connected to queue, waiting for clip jobs'));
  console.log('[worker] queue consumer starting...');
}

sweepOldClips();
setInterval(sweepOldClips, 15 * 60 * 1000);
