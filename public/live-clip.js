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
    + '.live-clip-dl{display:inline-block;background:#2ea043;color:#fff;'
    + 'text-decoration:none;padding:8px 14px;border-radius:6px;font-size:.82rem}'
    + '.live-clip-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px}'
    + '.live-clip-edit{display:inline-block;background:transparent;border:1px solid var(--border);'
    + 'color:var(--text);text-decoration:none;padding:7px 13px;border-radius:6px;font-size:.82rem}'
    + '.live-clip-edit:hover{border-color:var(--accent);color:var(--accent)}'
    + '.live-clip-again{background:transparent;border:1px solid var(--border);color:var(--muted);'
    + 'padding:7px 13px;border-radius:6px;font-size:.82rem;cursor:pointer}'
    + '.live-clip-again:hover{border-color:var(--accent);color:var(--accent)}'
    + '.live-clip-hint{font-size:.75rem;color:var(--muted);margin-top:6px;line-height:1.4}';
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

  function clearResult() {
    var old = card.querySelector('.live-clip-row');
    if (old) old.remove();
    var hint = card.querySelector('.live-clip-hint');
    if (hint) hint.remove();
  }

  // Twitch publishes only ~30s of its ~90s capture by default. The edit link opens Twitch's own
  // trimmer where any 5-60s slice can be chosen; re-downloading afterwards picks up that version,
  // since the edited clip keeps the same URL.
  function showResult(job, downloadUrl) {
    say('Clip ready.');
    clearResult();

    var row = document.createElement('div');
    row.className = 'live-clip-row';

    var dl = document.createElement('a');
    dl.className = 'live-clip-dl';
    dl.href = downloadUrl;
    dl.textContent = 'Download clip';
    dl.setAttribute('download', '');
    row.appendChild(dl);

    if (job.editUrl) {
      var edit = document.createElement('a');
      edit.className = 'live-clip-edit';
      edit.href = job.editUrl;
      edit.target = '_blank';
      edit.rel = 'noopener';
      edit.textContent = 'Adjust on Twitch';
      row.appendChild(edit);

      var again = document.createElement('button');
      again.type = 'button';
      again.className = 'live-clip-again';
      again.textContent = 'Download again';
      again.addEventListener('click', function () { redownload(job, again); });
      row.appendChild(again);
    }

    card.appendChild(row);

    if (job.editUrl) {
      var hint = document.createElement('div');
      hint.className = 'live-clip-hint';
      hint.textContent =
                'Clips are requested at 60s so you have room to trim down. "Adjust on Twitch" opens '
        + 'their editor \u2014 save there, then "Download again". Twitch\u2019s editor has been '
        + 'unreliable lately, so trimming in your own editor is the safer bet.';
      card.appendChild(hint);
    }
  }

  function redownload(job, btn) {
    btn.disabled = true;
    say('Fetching your edited clip from Twitch...');

    fetch('/api/twitch/redownload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clipId: job.clipId })
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || 'Could not queue the download.');
        return j;
      });
    }).then(function (next) {
      return poll(next.statusUrl, function () { say('Downloading your edited clip...'); })
        .then(function (out) {
          btn.disabled = false;
          if (!out.ok) return say(out.error, true);
          showResult(job, next.downloadUrl);
        });
    }).catch(function (err) {
      btn.disabled = false;
      say(err.message, true);
    });
  }

  function clipLive(btn) {
    var fav = card.querySelector('.fav-btn');
    var broadcasterId = fav && fav.dataset.channelId;
    if (!broadcasterId) return say("Couldn't work out which channel this is.", true);

    btn.disabled = true;
    clearResult();
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
        showResult(job, job.downloadUrl);
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
