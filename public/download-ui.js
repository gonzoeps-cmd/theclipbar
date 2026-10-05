// "Download" — put the actual video file on the phone or the computer, rather than handing over a
// link to somebody else's site the way Copy link does.
//
// Self-contained in the same way clip-ui.js, live-clip.js and trim-ui.js are: it watches for the
// cards app.js renders, adds its own button and injects its own styles, so neither app.js nor the
// clipping code has to know it exists. That is why the few small helpers below are repeated here
// instead of shared — a module that can be deleted by removing one <script> tag is worth a dozen
// duplicated lines.
//
// Underneath it is the same machinery as a clip: POST /api/clip, poll the worker, hand back the
// finished file. The difference is that it sends no range, and no range is already how the worker is
// told to take all of a video (it is the path Twitch live clips use).
(function () {
  'use strict';
  var results = document.getElementById('results');
  if (!results) return;

  var POLL_MS = 2000, TIMEOUT_MS = 600000;

  // Mirrors MAX_DOWNLOAD_SECONDS in src/routes/clip.js. Checked here as well so an over-long video
  // is turned away at once, with its real length in the message, instead of after a round trip.
  var MAX_DL_SECS = 1800;

  // Past this, it is a big file to pull over a phone connection, so the wait gets a warning rather
  // than a silent several-minute spinner.
  var BIG_DL_SECS = 600;

  // YouTube refuses downloads from this server's address — it treats datacenter IPs as bots and
  // Render is one. Nothing on our side can get around that, so the button says so immediately
  // instead of queueing a job that spends a minute failing. Flip this if YouTube ever relents.
  var DOWNLOAD_YOUTUBE = false;

  var css = '.dl-btn{background:transparent;border:1px solid var(--border);color:var(--muted);'
    + 'padding:4px 9px;border-radius:6px;font-size:.76rem;cursor:pointer;white-space:nowrap}'
    + '.dl-btn:hover:not(:disabled){color:var(--accent);border-color:var(--accent)}'
    + '.dl-btn:disabled{opacity:.6;cursor:default}'
    + '.dl-panel{margin-top:10px;padding-top:10px;border-top:1px solid var(--border);'
    + 'display:flex;flex-direction:column;gap:8px}'
    + '.dl-head{display:flex;align-items:center;justify-content:space-between;gap:10px}'
    + '.dl-head-title{font-size:.78rem;color:var(--muted)}'
    // Every panel can be dismissed, same as the clipping and trimming ones — a panel that can only
    // be opened piles up under the card with no way back to a clean view.
    + '.dl-close{background:transparent;border:1px solid var(--border);color:var(--muted);'
    + 'width:28px;height:28px;border-radius:6px;font-size:.8rem;line-height:1;cursor:pointer;'
    + 'flex-shrink:0}'
    + '.dl-close:hover{border-color:var(--accent);color:var(--accent)}'
    + '.dl-msg{font-size:.78rem;color:var(--muted);line-height:1.4}'
    + '.dl-msg.error{color:#ff6b6b}'
    + '.dl-link{display:inline-block;background:#2ea043;color:#fff;text-decoration:none;'
    + 'padding:8px 14px;border-radius:6px;font-size:.82rem;text-align:center}';
  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // Accepts "90", "1:30" or "1:02:03" — the shapes the duration badge uses.
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

  // Hours only appear past the hour mark, so a length reads the same way as the badge it came from
  // ("1:05:00", not a puzzling "65:00").
  function fmt(total) {
    var n = Math.max(0, Math.round(total));
    var h = Math.floor(n / 3600);
    var m = Math.floor((n % 3600) / 60);
    var sec = String(n % 60).padStart(2, '0');
    return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + sec : m + ':' + sec;
  }

  // The card's corner badge is the only place the video's length exists on the page, and the server
  // needs that number to check the request against the cap. "--:--" means unknown, which parseTime
  // rejects — and an unknown length is a request we can't safely make.
  function durationOf(card) {
    var badge = card.querySelector('.duration-badge');
    var secs = badge ? parseTime(badge.textContent) : null;
    return secs && secs > 0 ? secs : null;
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

  // What the file should be called once it lands. The worker stores clips under their job id, and
  // "41.mp4" sitting in a phone's downloads folder tells you nothing a week later.
  function fileName(info) {
    var parts = [];
    // The channel's name lives on the channel card above the results, not on each video card. Read
    // loosely and guarded: this is a nicety on a filename, so failing to find it means a shorter
    // name rather than a broken download — and app.js stays untouched.
    var channel = document.querySelector('#channel-card .channel-name-row span');
    if (channel && channel.textContent) parts.push(channel.textContent.trim());
    if (info.title) parts.push(info.title.trim());
    return parts.join(' - ').slice(0, 80) || 'theclipbar';
  }

  function poll(url, onTick) {
    var deadline = Date.now() + TIMEOUT_MS;
    return new Promise(function (resolve) {
      (function tick() {
        if (Date.now() > deadline) {
          return resolve({ ok: false, error: 'Timed out waiting for the download.' });
        }
        setTimeout(function () {
          fetch(url).then(function (r) { return r.json(); }).then(function (d) {
            if (d.state === 'completed') return resolve({ ok: true });
            if (d.state === 'failed') return resolve({ ok: false, error: d.error || 'The download failed.' });
            onTick(d.state);
            tick();
          }).catch(tick); // transient blip: keep waiting
        }, POLL_MS);
      })();
    });
  }

  // One panel per card, reused across repeat presses so an old result can't sit under a new one.
  function panelFor(card) {
    var existing = card.querySelector('.dl-panel');
    if (existing) return existing;

    var panel = document.createElement('div');
    panel.className = 'dl-panel';
    panel.innerHTML = '<div class="dl-head"><span class="dl-head-title">Download</span>'
      + '<button type="button" class="dl-close" aria-label="Close download">✕</button></div>'
      + '<div class="dl-msg"></div>';
    panel.querySelector('.dl-close').addEventListener('click', function () { panel.remove(); });
    card.querySelector('.body').appendChild(panel);
    return panel;
  }

  function startDownload(btn, card) {
    var panel = panelFor(card);
    var msg = panel.querySelector('.dl-msg');
    var old = panel.querySelector('.dl-link');
    if (old) old.remove();
    msg.classList.remove('error');

    function fail(text) { msg.classList.add('error'); msg.textContent = text; }

    var info = infoFor(card);
    if (!info.url) return fail("Couldn't work out this video's link.");

    if (!DOWNLOAD_YOUTUBE && info.platform === 'youtube') {
      return fail('YouTube blocks downloads from our server, so this one can only be watched there '
        + '— use Watch. Twitch VODs and clips download fine.');
    }

    var duration = durationOf(card);
    if (!duration) {
      return fail("This video doesn't say how long it is, so there's no way to check it against the "
        + 'size limit. Use Clip to take a piece of it instead.');
    }
    if (duration > MAX_DL_SECS) {
      return fail('This one runs ' + fmt(duration) + ', and whole-video downloads are capped at '
        + (MAX_DL_SECS / 60) + ' minutes — the server builds it on a small temp disk. '
        + 'Use Clip to take the part you want.');
    }

    btn.disabled = true;
    btn.textContent = 'Working...';
    msg.textContent = duration > BIG_DL_SECS
      ? 'Fetching the whole ' + fmt(duration) + ' video. This takes a few minutes and will be a '
        + 'large file — worth being on wi-fi for.'
      : 'Fetching the whole ' + fmt(duration) + ' video...';

    function done() { btn.disabled = false; btn.textContent = 'Download'; }

    fetch('/api/clip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: info.url,
        whole: true,
        duration: duration,
        platform: info.platform,
        title: info.title
      })
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || 'Could not start the download.');
        return j;
      });
    }).then(function (job) {
      return poll(job.statusUrl, function (state) {
        msg.textContent = state === 'active'
          ? 'Downloading from ' + (info.platform === 'twitch' ? 'Twitch' : 'the source') + '...'
          : 'Waiting for a free worker...';
      }).then(function (out) {
        done();
        if (!out.ok) return fail(out.error);
        msg.textContent = 'Ready — press below to save it. The server only keeps it for an '
          + 'hour, so grab it now.';
        var a = document.createElement('a');
        a.className = 'dl-link';
        a.href = job.downloadUrl + '?name=' + encodeURIComponent(fileName(info));
        a.textContent = 'Save video';
        // Ignored on a cross-origin link, which this is. It doesn't matter: the worker sends the file
        // as an attachment under the name above, so the browser saves rather than plays it either way.
        a.setAttribute('download', '');
        panel.appendChild(a);
      });
    }).catch(function (err) {
      done();
      fail(err.message);
    });
  }

  function decorate() {
    results.querySelectorAll('.video-card').forEach(function (card) {
      if (card.dataset.dlReady) return;
      var row = card.querySelector('.link-row');
      if (!row) return;
      card.dataset.dlReady = '1';

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dl-btn';
      btn.textContent = 'Download';
      btn.title = 'Save the whole video to this device';

      // Right after Copy link, so the row reads as a ladder: watch it there, pass the link on, take
      // the whole thing, or cut a piece out. clip-ui.js adds its Clip button from its own observer,
      // so which of us runs first isn't fixed — going in before Clip when it's already there, and
      // appending when it isn't, gives the same order either way.
      var clipBtn = row.querySelector('.clip-btn');
      if (clipBtn) row.insertBefore(btn, clipBtn);
      else row.appendChild(btn);
    });
  }

  // app.js rebuilds the results list on every lookup and every "Load more", so watch for new cards
  // rather than decorating once at startup.
  new MutationObserver(decorate).observe(results, { childList: true });
  decorate();

  results.addEventListener('click', function (e) {
    var btn = e.target.closest('.dl-btn');
    if (btn) startDownload(btn, btn.closest('.video-card'));
  });
})();
