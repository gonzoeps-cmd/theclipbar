const form = document.getElementById('lookup-form');
const submitBtn = document.getElementById('submit-btn');
const statusEl = document.getElementById('status');
const channelCard = document.getElementById('channel-card');
const results = document.getElementById('results');

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

function renderVideos(videos) {
  results.innerHTML = '';
  if (!videos.length) {
    results.innerHTML = '<p style="color:var(--muted);">No recent videos found.</p>';
    return;
  }
  for (const video of videos) {
    const card = document.createElement('article');
    card.className = 'video-card';
    card.innerHTML = `
      <div class="thumb-wrap">
        ${video.thumbnail ? `<img src="${video.thumbnail}" alt="${video.title}" loading="lazy" />` : ''}
        <span class="duration-badge">${formatDuration(video.durationSeconds)}</span>
      </div>
      <div class="body">
        <div class="title">${video.title}</div>
        <div class="meta">${formatDate(video.publishedAt)}</div>
        <a class="watch-link" href="${video.url}" target="_blank" rel="noopener">Watch on ${video.platform === 'youtube' ? 'YouTube' : 'Twitch'} &rarr;</a>
      </div>
    `;
    results.appendChild(card);
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const platform = document.getElementById('platform').value;
  const handle = document.getElementById('handle').value.trim();
  if (!handle) return;

  submitBtn.disabled = true;
  renderChannel(null);
  results.innerHTML = '';
  setStatus('Looking up channel...');

  try {
    const res = await fetch(`/api/lookup?platform=${encodeURIComponent(platform)}&handle=${encodeURIComponent(handle)}`);
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Lookup failed.');
    }
    renderChannel(data.channel);
    renderVideos(data.videos || []);
    setStatus(`Found ${data.videos?.length || 0} recent video${data.videos?.length === 1 ? '' : 's'}.`);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    submitBtn.disabled = false;
  }
});
