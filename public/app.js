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

let twitchType = 'videos'; // 'videos' (VODs) or 'clips'
let clipRange = clipRangeSelect.value; // 'all' | '30d' | '7d' | '24h', clips only
let lastLookup = null; // { platform, handle } of the most recent successful lookup

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

function renderChannel(channel) {
  if (!channel) {
    channelCard.classList.add('hidden');
    channelCard.innerHTML = '';
    return;
  }
  channelCard.classList.remove('hidden');
  channelCard.innerHTML = `
    ${channel.thumbnail ? `<img src="${channel.thumbnail}" alt="${channel.title}" />` : ''}
    <div>
      <div style="font-weight:600;">${channel.title || 'Unknown channel'}</div>
      <div style="color:var(--muted); font-size:0.82rem; text-transform:capitalize;">${channel.platform}</div>
    </div>
  `;
}

function renderVideos(videos, emptyLabel) {
  results.innerHTML = '';
  if (!videos.length) {
    results.innerHTML = `<p style="color:var(--muted);">${emptyLabel}</p>`;
    return;
  }
  for (const video of videos) {
    const card = document.createElement('article');
    card.className = 'video-card';
    const platformLabel = video.platform === 'youtube' ? 'YouTube' : 'Twitch';
    const kindLabel = video.kind === 'clip' ? 'Clip' : video.platform === 'twitch' ? 'VOD' : '';
    const viewLabel = formatViewCount(video.viewCount);
    const metaParts = [formatDate(video.publishedAt), viewLabel].filter(Boolean);
    card.innerHTML = `
      <div class="thumb-wrap">
        ${video.thumbnail ? `<img src="${video.thumbnail}" alt="${video.title}" loading="lazy" />` : ''}
        <span class="duration-badge">${formatDuration(video.durationSeconds)}</span>
        ${kindLabel ? `<span class="kind-badge">${kindLabel}</span>` : ''}
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
    results.appendChild(card);
  }
}

async function runLookup(platform, handle) {
  submitBtn.disabled = true;
  renderChannel(null);
  results.innerHTML = '';
  const isClips = platform === 'twitch' && twitchType === 'clips';
  const noun = isClips ? 'clips' : platform === 'twitch' ? 'streams' : 'videos';
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
    renderChannel(data.channel);
    const emptyLabel = isClips
      ? `No clips found (${rangeLabel}).`
      : 'No recent videos found.';
    renderVideos(data.videos || [], emptyLabel);
    const count = data.videos?.length || 0;
    const countNoun = noun === 'clips' ? (count === 1 ? 'clip' : 'clips') : count === 1 ? noun.slice(0, -1) : noun;
    setStatus(`Found ${count} ${countNoun}${rangeLabel ? ` (${rangeLabel})` : ''}.`);
    lastLookup = { platform, handle };
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    submitBtn.disabled = false;
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
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  const url = btn.dataset.url;
  try {
    await copyToClipboard(url);
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 1500);
  } catch (err) {
    btn.textContent = 'Copy failed';
    setTimeout(() => {
      btn.textContent = 'Copy link';
    }, 1500);
  }
});

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
