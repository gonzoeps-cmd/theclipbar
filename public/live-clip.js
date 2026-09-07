// Live clipping UI. Adds a "Clip live" button to the channel card while a Twitch channel is
// streaming. Kept separate from clip-ui.js (VOD clipping) because the mechanics are different:
// here Twitch cuts the clip on its own infrastructure and we only download the result.
// See src/routes/twitch-auth.js for why this needs a Twitch login at all.
(function () {
  'use strict';
  var card = document.getElementById('channel-card');
  if (!card) return;

  var POLL_MS = 2000, TIMEOUT_MS = 300000;

  var css = '.live-clip-btn{background:#2ea043;color:#fff;border:none;padding:8px 14px;'
    + 'border-radius:8px;font-size:.85rem;cursor:pointer;white-space:nowrap}'
    + '.live-clip-btn:hover{background:#278036}'
    + '.live-clip-btn:disabled{opacity:.6;cursor:default}'
    + '.live-clip-msg{font-size:.8rem;color:var(--muted);margin-top:8px;line-height:1.4}'
    + '.live-clip-msg.error{color:#ff6b6b}'
    + '.live-clip-msg a{color:var(--accent)}'
    + '.live-clip-dl{display:inline-block;margin-top:8px;background:#2ea043;color:#fff;'
    + 'text-decoration:none;padding:8px 14px;border-radius:6px;font-size:.82rem}';
  var s = document.createElement('style');
  s.textContent = css;
  document.head.appendChild(s);

  function msgEl() {
    var el = card.querySelector('.live-clip-msg');
    if (!el) {
      el = document.createElement('div');
      el.className = 'live-clip-msg';
      card.appendChild(el);
    }
    return el;
  }

  function say(text, isError) {
    var el = msgEl();
    el.classList.toggle('error', !!isError);
    el.innerHTML = text;
    return el;
  }

  function poll(url, onTick) {
    var deadline = Date.now() + TIMEOUT_MS;
    return new Promise(function (resolve) {
      (function tick() {
        if (Date.now() > deadline) return resolve({ ok: false, error: 'Timed out waiting for the clip.' });
        setTimeout(function () {
          fetch(url).then(function (r) { return r.json(); }).then(function (d) {
            if (d.state === 'completed') return resolve({ ok: true });
            if (d.state === 'failed') return resolve({ ok: false, error: d.error || 'The clip failed.' });
            onTick(d.state);
            tick();
          }).catch(tick);
        }, POLL_MS);
      })();
    });
  }

  function loginPrompt(reason) {
    say((reason ? reason + ' ' : 'Connect your Twitch account to clip live streams: ')
      + '<a href="/api/twitch/login">Connect Twitch</a>', true);
  }

  function clipLive(btn) {
    var fav = card.querySelector('.fav-btn');
    var broadcasterId = fav && fav.dataset.channelId;
    if (!broadcasterId) return say("Couldn't work out which channel this is.", true);

    btn.disabled = true;
    say('Asking Twitch to cut the clip...');

    fetch('/api/twitch/clip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ broadcasterId: broadcasterId })
    }).then(function (r) {
      return r.json().then(function (j) {
        if (j.needsLogin) { var e = new Error(j.error || ''); e.needsLogin = true; throw e; }
        if (!r.ok) throw new Error(j.error || 'Could not create the clip.');
        return j;
      });
    }).then(function (job) {
      // Twitch needs a moment to process a brand new clip, so the download job starts delayed.
      say('Twitch made the clip. Downloading it now - this takes about 20 seconds...');
      return poll(job.statusUrl, function (state) {
        say(state === 'active'
          ? 'Downloading your clip...'
          : 'Waiting for Twitch to finish processing the clip...');
      }).then(function (out) {
        btn.disabled = false;
        if (!out.ok) {
          say(out.error + ' <a href="' + job.clipUrl + '" target="_blank" rel="noopener">'
            + 'The clip still exists on Twitch &rarr;</a>', true);
          return;
        }
        say('Clip ready.');
        var a = document.createElement('a');
        a.className = 'live-clip-dl';
        a.href = job.downloadUrl;
        a.textContent = 'Download clip';
        a.setAttribute('download', '');
        card.appendChild(a);
      });
    }).catch(function (err) {
      btn.disabled = false;
      if (err.needsLogin) return loginPrompt(err.message);
      say(err.message, true);
    });
  }

  function decorate() {
    if (card.classList.contains('hidden')) return;
    if (card.querySelector('.live-clip-btn')) return;

    var fav = card.querySelector('.fav-btn');
    if (!fav || fav.dataset.platform !== 'twitch') return;
    // Only offer this while the channel is actually live — Twitch can only clip a running stream.
    if (!card.querySelector('.live-badge')) return;

    var actions = card.querySelector('.channel-actions');
    if (!actions) return;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'live-clip-btn';
    btn.textContent = 'Clip live';
    btn.title = 'Clip the last ~30 seconds of this stream via Twitch';
    actions.appendChild(btn);
  }

  // app.js re-renders the channel card on every lookup, so re-decorate whenever it changes.
  new MutationObserver(decorate).observe(card, { childList: true, attributes: true });
  decorate();

  card.addEventListener('click', function (e) {
    var btn = e.target.closest('.live-clip-btn');
    if (btn) clipLive(btn);
  });

  // Surface the result of the OAuth round trip, then tidy the URL.
  var params = new URLSearchParams(location.search);
  if (params.get('twitch')) {
    var state = params.get('twitch');
    if (state === 'connected') say('Twitch connected - you can clip live streams now.');
    else if (state === 'denied') say('Twitch login was declined.', true);
    else say('Twitch login failed. Try again.', true);
    history.replaceState({}, '', location.pathname);
  }
})();
