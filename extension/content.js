// Subtitle overlay, word popup, A/S/D keys and watch-time reporting on YouTube and Netflix.
(() => {
  const S = globalThis.LCSubs;
  const SITE = location.hostname.includes('netflix') ? 'netflix' : 'youtube';
  const WATCH_EVERY = 30; // seconds of playback between /api/watch calls
  const STATUS_BATCH = 400; // tokens per /api/words/status call

  let enabled = true; // overlay on for this site (toolbar popup toggle)
  let video = null; // {id, title, lines, statuses, sentencesSent} for the current video
  let watchSeconds = 0;
  let lastTick = performance.now();
  let shownIndex = null;
  let popup = null; // {el, pausedByUs}
  const ytUrls = {}; // YouTube videoId -> timedtext URL captured from the player
  const waiters = new Set();

  // ---------- messaging ----------
  function api(method, path, body) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'api', method, path, body }, (r) =>
          resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r)
        );
      } catch (err) {
        resolve({ ok: false, error: String(err) }); // extension reloaded; page needs a refresh
      }
    });
  }

  const toHook = (msg) => window.postMessage({ source: 'lc-content', ...msg }, '*');

  // Resolve with the first hook message that matches, or null after timeout.
  function waitForHook(match, timeout) {
    return new Promise((resolve) => {
      const w = { match, resolve };
      waiters.add(w);
      setTimeout(() => { if (waiters.delete(w)) resolve(null); }, timeout);
    });
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.source !== 'lc-hook') return;
    if (d.type === 'yt-timedtext-url') ytUrls[d.videoId] = d.url;
    for (const w of waiters) if (w.match(d)) { waiters.delete(w); w.resolve(d); }
  });

  // ---------- page helpers ----------
  function currentId() {
    if (SITE === 'youtube') return location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null;
    const m = /^\/watch\/(\d+)/.exec(location.pathname);
    return m ? m[1] : null;
  }
  const videoEl = () => document.querySelector(SITE === 'youtube' ? '#movie_player video' : 'video');
  const container = () =>
    SITE === 'youtube'
      ? document.getElementById('movie_player')
      : document.querySelector('.watch-video--player-view') || videoEl()?.parentElement;

  function seek(seconds) {
    if (SITE === 'netflix') return toHook({ type: 'nf-seek', seconds }); // setting currentTime crashes Netflix
    const v = videoEl();
    if (v) v.currentTime = seconds;
  }
  function pause() {
    if (SITE === 'netflix') toHook({ type: 'nf-pause' });
    else videoEl()?.pause();
  }
  function play() {
    if (SITE === 'netflix') toHook({ type: 'nf-play' });
    else videoEl()?.play();
  }

  async function fetchText(url) {
    const r = await fetch(url, { credentials: 'include' });
    return r.ok ? r.text() : '';
  }

  // ---------- loading subtitles ----------
  async function loadYouTube(id) {
    const reqId = Math.random().toString(36).slice(2);
    const reply = waitForHook((d) => d.type === 'yt-player' && d.reqId === reqId, 12000);
    toHook({ type: 'yt-get-player', videoId: id, reqId });
    const pr = await reply;
    if (!pr || pr.error) throw new Error('Could not read the YouTube player');
    video.title = pr.title;
    const track = S.pickYouTubeTrack(pr.captionTracks);
    if (!track) return null;
    if (pr.timedtextUrl) ytUrls[id] = ytUrls[id] || pr.timedtextUrl;

    // The plain baseUrl now usually returns an empty body; the player's own URL carries the token.
    let text = await fetchText(S.youtubeJson3Url(track.baseUrl, track)).catch(() => '');
    if (!text.trim()) {
      let url = ytUrls[id];
      if (!url) {
        const got = waitForHook((d) => d.type === 'yt-timedtext-url' && d.videoId === id, 10000);
        toHook({ type: 'yt-enable-captions', languageCode: track.languageCode, kind: track.kind });
        url = (await got)?.url;
      }
      if (!url) throw new Error('YouTube did not load its caption track');
      text = await fetchText(S.youtubeJson3Url(url, track));
    }
    return text;
  }

  async function loadNetflix() {
    video.title = document.querySelector('[data-uia="video-title"]')?.innerText.replace(/\n/g, ' ') || document.title;
    const reqId = Math.random().toString(36).slice(2);
    const got = waitForHook((d) => d.type === 'nf-subs' && d.reqId === reqId, 25000);
    toHook({ type: 'nf-get-subs', reqId });
    const r = await got;
    if (!r || r.error) throw new Error((r && r.error) || 'Netflix player not ready; reload the page');
    if (r.title) video.title = r.title;
    return r.text; // null when the title has no German subtitles
  }

  async function loadVideo(id) {
    flushWatch();
    closePopup(false);
    video = { id, title: document.title, lines: null, statuses: new Map(), sentencesSent: false };
    watchSeconds = 0;
    shownIndex = null;
    renderLine();
    const mine = video;
    try {
      const text = SITE === 'youtube' ? await loadYouTube(id) : await loadNetflix(id);
      if (video !== mine) return;
      const lines = text ? S.parseSubtitles(text) : [];
      mine.lines = lines;
      if (!lines.length) return notice('No German subtitles for this video');
      updateCaptionHiding();
      loadStatuses(mine);
    } catch (err) {
      if (video !== mine) return;
      mine.lines = [];
      notice('German subtitles unavailable: ' + err.message);
    }
  }

  async function loadStatuses(v) {
    const words = S.uniqueWords(v.lines);
    for (let i = 0; i < words.length; i += STATUS_BATCH) {
      const r = await api('POST', '/api/words/status', { tokens: words.slice(i, i + STATUS_BATCH) });
      if (!r.ok) return notice('Language Companion server not reachable');
      for (const [tok, info] of Object.entries(r.data?.tokens || {})) v.statuses.set(tok, info);
      if (video === v) { shownIndex = null; renderLine(); }
    }
  }

  // ---------- overlay ----------
  const overlay = document.createElement('div');
  overlay.className = 'lc-overlay';
  // Keep clicks on the overlay from reaching the player (which would toggle play/pause).
  for (const t of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick']) {
    overlay.addEventListener(t, (e) => e.stopPropagation());
  }
  overlay.addEventListener('click', (e) => {
    const w = e.target.closest('.lc-word');
    if (w) openPopup(w, video.lines[+overlay.dataset.index].text);
  });

  const active = () => enabled && video && video.lines && video.lines.length > 0;

  function updateCaptionHiding() {
    document.documentElement.classList.toggle('lc-active', !!active());
  }

  function mount(el) {
    const c = container();
    if (c && el.parentElement !== c) c.appendChild(el);
  }

  function renderLine() {
    if (!active()) { overlay.remove(); shownIndex = null; return; }
    mount(overlay);
    const v = videoEl();
    const i = v ? S.lineIndexAt(video.lines, v.currentTime) : -1;
    if (i === shownIndex) return;
    shownIndex = i;
    overlay.textContent = '';
    if (i < 0) return;
    overlay.dataset.index = i;
    const lineEl = document.createElement('div');
    lineEl.className = 'lc-line';
    for (const part of S.tokenize(video.lines[i].text)) {
      if (!part.word) { lineEl.append(part.text); continue; }
      const span = document.createElement('span');
      span.className = 'lc-word';
      const status = video.statuses.get(part.text)?.status;
      if (status === 'new' || status === 'learning') span.classList.add('lc-' + status);
      span.textContent = part.text;
      lineEl.append(span);
    }
    overlay.append(lineEl);
  }

  let noticeTimer;
  function notice(text) {
    const el = document.createElement('div');
    el.className = 'lc-notice';
    el.textContent = text;
    document.querySelector('.lc-notice')?.remove();
    (container() || document.body).appendChild(el);
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => el.remove(), 6000);
  }

  // ---------- word popup ----------
  function openPopup(wordEl, sentence) {
    const pausedByUs = (popup?.pausedByUs || false) || !videoEl()?.paused;
    closePopup(false);
    if (!videoEl()?.paused) pause();
    const word = wordEl.textContent;
    const wordIndex = [...overlay.querySelectorAll('.lc-word')].indexOf(wordEl);
    const el = document.createElement('div');
    el.className = 'lc-popup';
    for (const t of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick']) {
      el.addEventListener(t, (e) => e.stopPropagation());
    }
    el.innerHTML = '<button class="lc-close" title="Close (Esc)">×</button><div class="lc-head"></div><div class="lc-body">Looking up…</div>';
    el.querySelector('.lc-head').textContent = word;
    el.querySelector('.lc-close').addEventListener('click', () => closePopup(true));
    popup = { el, pausedByUs, word };
    mount(el);
    placePopup(el, wordEl);

    const mine = popup;
    api('POST', '/api/lookup', {
      word, sentence, source: SITE, external_id: video.id, title: video.title,
    }).then((r) => {
      if (popup !== mine) return;
      const body = el.querySelector('.lc-body');
      if (!r.ok) { body.textContent = r.error; return; }
      const d = r.data || {};
      el.querySelector('.lc-head').textContent = [d.article, d.lemma || word].filter(Boolean).join(' ');
      body.textContent = '';
      for (const [cls, text] of [['lc-gloss', d.gloss], ['lc-contextual', d.contextual], ['lc-grammar', d.note]]) {
        if (!text || (cls === 'lc-contextual' && text === d.gloss)) continue;
        const p = document.createElement('div');
        p.className = cls;
        p.textContent = text;
        body.append(p);
      }
      if (d.card_added) body.append(Object.assign(document.createElement('div'), { className: 'lc-note', textContent: 'Added to your cards' }));
      const btn = Object.assign(document.createElement('button'), { className: 'lc-ignore', textContent: "Don't track" });
      btn.addEventListener('click', () => ignore(d.lemma || word));
      body.append(btn);
      setStatus((tok, info) => tok === word, { lemma: d.lemma, status: d.status, gloss: d.gloss });
      // setStatus redraws the line, so measure from the redrawn copy of the word.
      const redrawn = overlay.querySelectorAll('.lc-word')[wordIndex];
      placePopup(el, redrawn?.textContent === word ? redrawn : wordEl);
    });
  }

  function placePopup(el, wordEl) {
    const c = el.parentElement;
    if (!c) return;
    // Measure from the element the popup is actually positioned against (not always the player box).
    const cr = (el.offsetParent || c).getBoundingClientRect();
    const wr = wordEl.getBoundingClientRect();
    const left = Math.min(Math.max(wr.left - cr.left + wr.width / 2 - el.offsetWidth / 2, 8), cr.width - el.offsetWidth - 8);
    el.style.left = left + 'px';
    el.style.bottom = cr.bottom - wr.top + 10 + 'px';
  }

  function closePopup(resume) {
    if (!popup) return;
    popup.el.remove();
    if (resume && popup.pausedByUs) play();
    popup = null;
  }

  async function ignore(lemma) {
    const r = await api('POST', '/api/ignore', { lemma });
    if (!r.ok) return notice(r.error);
    setStatus((tok, info) => info?.lemma === lemma || tok === popup?.word, { status: 'ignored' });
    closePopup(true);
  }

  function setStatus(match, info) {
    if (!video) return;
    for (const [tok, old] of video.statuses) if (match(tok, old)) video.statuses.set(tok, { ...old, ...info });
    if (popup && !video.statuses.has(popup.word)) video.statuses.set(popup.word, info);
    shownIndex = null;
    renderLine();
  }

  document.addEventListener('click', (e) => {
    if (!popup || popup.el.contains(e.target) || overlay.contains(e.target)) return;
    // A click on the player itself already toggles playback; resuming here would undo it.
    closePopup(!container()?.contains(e.target));
  }, true);

  // ---------- keys ----------
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popup) { closePopup(true); return; }
    if (!active() || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const key = { a: 'prev', d: 'next', s: 'replay' }[e.key.toLowerCase()];
    if (!key) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const v = videoEl();
    const i = v ? S.jumpTarget(video.lines, v.currentTime, key) : -1;
    if (i >= 0) { seek(video.lines[i].start); shownIndex = null; }
  }, true);

  // ---------- watch time ----------
  function flushWatch() {
    const v = video;
    const seconds = Math.round(watchSeconds);
    if (!v || !v.lines?.length || seconds < 1) return;
    watchSeconds = 0;
    const body = { source: SITE, external_id: v.id, title: v.title, url: location.href, seconds };
    if (!v.sentencesSent) body.sentences = v.lines.map((l) => ({ de: l.text, start: l.start, end: l.end }));
    api('POST', '/api/watch', body).then((r) => {
      if (r.ok && body.sentences) v.sentencesSent = true;
      if (!r.ok && video === v) watchSeconds += seconds; // retry with the next call
    });
  }

  function tick() {
    const now = performance.now();
    const dt = (now - lastTick) / 1000;
    lastTick = now;
    const id = currentId();
    if (id && id !== video?.id) loadVideo(id);
    else if (!id && video) { flushWatch(); closePopup(false); video = null; }
    updateCaptionHiding();
    if (!video) { overlay.remove(); return; }
    const v = videoEl();
    if (v && !v.paused && !v.ended && video.lines?.length && dt < 2) watchSeconds += dt;
    if (watchSeconds >= WATCH_EVERY) flushWatch();
    renderLine();
  }

  // ---------- settings ----------
  chrome.storage.sync.get({ sites: { youtube: true, netflix: true } }, ({ sites }) => {
    enabled = sites[SITE] !== false;
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.sites) return;
    enabled = changes.sites.newValue?.[SITE] !== false;
    if (!enabled) closePopup(true);
    shownIndex = null;
  });

  window.addEventListener('pagehide', flushWatch);
  setInterval(tick, 200);
})();
