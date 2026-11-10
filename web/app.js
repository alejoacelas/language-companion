// Sprachraum front end. One file, no build step. Every screen reads and writes the server's database.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const main = $('#main');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(path, opts = {}) {
  const init = { ...opts };
  if (opts.body && !(opts.body instanceof FormData)) {
    init.body = JSON.stringify(opts.body);
    init.headers = { 'Content-Type': 'application/json' };
    init.method = opts.method || 'POST';
  }
  const r = await fetch(path, init);
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}
const post = (path, body = {}) => api(path, { body });

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2800);
}
function ago(ts) {
  const s = Date.now() / 1000 - ts;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
function modal(html) { $('#modal').innerHTML = html; $('#overlay').classList.add('show'); }
function closeModal() { $('#overlay').classList.remove('show'); }
$('#overlay').addEventListener('click', e => { if (e.target.id === 'overlay') closeModal(); });

// ---------- audio ----------
const player = new Audio();
let playToken = 0;
function play(name) {
  return new Promise(res => {
    if (!name) return res();
    const tok = ++playToken;
    player.src = `/audio/${name}`;
    player.onended = () => res(tok === playToken);
    player.onerror = () => res(false);
    player.play().catch(() => res(false));
  });
}
function stopAudio() { playToken++; player.pause(); }
async function say(text, slow = false) {
  try { const r = await api(`/api/tts?text=${encodeURIComponent(text)}&slow=${slow}`); await play(r.audio); }
  catch { toast('Could not play audio'); }
}

// ---------- router ----------
let view = 'today', cleanup = null;
const views = {};
function go(v) {
  if (cleanup) { cleanup(); cleanup = null; }
  stopAudio();
  view = v; location.hash = v;
  $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  main.innerHTML = '';
  main.className = 'fade';
  views[v]();
  refreshNav();
}
$('#nav').addEventListener('click', e => { const b = e.target.closest('button[data-view]'); if (b) go(b.dataset.view); });

async function refreshNav() {
  try {
    const r = await api('/api/review');
    $('#dueCount').textContent = r.due || '';
  } catch { }
}

const SVG_MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';

// ---------- onboarding ----------
async function onboarding() {
  const ws = await api('/api/onboarding/words');
  const picked = new Set();
  main.innerHTML = `<h1>Willkommen</h1>
  <p class="sub">Tick the words you already know. These are the 300 most common German words, most common first. Skip any you're unsure of.</p>
  <div class="card"><div class="words" id="wp">${ws.map(w => `<button class="wpick" data-l="${esc(w.lemma)}">${w.article ? `<span class="muted">${esc(w.article)} </span>` : ''}${esc(w.lemma)}<small>${esc(w.gloss)}</small></button>`).join('')}</div>
  <div class="row" style="margin-top:16px"><label class="muted small">New words per day <input type="number" id="npd" value="10" min="3" max="30" style="width:70px;margin-left:6px"></label>
  <span class="spacer"></span><span class="muted small" id="pc">0 known</span><button class="btn primary big" id="ob">Start learning</button></div></div>`;
  $('#wp').addEventListener('click', e => {
    const b = e.target.closest('.wpick'); if (!b) return;
    const l = b.dataset.l; picked.has(l) ? picked.delete(l) : picked.add(l);
    b.classList.toggle('on'); $('#pc').textContent = `${picked.size} known`;
  });
  $('#ob').onclick = async () => {
    $('#ob').disabled = true;
    await post('/api/onboarding', { known: [...picked], new_per_day: +$('#npd').value || 10 });
    go('today');
  };
}

// ---------- today ----------
views.today = async () => {
  main.innerHTML = '<div class="empty"><span class="spin"></span></div>';
  const t = await api('/api/today');
  if (!t.onboarded) return onboarding();
  const hour = new Date().getHours();
  const hi = hour < 12 ? 'Guten Morgen' : hour < 18 ? 'Guten Tag' : 'Guten Abend';
  const toGo = Math.max(0, 600 - t.hours);
  main.innerHTML = `
  <div class="hero"><div><h1>${hi}</h1><p class="sub" style="margin:0">Day ${t.day_number} · ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</p></div>
    <div class="stats">
      <div class="stat"><b>${t.vocab.known + t.vocab.learning}</b><span>words in play</span></div>
      <div class="stat"><b>${t.hours}</b><span>hours practised</span></div>
      <div class="stat"><b>~${Math.round(toGo)}</b><span>hours to conversational</span></div>
    </div></div>
  <div class="grid" style="grid-template-columns:1.3fr 1fr">
    <div style="display:flex;flex-direction:column;gap:16px">
      <div class="card"><h3>Today</h3><div class="steps">${t.steps.map(s => `
        <div class="step ${s.done ? 'done' : ''}" data-v="${s.view}"><span class="check">${s.done ? '✓' : ''}</span>
        <span class="title">${esc(s.title)}</span><span class="min">${s.minutes} min</span></div>`).join('')}</div></div>
      <div class="card"><h3>Today's new words</h3>
        <div class="chips">${t.new_words.map(w => `<div class="chip" data-say="${esc(w.lemma)}" title="${esc(w.example || '')}">${w.article ? `<span class="art">${esc(w.article)}</span>` : ''}<b>${esc(w.lemma)}</b><span class="gl">${esc(w.gloss || '')}</span></div>`).join('') || '<span class="muted">None today</span>'}</div>
        <p class="muted small" style="margin:12px 0 0">They're already cards, and today's story and conversation use them. Click one to hear it.</p></div>
    </div>
    <div style="display:flex;flex-direction:column;gap:16px">
      <div class="card"><h3>In the background</h3>${t.feed.length ? `<ul class="feed">${t.feed.map(f => `<li><span class="when">${ago(f.ts)}</span><span>${esc(f.summary)}</span></li>`).join('')}</ul>` : '<p class="muted small" style="margin:0">Nothing yet. Lessons from Granola, videos you watch and conversations will show up here.</p>'}</div>
      <div class="card"><h3>Mistakes you're working on</h3>${t.errors.length ? `<div class="errlist">${t.errors.map(e => `<div class="err"><span>${esc(e.category)}</span><span class="tag warm">${e.n}×${e.fixed ? ` · fixed ${e.fixed}` : ''}</span></div>`).join('')}</div>` : '<p class="muted small" style="margin:0">None yet. They come from your conversations and lessons.</p>'}</div>
    </div>
  </div>`;
  main.addEventListener('click', todayClick);
  cleanup = () => main.removeEventListener('click', todayClick);
};
function todayClick(e) {
  const s = e.target.closest('.step'); if (s) return go(s.dataset.v);
  const c = e.target.closest('[data-say]'); if (c) say(c.dataset.say);
}

// ---------- review ----------
views.review = async () => {
  main.innerHTML = '<div class="empty"><span class="spin"></span></div>';
  const { cards } = await api('/api/review');
  let i = 0, revealed = false, shownAt = Date.now(), done = 0;
  let total = cards.length;
  const kindLabel = { word: 'Word', correction: 'Fix the mistake', pronunciation: 'Say it' };
  function render() {
    if (i >= cards.length) {
      main.innerHTML = `<div class="rev"><h1>All done</h1><p class="sub">${done ? `${done} cards reviewed.` : 'No cards are due right now.'} New ones come from today's words, what you look up and your mistakes.</p>
      <button class="btn primary big" id="next">Listen to today's story <kbd>3</kbd></button></div>`;
      $('#next').onclick = () => go('listen');
      refreshNav();
      return;
    }
    const c = cards[i];
    const [backMain, ...ex] = (c.back || '').split('\n');
    main.innerHTML = `<div class="rev">
      <div class="row"><span class="muted small">${i + 1} of ${cards.length}</span><span class="spacer"></span><button class="btn ghost small" id="susp" title="Remove this card">Remove card</button></div>
      <div class="progress"><div style="width:${i / cards.length * 100}%"></div></div>
      <div class="flash">
        <div class="kind">${kindLabel[c.kind] || c.kind}</div>
        <div class="front ${c.kind === 'correction' ? 'wrong' : ''}">${esc(c.front)}</div>
        ${c.kind === 'word' ? '<div><button class="btn ghost small" id="hearc">🔊 Hear it <kbd>R</kbd></button></div>' : ''}
        ${revealed ? `<div class="back">${esc(backMain)}${ex.length ? `<span class="ex">${esc(ex.join(' '))}</span>` : ''}</div>
        <div class="note">${esc(c.note || '')}${c.source ? ` <span class="tag">${esc(c.source)}</span>` : ''}</div>` : `<div class="note">${c.kind === 'word' ? 'What does it mean? Say it out loud.' : c.kind === 'correction' ? 'Say the correct version out loud.' : 'Say it out loud.'}</div>`}
      </div>
      ${revealed ? `<div class="grades">
        <button class="btn" data-g="1">Again <kbd>1</kbd></button><button class="btn" data-g="2">Hard <kbd>2</kbd></button>
        <button class="btn primary" data-g="3">Good <kbd>3</kbd></button><button class="btn" data-g="4">Easy <kbd>4</kbd></button></div>
        <p class="muted small">Space = Good · R = hear it again</p>`
        : `<div style="margin-top:18px"><button class="btn primary big" id="show">Show answer <kbd>Space</kbd></button></div>`}
    </div>`;
    $('#show')?.addEventListener('click', reveal);
    $('#hearc')?.addEventListener('click', speakCard);
    $$('[data-g]').forEach(b => b.onclick = () => grade(+b.dataset.g));
    $('#susp').onclick = async () => { await post(`/api/cards/${c.id}/suspend`); toast('Card removed'); i++; revealed = false; render(); };
  }
  function speakCard() {
    const c = cards[i]; if (!c) return;
    if (c.kind === 'word') say(c.front);
    else if (c.kind === 'correction') say(c.back);
  }
  function reveal() { revealed = true; render(); speakCard(); }
  async function grade(g) {
    const c = cards[i];
    const secs = (Date.now() - shownAt) / 1000;
    if (g === 1) cards.push(c);  // missed cards come back before the session ends
    i++; revealed = false; done++; shownAt = Date.now(); render();
    try { await post('/api/review', { card_id: c.id, rating: g, seconds: Math.min(secs, 60) }); refreshNav(); } catch { toast('Could not save that review'); }
  }
  function key(e) {
    if (e.target.matches('input,textarea')) return;
    if (i >= cards.length) return;
    if (e.code === 'Space') { e.preventDefault(); revealed ? grade(3) : reveal(); return; }
    if (['1', '2', '3', '4'].includes(e.key)) { e.stopPropagation(); if (revealed) grade(+e.key); return; }
    if (e.key === 'r' || e.key === 'R') speakCard();
  }
  document.addEventListener('keydown', key, true);
  cleanup = () => document.removeEventListener('keydown', key, true);
  render();
};

// ---------- listen & read ----------
let listenTab = 'made';
views.listen = async () => {
  main.innerHTML = `<h1>Listen &amp; read</h1><p class="sub">Words are coloured by what you know. Clicking a new word makes it a card.</p>
  <div class="tabs" id="tabs">${[['made', 'Made for you'], ['pod', 'Podcasts & articles'], ['youtube', 'YouTube'], ['netflix', 'Netflix']]
      .map(([k, l]) => `<button data-t="${k}" class="${k === listenTab ? 'on' : ''}">${l}</button>`).join('')}</div><div id="lib"></div>`;
  $('#tabs').onclick = e => { const b = e.target.closest('button'); if (b) { listenTab = b.dataset.t; views.listen(); } };
  const all = await api('/api/library');
  const lib = $('#lib');
  const itemCard = r => `<div class="card item" data-id="${r.id}" data-url="${esc(r.url || '')}" data-kind="${r.kind}">
    <span class="tag ${r.kind === 'youtube' || r.kind === 'netflix' ? 'ext' : r.kind === 'story' ? 'acc' : ''}">${r.kind}</span>
    <div class="t">${esc(r.title)}</div><div class="p">${esc(r.preview)}</div>
    ${r.known_share != null ? `<div class="small muted">${Math.round(r.known_share * 100)}% familiar${r.finished_ts ? ' · finished' : ''}</div><div class="meter"><div style="width:${r.known_share * 100}%"></div></div>` : ''}</div>`;
  if (listenTab === 'made') {
    const mine = all.filter(r => ['story', 'dialogue'].includes(r.kind));
    lib.innerHTML = `<div class="card" style="margin-bottom:16px"><div class="row"><div><h2 style="margin:0">Today's story</h2><span class="muted small">Written for you with today's new words and the ones you're learning.</span></div><span class="spacer"></span>
      <button class="btn primary" id="todayStory">Open today's story</button></div>
      <div class="row" style="margin-top:14px"><input type="text" id="topic" placeholder="Or ask for something: a dialogue at the bakery, a story about football…" style="flex:1"><button class="btn" id="gen">Write it</button></div></div>
      <div class="items">${mine.map(itemCard).join('') || ''}</div>`;
    $('#todayStory').onclick = async () => { const b = $('#todayStory'); b.disabled = true; b.innerHTML = '<span class="spin"></span> Writing today\'s story…'; const r = await api('/api/story/today'); openReader(r.id); };
    const gen = async () => {
      const topic = $('#topic').value.trim(); if (!topic) return $('#topic').focus();
      $('#gen').disabled = true; $('#gen').innerHTML = '<span class="spin"></span> Writing…';
      try { const r = await post('/api/content/generate', { kind: /dialog|gespräch|conversation/i.test(topic) ? 'dialogue' : 'story', topic }); openReader(r.id); }
      catch (e) { toast('Could not write it: ' + e.message); $('#gen').disabled = false; $('#gen').textContent = 'Write it'; }
    };
    $('#gen').onclick = gen; $('#topic').onkeydown = e => { if (e.key === 'Enter') gen(); };
  } else if (listenTab === 'pod') {
    const mine = all.filter(r => ['podcast', 'article'].includes(r.kind));
    lib.innerHTML = `<div class="grid" style="margin-bottom:16px">
      <div class="card"><h2>Find a podcast</h2><div class="row"><input type="text" id="pq" placeholder="e.g. slow german, deutsch lernen" style="flex:1" value="slow german"><button class="btn" id="ps">Search</button></div><div id="pr" style="margin-top:12px"></div></div>
      <div class="card"><h2>Import an article</h2><div class="row"><input type="url" id="au" placeholder="Paste a link to a German article" style="flex:1"><button class="btn" id="ai">Import</button></div>
      <p class="muted small" style="margin:10px 0 0">Easy news: <a href="https://www.nachrichtenleicht.de" target="_blank">nachrichtenleicht.de</a></p></div></div>
      <div class="items">${mine.map(itemCard).join('')}</div>`;
    const search = async () => {
      $('#pr').innerHTML = '<span class="spin"></span>';
      const res = await api('/api/podcasts/search?q=' + encodeURIComponent($('#pq').value));
      $('#pr').innerHTML = res.map(p => `<div class="row" style="padding:6px 0;border-top:1px solid var(--line)">${p.image ? `<img src="${esc(p.image)}" width="36" height="36" style="border-radius:6px">` : ''}<div style="flex:1"><b>${esc(p.title)}</b><div class="muted small">${esc(p.author)}</div></div><button class="btn small" data-feed="${esc(p.feed)}">Episodes</button></div>`).join('') || '<span class="muted">Nothing found</span>';
    };
    $('#ps').onclick = search; $('#pq').onkeydown = e => { if (e.key === 'Enter') search(); };
    $('#pr').onclick = async e => {
      const b = e.target.closest('[data-feed]'); if (b) {
        $('#pr').innerHTML = '<span class="spin"></span>';
        const eps = await api('/api/podcasts/episodes?feed=' + encodeURIComponent(b.dataset.feed));
        $('#pr').innerHTML = eps.map((ep, k) => `<div class="row" style="padding:6px 0;border-top:1px solid var(--line)"><div style="flex:1"><b>${esc(ep.title)}</b><div class="muted small">${esc(ep.published)}</div></div><button class="btn small" data-ep="${k}">Import</button></div>`).join('');
        $('#pr')._eps = eps; return;
      }
      const im = e.target.closest('[data-ep]'); if (im) {
        const ep = $('#pr')._eps[+im.dataset.ep];
        im.disabled = true; im.innerHTML = '<span class="spin"></span> Transcribing (a minute or two)…';
        try { const r = await post('/api/podcasts/import', { audio: ep.audio, title: ep.title, show: ep.show, id: ep.id }); openReader(r.id); }
        catch (err) { toast('Import failed: ' + err.message); im.disabled = false; im.textContent = 'Import'; }
      }
    };
    $('#ai').onclick = async () => {
      const u = $('#au').value.trim(); if (!u) return;
      $('#ai').disabled = true; $('#ai').innerHTML = '<span class="spin"></span>';
      try { const r = await post('/api/articles/import', { url: u }); openReader(r.id); }
      catch (err) { toast('Import failed: ' + err.message); $('#ai').disabled = false; $('#ai').textContent = 'Import'; }
    };
  } else {
    const src = listenTab;
    const mine = all.filter(r => r.kind === src);
    const site = src === 'youtube' ? 'https://www.youtube.com/results?search_query=easy+german' : 'https://www.netflix.com/browse';
    lib.innerHTML = `<div class="card" style="margin-bottom:16px;border-color:var(--ext-soft)"><div class="row"><span class="tag ext">Chrome extension</span>
      <span class="muted small" style="flex:1">Watch on ${src === 'youtube' ? 'YouTube' : 'Netflix'} with German subtitles. The extension colours words, lets you click them, and sends what you watch here. If ${src === 'youtube' ? 'YouTube' : 'Netflix'} changes its site, this part can break; everything else keeps working.</span>
      <a class="btn" href="${site}" target="_blank">Open ${src === 'youtube' ? 'YouTube' : 'Netflix'}</a></div></div>
      ${mine.length ? `<div class="items">${mine.map(itemCard).join('')}</div>` : `<div class="empty">Nothing watched yet.</div>`}`;
  }
  lib.addEventListener('click', e => {
    const it = e.target.closest('.item'); if (!it) return;
    if (['youtube', 'netflix'].includes(it.dataset.kind) && it.dataset.url) return window.open(it.dataset.url, '_blank');
    openReader(+it.dataset.id);
  });
};

async function openReader(id) {
  if (cleanup) { cleanup(); cleanup = null; }
  main.innerHTML = '<div class="empty"><span class="spin"></span></div>';
  let c = await api(`/api/content/${id}`);
  let cur = Math.min(c.progress || 0, c.sentences.length - 1), playing = false, showEn = false, sel = null;
  const started = Date.now();
  const isPod = c.kind === 'podcast';
  // split the raw text into words and the bits between them, escaping each piece
  const wrapWords = text => text.split(/([A-Za-zÄÖÜäöüß]+(?:[-'’][A-Za-zÄÖÜäöüß]+)*)/).map((part, k) => {
    if (k % 2 === 0) return esc(part);
    const st = c.tokens[part]?.status;
    return `<span class="w ${st === 'new' || st === 'learning' ? st : ''}" data-w="${esc(part)}">${esc(part)}</span>`;
  }).join('');
  main.innerHTML = `<div class="reader-head">
      <button class="btn ghost" id="back">← Library</button>
      <h1 style="margin:0">${esc(c.title)}</h1>
      <div class="muted small">${c.sentences.length} sentences · ${Math.round(c.known_share * 100)}% of the words are familiar</div></div>
    <div class="player">
      <button class="btn primary" id="pp">▶ Play <kbd>Space</kbd></button>
      <button class="btn ghost" id="prev">← <span class="small">previous</span></button><button class="btn ghost" id="nxt"><span class="small">next</span> →</button>
      <button class="btn ghost" id="tr">Translation <kbd>T</kbd></button>
      <span class="spacer"></span>
      <div class="legend"><span><i style="background:var(--new)"></i>new</span><span><i style="background:var(--learning)"></i>learning</span></div>
    </div>
    <div class="reader"><div class="text" id="txt">${c.sentences.map((s, k) => `<div class="sent" data-i="${k}"><div class="de">${wrapWords(s.de)}</div>${s.en ? `<div class="en">${esc(s.en)}</div>` : ''}</div>`).join('')}
      <div class="row" style="padding:14px"><span class="spacer"></span><button class="btn primary" id="fin">I'm done</button></div></div>
      <div class="card gloss" id="gloss"><h3>Click a word</h3><p class="muted small" style="margin:0">See what it means here. New words you click become cards.<br><br>Click a sentence to hear it. Space plays and pauses; ← and → move between sentences.</p></div></div>`;
  const podAudio = isPod ? new Audio(`/audio/${c.audio}`) : null;
  function mark() {
    $$('.sent').forEach(el => el.classList.toggle('cur', +el.dataset.i === cur));
    const el = $(`.sent[data-i="${cur}"]`); el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    $('#pp').innerHTML = playing ? '❚❚ Pause <kbd>Space</kbd>' : '▶ Play <kbd>Space</kbd>';
  }
  async function waitAudio(k) {
    // story audio is generated in the background; poll briefly if this sentence isn't ready yet
    for (let n = 0; n < 30 && !c.sentences[k].audio; n++) {
      await new Promise(r => setTimeout(r, 1000));
      const fresh = await api(`/api/content/${id}`); c.sentences = fresh.sentences;
      if (!playing) return null;
    }
    return c.sentences[k].audio;
  }
  async function playFrom(k) {
    playing = true; cur = k; mark();
    if (isPod) {
      podAudio.currentTime = c.sentences[k].start || 0; podAudio.play();
      return;
    }
    while (playing && cur < c.sentences.length) {
      const a = await waitAudio(cur);
      if (!playing) return;
      if (!a) { toast('Audio is still being made. Try again in a moment.'); playing = false; mark(); return; }
      const ok = await play(a);
      if (!ok || !playing) return;
      if (cur === c.sentences.length - 1) { playing = false; mark(); finish(); return; }
      cur++; mark(); post(`/api/content/${id}/progress`, { i: cur });
    }
  }
  if (isPod) {
    podAudio.ontimeupdate = () => {
      const t = podAudio.currentTime;
      const k = c.sentences.findIndex(s => t >= s.start && t < s.end);
      if (k >= 0 && k !== cur) { cur = k; mark(); }
    };
    podAudio.onended = () => { playing = false; mark(); finish(); };
  }
  function pause() { playing = false; stopAudio(); podAudio?.pause(); mark(); }
  function toggle() { playing ? pause() : playFrom(cur); }
  function step(d) { const was = playing; pause(); cur = Math.max(0, Math.min(c.sentences.length - 1, cur + d)); mark(); if (was) playFrom(cur); }
  let finished = false;
  async function finish() {
    if (finished) return; finished = true;
    await post(`/api/content/${id}/finish`, { seconds: (Date.now() - started) / 1000 });
    toast('Nice. Logged as listening time.');
  }
  async function lookup(w, sentence, el) {
    $$('.w.sel').forEach(x => x.classList.remove('sel')); el.classList.add('sel');
    $('#gloss').innerHTML = `<div class="lem">${esc(w)}</div><span class="spin"></span>`;
    const r = await post('/api/lookup', { word: w, sentence, source: c.kind, external_id: String(id), title: c.title });
    sel = r;
    $('#gloss').innerHTML = `<div class="lem">${r.article ? `<span class="art">${esc(r.article)}</span>` : ''}${esc(r.lemma)}</div>
      <div class="mean">${esc(r.contextual || r.gloss)}</div>
      ${r.contextual && r.gloss && r.contextual !== r.gloss ? `<div class="muted small">Usually: ${esc(r.gloss)}</div>` : ''}
      ${r.note ? `<p class="small" style="color:var(--warm)">${esc(r.note)}</p>` : ''}
      <p class="muted small">${r.card_added ? 'New word: added as a card.' : r.was === 'learning' ? "You're learning this one. Its card moves up." : r.was === 'known' ? 'You know this one.' : ''}</p>
      <div class="row"><button class="btn small" id="hear">🔊 Hear it</button>${r.status !== 'ignored' ? '<button class="btn ghost small" id="ign">Don\'t track</button>' : ''}</div>`;
    $('#hear').onclick = () => say(r.lemma);
    $('#ign')?.addEventListener('click', async () => { await post('/api/ignore', { lemma: r.lemma }); toast(`Won't track "${r.lemma}"`); $('#ign').remove(); });
    // recolour this word everywhere
    const st = r.status === 'ignored' ? '' : r.status;
    $$('.w').forEach(x => { if (c.tokens[x.dataset.w]?.lemma === r.lemma || x.dataset.w === w) { x.classList.remove('new', 'learning'); if (st === 'new' || st === 'learning') x.classList.add(st); } });
  }
  $('#txt').addEventListener('click', e => {
    const w = e.target.closest('.w');
    if (w) { e.stopPropagation(); pause(); return lookup(w.dataset.w, c.sentences[+w.closest('.sent').dataset.i].de, w); }
    const s = e.target.closest('.sent'); if (s) { pause(); playFrom(+s.dataset.i); }
  });
  $('#pp').onclick = toggle; $('#prev').onclick = () => step(-1); $('#nxt').onclick = () => step(1);
  $('#tr').onclick = () => { showEn = !showEn; $('#txt').classList.toggle('showen', showEn); };
  $('#fin').onclick = async () => { pause(); await finish(); views.listen(); };
  $('#back').onclick = () => { pause(); go('listen'); };
  function key(e) {
    if (e.target.matches('input,textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 't' || e.key === 'T') $('#tr').click();
    else if (e.key === 'Escape') { pause(); go('listen'); }
  }
  document.addEventListener('keydown', key);
  cleanup = () => { document.removeEventListener('keydown', key); pause(); };
  mark();
}

// ---------- speak ----------
views.speak = () => {
  main.innerHTML = `<h1>Speak</h1><p class="sub">A conversation pitched at your level. When you make a mistake it gives you a chance to fix it yourself first.</p>
  <div class="card" style="max-width:640px"><h2>What do you want to talk about?</h2>
  <div class="row"><input type="text" id="topic" placeholder="Anything, or leave empty and it picks from today's words" style="flex:1"><button class="btn primary" id="go">Start <kbd>↵</kbd></button></div>
  <p class="muted small" style="margin:12px 0 0">Hold <kbd>Space</kbd> to talk and let go to send. You can also type.</p></div>`;
  const start = async () => {
    if ($('#go').disabled) return;
    $('#go').disabled = true; $('#go').innerHTML = '<span class="spin"></span>';
    try { const r = await post('/api/speak/start', { topic: $('#topic').value }); if (cleanup) { cleanup(); cleanup = null; } conversation(r); }
    catch (e) { toast('Could not start: ' + e.message); $('#go').disabled = false; $('#go').textContent = 'Start'; }
  };
  $('#go').onclick = start; $('#topic').onkeydown = e => { if (e.key === 'Enter') start(); };
  // Enter starts from anywhere on this screen; number keys keep switching screens
  const key = e => { if (e.key === 'Enter' && !e.target.matches('input,textarea')) start(); };
  document.addEventListener('keydown', key);
  cleanup = () => document.removeEventListener('keydown', key);
};

function conversation(first) {
  const sid = first.session_id;
  const caught = [];
  let rec = null, chunks = [], busy = false, recording = false;
  main.innerHTML = `<div class="row" style="margin-bottom:14px"><h1 style="margin:0;flex:1">${esc(first.topic || 'Conversation')}</h1><button class="btn" id="end">End conversation</button></div>
  <div class="speak"><div class="card" style="padding:0"><div class="chat" id="chat"></div>
    <div class="talk"><button class="mic" id="mic" title="Hold to talk">${SVG_MIC}</button>
      <div class="muted small" id="hint">Hold <kbd>Space</kbd> or the button to talk</div>
      <div class="typed" style="padding:0 20px 18px"><input type="text" id="typed" placeholder="…or type and press Enter"><button class="btn ghost" id="en">Show English</button></div></div></div>
    <div class="card"><h3>This conversation</h3><div id="caught" class="feed"><p class="muted small" style="margin:0">Mistakes and new words show up here, and go into your cards.</p></div></div></div>`;
  const chat = $('#chat');
  let showEn = false;
  function addMsg(who, text, extra = {}) {
    const d = document.createElement('div');
    d.className = `msg ${who}`;
    d.innerHTML = `${esc(text)}${extra.en ? `<span class="en" style="display:${showEn ? 'block' : 'none'}">${esc(extra.en)}</span>` : ''}${extra.fix ? `<span class="fix">${esc(extra.fix)}</span>` : ''}`;
    if (who === 'ai' && extra.audio) { d.style.cursor = 'pointer'; d.title = 'Click to hear again'; d.onclick = () => play(extra.audio); }
    chat.appendChild(d); chat.scrollTop = chat.scrollHeight; return d;
  }
  function renderCaught() {
    $('#caught').innerHTML = caught.length ? '<ul class="feed caught">' + caught.map(c => `<li>${c}</li>`).join('') + '</ul>' : '<p class="muted small" style="margin:0">Nothing yet.</p>';
  }
  addMsg('ai', first.reply, { en: first.reply_en, audio: first.audio });
  play(first.audio);
  async function send(form, label) {
    busy = true; $('#mic').classList.add('busy'); $('#hint').innerHTML = '<span class="spin"></span> Listening to what you said…';
    const pending = addMsg('me', label || '…');
    const thinking = addMsg('ai pending', '…');
    form.append('session_id', sid);
    try {
      const r = await api('/api/speak/turn', { method: 'POST', body: form });
      if (r.empty) { pending.remove(); thinking.remove(); toast("I didn't catch that. Try again."); return; }
      pending.textContent = r.heard;
      thinking.remove();
      const m = r.mistake;
      let fix = '';
      if (m && m.status === 'prompted') { fix = 'Your turn: say it again, fixed'; caught.push(`<span class="tag warm">${esc(m.category)}</span><div>${esc(m.wrong)}</div>`); }
      if (m && m.status === 'self_corrected') { fix = 'You fixed it ✓'; caught.push(`<span class="tag acc">Fixed it yourself</span><div>${esc(m.right)}</div>`); }
      if (m && m.status === 'corrected_by_ai') { fix = `Correct: ${m.right}`; caught.push(`<span class="tag">New card</span><div>${esc(m.right)}</div>`); }
      (r.english_words || []).forEach(w => caught.push(`<span class="tag">Needed a word</span><div>${esc(w)}</div>`));
      renderCaught();
      if (m && m.status === 'corrected_by_ai' && m.explanation) fix += ` · ${m.explanation}`;
      addMsg('ai', r.reply, { en: r.reply_en, fix, audio: r.audio });
      busy = false; $('#mic').classList.remove('busy'); $('#hint').innerHTML = 'Hold <kbd>Space</kbd> or the button to talk';
      await play(r.audio);
    } catch (e) { pending.remove(); thinking.remove(); toast('Something went wrong: ' + e.message); }
    finally { busy = false; $('#mic').classList.remove('busy'); $('#hint').innerHTML = 'Hold <kbd>Space</kbd> or the button to talk'; }
  }
  async function startRec() {
    if (busy || recording) return;
    stopAudio();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      rec = new MediaRecorder(stream); chunks = [];
      rec.ondataavailable = e => chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        if (blob.size < 2000) { toast('Hold a little longer while you speak'); return; }
        const f = new FormData(); f.append('audio', blob, 'speech.webm'); send(f);
      };
      rec.start(); recording = true; $('#mic').classList.add('rec'); $('#hint').textContent = 'Listening… let go to send';
    } catch { toast('Microphone not available. Allow it in the browser, or type instead.'); }
  }
  function stopRec() { if (!recording) return; recording = false; $('#mic').classList.remove('rec'); rec.stop(); }
  const mic = $('#mic');
  mic.addEventListener('pointerdown', startRec); mic.addEventListener('pointerup', stopRec); mic.addEventListener('pointerleave', stopRec);
  $('#typed').onkeydown = e => { if (e.key === 'Enter' && e.target.value.trim() && !busy) { const f = new FormData(); f.append('text', e.target.value); send(f, e.target.value); e.target.value = ''; } };
  $('#en').onclick = () => { showEn = !showEn; $$('.msg .en').forEach(x => x.style.display = showEn ? 'block' : 'none'); $('#en').textContent = showEn ? 'Hide English' : 'Show English'; };
  const end = async () => { stopRec(); await post('/api/speak/end', { session_id: sid }); toast('Conversation saved'); go('today'); };
  $('#end').onclick = end;
  function kd(e) { if (e.target.matches('input,textarea')) return; if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) startRec(); } }
  function ku(e) { if (e.target.matches('input,textarea')) return; if (e.code === 'Space') { e.preventDefault(); stopRec(); } }
  document.addEventListener('keydown', kd); document.addEventListener('keyup', ku);
  cleanup = () => { document.removeEventListener('keydown', kd); document.removeEventListener('keyup', ku); post('/api/speak/end', { session_id: sid }).catch(() => { }); };
}

// ---------- tutor ----------
views.tutor = async () => {
  main.innerHTML = '<div class="empty"><span class="spin"></span></div>';
  const L = await api('/api/lessons');
  main.innerHTML = `<h1>Tutor</h1><p class="sub">Book a lesson on italki. Granola records it, and its mistakes and new words come back here as cards.</p>
  <div class="grid" style="margin-bottom:16px">
    <div class="card"><h2>Find a tutor now</h2><p class="muted small">Opens italki's German teachers. Use the Lesson time filter to pick someone free today.</p>
      <button class="btn primary" id="find">Find a German tutor <kbd>T</kbd></button></div>
    <div class="card"><h2>Brief for your tutor</h2><p class="muted small">Written from your progress. Paste it in the italki chat before the lesson.</p>
      <div class="row"><input type="text" id="tname" list="tutors" placeholder="Tutor's name" style="flex:1"><datalist id="tutors">${L.tutors.map(t => `<option value="${esc(t)}">`).join('')}</datalist><button class="btn" id="mk">Write brief</button></div></div>
  </div>
  <div class="card"><div class="row" style="margin-bottom:8px"><h2 style="margin:0;flex:1">Lessons</h2>
    ${L.configured ? `<span class="muted small">Granola checked ${L.last_sync ? ago(L.last_sync) + ' ago' : 'not yet'}</span><button class="btn small" id="sync">Check now</button>` : '<span class="tag warm">Granola not connected yet</span>'}</div>
    ${L.lessons.length ? `<table><tr><th>Date</th><th>Tutor</th><th>Length</th><th>What came out of it</th></tr>${L.lessons.map(l => `<tr class="click" data-id="${l.id}"><td>${new Date(l.started * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</td><td>${esc(l.meta.tutor || '—')}</td><td>${l.meta.duration_min ? l.meta.duration_min + ' min' : ''}</td><td>${l.meta.cards_added ?? 0} corrections · ${l.meta.words_added ?? 0} words</td></tr>`).join('')}</table>`
      : `<div class="empty">No lessons yet. ${L.configured ? 'Record your next italki lesson with Granola and it will show up here within ten minutes of the summary being ready.' : 'Once the Granola API key is set, your recorded lessons appear here automatically.'}</div>`}</div>`;
  const find = async () => { window.open('https://www.italki.com/en/teachers/german', '_blank'); post('/api/tutor/started'); };
  $('#find').onclick = find;
  $('#mk').onclick = () => { const n = $('#tname').value.trim(); if (!n) return $('#tname').focus(); briefModal(n); };
  $('#tname').onkeydown = e => { if (e.key === 'Enter') $('#mk').click(); };
  $('#sync')?.addEventListener('click', async () => {
    $('#sync').innerHTML = '<span class="spin"></span>';
    try { const r = await post('/api/lessons/sync'); toast(`${r.imported.length} new lesson(s)`); views.tutor(); }
    catch (e) { toast('Sync failed: ' + e.message); $('#sync').textContent = 'Check now'; }
  });
  main.querySelector('table')?.addEventListener('click', e => { const tr = e.target.closest('tr[data-id]'); if (tr) lessonView(+tr.dataset.id); });
  function key(e) { if (e.target.matches('input,textarea')) return; if (e.key === 't' || e.key === 'T') find(); }
  document.addEventListener('keydown', key);
  cleanup = () => document.removeEventListener('keydown', key);
};

async function briefModal(name) {
  modal(`<h2>Brief for ${esc(name)}</h2><div class="empty"><span class="spin"></span> Writing from your progress…</div>`);
  try {
    const r = await api('/api/brief?tutor=' + encodeURIComponent(name));
    modal(`<h2>Brief for ${esc(name)}</h2><p class="muted small">Edit anything, then copy it into the italki chat.</p>
      <textarea class="brief" id="bt">${esc(r.text)}</textarea>
      <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn ghost" id="bc">Close <kbd>Esc</kbd></button><button class="btn primary" id="bcp">Copy <kbd>⌘↵</kbd></button></div>`);
    const copy = async () => {
      // the clipboard API only exists on localhost/https; select-and-copy covers other addresses
      if (navigator.clipboard) await navigator.clipboard.writeText($('#bt').value);
      else { $('#bt').select(); document.execCommand('copy'); }
      closeModal(); toast('Copied. Paste it in the italki chat.');
    };
    $('#bcp').onclick = copy; $('#bc').onclick = closeModal;
    $('#bt').onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); copy(); } };
    $('#bt').focus();
  } catch (e) { modal(`<h2>Brief for ${esc(name)}</h2><p>Could not write it: ${esc(e.message)}</p><button class="btn" onclick="document.getElementById('overlay').classList.remove('show')">Close</button>`); }
}

async function lessonView(id) {
  const l = await api(`/api/lessons/${id}`);
  main.innerHTML = `<div class="row" style="margin-bottom:14px"><button class="btn ghost" id="back">← Tutor <kbd>Esc</kbd></button><h1 style="margin:0">${esc(l.meta.tutor || 'Lesson')} · ${new Date(l.started * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</h1></div>
  <div class="grid" style="grid-template-columns:1.4fr 1fr">
    <div class="card transcript"><h3>Transcript</h3><p class="muted small">"Me" is your microphone and "Tutor" is the call audio, so who said what comes from the recording itself.</p>
      ${l.lines.map(x => `<div class="line ${x.speaker}"><span class="who">${x.speaker === 'me' ? 'Me' : 'Tutor'}</span><span>${esc(x.text)}</span></div>`).join('')}</div>
    <div style="display:flex;flex-direction:column;gap:16px">
      <div class="card"><h3>Summary</h3><p style="margin:0">${esc(l.meta.summary || '')}</p>${l.meta.next_time ? `<p class="small muted">Next time: ${esc(l.meta.next_time)}</p>` : ''}</div>
      <div class="card"><h3>Added to your cards</h3>${l.cards.length ? `<ul class="feed">${l.cards.map(c => `<li style="justify-content:space-between;${c.suspended ? 'opacity:.4' : ''}"><span><span class="muted">${esc(c.front)}</span> → ${esc(c.back)}</span>${c.suspended ? '<span class="small muted">removed</span>' : `<button class="btn ghost small" data-rm="${c.id}">undo</button>`}</li>`).join('')}</ul>` : '<p class="muted small">Nothing.</p>'}</div>
    </div></div>`;
  $('#back').onclick = () => go('tutor');
  main.addEventListener('click', async e => { const b = e.target.closest('[data-rm]'); if (b) { await post(`/api/cards/${b.dataset.rm}/suspend`); lessonView(id); } });
  function key(e) { if (e.key === 'Escape') go('tutor'); }
  if (cleanup) cleanup();
  document.addEventListener('keydown', key);
  cleanup = () => document.removeEventListener('keydown', key);
}

// ---------- progress ----------
views.me = async () => {
  main.innerHTML = '<div class="empty"><span class="spin"></span></div>';
  const m = await api('/api/me');
  const total = m.vocab.known + m.vocab.learning;
  const p = m.practice; const fmt = s => s ? `${Math.floor(s / 3600)}h ${String(Math.round(s % 3600 / 60)).padStart(2, '0')}` : '—';
  const labels = { review: 'Reviews', listening: 'Stories & podcasts', reading: 'Articles', youtube: 'YouTube', netflix: 'Netflix', speaking: 'AI conversation', tutor: 'Tutor lessons' };
  main.innerHTML = `<h1>Progress</h1><p class="sub">Everything below comes from one database that every part of the app writes to.</p>
  <div class="grid">
    <div class="card"><h3>Vocabulary</h3><div class="bignum">${total}</div><div class="muted small">${m.vocab.known} known · ${m.vocab.learning} learning</div>
      <div class="bar"><div style="width:${Math.min(100, total / 2500 * 100)}%"></div></div><div class="muted small">About 2,500 words cover 95% of everyday conversation.</div></div>
    <div class="card"><h3>This week</h3><table>${Object.entries(labels).map(([k, l]) => `<tr><td>${l}</td><td style="text-align:right">${fmt(p[k])}</td></tr>`).join('')}</table>
      <p class="muted small" style="margin:10px 0 0">${m.hours} hours in total</p></div>
    <div class="card"><h3>Recurring mistakes</h3>${m.errors.length ? `<div class="errlist">${m.errors.map(e => `<div class="err"><span>${esc(e.category)}</span><span class="tag warm">${e.n}×</span></div>`).join('')}</div>` : '<p class="muted small">None yet.</p>'}</div>
  </div>
  <div class="card" style="margin-top:16px"><div class="row"><h3 style="margin:0;flex:1">Settings</h3>
    <label class="small">New words per day <input type="number" id="npd" min="3" max="30" value="${m.settings.new_per_day}" style="width:70px;margin-left:6px"></label></div></div>
  <div class="card" style="margin-top:16px"><h3>Everything that happened</h3><div class="log">${m.events.map(ev => `<div><span class="k">${new Date(ev.ts * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span><span class="k">${esc(ev.kind)}</span><span>${esc(ev.summary)}</span></div>`).join('')}</div></div>`;
  $('#npd').onchange = async e => { await post('/api/settings', { new_per_day: +e.target.value }); toast('Saved. Applies from tomorrow.'); };
};

// ---------- global keys ----------
document.addEventListener('keydown', e => {
  if (e.target.matches('input,textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if ($('#overlay').classList.contains('show')) { if (e.key === 'Escape') closeModal(); return; }
  const map = { 1: 'today', 2: 'review', 3: 'listen', 4: 'speak', 5: 'tutor', 6: 'me' };
  if (map[e.key]) go(map[e.key]);
});

async function navFoot() {
  try { const t = await api('/api/today'); $('#navFoot').innerHTML = `<div><span class="dot ${t.granola ? 'ok' : ''}"></span>Granola ${t.granola ? 'connected' : 'not connected'}</div>`; } catch { }
}

window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (v in views && v !== view) go(v); });
go(location.hash.slice(1) in views ? location.hash.slice(1) : 'today');
navFoot();
