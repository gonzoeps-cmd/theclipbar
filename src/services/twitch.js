const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const HELIX_BASE = 'https://api.twitch.tv/helix';

let cachedToken = null;
let cachedTokenExpiresAt = 0;

function creds() {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are not set');
  }
  return { clientId, clientSecret };
}

// Client Credentials OAuth flow — this is an *app* access token (no user login needed),
// good enough for reading public channel/video data. Cached in memory until near-expiry.
async function getAppAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) {
    return cachedToken;
  }
  const { clientId, clientSecret } = creds();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data?.message || 'Failed to get Twitch app access token');
  }
  cachedToken = data.access_token;
  // Refresh a bit early to avoid edge-of-expiry failures.
  cachedTokenExpiresAt = Date.now() + Math.max((data.expires_in || 0) - 60, 60) * 1000;
  return cachedToken;
}

async function helixFetch(path) {
  const { clientId } = creds();
  const token = await getAppAccessToken();
  const res = await fetch(`${HELIX_BASE}${path}`, {
    headers: {
      'Client-Id': clientId,
      Authorization: `Bearer ${token}`,
    },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || `Twitch API error (${res.status})`);
  }
  return data;
}

// Twitch VOD durations look like "1h2m3s", "45m10s", or "30s".
function twitchDurationToSeconds(duration) {
  if (!duration) return 0;
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(duration);
  if (!match) return 0;
  const [, h, m, s] = match;
  return (parseInt(h || '0', 10) * 3600) + (parseInt(m || '0', 10) * 60) + parseInt(s || '0', 10);
}

function bestThumbnail(url, width = 320, height = 180) {
  if (!url) return null;
  return url.replace('%{width}', String(width)).replace('%{height}', String(height));
}

async function resolveUser(handleRaw) {
  const login = handleRaw.trim().replace(/^@/, '').toLowerCase();
  const userData = await helixFetch(`/users?login=${encodeURIComponent(login)}`);
  const user = userData.data?.[0];
  if (!user) {
    throw new Error(`No Twitch channel found for "${handleRaw}"`);
  }
  return user;
}

function formatChannel(user) {
  return {
    id: user.id,
    title: user.display_name,
    thumbnail: user.profile_image_url,
    platform: 'twitch',
  };
}

// type=archive == past broadcasts (VODs) — full-length streams.
async function getRecentVideos(handleRaw, maxResults = 12) {
  const user = await resolveUser(handleRaw);

  const videosData = await helixFetch(
    `/videos?user_id=${user.id}&first=${maxResults}&type=archive`
  );

  const videos = (videosData.data || []).map((v) => ({
    id: v.id,
    title: v.title,
    thumbnail: bestThumbnail(v.thumbnail_url),
    publishedAt: v.published_at || v.created_at,
    durationSeconds: twitchDurationToSeconds(v.duration),
    url: v.url,
    platform: 'twitch',
    kind: 'video',
  }));

  return { channel: formatChannel(user), videos };
}

// Twitch's clips endpoint doesn't support pure recency sorting, so we scope to a recent
// window (last 30 days) to keep results feeling "recent" rather than all-time top clips.
async function getRecentClips(handleRaw, maxResults = 12) {
  const user = await resolveUser(handleRaw);

  const startedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const clipsData = await helixFetch(
    `/clips?broadcaster_id=${user.id}&first=${maxResults}&started_at=${encodeURIComponent(startedAt)}`
  );

  const videos = (clipsData.data || []).map((c) => ({
    id: c.id,
    title: c.title,
    thumbnail: c.thumbnail_url || null,
    publishedAt: c.created_at,
    durationSeconds: Math.round(c.duration || 0),
    url: c.url,
    platform: 'twitch',
    kind: 'clip',
  }));

  return { channel: formatChannel(user), videos };
}

module.exports = { getRecentVideos, getRecentClips, twitchDurationToSeconds, getAppAccessToken };
