const form = document.getElementById('lookup-form');
const submitBtn = document.getElementById('submit-btn');
const statusEl = document.getElementById('status');
const channelCard = document.getElementById('channel-card');
const results = document.getElementById('results');
const platformSelect = document.getElementById('platform');
const handleInput = document.getElementById('handle');
const twitchTypeField = document.getElementById('twitch-type-field');
const twitchTypeButtons = document.querySelectorAll('#twitch-type .segmented-btn');
const clipRangeField = document.getElementById('clip-range-field');
const clipRangeSelect = document.getElementById('clip-range');

const CLIP_RANGE_LABELS = {
  all: 'all time',
  '30d': 'last 30 days',
  '7d': 'last 7 days',
  '24h': 'last 24 hours',
};

const loadMoreBtn = document.getElementById('load-more-btn');

let twitchType = 'videos'; // 'videos' (VODs) or 'clips'
let clipRange = clipRangeSelect.value; // 'all' | '30d' | '7d' | '24h', clips only
let lastLookup = null; // { platform, handle } of the most recent successful lookup
let nextPage = null; // opaque page token/cursor/offset for "Load more", or null if no more
let loadMoreLoading = false;

const FAVORITES_KEY = 'theclipbar_favorites';

function favoriteKey(platform, handle) {
  return `${platform}:${(handle || '').trim().toLowerCase().replace(/^@/, '')}`;
}

function getFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveFavoritesList(list) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
  } catch {
    // localStorage unavailable (e.g. private browsing) — favorites just won't persist.
  }
}

function isFavorite(platform, handle) {
  const key = favoriteKey(platform, handle);
  return getFavorites().some((f) => favoriteKey(f.platform, f.handle) === key);
}

function addFavorite({ platform, handle, title, thumbnail, channelId }) {
  const favs = getFavorites();
  const key = favoriteKey(platform, handle);
  if (favs.some((f) => favoriteKey(f.platform, f.handle) === key)) return;
  favs.unshift({ platform, handle, title, thumbnail, channelId: channelId || null });
  saveFavoritesList(favs);
  renderFavorites();
}

function removeFavorite(platform, handle) {
  const key = favoriteKey(platform, handle);
  saveFavoritesList(getFavorites().filter((f) => favoriteKey(f.platform, f.handle) !== key));
  renderFavorites();
}

const FAVORITES_PLATFORMS = ['youtube', 'twitch', 'tiktok'];

const favoritesEls = {
  youtube: {
    dropdown: document.getElementById('favorites-dropdown-youtube'),
    toggle: document.getElementById('favorites-toggle-youtube'),
    menu: document.getElementById('favorites-menu-youtube'),
    count: document.getElementById('favorites-count-youtube'),
  },
  twitch: {
    dropdown: document.getElementById('favorites-dropdown-twitch'),
    toggle: document.getElementById('favorites-toggle-twitch'),
    menu: document.getElementById('favorites-menu-twitch'),
    count: document.getElementById('favorites-count-twitch'),
  },
  tiktok: {
    dropdown: document.getElementById('favorites-dropdown-tiktok'),
    toggle: document.getElementById('favorites-toggle-tiktok'),
    menu: document.getElementById('favorites-menu-tiktok'),
    count: document.getElementById('favorites-count-tiktok'),
  },
};

function openFavoritesMenu(platform) {
  const { menu, toggle } = favoritesEls[platform];
  menu.classList.remove('hidden');
  toggle.setAttribute('aria-expanded', 'true');
}

function closeFavoritesMenu(platform) {
  const { menu, toggle } = favoritesEls[platform];
  menu.classList.add('hidden');
  toggle.setAttribute('aria-expanded', 'false');
}

function closeAllFavoritesMenus() {
  FAVORITES_PLATFORMS.forEach((p) => closeFavoritesMenu(p));
}

function toggleFavoritesMenu(platform) {
  const { menu } = favoritesEls[platform];
  if (menu.classList.contains('hidden')) {
    closeAllFavoritesMenus();
    openFavoritesMenu(platform);
  } else {
    closeFavoritesMenu(platform);
  }
}

function favoriteItemHtml(f) {
  let badge = '';
  if (f.isLive) {
    badge = '<span class="fav-status-badge fav-live-badge">&#9679; LIVE</span>';
  } else if (f.isNew) {
    badge = '<span class="fav-status-badge fav-new-badge">NEW</span>';
  }
  return `
    <div class="favorite-item" data-platform="${f.platform}" data-handle="${f.handle}">
      ${f.thumbnail ? `<img src="${f.thumbnail}" alt="" />` : `<span class="favorite-item-placeholder"></span>`}
      <span class="favorite-item-name">${f.title || f.handle}</span>
      ${badge}
      <button type="button" class="favorite-item-remove" data-platform="${f.platform}" data-handle="${f.handle}" title="Remove from favorites" aria-label="Remove from favorites">&times;</button>
    </div>
  `;
}

function renderFavorites() {
  const favs = getFavorites();
  FAVORITES_PLATFORMS.forEach((platform) => {
    const { dropdown, menu, count } = favoritesEls[platform];
    const platformFavs = favs.filter((f) => f.platform === platform);
    if (!platformFavs.length) {
      dropdown.classList.add('hidden');
      closeFavoritesMenu(platform);
      menu.innerHTML = '';
      return;
    }
    dropdown.classList.remove('hidden');
    count.textContent = String(platformFavs.length);
    menu.innerHTML = platformFavs.map(favoriteItemHtml).join('');
  });
}

function updateFavoriteMeta(platform, handle, patch) {
  const key = favoriteKey(platform, handle);
  const favs = getFavorites();
  const idx = favs.findIndex((f) => favoriteKey(f.platform, f.handle) === key);
  if (idx === -1) return;
  favs[idx] = { ...favs[idx], ...patch };
  saveFavoritesList(favs);
}

// "New" means posted within this window — checked directly against the video's own publish
// date, not against whatever we happened to see last time. That way it's correct from the very
// first check (no baseline needed) instead of only catching uploads that happen *after* the
// app started watching.
const NEW_UPLOAD_WINDOW_MS = 24 * 60 * 60 * 1000;

// Checks status for every saved favorite on a platform, then re-sorts that platform's dropdown
// so the most relevant creators show up first. Runs only when the dropdown is actually opened
// — not on a timer — to keep API usage reasonable.
//
// Twitch: checks live status (cheap, no quota limit) — anyone live now goes to the top — and
// also flags anyone whose latest VOD posted in the last 24 hours, so a creator who streamed
// recently but isn't live right now still bumps up with a NEW tag.
//
// YouTube: does NOT check live status here. YouTube's live check costs 100x more of its free
// daily quota than anything else the app does, and checking a whole favorites list of that
// cost every time it's opened blows through the day's quota almost immediately (live status
// still shows on the single-creator lookup page, just not across the whole favorites list).
// Instead this only checks for a recent upload (cheap), using the favorite's saved channel id
// when we have it to skip the expensive name-search step too. Favorites saved before this
// existed don't have a channel id yet — the first check for those falls back to the normal
// (pricier) lookup, and then remembers the id so every check after that is cheap.
//
// TikTok: checks both live status and recent uploads, same as Twitch — but both are best-effort
// page scrapes (see src/services/tiktok.js, since TikTok has no official API for either), and
// they're deliberately independent of each other: if TikTok changes something that breaks the
// video-feed scrape, live status keeps working fine, and vice versa. The video feed can also
// legitimately come back empty even when nothing's broken (TikTok doesn't always include it on
// the page), in which case isNew just comes back false for that favorite.
async function refreshFavoritesStatus(platform) {
  const favs = getFavorites().filter((f) => f.platform === platform);
  if (!favs.length) return;

  const withStatus = await Promise.all(
    favs.map(async (f) => {
      try {
        const params = new URLSearchParams({ platform, handle: f.handle });
        if (platform === 'youtube') {
          params.set('skipLive', '1');
          if (f.channelId) params.set('channelId', f.channelId);
        }
        const res = await fetch(`/api/lookup?${params.toString()}`);
        const data = await res.json();
        if (!res.ok) return { ...f, isLive: false, isNew: false };

        const isLive = (platform === 'twitch' || platform === 'tiktok') && !!data.channel?.live;
        const latest = data.videos?.[0] || null;
        const isNew = !!(
          latest?.publishedAt &&
          Date.now() - new Date(latest.publishedAt).getTime() < NEW_UPLOAD_WINDOW_MS
        );

        if (platform === 'youtube' && !f.channelId && data.channel?.id) {
          updateFavoriteMeta(platform, f.handle, { channelId: data.channel.id });
        }

        return { ...f, isLive, isNew };
      } catch {
        return { ...f, isLive: false, isNew: false };
      }
    })
  );

  // Live first, then new uploads, then everyone else — stable sort keeps the saved order
  // within each group.
  withStatus.sort((a, b) => {
    const score = (x) => (x.isLive ? 2 : x.isNew ? 1 : 0);
    return score(b) - score(a);
  });

  const { menu } = favoritesEls[platform];
  menu.innerHTML = withStatus.map(favoriteItemHtml).join('');
}

const FAVORITES_LAST_CHECK_KEY = 'theclipbar_favorites_last_check';
const DAY_MS = 24 * 60 * 60 * 1000;

function getLastCheckTimes() {
  try {
    const raw = localStorage.getItem(FAVORITES_LAST_CHECK_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function setLastCheckTime(platform, timestamp) {
  try {
    const times = getLastCheckTimes();
    times[platform] = timestamp;
    localStorage.setItem(FAVORITES_LAST_CHECK_KEY, JSON.stringify(times));
  } catch {
    // localStorage unavailable — the auto-check will just run again next time.
  }
}

// Runs once per page load: for each platform with favorites, if it's been 24+ hours (or this
// is the first time ever) since the last check, silently refresh live/new status in the
// background — so whenever you actually open the dropdown that day, it's already up to date.
// This can't guarantee an exact 7am run (nothing runs while the app is closed), but it means
// the first time you open the app each day, the list has already been refreshed for you.
async function autoRefreshFavoritesIfDue() {
  const lastChecks = getLastCheckTimes();
  const now = Date.now();
  for (const platform of FAVORITES_PLATFORMS) {
    const favs = getFavorites().filter((f) => f.platform === platform);
    if (!favs.length) continue;
    const last = lastChecks[platform] || 0;
    if (now - last >= DAY_MS) {
      setLastCheckTime(platform, now);
      await refreshFavoritesStatus(platform);
    }
  }
}

function formatDuration(totalSeconds) {
  if (!totalSeconds || totalSeconds <= 0) return '--:--';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function embedUrlFor({ id, platform, kind, channelLogin }) {
  const host = window.location.hostname;
  if (platform === 'youtube') {
    return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1`;
  }
  if (platform === 'tiktok') {
    return `https://www.tiktok.com/embed/v2/${encodeURIComponent(id)}`;
  }
  if (kind === 'live') {
    return `https://player.twitch.tv/?channel=${encodeURIComponent(channelLogin)}&parent=${host}&autoplay=true`;
  }
  if (kind === 'clip') {
    return `https://clips.twitch.tv/embed?clip=${encodeURIComponent(id)}&parent=${host}&autoplay=true`;
  }
  return `https://player.twitch.tv/?video=${encodeURIComponent(id)}&parent=${host}&autoplay=true`;
}

function openPlayer(thumbWrap) {
  document.querySelectorAll('.thumb-wrap.playing').forEach((el) => {
    if (el !== thumbWrap) closePlayer(el);
  });

  const iframe = document.createElement('iframe');
  iframe.className = 'player-iframe';
  iframe.src = embedUrlFor(thumbWrap.dataset);
  iframe.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
  iframe.allowFullscreen = true;
  iframe.frameBorder = '0';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'close-player-btn';
  closeBtn.setAttribute('aria-label', 'Close player');
  closeBtn.title = 'Close player';
  closeBtn.textContent = '✕';

  thumbWrap.appendChild(iframe);
  thumbWrap.appendChild(closeBtn);
  thumbWrap.classList.add('playing');
}

function closePlayer(thumbWrap) {
  thumbWrap.classList.remove('playing');
  thumbWrap.querySelector('.player-iframe')?.remove();
  thumbWrap.querySelector('.close-player-btn')?.remove();
}

function openLivePlayer() {
  const wrap = document.getElementById('live-player-wrap');
  if (!wrap) return;
  const { id, platform, channelLogin } = wrap.dataset;

  const iframe = document.createElement('iframe');
  iframe.className = 'player-iframe';
  iframe.src = embedUrlFor({ id, platform, kind: 'live', channelLogin });
  iframe.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
  iframe.allowFullscreen = true;
  iframe.frameBorder = '0';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'close-player-btn close-live-btn';
  closeBtn.setAttribute('aria-label', 'Close live player');
  closeBtn.title = 'Close live player';
  closeBtn.textContent = '✕';

  wrap.innerHTML = '';
  wrap.appendChild(iframe);
  wrap.appendChild(closeBtn);
  wrap.classList.remove('hidden');
  wrap.classList.add('playing');
}

function closeLivePlayer() {
  const wrap = document.getElementById('live-player-wrap');
  if (!wrap) return;
  wrap.classList.add('hidden');
  wrap.classList.remove('playing');
  wrap.innerHTML = '';
}

function formatViewCount(count) {
  if (!count && count !== 0) return null;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count % 1_000_000 === 0 ? 0 : 1)}M views`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(count % 1_000 === 0 ? 0 : 1)}K views`;
  return `${count} view${count === 1 ? '' : 's'}`;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function updateTwitchFieldVisibility() {
  const isTwitch = platformSelect.value === 'twitch';
  twitchTypeField.classList.toggle('hidden', !isTwitch);
  updateClipRangeVisibility();
}

function updateClipRangeVisibility() {
  const showClipRange = platformSelect.value === 'twitch' && twitchType === 'clips';
  clipRangeField.classList.toggle('hidden', !showClipRange);
}

function setTwitchType(nextType) {
  twitchType = nextType;
  twitchTypeButtons.forEach((btn) => {
    const isActive = btn.dataset.type === nextType;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-checked', String(isActive));
  });
  updateClipRangeVisibility();
}

function renderChannel(channel, platform, handle) {
  if (!channel) {
    channelCard.classList.add('hidden');
    channelCard.innerHTML = '';
    return;
  }
  channelCard.classList.remove('hidden');
  const fav = isFavorite(platform, handle);
  const live = channel.live;
  channelCard.innerHTML = `
    <div class="channel-card-top">
      ${channel.thumbnail
        ? platform === 'tiktok'
          ? `<a href="https://www.tiktok.com/@${encodeURIComponent((channel.username || handle).replace(/^@/, ''))}" title="View ${channel.title || handle}'s TikTok profile" style="display:inline-flex;cursor:pointer;"><img src="${channel.thumbnail}" alt="${channel.title}" /></a>`
          : `<img src="${channel.thumbnail}" alt="${channel.title}" />`
        : ''}
      <div class="channel-info">
        <div class="channel-name-row">
          <span style="font-weight:600;">${channel.title || 'Unknown channel'}</span>
          ${live ? `<span class="live-badge">&#9679; LIVE</span>` : ''}
        </div>
        <div style="color:var(--muted); font-size:0.82rem; text-transform:capitalize;">${channel.platform}</div>
      </div>
      <div class="channel-actions">
        ${live
          ? platform === 'tiktok'
            ? `<a class="watch-live-btn" href="https://www.tiktok.com/@${encodeURIComponent((channel.username || handle).replace(/^@/, ''))}/live">Watch live &#8599;</a>`
            : `<button type="button" class="watch-live-btn">Watch live</button>`
          : ''}
        <button
          type="button"
          class="fav-btn ${fav ? 'active' : ''}"
          data-platform="${platform}"
          data-handle="${handle}"
          data-title="${channel.title || handle}"
          data-thumbnail="${channel.thumbnail || ''}"
          data-channel-id="${channel.id || ''}"
          title="${fav ? 'Remove from favorites' : 'Save to favorites'}"
        >${fav ? '★ Saved' : '☆ Save'}</button>
      </div>
    </div>
    ${live && platform !== 'tiktok' ? `<div class="live-player-wrap hidden" id="live-player-wrap" data-id="${live.id || ''}" data-platform="${platform}" data-channel-login="${channel.login || handle}"></div>` : ''}
  `;
}

function buildVideoCard(video) {
  const card = document.createElement('article');
  card.className = 'video-card';
  const platformLabel = video.platform === 'youtube' ? 'YouTube' : video.platform === 'tiktok' ? 'TikTok' : 'Twitch';
  const kindLabel = video.kind === 'clip' ? 'Clip' : video.platform === 'twitch' ? 'VOD' : '';
  const viewLabel = formatViewCount(video.viewCount);
  const metaParts = [formatDate(video.publishedAt), viewLabel].filter(Boolean);
  card.innerHTML = `
    <div class="thumb-wrap" data-id="${video.id}" data-platform="${video.platform}" data-kind="${video.kind || 'video'}">
      ${video.thumbnail ? `<img src="${video.thumbnail}" alt="${video.title}" loading="lazy" />` : ''}
      <span class="duration-badge">${formatDuration(video.durationSeconds)}</span>
      ${kindLabel ? `<span class="kind-badge">${kindLabel}</span>` : ''}
      <button type="button" class="play-btn" aria-label="Play inline" title="Play here">&#9658;</button>
    </div>
    <div class="body">
      <div class="title">${video.title}</div>
      <div class="meta">${metaParts.join(' &middot; ')}</div>
      <div class="link-row">
        <a class="watch-link" href="${video.url}" target="_blank" rel="noopener">Watch on ${platformLabel} &rarr;</a>
        <button type="button" class="copy-btn" data-url="${video.url}" title="Copy link">Copy link</button>
      </div>
    </div>
  `;
  return card;
}

function renderVideos(videos, emptyLabel, { append = false } = {}) {
  if (!append) {
    results.innerHTML = '';
    if (!videos.length) {
      results.innerHTML = `<p style="color:var(--muted);">${emptyLabel}</p>`;
      return;
    }
  }
  for (const video of videos) {
    results.appendChild(buildVideoCard(video));
  }
}

async function runLookup(platform, handle) {
  submitBtn.disabled = true;
  renderChannel(null);
  results.innerHTML = '';
  nextPage = null;
  loadMoreBtn.classList.add('hidden');
  const isClips = platform === 'twitch' && twitchType === 'clips';
  const isTikTok = platform === 'tiktok';
  const noun = isClips ? 'clips' : platform === 'twitch' ? 'streams' : isTikTok ? 'live status' : 'videos';
  const rangeLabel = isClips ? CLIP_RANGE_LABELS[clipRange] : '';
  setStatus(`Looking up ${noun}${rangeLabel ? ` (${rangeLabel})` : ''}...`);

  try {
    const params = new URLSearchParams({ platform, handle });
    if (platform === 'twitch') {
      params.set('type', twitchType);
      if (isClips) {
        params.set('range', clipRange);
      }
    }
    const res = await fetch(`/api/lookup?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Lookup failed.');
    }
    renderChannel(data.channel, platform, handle);

    if (isTikTok) {
      // The video feed is best-effort (see src/services/tiktok.js) — TikTok doesn't always
      // include it on the page, so an empty list here doesn't necessarily mean anything's wrong.
      const emptyLabel = "Couldn't load a video feed for this profile right now (live status above still works either way).";
      renderVideos(data.videos || [], emptyLabel);
      const name = data.channel?.title || handle;
      const liveNote = data.channel?.live ? `${name} is live right now.` : `${name} isn't live right now.`;
      const videoCount = data.videos?.length || 0;
      const feedNote = videoCount ? ` Found ${videoCount} recent video${videoCount === 1 ? '' : 's'}.` : '';
      setStatus(`${liveNote}${feedNote}`);
    } else {
      const emptyLabel = isClips
        ? `No clips found (${rangeLabel}).`
        : 'No recent videos found.';
      renderVideos(data.videos || [], emptyLabel);
      const count = data.videos?.length || 0;
      const countNoun = noun === 'clips' ? (count === 1 ? 'clip' : 'clips') : count === 1 ? noun.slice(0, -1) : noun;
      setStatus(`Found ${count} ${countNoun}${rangeLabel ? ` (${rangeLabel})` : ''}.`);
    }

    lastLookup = { platform, handle };
    nextPage = data.nextPage || null;
    loadMoreBtn.classList.toggle('hidden', !nextPage);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    submitBtn.disabled = false;
  }
}

async function loadMore() {
  if (!lastLookup || !nextPage || loadMoreLoading) return;
  loadMoreLoading = true;
  loadMoreBtn.disabled = true;
  loadMoreBtn.textContent = 'Loading...';

  try {
    const { platform, handle } = lastLookup;
    const isClips = platform === 'twitch' && twitchType === 'clips';
    const params = new URLSearchParams({ platform, handle, page: nextPage });
    if (platform === 'twitch') {
      params.set('type', twitchType);
      if (isClips) {
        params.set('range', clipRange);
      }
    }
    const res = await fetch(`/api/lookup?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to load more.');
    }
    renderVideos(data.videos || [], '', { append: true });
    nextPage = data.nextPage || null;
    loadMoreBtn.classList.toggle('hidden', !nextPage);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    loadMoreLoading = false;
    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = 'Load more';
  }
}

async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Fallback for browsers/contexts without the async Clipboard API.
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

results.addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('.copy-btn');
  if (copyBtn) {
    const url = copyBtn.dataset.url;
    try {
      await copyToClipboard(url);
      const original = copyBtn.textContent;
      copyBtn.textContent = 'Copied!';
      copyBtn.classList.add('copied');
      setTimeout(() => {
        copyBtn.textContent = original;
        copyBtn.classList.remove('copied');
      }, 1500);
    } catch (err) {
      copyBtn.textContent = 'Copy failed';
      setTimeout(() => {
        copyBtn.textContent = 'Copy link';
      }, 1500);
    }
    return;
  }

  const closeBtn = e.target.closest('.close-player-btn');
  if (closeBtn) {
    closePlayer(closeBtn.closest('.thumb-wrap'));
    return;
  }

  const thumbWrap = e.target.closest('.thumb-wrap');
  if (thumbWrap && !thumbWrap.classList.contains('playing')) {
    openPlayer(thumbWrap);
  }
});

channelCard.addEventListener('click', (e) => {
  const liveBtn = e.target.closest('.watch-live-btn');
  if (liveBtn && liveBtn.tagName === 'BUTTON') {
    // TikTok's "Watch live" is a plain link to TikTok (no public embed player exists for
    // TikTok LIVE), so it navigates normally instead of opening the inline player.
    openLivePlayer();
    return;
  }

  const closeLiveBtn = e.target.closest('.close-live-btn');
  if (closeLiveBtn) {
    closeLivePlayer();
    return;
  }

  const btn = e.target.closest('.fav-btn');
  if (!btn) return;
  const { platform, handle, title, thumbnail, channelId } = btn.dataset;
  if (isFavorite(platform, handle)) {
    removeFavorite(platform, handle);
    btn.classList.remove('active');
    btn.textContent = '☆ Save';
    btn.title = 'Save to favorites';
  } else {
    addFavorite({ platform, handle, title, thumbnail, channelId });
    btn.classList.add('active');
    btn.textContent = '★ Saved';
    btn.title = 'Remove from favorites';
  }
});

FAVORITES_PLATFORMS.forEach((platform) => {
  const { toggle, menu } = favoritesEls[platform];

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasHidden = menu.classList.contains('hidden');
    toggleFavoritesMenu(platform);
    if (wasHidden) {
      refreshFavoritesStatus(platform);
    }
  });

  menu.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.favorite-item-remove');
    if (removeBtn) {
      e.stopPropagation();
      removeFavorite(removeBtn.dataset.platform, removeBtn.dataset.handle);
      return;
    }
    const item = e.target.closest('.favorite-item');
    if (item) {
      const { platform: itemPlatform, handle } = item.dataset;
      platformSelect.value = itemPlatform;
      handleInput.value = handle;
      updateTwitchFieldVisibility();
      closeFavoritesMenu(platform);
      runLookup(itemPlatform, handle);
    }
  });
});

document.addEventListener('click', (e) => {
  FAVORITES_PLATFORMS.forEach((platform) => {
    const { dropdown } = favoritesEls[platform];
    if (!dropdown.contains(e.target)) {
      closeFavoritesMenu(platform);
    }
  });
});

loadMoreBtn.addEventListener('click', loadMore);

platformSelect.addEventListener('change', updateTwitchFieldVisibility);

twitchTypeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.type === twitchType) return;
    setTwitchType(btn.dataset.type);
    // If we already have Twitch results on screen, refresh immediately so switching
    // between Videos and Clips doesn't require re-submitting the form.
    if (lastLookup && lastLookup.platform === 'twitch') {
      runLookup('twitch', lastLookup.handle);
    }
  });
});

clipRangeSelect.addEventListener('change', () => {
  clipRange = clipRangeSelect.value;
  // Refresh immediately if we're already looking at Twitch clips.
  if (lastLookup && lastLookup.platform === 'twitch' && twitchType === 'clips') {
    runLookup('twitch', lastLookup.handle);
  }
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const platform = platformSelect.value;
  const handle = handleInput.value.trim();
  if (!handle) return;
  runLookup(platform, handle);
});

updateTwitchFieldVisibility();
renderFavorites();
autoRefreshFavoritesIfDue();
