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
    // Slider rows. The typed box stays alongside each slider: dragging is quick, typing is exact,
    // and on a long VOD one slider pixel is worth several seconds so the box is the way back.
    + '.clip-slider-row{display:flex;flex-direction:column;gap:5px}'
    + '.clip-slider-head{display:flex;justify-content:space-between;align-items:center;gap:8px;'
    + 'font-size:.72rem;color:var(--muted)}'
    + '.clip-slider-head input{background:#0d0f14;border:1px solid var(--border);color:var(--text);'
    + 'padding:4px 7px;border-radius:5px;font-size:.8rem;width:86px;text-align:right}'
    + '.clip-slider-row input[type=range]{width:100%;accent-color:var(--accent);margin:0}'
    + '.clip-length{font-size:.72rem;color:var(--muted)}'
    + '.clip-length.over{color:#ff6b6b}'
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

  // Hours only appear past the hour mark, so a position in a long VOD reads the same way as the
  // duration badge above it ("1:05:00", not a puzzling "65:00").
  function fmt(total) {
    var n = Math.max(0, Math.round(total));
    var h = Math.floor(n / 3600);
    var m = Math.floor((n % 3600) / 60);
    var s = String(n % 60).padStart(2, '0');
    return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + s : m + ':' + s;
  }

  // The card already shows the video's length in its corner badge, so the slider range comes from
  // there rather than from a change to app.js. Unknown lengths render as "--:--", which parseTime
  // rejects, and that's the signal to fall back to plain typed boxes.
  function durationOf(card) {
    var badge = card.querySelector('.duration-badge');
    var secs = badge ? parseTime(badge.textContent) : null;
    return secs && secs > 0 ? secs : null;
  }

  // Wire a slider to its typed box so either one can drive the value, keeping start < end and the
  // length readout honest. Returns nothing; the panel's .clip-start/.clip-end boxes stay the single
  // source of truth, which is what createClip already reads.
  function wireSliders(panel, duration) {
    var startBox = panel.querySelector('.clip-start');
    var endBox = panel.querySelector('.clip-end');
    var startRange = panel.querySelector('.clip-start-range');
    var endRange = panel.querySelector('.clip-end-range');
    var lengthEl = panel.querySelector('.clip-length');
    if (!startRange || !endRange) return;

    function clamp(n) { return Math.min(duration, Math.max(0, n)); }

    function refresh() {
      var len = Number(endRange.value) - Number(startRange.value);
      lengthEl.textContent = 'Length ' + fmt(len)
        + (len > MAX_SECS ? ' — over the ' + (MAX_SECS / 60) + ' minute limit' : '');
      lengthEl.classList.toggle('over', len > MAX_SECS);
    }

    // Dragging either handle pushes the other out of the way rather than letting them cross.
    function fromRange() {
      if (Number(startRange.value) >= Number(endRange.value)) {
        if (this === startRange) endRange.value = String(clamp(Number(startRange.value) + 1));
        else startRange.value = String(clamp(Number(endRange.value) - 1));
      }
      startBox.value = fmt(Number(startRange.value));
      endBox.value = fmt(Number(endRange.value));
      refresh();
    }

    // Typing wins over the slider's position — that's the whole point of keeping the box.
    function fromBox(box, range) {
      var secs = parseTime(box.value);
      if (secs === null) return; // leave half-typed text alone until they finish
      range.value = String(clamp(secs));
      fromRange.call(range);
    }

    startRange.addEventListener('input', fromRange);
    endRange.addEventListener('input', fromRange);
    startBox.addEventListener('change', function () { fromBox(startBox, startRange); });
    endBox.addEventListener('change', function () { fromBox(endBox, endRange); });

    refresh();
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

      var duration = durationOf(card);
      if (duration) {
        // A sensible opening selection: the first 30 seconds, or the whole thing if it's shorter.
        var initialEnd = Math.min(30, duration);
        panel.innerHTML =
          '<div class="clip-slider-row">'
          + '<div class="clip-slider-head"><span>Start</span>'
          + '<input type="text" class="clip-start" value="0:00" /></div>'
          + '<input type="range" class="clip-start-range" min="0" max="' + duration + '" step="1" value="0" />'
          + '</div>'
          + '<div class="clip-slider-row">'
          + '<div class="clip-slider-head"><span>End</span>'
          + '<input type="text" class="clip-end" value="' + fmt(initialEnd) + '" /></div>'
          + '<input type="range" class="clip-end-range" min="0" max="' + duration + '" step="1" value="'
          + initialEnd + '" />'
          + '</div>'
          + '<div class="clip-length"></div>'
          + '<button type="button" class="clip-make-btn">Create clip</button>'
          + '<div class="clip-msg"></div>';
      } else {
        // No length on the card (a live VOD still recording, say) means no range to slide over.
        panel.innerHTML = '<div class="clip-times">'
          + '<label>Start (mm:ss)<input type="text" class="clip-start" placeholder="0:00" /></label>'
          + '<label>End (mm:ss)<input type="text" class="clip-end" placeholder="0:30" /></label></div>'
          + '<button type="button" class="clip-make-btn">Create clip</button>'
          + '<div class="clip-msg"></div>';
      }

      card.querySelector('.body').appendChild(panel);
      if (duration) wireSliders(panel, duration);
      open.classList.add('open');
      return;
    }
    var make = e.target.closest('.clip-make-btn');
    if (make) createClip(make.closest('.clip-panel'), make.closest('.video-card'));
  });
})();
