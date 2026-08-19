const API_BASE = 'https://www.googleapis.com/youtube/v3';

function apiKey() {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error('YOUTUBE_API_KEY is not set');
  return key;
}

// Converts an ISO 8601 duration (e.g. "PT1H2M10S") to whole seconds.
function isoDurationToSeconds(iso) {
  if (!iso) return 0;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!match) return 0;
  const [, h, m, s] = match;
  return (parseInt(h || '0', 10) * 3600) + (parseInt(m || '0', 10) * 60) + parseInt(s || '0', 10);
}

async function fetchJson(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    const message = data?.error?.message || `YouTube API error (${res.status})`;
    throw new Error(message);
  }
  return data;
}

// Resolves a handle (with or without leading @) or legacy username to a channel resource
// with contentDetails (needed for the uploads playlist id).
async function resolveChannel(handleRaw) {
  const key = apiKey();
  const trimmed = handleRaw.trim();
  // Only trust exact handle/username lookups when the person actually typed "@something" —
  // that's an unambiguous real handle. A bare name like "AMP" is a search term, not a handle,
  // and matching it against forHandle can land on a totally unrelated channel that happens to
  // own that literal handle instead of the popular channel the person meant.
  const isExplicitHandle = trimmed.startsWith('@');
  const cleanHandle = trimmed.replace(/^@/, '');

  if (isExplicitHandle) {
    // 1) Modern handle lookup.
    let data = await fetchJson(
      `${API_BASE}/channels?part=id,snippet,contentDetails&forHandle=${encodeURIComponent(cleanHandle)}&key=${key}`
    );
    if (data.items?.length) return data.items[0];

    // 2) Legacy username lookup.
    data = await fetchJson(
      `${API_BASE}/channels?part=id,snippet,contentDetails&forUsername=${encodeURIComponent(cleanHandle)}&key=${key}`
    );
    if (data.items?.length) return data.items[0];
  }

  // 3) Relevance-ranked search — the default for plain names, and the fallback if an
  // explicit handle/username didn't match anything.
  const searchData = await fetchJson(
    `${API_BASE}/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(cleanHandle)}&key=${key}`
  );
  const channelId = searchData.items?.[0]?.snippet?.channelId;
  if (!channelId) {
    throw new Error(`No YouTube channel found for "${handleRaw}"`);
  }
  const data = await fetchJson(
    `${API_BASE}/channels?part=id,snippet,contentDetails&id=${channelId}&key=${key}`
  );
  if (!data.items?.length) {
    throw new Error(`No YouTube channel found for "${handleRaw}"`);
  }
  return data.items[0];
}

async function getRecentVideos(handleRaw, maxResults = 12, pageToken = null) {
  const key = apiKey();
  const channel = await resolveChannel(handleRaw);
  const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) {
    throw new Error('Could not find an uploads playlist for this channel');
  }

  const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
  const playlistData = await fetchJson(
    `${API_BASE}/playlistItems?part=contentDetails&playlistId=${uploadsPlaylistId}&maxResults=${maxResults}${pageParam}&key=${key}`
  );
  const videoIds = (playlistData.items || [])
    .map((item) => item.contentDetails?.videoId)
    .filter(Boolean);

  if (!videoIds.length) {
    return { channel: formatChannel(channel), videos: [], nextPage: null };
  }

  const videosData = await fetchJson(
    `${API_BASE}/videos?part=snippet,contentDetails,statistics&id=${videoIds.join(',')}&key=${key}`
  );

  const videos = (videosData.items || []).map((v) => ({
    id: v.id,
    title: v.snippet?.title,
    thumbnail:
      v.snippet?.thumbnails?.medium?.url ||
      v.snippet?.thumbnails?.default?.url ||
      null,
    publishedAt: v.snippet?.publishedAt,
    durationSeconds: isoDurationToSeconds(v.contentDetails?.duration),
    viewCount: parseInt(v.statistics?.viewCount || '0', 10),
    url: `https://www.youtube.com/watch?v=${v.id}`,
    platform: 'youtube',
  }));

  return { channel: formatChannel(channel), videos, nextPage: playlistData.nextPageToken || null };
}

function formatChannel(channel) {
  return {
    id: channel.id,
    title: channel.snippet?.title,
    thumbnail:
      channel.snippet?.thumbnails?.medium?.url ||
      channel.snippet?.thumbnails?.default?.url ||
      null,
    platform: 'youtube',
  };
}

module.exports = { getRecentVideos, isoDurationToSeconds };
