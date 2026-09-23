// In-browser editing for finished clips: a manual trimmer and a one-press "Cut dead air".
//
// Self-contained on purpose: it watches for a clip's download link appearing and attaches itself,
// so neither live-clip.js, clip-ui.js nor app.js has to know it exists. Works out the worker's
// address from the download link itself rather than needing configuration.
//
// Attaches to BOTH kinds of finished clip: the live-clip button's link (.live-clip-dl, inside the
// channel card) and the VOD clip flow's link (.clip-download, inside a video card). Both point at
// the same worker and the same clips directory, so the same two buttons work on either.
//
// Both operations happen on the worker (POST /trim and POST /autocut), not here — the file is
// already sitting on that machine with the tools installed, so it is faster there and nothing has
// to be uploaded. Doing it in the browser would mean shipping a video encoder to the phone.
(function () {
  'use strict';

  // Cut dead air is off. auto-editor's Linux binary needs a newer system C library than Render's
  // machine has (GLIBC_2.38), so every run failed there; every published release back to v29 has
  // the same requirement, so there is no older build to fall back to. The button is hidden rather
  // than left to fail. Flip this back to true once the silence cutting is done with ffmpeg, which
  // is already installed and working on the worker.
  var AUTOCUT_ENABLED = false;

  var channelCard = document.getElementById('channel-card');
  var results = document.getElementById('results');
  if (!channelCard && !results) return;

  var css = '.trim-btn{background:transparent;border:1px solid var(--border);color:var(--text);'
    + 'padding:7px 13px;border-radius:6px;font-size:.82rem;cursor:pointer}'
    + '.trim-btn:hover{border-color:var(--accent);color:var(--accent)}'
    + '.trim-panel{margin-top:10px;padding-top:10px;border-top:1px solid var(--border);'
    + 'display:flex;flex-direction:column;gap:10px}'
    + '.trim-panel video{width:100%;max-height:320px;background:#000;border-radius:8px}'
    + '.trim-range{display:flex;flex-direction:column;gap:4px}'
    + '.trim-range label{font-size:.72rem;color:var(--muted);display:flex;'
    + 'justify-content:space-between;align-items:center}'
    + '.trim-range input[type=range]{width:100%;accent-color:var(--accent)}'
    + '.trim-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}'
    + '.trim-go{background:var(--accent);color:#fff;border:none;padding:8px 14px;'
    + 'border-radius:6px;font-size:.82rem;cursor:pointer}'
    + '.trim-go:disabled{opacity:.6;cursor:default}'
    + '.trim-preview{background:transparent;border:1px solid var(--border);color:var(--muted);'
    + 'padding:8px 13px;border-radius:6px;font-size:.82rem;cursor:pointer}'
    + '.trim-msg{font-size:.78rem;color:var(--muted);line-height:1.4}'
    + '.trim-msg.error{color:#ff6b6b}'
    + '.trim-dl{display:inline-block;background:#2ea043;color:#fff;text-decoration:none;'
    + 'padding:8px 14px;border-radius:6px;font-size:.82rem}'
    // The auto-cut button and its result panel borrow the trimmer's look so the two sit together
    // as one row of controls rather than looking bolted on.
    + '.autocut-btn{background:transparent;border:1px solid var(--border);color:var(--text);'
    + 'padding:7px 13px;border-radius:6px;font-size:.82rem;cursor:pointer}'
    + '.autocut-btn:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}'
    + '.autocut-btn:disabled{opacity:.6;cursor:default}'
    // Every panel gets its own dismiss. Editing tools that can only be opened pile up under the
    // card and there is no way back to a clean view.
    + '.trim-head{display:flex;align-items:center;justify-content:space-between;gap:10px}'
    + '.trim-head-title{font-size:.78rem;color:var(--muted)}'
    + '.trim-close{background:transparent;border:1px solid var(--border);color:var(--muted);'
    + 'width:28px;height:28px;border-radius:6px;font-size:.8rem;line-height:1;cursor:pointer;'
    + 'flex-shrink:0}'
    + '.trim-close:hover{border-color:var(--accent);color:var(--accent)}';
  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // Give a panel a title bar with a dismiss button. Returns the markup; the click is wired in
  // closable() once the panel element exists.
  function headHtml(title) {
    return '<div class="trim-head"><span class="trim-head-title">' + title + '</span>'
      + '<button type="button" class="trim-close" aria-label="Close ' + title + '">✕</button></div>';
  }

  function closable(panel) {
    var btn = panel.querySelector('.trim-close');
    if (btn) btn.addEventListener('click', function () { panel.remove(); });
    return panel;
  }

  function fmt(total) {
    var n = Math.max(0, total || 0);
    var m = Math.floor(n / 60);
    var s = (n % 60).toFixed(1).padStart(4, '0');
    return m + ':' + s;
  }

  // The download link points at the worker, so it carries everything needed to talk to it.
  function sourceFrom(link) {
    try {
      var url = new URL(link.href, location.href);
      var file = url.pathname.split('/').pop();
      if (!/^[A-Za-z0-9_-]+\.mp4$/.test(file)) return null;
      return { origin: url.origin, file: file, src: url.href };
    } catch (err) {
      return null;
    }
  }

  // Panel shown after an auto-cut finishes: the shortened clip, how much came off, a download, and
  // a way to hand the result straight to the manual trimmer for fine-tuning.
  function buildResultPanel(host, source, originalDuration) {
    var panel = document.createElement('div');
    panel.className = 'trim-panel';
    panel.innerHTML = headHtml('Dead air removed')
      + '<video controls preload="metadata" playsinline src="' + source.src + '"></video>'
      + '<span class="trim-msg autocut-summary">Dead air removed.</span>'
      + '<div class="trim-actions">'
      + '<a class="trim-dl" href="' + source.src + '" download>Download</a>'
      + '<button type="button" class="trim-preview autocut-refine">Trim this one further</button>'
      + '</div>';

    var video = panel.querySelector('video');
    var summary = panel.querySelector('.autocut-summary');

    // Only say how much came off once the browser knows how long the new file is.
    video.addEventListener('loadedmetadata', function () {
      var now = video.duration;
      if (!isFinite(now) || now <= 0) return;
      if (isFinite(originalDuration) && originalDuration > now) {
        summary.textContent = 'Cut from ' + fmt(originalDuration) + ' down to ' + fmt(now)
          + ' — ' + fmt(originalDuration - now) + ' of dead air removed.';
      } else {
        summary.textContent = 'Now ' + fmt(now) + '.';
      }
    });

    panel.querySelector('.autocut-refine').addEventListener('click', function () {
      var open = host.querySelector('.trim-panel.trim-manual');
      if (open) open.remove();
      var manual = buildPanel(source);
      manual.classList.add('trim-manual');
      host.appendChild(manual);
      manual.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    return closable(panel);
  }

  function buildPanel(source) {
    var panel = document.createElement('div');
    panel.className = 'trim-panel';
    panel.innerHTML = headHtml('Trim')
      + '<video controls preload="metadata" playsinline src="' + source.src + '"></video>'
      + '<div class="trim-range"><label>Start <span class="trim-start-val">0:00.0</span></label>'
      + '<input type="range" class="trim-start" min="0" max="100" step="0.1" value="0" /></div>'
      + '<div class="trim-range"><label>End <span class="trim-end-val">0:00.0</span></label>'
      + '<input type="range" class="trim-end" min="0" max="100" step="0.1" value="100" /></div>'
      + '<div class="trim-actions">'
      + '<button type="button" class="trim-go">Trim &amp; download</button>'
      + '<button type="button" class="trim-preview">Preview selection</button>'
      + '<span class="trim-msg"></span></div>';

    var video = panel.querySelector('video');
    var startEl = panel.querySelector('.trim-start');
    var endEl = panel.querySelector('.trim-end');
    var startVal = panel.querySelector('.trim-start-val');
    var endVal = panel.querySelector('.trim-end-val');
    var msg = panel.querySelector('.trim-msg');
    var goBtn = panel.querySelector('.trim-go');
    var previewBtn = panel.querySelector('.trim-preview');

    function refreshLabels() {
      startVal.textContent = fmt(Number(startEl.value));
      endVal.textContent = fmt(Number(endEl.value));
    }

    // The sliders can't be scaled until the browser knows how long the clip is.
    video.addEventListener('loadedmetadata', function () {
      var duration = video.duration;
      if (!isFinite(duration) || duration <= 0) return;
      startEl.max = String(duration);
      endEl.max = String(duration);
      endEl.value = String(duration);
      refreshLabels();
    });

    startEl.addEventListener('input', function () {
      if (Number(startEl.value) >= Number(endEl.value)) {
        startEl.value = String(Math.max(0, Number(endEl.value) - 0.5));
      }
      refreshLabels();
      video.currentTime = Number(startEl.value); // scrub the preview to the new in-point
    });

    endEl.addEventListener('input', function () {
      if (Number(endEl.value) <= Number(startEl.value)) {
        endEl.value = String(Number(startEl.value) + 0.5);
      }
      refreshLabels();
      video.currentTime = Number(endEl.value);
    });

    previewBtn.addEventListener('click', function () {
      var stopAt = Number(endEl.value);
      video.currentTime = Number(startEl.value);
      video.play();
      // Stop at the out-point instead of running to the end of the clip.
      var watch = setInterval(function () {
        if (video.paused || video.currentTime >= stopAt) {
          video.pause();
          clearInterval(watch);
        }
      }, 100);
    });

    goBtn.addEventListener('click', function () {
      var start = Number(startEl.value);
      var end = Number(endEl.value);
      var existing = panel.querySelector('.trim-dl');
      if (existing) existing.remove();

      goBtn.disabled = true;
      msg.classList.remove('error');
      msg.textContent = 'Trimming...';

      fetch(source.origin + '/trim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: source.file, start: start, end: end })
      }).then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) throw new Error(j.error || 'Trimming failed.');
          return j;
        });
      }).then(function (result) {
        goBtn.disabled = false;
        msg.textContent = 'Trimmed to ' + fmt(end - start) + '.';
        var a = document.createElement('a');
        a.className = 'trim-dl';
        a.href = source.origin + '/clips/' + result.file;
        a.textContent = 'Download trimmed clip';
        a.setAttribute('download', '');
        panel.querySelector('.trim-actions').appendChild(a);
      }).catch(function (err) {
        goBtn.disabled = false;
        msg.classList.add('error');
        msg.textContent = err.message;
      });
    });

    refreshLabels();
    return closable(panel);
  }

  // Where a clip's editing panels get appended. A VOD clip's link sits inside the clip panel on its
  // own video card, so the panels belong there; a live clip's link has no such wrapper, so they go
  // on the channel card. Keeping them next to their own clip is what lets several cards on screen
  // each have their own trimmer open without the panels landing on top of each other.
  function hostFor(link) {
    return link.closest('.clip-panel') || link.closest('.video-card') || channelCard;
  }

  function attach(link) {
    if (link.dataset.trimReady) return;

    var source = sourceFrom(link);
    if (!source) return;
    link.dataset.trimReady = '1';

    var host = hostFor(link);
    if (!host) return;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'trim-btn';
    btn.textContent = 'Trim';
    btn.title = 'Cut this clip down before downloading';
    link.parentNode.appendChild(btn);

    btn.addEventListener('click', function () {
      var open = host.querySelector('.trim-panel.trim-manual');
      if (open) {
        open.remove();
        return;
      }
      var manual = buildPanel(source);
      manual.classList.add('trim-manual');
      host.appendChild(manual);
    });

    if (!AUTOCUT_ENABLED) return;

    var autoBtn = document.createElement('button');
    autoBtn.type = 'button';
    autoBtn.className = 'autocut-btn';
    autoBtn.textContent = 'Cut dead air';
    autoBtn.title = 'Automatically remove the silent stretches from this clip';
    link.parentNode.appendChild(autoBtn);

    autoBtn.addEventListener('click', function () {
      var existing = host.querySelector('.trim-panel.trim-auto');
      if (existing) existing.remove();

      // The original clip's length is read straight off the source so the result panel can say how
      // much actually came off. A browser that can't report it just gets the shorter summary.
      var probe = document.createElement('video');
      probe.preload = 'metadata';
      probe.src = source.src;
      var originalDuration = NaN;
      probe.addEventListener('loadedmetadata', function () {
        originalDuration = probe.duration;
      });

      autoBtn.disabled = true;
      autoBtn.textContent = 'Cutting...';

      fetch(source.origin + '/autocut', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: source.file })
      }).then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) throw new Error(j.error || 'Auto-cut failed.');
          return j;
        });
      }).then(function (result) {
        autoBtn.disabled = false;
        autoBtn.textContent = 'Cut dead air';
        var cutSource = {
          origin: source.origin,
          file: result.file,
          src: source.origin + '/clips/' + result.file
        };
        var panel = buildResultPanel(host, cutSource, originalDuration);
        panel.classList.add('trim-auto');
        host.appendChild(panel);
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }).catch(function (err) {
        autoBtn.disabled = false;
        autoBtn.textContent = 'Cut dead air';
        var note = document.createElement('div');
        note.className = 'trim-panel trim-auto';
        note.innerHTML = headHtml('Auto-cut') + '<span class="trim-msg error"></span>';
        note.querySelector('.trim-msg').textContent = err.message;
        host.appendChild(closable(note));
      });
    });
  }

  function decorate() {
    // Both link kinds, wherever they are. Already-decorated links are skipped inside attach().
    var links = document.querySelectorAll('.live-clip-dl, .clip-download');
    for (var i = 0; i < links.length; i += 1) attach(links[i]);
  }

  // Cards are rebuilt on every lookup, every "Load more" and every new clip, so watch for download
  // links appearing rather than decorating once at startup. Both containers are watched because a
  // live clip lands in the channel card and a VOD clip lands in the results list.
  var observer = new MutationObserver(decorate);
  if (channelCard) observer.observe(channelCard, { childList: true, subtree: true });
  if (results) observer.observe(results, { childList: true, subtree: true });
  decorate();
})();
