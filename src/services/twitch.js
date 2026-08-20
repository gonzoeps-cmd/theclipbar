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
  // Clips/VODs use "%{width}x%{height}"; live stream previews use "{width}x{height}" (no %).
  return url
    .replace('%{width}', String(width))
    .replace('%{height}', String(height))
    .replace('{width}', String(width))
    .replace('{height}', String(height));
}

// Checks whether a channel is currently live. Uses the app access token like everything else
// here — no broadcaster-scoped login needed for this endpoint.
async function getLiveStream(userId) {
  try {
    const data = await helixFetch(`/streams?user_id=${userId}`);
    const stream = data.data?.[0];
    if (!stream) return null;
    return {
      id: stream.id,
      title: stream.title,
      thumbnail: bestThumbnail(stream.thumbnail_url),
    };
  } catch (err) {
    // A live-check failure shouldn't break the whole lookup — just treat as "not live".
    console.error('[twitch] live check failed:', err.message);
    return null;
  }
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

function formatChannel(user, live = null) {
  return {
    id: user.id,
    title: user.display_name,
    thumbnail: user.profile_image_url,
    platform: 'twitch',
    login: user.login,
    live: live ? { id: live.id, title: live.title, thumbnail: live.thumbnail, kind: 'live' } : null,
  };
}

// type=archive == past broadcasts (VODs) — full-length streams.
async function getRecentVideos(handleRaw, maxResults = 12, after = null) {
  const user = await resolveUser(handleRaw);

  const afterParam = after ? `&after=${encodeURIComponent(after)}` : '';
  const videosData = await helixFetch(
    `/videos?user_id=${user.id}&first=${maxResults}&type=archive${afterParam}`
  );

  const videos = (videosData.data || []).map((v) => ({
    id: v.id,
    title: v.title,
    thumbnail: bestThumbnail(v.thumbnail_url),
    publishedAt: v.published_at || v.created_at,
    durationSeconds: twitchDurationToSeconds(v.duration),
    viewCount: v.view_count || 0,
    url: v.url,
    platform: 'twitch',
    kind: 'video',
  }));

  // Only check live status on a fresh lookup (not on "Load more" pages).
  const live = after ? null : await getLiveStream(user.id);

  return { channel: formatChannel(user, live), videos, nextPage: videosData.pagination?.cursor || null };
}

// Twitch's clips endpoint doesn't support pure recency sorting. When a range is given we
// scope to that window (via started_at) to keep results feeling "recent"; "all" skips the
// window entirely and falls back to Twitch's all-time top clips.
const CLIP_RANGE_MS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

async function getRecentClips(handleRaw, maxResults = 12, rangeKey = '30d', offset = 0) {
  const user = await resolveUser(handleRaw);

  const rangeMs = CLIP_RANGE_MS[rangeKey];
  const startedAtParam = rangeMs
    ? `&started_at=${encodeURIComponent(new Date(Date.now() - rangeMs).toISOString())}`
    : '';
  // Twitch's /clips endpoint always sorts by view count (trending), never by date — even
  // inside a started_at window. So we over-fetch its max page (100) and sort/paginate
  // ourselves to actually get the *most recent* clips, not just the most-viewed. This caps
  // us at the 100 most-viewed clips in the chosen window — a channel with more than 100
  // clips there may have older ones beyond this pool that "Load more" can't reach.
  const clipsData = await helixFetch(
    `/clips?broadcaster_id=${user.id}&first=100${startedAtParam}`
  );

  const allVideos = (clipsData.data || [])
    .map((c) => ({
      id: c.id,
      title: c.title,
      thumbnail: c.thumbnail_url || null,
      publishedAt: c.created_at,
      durationSeconds: Math.round(c.duration || 0),
      viewCount: c.view_count || 0,
      url: c.url,
      platform: 'twitch',
      kind: 'clip',
    }))
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const videos = allVideos.slice(offset, offset + maxResults);
  const nextOffset = offset + maxResults;
  const nextPage = nextOffset < allVideos.length ? String(nextOffset) : null;

  // Only check live status on a fresh lookup (not on "Load more" pages).
  const live = offset ? null : await getLiveStream(user.id);

  return { channel: formatChannel(user, live), videos, nextPage };
}

module.exports = { getRecentVideos, getRecentClips, twitchDurationToSeconds, getAppAccessToken, CLIP_RANGE_MS };
