// Clipping UI (Phase 2). Self-contained on purpose: hooks onto the cards app.js renders and
// injects its own styles, so nothing in the existing lookup/favorites code has to change.
// Flow: pick start/end -> POST /api/clip (queues it) -> poll worker /status -> download link.
(function () {
  'use strict';
  var results = document.getElementById('results');
  if (!results) return;

  var POLL_MS = 2000, TIMEOUT_MS = 600000, MAX_SECS = 300; // MAX_SECS matches src/routes/clip.js

  var css = '.clip-btn{background:transparent;border:1px solid var(--border);color:var(--muted);'
    + 'padding:4px 9px;border-radius:6px;font-size:.76rem;cursor:pointer;white-space:nowrap}'
    + '.clip-btn:hover,.clip-btn.open{color:var(--accent);border-color:var(--accent)}'
    + '.clip-panel{margin-top:10px;padding-top:10px;border-top:1px solid var(--border);'
    + 'display:flex;flex-direction:column;gap:8px}'
    + '.clip-times{display:flex;gap:8px}'
    + '.clip-times label{flex:1;display:flex;flex-direction:column;gap:4px;font-size:.72rem;color:var(--muted)}'
    + '.clip-times input{background:#0d0f14;border:1px solid var(--border);color:var(--text);'
    + 'padding:7px 9px;border-radius:6px;font-size:.85rem;width:100%}'
    + '.clip-make-btn{background:var(--accent);color:#fff;border:none;padding:8px 14px;'
    + 'border-radius:6px;font-size:.82rem;cursor:pointer}'
    + '.clip-make-btn:disabled{opacity:.6;cursor:default}'
    + '.clip-msg{font-size:.78rem;color:var(--muted);line-height:1.4}'
    + '.clip-msg.error{color:#ff6b6b}'
    + '.clip-download{display:inline-block;background:#2ea043;color:#fff;text-decoration:none;'
    + 'padding:8px 14px;border-radius:6px;font-size:.82rem;text-align:center}';
  var s = document.createElement('style');
  s.textContent = css;
  document.head.appendChild(s);

  // Accepts "90", "1:30" or "1:02:03".
  function parseTime(raw) {
    var t = String(raw || '').trim();
    if (!t || !/^[\d:]+$/.test(t)) return null;
    var p = t.split(':').map(Number);
    if (p.some(function (n) { return !isFinite(n) || n < 0; })) return null;
    if (p.length === 1) return p[0];
    if (p.length === 2) return p[0] * 60 + p[1];
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    return null;
  }

  function fmt(total) {
    var n = Math.max(0, Math.round(total));
    return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
  }

  function infoFor(card) {
    var copy = card.querySelector('.copy-btn');
    var link = card.querySelector('.watch-link');
    var thumb = card.querySelector('.thumb-wrap');
    var title = card.querySelector('.title');
    return {
      url: (copy && copy.dataset.url) || (link && link.href) || '',
      platform: (thumb && thumb.dataset.platform) || null,
      title: (title && title.textContent) || null
    };
  }

  function poll(url, onTick) {
    var deadline = Date.now() + TIMEOUT_MS;
    return new Promise(function (resolve) {
      (function tick() {
        if (Date.now() > deadline) {
          return resolve({ ok: false, error: 'Timed out waiting for the clip.' });
        }
        setTimeout(function () {
          fetch(url).then(function (r) { return r.json(); }).then(function (d) {
            if (d.state === 'completed') return resolve({ ok: true });
            if (d.state === 'failed') return resolve({ ok: false, error: d.error || 'The clip failed.' });
            onTick(d.state);
            tick();
          }).catch(tick); // transient blip: keep waiting
        }, POLL_MS);
      })();
    });
  }

  function createClip(panel, card) {
    var msg = panel.querySelector('.clip-msg');
    var btn = panel.querySelector('.clip-make-btn');
    var old = panel.querySelector('.clip-download');
    if (old) old.remove();
    msg.classList.remove('error');

    function fail(text) { msg.classList.add('error'); msg.textContent = text; }

    var start = parseTime(panel.querySelector('.clip-start').value);
    var end = parseTime(panel.querySelector('.clip-end').value);
    if (start === null || end === null) return fail('Enter times like 1:30 (or plain seconds).');
    if (end <= start) return fail('The end time has to come after the start time.');
    if (end - start > MAX_SECS) return fail('Clips are capped at ' + (MAX_SECS / 60) + ' minutes for now.');

    var info = infoFor(card);
    if (!info.url) return fail("Couldn't work out this video's link.");

    btn.disabled = true;
    msg.textContent = 'Queueing...';

    fetch('/api/clip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: info.url, start: start, end: end, platform: info.platform, title: info.title })
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || 'Could not start the clip.');
        return j;
      });
    }).then(function (job) {
      msg.textContent = 'Working on your ' + fmt(end - start) + ' clip - this can take a minute...';
      return poll(job.statusUrl, function (state) {
        msg.textContent = state === 'active'
          ? 'Downloading and cutting your ' + fmt(end - start) + ' clip...'
          : 'Waiting for a free worker...';
      }).then(function (out) {
        btn.disabled = false;
        if (!out.ok) return fail(out.error);
        msg.textContent = 'Clip ready.';
        var a = document.createElement('a');
        a.className = 'clip-download';
        a.href = job.downloadUrl;
        a.textContent = 'Download clip';
        a.setAttribute('download', '');
        panel.appendChild(a);
      });
    }).catch(function (err) {
      btn.disabled = false;
      fail(err.message);
    });
  }

  function decorate() {
    results.querySelectorAll('.video-card').forEach(function (card) {
      if (card.dataset.clipReady) return;
      var row = card.querySelector('.link-row');
      if (!row) return;
      card.dataset.clipReady = '1';
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'clip-btn';
      b.textContent = 'Clip';
      b.title = 'Cut a clip from this video';
      row.appendChild(b);
    });
  }

  // app.js rebuilds the results list on each lookup and "Load more", so watch for new cards.
  new MutationObserver(decorate).observe(results, { childList: true });
  decorate();

  results.addEventListener('click', function (e) {
    var open = e.target.closest('.clip-btn');
    if (open) {
      var card = open.closest('.video-card');
      var existing = card.querySelector('.clip-panel');
      if (existing) { existing.remove(); open.classList.remove('open'); return; }
      var panel = document.createElement('div');
      panel.className = 'clip-panel';
      panel.innerHTML = '<div class="clip-times">'
        + '<label>Start (mm:ss)<input type="text" class="clip-start" placeholder="0:00" /></label>'
        + '<label>End (mm:ss)<input type="text" class="clip-end" placeholder="0:30" /></label></div>'
        + '<button type="button" class="clip-make-btn">Create clip</button>'
        + '<div class="clip-msg"></div>';
      card.querySelector('.body').appendChild(panel);
      open.classList.add('open');
      return;
    }
    var make = e.target.closest('.clip-make-btn');
    if (make) createClip(make.closest('.clip-panel'), make.closest('.video-card'));
  });
})();
