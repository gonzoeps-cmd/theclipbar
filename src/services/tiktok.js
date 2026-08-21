// TikTok has no official public API for checking whether an arbitrary creator is live, or for
// listing a creator's videos — unlike YouTube/Twitch, there's no documented endpoint, API key,
// or quota system for either of those. This works by fetching TikTok's own public web pages and
// reading the page-state JSON that TikTok embeds into the HTML to render the page client-side.
// That's inherently a scrape: it has no contract with TikTok, no guaranteed uptime, and can
// break without warning if TikTok changes how it structures that JSON, or start
// rate-limiting/blocking requests if this is called too often.
//
// Live status and the video feed are kept deliberately independent so a break in one can never
// take down the other:
//   - getLiveStatus() fetches a different URL (.../live) and always catches its own errors,
//     falling back to "not live" — see getChannel() below.
//   - The video feed is parsed from the profile page separately from the profile info itself
//     (findVideoItems vs findUserInfo), in its own try/catch, falling back to an empty list.
// If lookups start failing, the JSON shapes in extractPageState/findUserInfo/findLiveRoom/
// findVideoItems below are the first thing to check against what TikTok is actually sending now.

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

// The list of a creator's recent videos, when TikTok includes it in the server-rendered profile
// page. TikTok increasingly loads this list via a separate signed client-side request instead of
// baking it into the page, so this can legitimately come back empty even when nothing is
// "broken" — that's why getChannel() below treats an empty result as normal, not an error.
function findVideoItems(state) {
  if (!state) return [];
  if (state.shape === 'universal') {
    const scope = state.data?.__DEFAULT_SCOPE__ || {};
    const candidates = [
      scope['webapp.user-detail']?.itemList,
      scope['webapp.user-detail']?.userPostList?.itemList,
      scope['user-post']?.list,
      scope['webapp.user-detail']?.userInfo?.itemList,
    ].filter(Array.isArray);
    return candidates[0] || [];
  }
  const itemModule = state.data?.ItemModule;
  if (itemModule && typeof itemModule === 'object') {
    return Object.values(itemModule);
  }
  return [];
}

function mapVideoItem(item, username) {
  const id = item?.id || item?.video?.id;
  if (!id) return null;
  const createTimeSec = Number(item.createTime || item.create_time || 0);
  return {
    id: String(id),
    title: item.desc || '',
    thumbnail:
      item.video?.cover ||
      item.video?.dynamicCover ||
      item.video?.originCover ||
      null,
    publishedAt: createTimeSec ? new Date(createTimeSec * 1000).toISOString() : null,
    durationSeconds: Math.round(item.video?.duration || 0),
    viewCount: Number(item.stats?.playCount ?? item.statsV2?.playCount ?? 0),
    url: `https://www.tiktok.com/@${encodeURIComponent(username)}/video/${id}`,
    platform: 'tiktok',
    kind: 'video',
  };
}

// Best-effort live check — any failure (network error, TikTok having changed the page shape,
// etc.) is treated as "not live" rather than breaking the whole lookup, same as the
// YouTube/Twitch live checks. This hits a different URL than the profile/video lookup below,
// so it never shares a failure with them.
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

async function getChannel(handleRaw) {
  const username = cleanHandle(handleRaw);

  // The profile page and the live page are different URLs, fetched in parallel, so a problem
  // fetching/parsing one can never affect the other.
  const [profileHtml, live] = await Promise.all([
    fetchHtml(`https://www.tiktok.com/@${encodeURIComponent(username)}`),
    getLiveStatus(username),
  ]);

  const state = extractPageState(profileHtml);
  const user = findUserInfo(state);
  if (!user) {
    throw new Error(`Could not find TikTok user "@${username}"`);
  }
  const profile = {
    id: user.id || user.secUid || username,
    username: user.uniqueId || username,
    title: user.nickname || user.uniqueId || username,
    thumbnail: user.avatarLarger || user.avatarMedium || user.avatarThumb || null,
  };

  // The video feed is parsed independently from the profile info above: a failure here (or
  // TikTok simply not including a video list on this page) falls back to an empty list rather
  // than breaking the profile/live parts of the lookup.
  let videos = [];
  try {
    videos = findVideoItems(state)
      .map((item) => mapVideoItem(item, profile.username))
      .filter(Boolean)
      .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  } catch (err) {
    console.error('[tiktok] video feed parse failed:', err.message);
    videos = [];
  }

  return { channel: formatChannel(profile, live), videos, nextPage: null };
}

// TEMPORARY DIAGNOSTIC — not used by the app itself. Reports the shape of a profile page's
// embedded JSON (top-level keys, and a search for anything that looks like a list of video
// items) so the real path can be found and wired into findVideoItems() above once discovered.
// Safe to remove once that's done; it never runs as part of a normal lookup.
function looksLikeVideoItem(obj) {
  return (
    obj &&
    typeof obj === 'object' &&
    !Array.isArray(obj) &&
    ('desc' in obj || 'video' in obj) &&
    ('stats' in obj || 'statsV2' in obj)
  );
}

function findArraysOfVideoItems(node, path = '', results = [], depth = 0, seen = new WeakSet()) {
  if (depth > 8 || node == null || typeof node !== 'object') return results;
  if (seen.has(node)) return results;
  seen.add(node);

  if (Array.isArray(node)) {
    if (node.length && looksLikeVideoItem(node[0])) {
      results.push({ path, length: node.length, sampleKeys: Object.keys(node[0]).slice(0, 25) });
    }
    node.slice(0, 5).forEach((item, i) =>
      findArraysOfVideoItems(item, `${path}[${i}]`, results, depth + 1, seen)
    );
  } else {
    for (const key of Object.keys(node)) {
      findArraysOfVideoItems(node[key], path ? `${path}.${key}` : key, results, depth + 1, seen);
    }
  }
  return results;
}

async function debugProfileShape(handleRaw) {
  const username = cleanHandle(handleRaw);
  const html = await fetchHtml(`https://www.tiktok.com/@${encodeURIComponent(username)}`);
  const state = extractPageState(html);
  if (!state) {
    return {
      found: false,
      reason: 'No __UNIVERSAL_DATA_FOR_REHYDRATION__ or SIGI_STATE script tag found on the page.',
      htmlLength: html.length,
    };
  }
  const topLevelKeys =
    state.shape === 'universal' ? Object.keys(state.data?.__DEFAULT_SCOPE__ || {}) : Object.keys(state.data || {});
  const userDetailKeys =
    state.shape === 'universal'
      ? Object.keys(state.data?.__DEFAULT_SCOPE__?.['webapp.user-detail'] || {})
      : null;
  const videoArrayHits = findArraysOfVideoItems(state.data);

  return { shape: state.shape, topLevelKeys, userDetailKeys, videoArrayHits, htmlLength: html.length };
}

module.exports = { getChannel, debugProfileShape };
