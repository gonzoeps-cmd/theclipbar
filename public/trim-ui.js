// In-browser trimmer for finished clips.
//
// Self-contained on purpose: it watches for a clip's download link appearing and attaches itself,
// so neither live-clip.js nor app.js needs to know it exists. Works out the worker's address from
// the download link itself rather than needing configuration.
//
// The trimming happens on the worker (POST /trim), not here — the file is already sitting on that
// machine and ffmpeg is already installed there, so re-cutting is a fast stream copy. Doing it in
// the browser would mean shipping a video encoder to the phone for no benefit.
(function () {
  'use strict';
  var card = document.getElementById('channel-card');
  if (!card) return;

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
    + 'padding:8px 14px;border-radius:6px;font-size:.82rem}';
  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

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

  function buildPanel(link, source) {
    var panel = document.createElement('div');
    panel.className = 'trim-panel';
    panel.innerHTML =
      '<video controls preload="metadata" playsinline src="' + source.src + '"></video>'
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
    return panel;
  }

  function decorate() {
    var link = card.querySelector('.live-clip-dl');
    if (!link || link.dataset.trimReady) return;

    var source = sourceFrom(link);
    if (!source) return;
    link.dataset.trimReady = '1';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'trim-btn';
    btn.textContent = 'Trim';
    btn.title = 'Cut this clip down before downloading';
    link.parentNode.appendChild(btn);

    btn.addEventListener('click', function () {
      var open = card.querySelector('.trim-panel');
      if (open) {
        open.remove();
        return;
      }
      card.appendChild(buildPanel(link, source));
    });
  }

  // The clip card is rebuilt on every lookup and every new clip, so watch for the download link
  // rather than decorating once at startup.
  new MutationObserver(decorate).observe(card, { childList: true, subtree: true });
  decorate();
})();
