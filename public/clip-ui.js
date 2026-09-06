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
    if (parts.length === 3) return parts[0] *
