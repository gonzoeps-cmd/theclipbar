// Downloads the standalone yt-dlp binary at build time (npm install runs this via "postinstall").
//
// Why fetch it here instead of using an npm wrapper package: the wrappers pin their own copy of the
// yt-dlp binary, and a stale yt-dlp breaks constantly as sites change. Grabbing the latest release
// straight from yt-dlp's GitHub means every deploy gets a current binary. yt-dlp_linux is the
// self-contained build, so no Python install is needed on the server.
//
// This is deliberately FAIL-SOFT: if the download doesn't work, it logs and exits 0 rather than
// failing the whole npm install. Both the web service and the worker share this package.json, and a
// GitHub hiccup here must never take down the main site's deploy. The worker checks for the binary
// at runtime and reports a clear error if it's missing.

const fs = require('fs');
const path = require('path');

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
const BIN_DIR = path.join(__dirname, '..', 'bin');
const BIN_PATH = path.join(BIN_DIR, 'yt-dlp');

async function main() {
  // Only meaningful on Linux (Render). Skip elsewhere so local installs on a Mac/Windows box
  // don't pull down a Linux binary they can't run.
  if (process.platform !== 'linux') {
    console.log('[fetch-ytdlp] not linux, skipping yt-dlp download');
    return;
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });

  console.log('[fetch-ytdlp] downloading yt-dlp...');
  const res = await fetch(YTDLP_URL, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`download failed (${res.status})`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1_000_000) {
    throw new Error(`downloaded file looks too small (${buf.length} bytes)`);
  }

  fs.writeFileSync(BIN_PATH, buf);
  fs.chmodSync(BIN_PATH, 0o755);
  console.log(`[fetch-ytdlp] yt-dlp ready at ${BIN_PATH} (${buf.length} bytes)`);
}

main().catch((err) => {
  console.warn(`[fetch-ytdlp] WARNING: could not download yt-dlp: ${err.message}`);
  console.warn('[fetch-ytdlp] continuing anyway — clip jobs will report this as an error until it is fixed.');
  process.exit(0);
});
