// Clipping UI (Phase 2). Deliberately self-contained: this file injects its own styles and hooks
// itself onto the video cards that app.js renders, rather than being woven into app.js. That keeps
// the clipping feature separable — if it ever needs to be pulled out or breaks, nothing in the
// existing lookup/favorites code is touched.
//
// Flow: pick a start/end on a video card -> POST /api/clip (the web service just queues it) ->
// poll the worker's /status/<jobId> until it's done -> hand over a download link. See src/queue.js
// for why the work happens on a separate service instead of in the request.

(function () {
  'use strict';

  const results = document.getElementById('results');
  if (!results) return;

  const POLL_INTERVAL_MS = 2000;
  const POLL_TIMEOUT_MS = 10 * 60 * 1000;
  const MAX_CLIP_SECONDS = 300; // must match MAX_CLIP_SECONDS in src/routes/clip.js

  // --- styles ---------------------------------------------------------------
  // Injected here rather than in style.css so this feature owns its own presentation.
  const style = document.createElement('style');
  style.textContent = `
    .clip-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--muted);
      padding: 4px 9px;
      border-radius: 6px;
      font-size: 0.76rem;
      cursor: pointer;
      white-space: nowrap;
    }
    .clip-btn:hover { color: var(--accent); border-color: var(--accent); }
    .clip-btn.open { color: var(--accent); border-color: var(--accent); }
    .clip-panel {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .clip-times { display: flex; gap: 8px; }
    .clip-times label {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 0.72rem;
      color: var(--muted);
    }
    .clip-times input {
      background: #0d0f14;
      border: 1px solid var(--border);
      color: var(--text);
      padding: 7px 9px;
      border-radius: 6px;
      font-size: 0.85rem;
      width: 100%;
    }
    .clip-make-btn {
      background: var(--accent);
      color: #fff;
      border: none;
      padding: 8px 14px;
      border-radius: 6px;
      font-size: 0.82rem;
      cursor: pointer;
    }
    .clip-make-btn:hover { background: var(--accent-hover); }
    .clip-make-btn:disabled { opacity: 0.6; cursor: default; }
    .clip-msg { font-size: 0.78rem; color: var(--muted); line-height: 1.4; }
    .clip-msg.error { color: #ff6b6b; }
    .clip-download {
      display: inline-block;
      background: #2ea043;
      color: #fff;
      text-decoration: none;
      padding: 8px 14px;
      border-radius: 6px;
      font-size: 0.82rem;
      text-align: center;
    }
    .clip-download:hover { background: #278036; }
  `;
  document.head.appendChild(style);

  // --- time helpers ---------------------------------------------------------

  // Accepts "90", "1:30", or "1:02:03" so people can type whatever's natural.
  function parseTime(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    if (!/^[\d:]+$/.test(text)) return null;
    const parts = text.split(':').map((p) => Number(p));
    if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }

  function formatSeconds(total) {
    const s = Math.max(0, Math.round(total));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${String(rem).padStart(2, '0')}`;
  }

  // --- panel wiring ---------------------------------------------------------

  function buildPanel(card) {
    const panel = document.createElement('div');
    panel.className = 'clip-panel';
    panel.innerHTML = `
      <div class="clip-times">
        <label>Start (mm:ss)<input type="text" class="clip-start" placeholder="0:00" inputmode="numeric" /></label>
        <label>End (mm:ss)<input type="text" class="clip-end" placeholder="0:30" inputmode="numeric" /></label>
      </div>
      <button type="button" class="clip-make-btn">Create clip</button>
      <div class="clip-msg"></div>
    `;
    card.querySelector('.body').appendChild(panel);
    return panel;
  }

  function videoInfoFor(card) {
    const copyBtn = card.querySelector('.copy-btn');
    const watchLink = card.querySelector('.watch-link');
    const thumb = card.querySelector('.thumb-wrap');
    return {
      url: (copyBtn && copyBtn.dataset.url) || (watchLink && watchLink.href) || '',
      platform: (thumb && thumb.dataset.platform) || null,
      title: (card.querySelector('.title') || {}).textContent || null,
    };
  }

  async function pollUntilDone(statusUrl, onTick) {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      let data;
      try {
        const res = await fetch(statusUrl);
        data = await res.json();
      } catch {
        // A transient network blip shouldn't kill the whole wait — keep polling.
        continue;
      }
      if (data.state === 'completed') return { ok: true };
      if (data.state === 'failed') return { ok: false, error: data.error || 'The clip failed.' };
      onTick(data.state, data.progress || 0);
    }
    return { ok: false, error: 'Timed out waiting for the clip. It may still be processing.' };
  }

  async function createClip(panel, card) {
    const msg = panel.querySelector('.clip-msg');
    const makeBtn = panel.querySelector('.clip-make-btn');
    const existingLink = panel.querySelector('.clip-download');
    if (existingLink) existingLink.remove();

    const start = parseTime(panel.querySelector('.clip-start').value);
    const end = parseTime(panel.querySelector('.clip-end').value);

    msg.classList.remove('error');

    if (start === null || end === null) {
      msg.classList.add('error');
      msg.textContent = 'Enter times like 1:30 (or plain seconds).';
      return;
    }
    if (end <= start) {
      msg.classList.add('error');
      msg.textContent = 'The end time has to come after the start time.';
      return;
    }
    if (end - start > MAX_CLIP_SECONDS) {
      msg.classList.add('error');
      msg.textContent = `Clips are capped at ${MAX_CLIP_SECONDS / 60} minutes for now (you asked for ${formatSeconds(end - start)}).`;
      return;
    }

    const info = videoInfoFor(card);
    if (!info.url) {
      msg.classList.add('error');
      msg.textContent = "Couldn't work out this video's link.";
      return;
    }

    makeBtn.disabled = true;
    msg.textContent = 'Queueing...';

    let job;
    try {
      const res = await fetch('/api/clip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: info.url, start, end, platform: info.platform, title: info.title }),
      });
      job = await res.json();
      if (!res.ok) throw new Error(job.error || 'Could not start the clip.');
    } catch (err) {
      makeBtn.disabled = false;
      msg.classList.add('error');
      msg.textContent = err.message;
      return;
    }

    msg.textContent = `Working on your ${formatSeconds(end - start)} clip — this can take a minute...`;

    const outcome = await pollUntilDone(job.statusUrl, (state) => {
      msg.textContent =
        state === 'active'
          ? `Downloading and cutting your ${formatSeconds(end - start)} clip...`
          : 'Waiting for a free worker...';
    });

    makeBtn.disabled = false;

    if (!outcome.ok) {
      msg.classList.add('error');
      msg.textContent = outcome.error;
      return;
    }

    msg.textContent = 'Clip ready.';
    const link = document.createElement('a');
    link.className = 'clip-download';
    link.href = job.downloadUrl;
    link.textContent = 'Download clip';
    link.setAttribute('download', '');
    panel.appendChild(link);
  }

  // --- inject the button onto each card ------------------------------------

  function decorate(card) {
    if (card.dataset.clipReady) return;
    const linkRow = card.querySelector('.link-row');
    if (!linkRow) return;
    card.dataset.clipReady = '1';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'clip-btn';
    btn.textContent = '✂ Clip';
    btn.title = 'Cut a clip from this video';
    linkRow.appendChild(btn);
  }

  function decorateAll() {
    results.querySelectorAll('.video-card').forEach(decorate);
  }

  // app.js re-renders the results list on every lookup and "Load more", so watch for new cards
  // instead of decorating once at startup.
  new MutationObserver(decorateAll).observe(results, { childList: true });
  decorateAll();

  results.addEventListener('click', (e) => {
    const btn = e.target.closest('.clip-btn');
    if (btn) {
      const card = btn.closest('.video-card');
      let panel = card.querySelector('.clip-panel');
      if (panel) {
        panel.remove();
        btn.classList.remove('open');
      } else {
        panel = buildPanel(card);
        btn.classList.add('open');
      }
      return;
    }

    const makeBtn = e.target.closest('.clip-make-btn');
    if (makeBtn) {
      const panel = makeBtn.closest('.clip-panel');
      createClip(panel, makeBtn.closest('.video-card'));
    }
  });
})();
