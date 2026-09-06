require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const lookupRouter = require('./routes/lookup');
const clipRouter = require('./routes/clip');

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

app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`TheClipBar server listening on http://localhost:${PORT}`);
});
