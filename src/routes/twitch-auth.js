// Twitch user login + live clipping (Phase 2).
//
// Everything else in this app talks to Twitch with an APP token (client credentials), which can
// read public data but cannot act on anyone's behalf. Creating a clip is an action, so it needs a
// USER token carrying the clips:edit scope — hence the OAuth round trip here.
//
// Why go through Twitch's own Create Clip API instead of recording the stream ourselves: to grab
// "the thing that just happened" we'd have to be continuously recording every stream being
// watched, which would burn CPU, bandwidth and disk nonstop on a small instance. Twitch already
// keeps that buffer, so we ask Twitch to cut the clip and then just download the result through
// the normal clip pipeline.
//
// TOKEN STORAGE: this is a personal, single-user app, so the token is kept under one fixed Redis
// key rather than per-visitor sessions. Practical trade-off worth knowing: anyone who can reach
// this site can create clips under the connected Twitch account. Fine for a private tool; it would
// need real per-user sessions before being shared around.

const express = require('express');
const { createConnection, getQueue } = require('../queue');

const router = express.Router();

const TOKEN_KEY = 'twitch:user_token';
const STATE_PREFIX = 'twitch:oauth_state:';
const SCOPES = 'clips:edit';

// Twitch needs a few seconds to finish processing a new clip before it can be downloaded, so the
// download job is queued with a delay rather than racing it.
const CLIP_READY_DELAY_MS = 15000;

// Ask Twitch for the longest clip it allows. Without this the API publishes exactly 30 seconds,
// which leaves no room to trim afterwards. The parameter is newer than the rest of the endpoint,
// so requestClip() below degrades gracefully if this deployment of the API rejects it.
const CLIP_DURATION_SECONDS = Number(process.env.CLIP_DURATION_SECONDS) || null;


let redis = null;
function getRedis() {
  if (!redis) redis = createConnection();
  return redis;
}

function baseUrl(req) {
  // Render terminates TLS in front of the app, so trust the forwarded proto when present.
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.get('host')}`;
}

function redirectUri(req) {
  return `${baseUrl(req)}/api/twitch/callback`;
}

function creds() {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Twitch credentials are not configured.');
  return { clientId, clientSecret };
}

async function saveToken(payload) {
  const store = getRedis();
  if (!store) throw new Error('No Redis connection to store the Twitch token.');
  await store.set(TOKEN_KEY, JSON.stringify(payload));
}

async function loadToken() {
  const store = getRedis();
  if (!store) return null;
  const raw = await store.get(TOKEN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Access tokens last about four hours. Refresh a little early so a clip request never lands on an
// expired token mid-flight.
async function refreshToken(stored) {
  const { clientId, clientSecret } = creds();
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data.message || 'Could not refresh the Twitch login.');
  }
  const updated = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || stored.refreshToken,
    expiresAt: Date.now() + (data.expires_in || 0) * 1000,
  };
  await saveToken(updated);
  return updated;
}

async function validToken() {
  const stored = await loadToken();
  if (!stored) return null;
  if (stored.expiresAt && Date.now() > stored.expiresAt - 60_000) {
    return refreshToken(stored);
  }
  return stored;
}

// --- oauth ----------------------------------------------------------------

router.get('/twitch/login', async (req, res) => {
  try {
    const { clientId } = creds();
    const state = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const store = getRedis();
    if (store) await store.set(`${STATE_PREFIX}${state}`, '1', 'EX', 600);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri(req),
      response_type: 'code',
      scope: SCOPES,
      state,
      // Without this Twitch silently reuses whichever account already approved the app, which
      // makes it impossible to switch accounts after connecting the wrong one.
      force_verify: 'true',
    });
    res.redirect(`https://id.twitch.tv/oauth2/authorize?${params.toString()}`);
  } catch (err) {
    res.status(503).send(`Twitch login unavailable: ${err.message}`);
  }
});

router.get('/twitch/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    return res.redirect(`/?twitch=denied&reason=${encodeURIComponent(errorDescription || error)}`);
  }
  if (!code || !state) return res.redirect('/?twitch=error');

  try {
    const store = getRedis();
    if (store) {
      const ok = await store.get(`${STATE_PREFIX}${state}`);
      if (!ok) return res.redirect('/?twitch=error');
      await store.del(`${STATE_PREFIX}${state}`);
    }

    const { clientId, clientSecret } = creds();
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: String(code),
        grant_type: 'authorization_code',
        redirect_uri: redirectUri(req),
      }),
    });
    const data = await tokenRes.json();
    if (!tokenRes.ok || !data.access_token) {
      console.error('[twitch-auth] token exchange failed:', data);
      return res.redirect('/?twitch=error');
    }

    await saveToken({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in || 0) * 1000,
    });
    res.redirect('/?twitch=connected');
  } catch (err) {
    console.error('[twitch-auth] callback failed:', err.message);
    res.redirect('/?twitch=error');
  }
});

router.get('/twitch/status', async (req, res) => {
  try {
    const stored = await loadToken();
    res.json({ connected: Boolean(stored && stored.accessToken) });
  } catch {
    res.json({ connected: false });
  }
});

router.post('/twitch/disconnect', async (req, res) => {
  const store = getRedis();
  if (store) await store.del(TOKEN_KEY);
  res.json({ ok: true });
});

// --- live clipping --------------------------------------------------------

// One Create Clip call. duration is passed only when set, so the caller can retry without it.
async function requestClip(clientId, accessToken, broadcasterId, duration) {
  const params = new URLSearchParams({ broadcaster_id: String(broadcasterId) });
  if (duration) params.set('duration', String(duration));

  const res = await fetch(`https://api.twitch.tv/helix/clips?${params.toString()}`, {
    method: 'POST',
    headers: {
      'Client-Id': clientId,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

router.post('/twitch/clip', async (req, res) => {
  const { broadcasterId } = req.body || {};
  if (!broadcasterId || !/^\d+$/.test(String(broadcasterId))) {
    return res.status(400).json({ error: 'A numeric "broadcasterId" is required.' });
  }

  let token;
  try {
    token = await validToken();
  } catch (err) {
    return res.status(401).json({ error: err.message, needsLogin: true });
  }
  if (!token) {
    return res.status(401).json({ error: 'Connect your Twitch account first.', needsLogin: true });
  }

  try {
    const { clientId } = creds();

    let { res: clipRes, data } = await requestClip(
      clientId,
      token.accessToken,
      broadcasterId,
      CLIP_DURATION_SECONDS
    );

    // A 400 here most likely means this API deployment doesn't accept "duration". Retry without it
    // so a clip still gets made (just at Twitch's 30s default) instead of failing outright. The
    // logged response is the only reliable way to learn what the live API actually supports.
        if (clipRes.status === 400 && CLIP_DURATION_SECONDS) {
if (clipRes.status === 400) {
      console.warn(
        `[twitch-auth] duration=${CLIP_DURATION_SECONDS} rejected, retrying without it:`,
        JSON.stringify(data)
      );
      ({ res: clipRes, data } = await requestClip(clientId, token.accessToken, broadcasterId, null));
    }

    if (clipRes.status === 401) {
      return res.status(401).json({ error: 'Your Twitch login expired — connect again.', needsLogin: true });
    }
    if (clipRes.status === 404) {
      return res.status(400).json({ error: "That channel isn't live right now, so there's nothing to clip." });
    }
    // Twitch accepted the token but refuses the action. In practice this is almost always the
    // connected account rather than the channel: Twitch blocks clip creation from accounts that
    // are new or unverified. Offer a reconnect so a different account can be used.
    if (clipRes.status === 403) {
      return res.status(403).json({
        error:
          'Twitch will not let the connected account create clips (this usually means it is a new or unverified account). Connect the Twitch account you normally clip with:',
        needsLogin: true,
      });
    }
    if (!clipRes.ok || !data.data || !data.data[0]) {
      console.error('[twitch-auth] create clip failed:', clipRes.status, data);
      return res.status(502).json({ error: data.message || 'Twitch would not create the clip.' });
    }

        console.log(
      `[twitch-auth] clip created (duration requested: ${CLIP_DURATION_SECONDS || 'default'}):`,
      JSON.stringify(data.data[0])
    );

const clipId = data.data[0].id;
    const clipUrl = `https://clips.twitch.tv/${clipId}`;
    // Twitch captures ~90s (about 85s before the request) but only publishes ~30s of it by
    // default. edit_url opens Twitch's trimmer, where any 5-60s slice of that window can be
    // chosen. Valid for 24 hours. Surfaced so a clip can be widened before downloading.
    const editUrl = data.data[0].edit_url || `${clipUrl}/edit`;

    const queue = getQueue();
    if (!queue) {
      // The clip still exists on Twitch even if we can't queue the download.
      return res.status(503).json({ error: 'Clip was created on Twitch but downloading is not configured.', clipUrl });
    }

    // No start/end: the worker downloads the whole clip. Delayed because Twitch needs a moment to
    // finish processing before the clip is fetchable.
    const job = await queue.add(
      'clip',
      { url: clipUrl, startSeconds: null, endSeconds: null, platform: 'twitch', title: `Live clip ${clipId}` },
      { delay: CLIP_READY_DELAY_MS }
    );

    const workerUrl = (process.env.WORKER_URL || '').replace(/\/$/, '');
    res.status(202).json({
      clipId,
      clipUrl,
      editUrl,
      jobId: job.id,
      statusUrl: `${workerUrl}/status/${job.id}`,
      downloadUrl: `${workerUrl}/clips/${job.id}.mp4`,
    });
  } catch (err) {
    console.error('[twitch-auth] clip failed:', err.message);
    res.status(502).json({ error: 'Could not create the clip.' });
  }
});

// After trimming on Twitch, the same clip URL serves the edited version — so re-running the
// download is all that's needed to get the longer/retimed cut.
router.post('/twitch/redownload', async (req, res) => {
  const { clipId } = req.body || {};
  // Twitch clip slugs are word characters and dashes. Validating here keeps this endpoint from
  // being turned into a downloader for arbitrary URLs.
  if (!clipId || !/^[A-Za-z0-9_-]{1,120}$/.test(String(clipId))) {
    return res.status(400).json({ error: 'A valid "clipId" is required.' });
  }

  const queue = getQueue();
  if (!queue) return res.status(503).json({ error: 'Downloading is not configured.' });

  try {
    const job = await queue.add('clip', {
      url: `https://clips.twitch.tv/${clipId}`,
      startSeconds: null,
      endSeconds: null,
      platform: 'twitch',
      title: `Live clip ${clipId}`,
    });

    const workerUrl = (process.env.WORKER_URL || '').replace(/\/$/, '');
    res.status(202).json({
      jobId: job.id,
      statusUrl: `${workerUrl}/status/${job.id}`,
      downloadUrl: `${workerUrl}/clips/${job.id}.mp4`,
    });
  } catch (err) {
    console.error('[twitch-auth] redownload failed:', err.message);
    res.status(502).json({ error: 'Could not queue the download.' });
  }
});

module.exports = router;
