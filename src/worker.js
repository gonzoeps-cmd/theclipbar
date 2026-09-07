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
const { spawn } = require('child_process');
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

// Twitch returns a clip's metadata as soon as it's created, but the actual video file lands a while
// later — and the longer the clip, the longer that takes. Downloading too eagerly just 404s on the
// media URL. These are the waits between attempts (~3 minutes total), which comfortably covers a
// 60s clip without giving up on it.
const CLIP_RENDER_WAITS_MS = [15000, 20000, 30000, 45000, 60000];

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
  if (/unable to download video data|HTTP Error 404/i.test(text)) {
    return 'Twitch is still processing this clip. It exists — give it a minute and download again.';
  }
  return 'The download failed. The source may be unavailable or blocked.';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Twitch says "404 Not Found" for the media file of a clip it hasn't finished rendering. That's a
// wait-and-retry, not a real failure — unlike a deleted video, which fails at metadata lookup.
function looksLikeClipNotRendered(rawOutput) {
  return /unable to download video data|HTTP Error 404/i.test(rawOutput || '');
}

// yt-dlp's in-progress and sidecar files. These share the job's filename prefix, so anything that
// scans by prefix has to skip them.
function isTempFile(name) {
  return /\.(part|ytdl|temp|tmp)$/i.test(name);
}

function ownedFiles(jobId) {
  return fs.readdirSync(CLIPS_DIR).filter((name) => name.startsWith(`${jobId}.`));
}

function clearJobFiles(jobId) {
  for (const name of ownedFiles(jobId)) {
    try {
      fs.unlinkSync(path.join(CLIPS_DIR, name));
    } catch {
      // already gone
    }
  }
}

function runYtDlp(job, outputTemplate) {
  const { url, startSeconds, endSeconds } = job.data;

  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    // NOTE: --force-keyframes-at-cuts is deliberately NOT used. It forces a full re-encode, which
    // saturated this instance's 0.5 CPU allowance; Node then couldn't answer Render's health check
    // and the platform restarted the service mid-job (silently killing the clip). Without it the
    // cut is a stream copy, so it may start up to a keyframe early - a fine trade for finishing.
    '-f', 'bv*[height<=720]+ba/b[height<=720]/b',
    '--merge-output-format', 'mp4',
    // Keep ffmpeg single-threaded for the same reason: leave CPU for the health check.
    '--postprocessor-args', 'ffmpeg:-threads 1',
    // Point at the directory so yt-dlp finds ffprobe alongside ffmpeg.
    '--ffmpeg-location', BIN_DIR,
    '-o', outputTemplate,
  ];

  // A range means "cut this section out of a long video" (a VOD). No range means the source is
  // already short and we want all of it — that's how Twitch live clips arrive, since Twitch has
  // done the cutting for us. Sectioning a clip that's shorter than the requested window fails, so
  // only pass --download-sections when there's an actual range to cut.
  if (startSeconds != null && endSeconds != null) {
    args.splice(
      3,
      0,
      // Download ONLY the requested range instead of the whole video. Critical on a small
      // instance: a full multi-hour VOD would blow past both the disk and the time budget.
      '--download-sections',
      `*${startSeconds}-${endSeconds}`
    );
  }

  args.push(url);

  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_PATH, args);
    // Keep only the tail — enough to classify the failure without flooding memory.
    let tail = '';
    const capture = (chunk) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-4000);
      // Stream it to the logs live. If the platform kills this instance mid-job we still get to
      // see how far the download actually got, instead of losing everything with the process.
      for (const line of text.split('\n')) {
        if (line.trim()) console.log(`[worker] job ${job.id} yt-dlp | ${line.trim()}`);
      }
    };

    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    const timer = setTimeout(() => {
      console.error(`[worker] job ${job.id} exceeded ${JOB_TIMEOUT_MS}ms, killing yt-dlp`);
      child.kill('SIGKILL');
    }, JOB_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not start the downloader: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      console.error(`[worker] job ${job.id} yt-dlp exited (code=${code} signal=${signal})`);
      const failure = new Error(friendlyError(tail));
      failure.raw = tail; // retry logic needs the real output, not the friendly summary
      reject(failure);
    });
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

  // Clear anything a previous attempt left behind. Jobs retry (see attempts in src/queue.js), and
  // a half-written file from the first try must never be mistaken for this try's output.
  clearJobFiles(job.id);

  const outputTemplate = path.join(CLIPS_DIR, `${job.id}.%(ext)s`);

  // Twitch live clips are queued the moment they're created, so the first attempt often beats
  // Twitch's own rendering. Wait it out rather than reporting a failure for a clip that is fine.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await runYtDlp(job, outputTemplate);
      break;
    } catch (err) {
      const isTwitchClip = /clips\.twitch\.tv/i.test(job.data.url || '');
      const canWait = isTwitchClip && looksLikeClipNotRendered(err.raw) && attempt < CLIP_RENDER_WAITS_MS.length;
      if (!canWait) throw err;

      const wait = CLIP_RENDER_WAITS_MS[attempt];
      console.log(
        `[worker] job ${job.id} clip not rendered yet, waiting ${wait}ms (attempt ${attempt + 1}/${CLIP_RENDER_WAITS_MS.length})`
      );
      await job.updateProgress(10 + attempt * 10);
      clearJobFiles(job.id); // drop any stub the failed attempt left behind
      await sleep(wait);
    }
  }

  await job.updateProgress(90);

  // yt-dlp fills in the real extension, so find whatever it actually wrote. Temp files are
  // excluded deliberately: yt-dlp writes "<name>.mp4.part" while downloading, and that name also
  // starts with "<id>." — renaming one of those would hand back a truncated, corrupt clip.
  const produced = ownedFiles(job.id).find((name) => !isTempFile(name));
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
  const worker = new Worker(QUEUE_NAME, processClip, {
    connection,
    concurrency: 1,
    // A job orphaned by a platform restart is recoverable, so allow it to be picked back up
    // instead of being failed the first time it stalls. lockDuration gives extra slack in case
    // the download starves the event loop briefly.
    maxStalledCount: 3,
    lockDuration: 60000,
  });
  worker.on('failed', (job, err) => {
    console.error(`[worker] job ${job?.id} failed: ${err.message}`);
  });
  worker.on('ready', () => console.log('[worker] connected to queue, waiting for clip jobs'));
  console.log('[worker] queue consumer starting...');
}

// The instance was being restarted mid-job with nothing in the logs. These make the reason
// visible: a platform stop arrives as SIGTERM, a code bug as an exception/rejection.
process.on('SIGTERM', () => {
  console.error('[worker] SIGTERM received - the platform is stopping this instance');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.error('[worker] SIGINT received');
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  console.error('[worker] uncaught exception:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[worker] unhandled rejection:', err && err.stack ? err.stack : err);
});

sweepOldClips();
setInterval(sweepOldClips, 15 * 60 * 1000);
