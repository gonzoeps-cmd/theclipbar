// Downloads the binaries the clip worker shells out to: yt-dlp, ffmpeg, and auto-editor.
// Runs automatically via the "postinstall" script in package.json.
//
// Why fetch these instead of installing npm packages for them:
//   yt-dlp       - the npm wrappers pin their own copy, and a stale yt-dlp breaks constantly as
//                  sites change. Pulling the latest release means every deploy gets a current
//                  binary, and yt-dlp_linux is self-contained so no Python is needed on the server.
//   ffmpeg       - the ffmpeg-static npm package's binary segfaulted here (ffmpeg exited with code
//                  -11) when yt-dlp handed it a Twitch HLS stream. yt-dlp publishes its own ffmpeg
//                  builds specifically for smooth integration with yt-dlp, so we use those instead.
//   auto-editor  - powers the "Cut dead air" button. Public domain, no account and no telemetry;
//                  the released Linux binary ships its own FFmpeg inside, so there is nothing else
//                  to install and no Python or Nim toolchain on the server.
//
// Deliberately FAIL-SOFT: if a download fails this logs and exits 0 rather than failing the whole
// npm install. The web service and the worker share this package.json, and a GitHub hiccup must
// never take down the main site's deploy. The worker checks for each binary at runtime and reports
// a clear error if one is missing.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
const FFMPEG_URL =
  'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz';

// Render runs x86_64, but pick by architecture so this still works if that ever changes.
const AUTO_EDITOR_URL =
  'https://github.com/WyattBlue/auto-editor/releases/latest/download/auto-editor-linux-' +
  (process.arch === 'arm64' ? 'aarch64' : 'x86_64');

const BIN_DIR = path.join(__dirname, '..', 'bin');

async function download(url, dest, minBytes) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < minBytes) {
    throw new Error(`downloaded file looks too small (${buf.length} bytes) for ${url}`);
  }
  fs.writeFileSync(dest, buf);
  return buf.length;
}

async function fetchYtDlp() {
  const dest = path.join(BIN_DIR, 'yt-dlp');
  const bytes = await download(YTDLP_URL, dest, 1_000_000);
  fs.chmodSync(dest, 0o755);
  console.log(`[postinstall] yt-dlp ready (${bytes} bytes)`);
}

async function fetchFfmpeg() {
  const archive = path.join(BIN_DIR, 'ffmpeg.tar.xz');
  const bytes = await download(FFMPEG_URL, archive, 5_000_000);

  // Pull just the two binaries straight out of the archive's bin/ directory. --wildcards keeps this
  // working even if the top-level folder name in the release changes.
  execFileSync(
    'tar',
    ['-xJf', archive, '-C', BIN_DIR, '--strip-components=2', '--wildcards', '*/bin/ffmpeg', '*/bin/ffprobe'],
    { stdio: 'inherit' }
  );

  fs.unlinkSync(archive);
  fs.chmodSync(path.join(BIN_DIR, 'ffmpeg'), 0o755);
  fs.chmodSync(path.join(BIN_DIR, 'ffprobe'), 0o755);
  console.log(`[postinstall] ffmpeg + ffprobe ready (archive was ${bytes} bytes)`);
}

async function fetchAutoEditor() {
  const dest = path.join(BIN_DIR, 'auto-editor');
  // ~45MB because FFmpeg is statically linked in, so the floor here is much higher than yt-dlp's.
  const bytes = await download(AUTO_EDITOR_URL, dest, 20_000_000);
  fs.chmodSync(dest, 0o755);
  console.log(`[postinstall] auto-editor ready (${bytes} bytes)`);
}

async function main() {
  // Only meaningful on Linux (Render). Skip elsewhere so a local install on a Mac/Windows box
  // doesn't pull down Linux binaries it can't run.
  if (process.platform !== 'linux') {
    console.log('[postinstall] not linux, skipping binary downloads');
    return;
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });

  // Fetch all of them even if one fails, so a single bad download doesn't hide the state of the
  // others. A missing auto-editor only disables the "Cut dead air" button; clipping still works.
  const results = await Promise.allSettled([fetchYtDlp(), fetchFfmpeg(), fetchAutoEditor()]);
  for (const r of results) {
    if (r.status === 'rejected') {
      console.warn(`[postinstall] WARNING: ${r.reason && r.reason.message}`);
    }
  }
}

main().catch((err) => {
  console.warn(`[postinstall] WARNING: binary setup failed: ${err.message}`);
  console.warn('[postinstall] continuing anyway — clip jobs will report this as an error until fixed.');
  process.exit(0);
});
