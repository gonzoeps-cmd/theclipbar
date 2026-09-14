require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const lookupRouter = require('./routes/lookup');
const clipRouter = require('./routes/clip');
const twitchAuthRouter = require('./routes/twitch-auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    youtubeConfigured: Boolean(process.env.YOUTUBE_API_KEY),
    twitchConfigured: Boolean(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET),
    clippingConfigured: Boolean(process.env.REDIS_URL && process.env.WORKER_URL),
  });
});

app.use('/api', lookupRouter);
app.use('/api', clipRouter);
app.use('/api', twitchAuthRouter);

// The marketing page is the front door; the app itself lives at /app. Both routes are declared
// before express.static so it can't serve public/index.html at "/" ahead of them.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// Everything else (app.js, style.css, logo.png, the clip UI scripts) is served as-is. The app's
// script tags use root-relative paths, so they resolve correctly from /app too.
app.use(express.static(PUBLIC_DIR));


app.listen(PORT, () => {
  console.log(`TheClipBar server listening on http://localhost:${PORT}`);
});
