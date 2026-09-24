// Clipping UI (Phase 2). Self-contained on purpose: hooks onto the cards app.js renders and
// injects its own styles, so nothing in the existing lookup/favorites code has to change.
//
// The panel is built around one decision: where does the clip start. You drag a single handle,
// watch the player follow it, pick how long you want, and take it. An end-point slider was the
// earlier design and meant fussing with two handles that could cross each other; a length is easier
// to think about than an out-point, and the trimmer handles fine-tuning afterwards.
//
// Flow: pick a start -> POST /api/clip (queues it) -> poll worker /status -> download link.
(function () {
  'use strict';
  var results = document.getElementById('results');
  if (!results) return;

  var POLL_MS = 2000, TIMEOUT_MS = 600000, MAX_SECS = 300; // MAX_SECS matches src/routes/clip.js
  var LENGTHS = [15, 30, 60, 120]; // every option stays under MAX_SECS
  var DEFAULT_LENGTH = 30;

  var css = '.clip-btn{background:transparent;border:1px solid var(--border);color:var(--muted);'
    + 'padding:4px 9px;border-radius:6px;font-size:.76rem;cursor:pointer;white-space:nowrap}'
    + '.clip-btn:hover,.clip-btn.open{color:var(--accent);border-color:var(--accent)}'
    + '.clip-panel{margin-top:10px;padding-top:10px;border-top:1px solid var(--border);'
    + 'display:flex;flex-direction:column;gap:10px}'
    + '.clip-slider-row{display:flex;flex-direction:column;gap:5px}'
    + '.clip-slider-head{display:flex;justify-content:space-between;align-items:center;gap:8px;'
    + 'font-size:.72rem;color:var(--muted)}'
    + '.clip-slider-head input{background:#0d0f14;border:1px solid var(--border);color:var(--text);'
    + 'padding:4px 7px;border-radius:5px;font-size:.8rem;width:92px;text-align:right}'
    + '.clip-slider-row input[type=range]{width:100%;accent-color:var(--accent);margin:0}'
    // Length choices as one segmented row, so the selected length is visible at a glance rather
    // than hidden in a dropdown.
    + '.clip-len-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}'
    + '.clip-len-label{font-size:.72rem;color:var(--muted);margin-right:2px}'
    + '.clip-len-btn{background:transparent;border:1px solid var(--border);color:var(--muted);'
    + 'padding:5px 11px;border-radius:99px;font-size:.78rem;cursor:pointer}'
    + '.clip-len-btn:hover{color:var(--text)}'
    + '.clip-len-btn.active{border-color:var(--accent);color:var(--accent)}'
    + '.clip-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}'
    + '.clip-make-btn{background:var(--accent);color:#fff;border:none;padding:8px 14px;'
    + 'border-radius:6px;font-size:.82rem;cursor:pointer}'
    + '.clip-make-btn:disabled{opacity:.6;cursor:default}'
    + '.clip-preview-btn{background:transparent;border:1px solid var(--border);color:var(--muted);'
    + 'padding:8px 13px;border-radius:6px;font-size:.82rem;cursor:pointer;white-space:nowrap}'
    + '.clip-preview-btn:hover{border-color:var(--accent);color:var(--accent)}'
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
    var sec = String(n % 60).padStart(2, '0');
    return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + sec : m + ':' + sec;
  }

  // "30s", "1min" — how a length reads on a button, as opposed to a position on the timeline.
  function lenLabel(secs) {
    return secs >= 60 && secs % 60 === 0 ? (secs / 60) + 'min' : secs + 's';
  }

  // The card already shows the video's length in its corner badge, so the slider range comes from
  // there rather than from a change to app.js. Unknown lengths render as "--:--", which parseTime
  // rejects, and that's the signal to drop the slider and just take a typed start time.
  function durationOf(card) {
    var badge = card.querySelector('.duration-badge');
    var secs = badge ? parseTime(badge.textContent) : null;
    return secs && secs > 0 ? secs : null;
  }

  // Keep the slider, the typed box, the length choice and both button labels in agreement, and keep
  // the hidden .clip-end in step with them — that field is what createClip reads, so the rest of the
  // panel can change shape without touching the submit path.
  function wirePanel(panel, card, duration) {
    var startBox = panel.querySelector('.clip-start');
    var startRange = panel.querySelector('.clip-start-range');
    var endBox = panel.querySelector('.clip-end');
    var makeBtn = panel.querySelector('.clip-make-btn');
    var previewBtn = panel.querySelector('.clip-preview-btn');
    var lenBtns = panel.querySelectorAll('.clip-len-btn');
    var wanted = DEFAULT_LENGTH;

    // fromTyping says the box is the authority for this update. Without it the slider's position
    // would always win and a typed time would be overwritten the moment it was entered.
    function update(fromTyping) {
      var start = null;
      if (fromTyping) start = parseTime(startBox.value);
      if (start === null) start = startRange ? Number(startRange.value) : (parseTime(startBox.value) || 0);

      // Leave at least a second of video to take, so the start can't sit on the very last frame.
      if (duration) start = Math.min(start, Math.max(0, duration - 1));
      var end = duration ? Math.min(start + wanted, duration) : start + wanted;
      var actual = Math.round(end - start);

      if (startRange) startRange.value = String(start);
      startBox.value = fmt(start);
      endBox.value = fmt(end);

      // Say the real length when the end of the video cuts it short, rather than promising 30s and
      // quietly handing back 12.
      makeBtn.textContent = actual < wanted
        ? 'Clip ' + actual + 's (end of video)'
        : 'Clip ' + lenLabel(wanted);
      previewBtn.textContent = 'Preview from ' + fmt(start);

      // If a preview is already open on this card, walk it to the new start point.
      scrubTo(card, start);
    }

    if (startRange) startRange.addEventListener('input', function () { update(false); });
    // On "change" rather than "input" so rewriting the box doesn't fight them mid-type.
    startBox.addEventListener('change', function () { update(true); });

    for (var i = 0; i < lenBtns.length; i += 1) {
      lenBtns[i].addEventListener('click', function () {
        wanted = Number(this.dataset.secs) || DEFAULT_LENGTH;
        for (var j = 0; j < lenBtns.length; j += 1) {
          lenBtns[j].classList.toggle('active', lenBtns[j] === this);
        }
        update(false);
      });
    }

    update(false);
  }

  // Twitch takes a start time as 1h2m3s rather than plain seconds.
  function twitchTime(total) {
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    return h + 'h' + m + 'm' + (total % 60) + 's';
  }

  // --- preview player -------------------------------------------------------
  //
  // The player opens in the card's own thumbnail, so it sits directly above the slider and both
  // stay visible: watching the video while dragging only works if neither hides the other.
  //
  // Seeking needs more than a plain embed. YouTube accepts commands over postMessage once the
  // embed URL carries enablejsapi=1. Twitch has no such hook on a plain iframe, so its own player
  // script is loaded the first time a Twitch VOD is previewed.

  var TWITCH_SDK = 'https://player.twitch.tv/js/embed/v1.js';
  var twitchSdk = null; // a promise, so the script is fetched once however many previews are opened

  function loadTwitchSdk() {
    if (twitchSdk) return twitchSdk;
    twitchSdk = new Promise(function (resolve, reject) {
      if (window.Twitch && window.Twitch.Player) return resolve();
      var tag = document.createElement('script');
      tag.src = TWITCH_SDK;
      tag.onload = function () { resolve(); };
      tag.onerror = function () {
        twitchSdk = null; // let a later attempt retry rather than failing forever
        reject(new Error('Could not load the Twitch player.'));
      };
      document.head.appendChild(tag);
    });
    return twitchSdk;
  }

  // The one preview open at a time: { card, thumb, el, seek(seconds), destroy() }.
  var active = null;

  function closePreview() {
    if (!active) return;
    try { active.destroy(); } catch (err) { /* already gone */ }
    if (active.thumb) {
      active.thumb.classList.remove('playing');
      // Take the ✕ with it. app.js's own handler would also clear this, but only when the click
      // came from there; closing any other way used to strand the button over the thumbnail.
      var close = active.thumb.querySelector('.close-player-btn');
      if (close) close.remove();
    }
    active = null;
  }

  function youtubePlayer(thumb, id, atSeconds) {
    var iframe = document.createElement('iframe');
    iframe.className = 'player-iframe';
    iframe.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
    iframe.allowFullscreen = true;
    // Muted so hunting through a video isn't a wall of noise; the player's own control unmutes.
    iframe.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id)
      + '?enablejsapi=1&autoplay=1&mute=1&playsinline=1'
      + '&origin=' + encodeURIComponent(window.location.origin)
      + '&start=' + Math.max(0, Math.floor(atSeconds));
    thumb.appendChild(iframe);

    function command(func, args) {
      if (!iframe.contentWindow) return;
      try {
        iframe.contentWindow.postMessage(
          JSON.stringify({ event: 'command', func: func, args: args || [] }), '*'
        );
      } catch (err) {
        // The frame isn't listening yet. Dropping this one is fine — dragging sends another.
      }
    }

    return {
      thumb: thumb,
      el: iframe,
      seek: function (secs) {
        command('seekTo', [Math.max(0, secs), true]);
        command('playVideo');
      },
      destroy: function () { iframe.remove(); }
    };
  }

  function twitchVodPlayer(thumb, videoId, atSeconds) {
    var mount = document.createElement('div');
    mount.className = 'player-iframe';
    mount.id = 'clip-player-' + Date.now().toString(36);
    thumb.appendChild(mount);

    var player = new window.Twitch.Player(mount.id, {
      video: videoId,
      parent: [window.location.hostname],
      autoplay: true,
      muted: true,
      width: '100%',
      height: '100%',
      time: twitchTime(Math.max(0, Math.floor(atSeconds))),
    });

    return {
      thumb: thumb,
      el: mount,
      seek: function (secs) {
        try {
          player.seek(Math.max(0, secs));
          player.play();
        } catch (err) {
          // The player is still starting up; the next drag will land.
        }
      },
      destroy: function () {
        try { player.pause(); } catch (err) { /* fine */ }
        mount.remove();
      }
    };
  }

  // Twitch clips have no seek parameter and no seek method, so this one just plays from the start.
  function twitchClipPlayer(thumb, clipId) {
    var iframe = document.createElement('iframe');
    iframe.className = 'player-iframe';
    iframe.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
    iframe.allowFullscreen = true;
    iframe.src = 'https://clips.twitch.tv/embed?clip=' + encodeURIComponent(clipId)
      + '&parent=' + window.location.hostname + '&autoplay=true&muted=true';
    thumb.appendChild(iframe);
    return {
      thumb: thumb,
      el: iframe,
      seek: function () { /* not supported by Twitch for clips */ },
      destroy: function () { iframe.remove(); }
    };
  }

  function addCloseButton(thumb) {
    if (thumb.querySelector('.close-player-btn')) return;
    // Same class app.js uses, so its existing handler closes this player too.
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'close-player-btn';
    btn.setAttribute('aria-label', 'Close player');
    btn.title = 'Close player';
    btn.textContent = '✕';
    btn.addEventListener('click', closePreview);
    thumb.appendChild(btn);
  }

  function openPreview(card, atSeconds) {
    var thumb = card.querySelector('.thumb-wrap');
    if (!thumb || !thumb.dataset.id) return;

    closePreview();

    // Clear any player app.js opened from the play button, so only one thing is ever running.
    document.querySelectorAll('.thumb-wrap.playing').forEach(function (el) {
      el.classList.remove('playing');
      var frame = el.querySelector('.player-iframe');
      if (frame) frame.remove();
      var close = el.querySelector('.close-player-btn');
      if (close) close.remove();
    });

    var d = thumb.dataset;

    function ready(handle) {
      handle.card = card;
      active = handle;
      thumb.classList.add('playing');
      addCloseButton(thumb);
    }

    if (d.platform === 'youtube') return ready(youtubePlayer(thumb, d.id, atSeconds));
    if (d.kind === 'clip') return ready(twitchClipPlayer(thumb, d.id));

    loadTwitchSdk().then(function () {
      ready(twitchVodPlayer(thumb, d.id, atSeconds));
    }).catch(function () {
      // Fall back to the plain embed: it can't be scrubbed, but it still shows the right moment.
      var iframe = document.createElement('iframe');
      iframe.className = 'player-iframe';
      iframe.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
      iframe.allowFullscreen = true;
      iframe.src = 'https://player.twitch.tv/?video=' + encodeURIComponent(d.id)
        + '&parent=' + window.location.hostname + '&autoplay=true&muted=true'
        + '&time=' + twitchTime(Math.max(0, Math.floor(atSeconds)));
      thumb.appendChild(iframe);
      ready({ thumb: thumb, el: iframe, seek: function () {}, destroy: function () { iframe.remove(); } });
    });
  }

  // Dragging fires continuously, and seeking on every pixel makes the player stutter and fight the
  // handle. Waiting for a pause in the movement gives the picture a beat to catch up instead.
  var scrubTimer = null;
  function scrubTo(card, seconds) {
    if (!active || active.card !== card) return;
    if (!document.contains(active.el)) { active = null; return; } // closed from elsewhere
    clearTimeout(scrubTimer);
    scrubTimer = setTimeout(function () {
      if (active && active.card === card) active.seek(seconds);
    }, 180);
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
    if (start === null || end === null) return fail('Enter a start time like 1:30 (or plain seconds).');
    if (end <= start) return fail("There's no video left at that point - move the start back.");
    if (end - start > MAX_SECS) return fail('Clips are capped at ' + (MAX_SECS / 60) + ' minutes for now.');

    var info = infoFor(card);
    if (!info.url) return fail("Couldn't work out this video's link.");

    // The button's label is the length, so put it back rather than leaving "Queueing..." behind.
    var label = btn.textContent;
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
        btn.textContent = label;
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
      btn.textContent = label;
      fail(err.message);
    });
  }

  function lengthRow() {
    var html = '<div class="clip-len-row" role="group" aria-label="Clip length">'
      + '<span class="clip-len-label">Length</span>';
    for (var i = 0; i < LENGTHS.length; i += 1) {
      var n = LENGTHS[i];
      html += '<button type="button" class="clip-len-btn' + (n === DEFAULT_LENGTH ? ' active' : '')
        + '" data-secs="' + n + '">' + lenLabel(n) + '</button>';
    }
    return html + '</div>';
  }

  // The end time is computed from start + length, so it lives in a hidden field rather than in a
  // control of its own. createClip reads it exactly as it always did.
  function panelHtml(duration) {
    var html = '<div class="clip-slider-row">'
      + '<div class="clip-slider-head"><span>Start</span>'
      + '<input type="text" class="clip-start" value="0:00" /></div>';
    if (duration) {
      html += '<input type="range" class="clip-start-range" min="0" max="' + duration
        + '" step="1" value="0" />';
    }
    html += '</div>';

    return html
      + lengthRow()
      + '<input type="hidden" class="clip-end" value="0:30" />'
      + '<div class="clip-actions">'
      + '<button type="button" class="clip-make-btn">Clip 30s</button>'
      + '<button type="button" class="clip-preview-btn">Preview from 0:00</button>'
      + '</div>'
      + '<div class="clip-msg"></div>';
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

      var duration = durationOf(card);
      var panel = document.createElement('div');
      panel.className = 'clip-panel';
      panel.innerHTML = panelHtml(duration);

      card.querySelector('.body').appendChild(panel);
      wirePanel(panel, card, duration);
      open.classList.add('open');
      return;
    }

    var preview = e.target.closest('.clip-preview-btn');
    if (preview) {
      var pPanel = preview.closest('.clip-panel');
      // Fall back to 0 for a half-typed time rather than refusing to open the player.
      var at = parseTime(pPanel.querySelector('.clip-start').value) || 0;
      openPreview(preview.closest('.video-card'), at);
      return;
    }

    var make = e.target.closest('.clip-make-btn');
    if (make) createClip(make.closest('.clip-panel'), make.closest('.video-card'));
  });
})();
