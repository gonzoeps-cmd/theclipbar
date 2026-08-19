const form = document.getElementById('lookup-form');
const submitBtn = document.getElementById('submit-btn');
const statusEl = document.getElementById('status');
const channelCard = document.getElementById('channel-card');
const results = document.getElementById('results');
const platformSelect = document.getElementById('platform');
const handleInput = document.getElementById('handle');
const twitchTypeField = document.getElementById('twitch-type-field');
const twitchTypeButtons = document.querySelectorAll('#twitch-type .segmented-btn');

let twitchType = 'videos'; // 'videos' (VODs) or 'clips'
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

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function updateTwitchFieldVisibility() {
  const isTwitch = platformSelect.value === 'twitch';
  twitchTypeField.classList.toggle('hidden', !isTwitch);
}

function setTwitchType(nextType) {
  twitchType = nextType;
  twitchTypeButtons.forEach((btn) => {
    const isActive = btn.dataset.type === nextType;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-checked', String(isActive));
  });
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
    card.innerHTML = `
      <div class="thumb-wrap">
        ${video.thumbnail ? `<img src="${video.thumbnail}" alt="${video.title}" loading="lazy" />` : ''}
        <span class="duration-badge">${formatDuration(video.durationSeconds)}</span>
        ${kindLabel ? `<span class="kind-badge">${kindLabel}</span>` : ''}
      </div>
      <div class="body">
        <div class="title">${video.title}</div>
        <div class="meta">${formatDate(video.publishedAt)}</div>
        <a class="watch-link" href="${video.url}" target="_blank" rel="noopener">Watch on ${platformLabel} &rarr;</a>
      </div>
    `;
    results.appendChild(card);
  }
}

async function runLookup(platform, handle) {
  submitBtn.disabled = true;
  renderChannel(null);
  results.innerHTML = '';
  const noun = platform === 'twitch' && twitchType === 'clips' ? 'clips' : platform === 'twitch' ? 'streams' : 'videos';
  setStatus(`Looking up ${noun}...`);

  try {
    const params = new URLSearchParams({ platform, handle });
    if (platform === 'twitch') {
      params.set('type', twitchType);
    }
    const res = await fetch(`/api/lookup?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Lookup failed.');
    }
    renderChannel(data.channel);
    const emptyLabel = platform === 'twitch' && twitchType === 'clips'
      ? 'No recent clips found (looked back 30 days).'
      : 'No recent videos found.';
    renderVideos(data.videos || [], emptyLabel);
    const count = data.videos?.length || 0;
    setStatus(`Found ${count} recent ${noun === 'clips' ? (count === 1 ? 'clip' : 'clips') : count === 1 ? noun.slice(0, -1) : noun}.`);
    lastLookup = { platform, handle };
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    submitBtn.disabled = false;
  }
}

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

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const platform = platformSelect.value;
  const handle = handleInput.value.trim();
  if (!handle) return;
  runLookup(platform, handle);
});

updateTwitchFieldVisibility();
