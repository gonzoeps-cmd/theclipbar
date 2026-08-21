// TikTok has no official public API for checking whether an arbitrary creator is live —
// unlike YouTube/Twitch, there's no documented endpoint, API key, or quota system for this.
// This works by fetching TikTok's own public web pages and reading the page-state JSON that
// TikTok embeds into the HTML to render the page client-side. That's inherently a scrape: it
// has no contract with TikTok, no guaranteed uptime, and can break without warning if TikTok
// changes how it structures that JSON, or start rate-limiting/blocking requests if this is
// called too often. If lookups start failing, the JSON shapes in extractPageState/findUserInfo/
// findLiveRoom below are the first thing to check against what TikTok is actually sending now.

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
};

function cleanHandle(handleRaw) {
  return (handleRaw || '').trim().replace(/^@/, '');
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) {
    throw new Error(`TikTok page error (${res.status})`);
  }
  return res.text();
}

// TikTok embeds page state as JSON in one of these script tags depending on which version of
// the site rendered the page. Try the modern one first and fall back to the legacy one.
function extractPageState(html) {
  const modern = html.match(
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (modern) {
    try {
      return { shape: 'universal', data: JSON.parse(modern[1]) };
    } catch {
      // fall through to legacy shape
    }
  }
  const legacy = html.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
  if (legacy) {
    try {
      return { shape: 'sigi', data: JSON.parse(legacy[1]) };
    } catch {
      // fall through
    }
  }
  return null;
}

function findUserInfo(state) {
  if (!state) return null;
  if (state.shape === 'universal') {
    return state.data?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo?.user || null;
  }
  const users = state.data?.UserModule?.users;
  if (users) {
    const key = Object.keys(users)[0];
    return key ? users[key] : null;
  }
  return null;
}

function findLiveRoom(state) {
  if (!state) return null;
  if (state.shape === 'universal') {
    const scope = state.data?.__DEFAULT_SCOPE__ || {};
    return (
      scope['webapp.live-detail']?.liveRoom ||
      scope['webapp.live-detail']?.roomInfo?.liveRoom ||
      scope['live/detail']?.liveRoomInfo ||
      null
    );
  }
  return state.data?.LiveRoom?.liveRoomUserInfo?.liveRoom || null;
}

async function getProfile(username) {
  const html = await fetchHtml(`https://www.tiktok.com/@${encodeURIComponent(username)}`);
  const state = extractPageState(html);
  const user = findUserInfo(state);
  if (!user) {
    throw new Error(`Could not find TikTok user "@${username}"`);
  }
  return {
    id: user.id || user.secUid || username,
    username: user.uniqueId || username,
    title: user.nickname || user.uniqueId || username,
    thumbnail: user.avatarLarger || user.avatarMedium || user.avatarThumb || null,
  };
}

// Best-effort live check — any failure (network error, TikTok having changed the page shape,
// etc.) is treated as "not live" rather than breaking the whole lookup, same as the
// YouTube/Twitch live checks.
async function getLiveStatus(username) {
  try {
    const html = await fetchHtml(`https://www.tiktok.com/@${encodeURIComponent(username)}/live`);
    const state = extractPageState(html);
    const room = findLiveRoom(state);
    // TikTok uses status 2 for "currently broadcasting"; other values mean offline/ended.
    if (!room || room.status !== 2) return null;
    return {
      id: String(room.id || room.roomId || ''),
      title: room.title || null,
      thumbnail: room.cover?.url_list?.[0] || room.cover?.urlList?.[0] || room.coverUrl || null,
    };
  } catch (err) {
    console.error('[tiktok] live check failed:', err.message);
    return null;
  }
}

function formatChannel(profile, live = null) {
  return {
    id: profile.id,
    title: profile.title,
    thumbnail: profile.thumbnail,
    platform: 'tiktok',
    username: profile.username,
    live: live ? { id: live.id, title: live.title, thumbnail: live.thumbnail, kind: 'live' } : null,
  };
}

// TikTok doesn't offer any public, keyless way to list a creator's past videos (unlike the
// YouTube/Twitch APIs) — so a TikTok lookup only ever returns live status, never a video list.
async function getChannel(handleRaw) {
  const username = cleanHandle(handleRaw);
  const [profile, live] = await Promise.all([getProfile(username), getLiveStatus(username)]);
  return { channel: formatChannel(profile, live), videos: [], nextPage: null };
}

module.exports = { getChannel };
