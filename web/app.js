// Sprechstunde: a 15-minute German block in four steps (review, read, speak, wrap-up), plus a free library.
import { VoiceCoach } from "/voice.js";

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function api(path, opts = {}) {
  const init = { ...opts };
  if (opts.json) { init.method = init.method || "POST"; init.headers = { "Content-Type": "application/json" }; init.body = JSON.stringify(opts.json); }
  const r = await fetch(path, init);
  if (!r.ok) throw new Error(`${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
function toast(msg, ms = 2000) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, ms); }
function keys(list) { $("#keys").innerHTML = list.map(([k, l]) => `<span><kbd>${k}</kbd> ${l}</span>`).join(""); }
function fail(e) { console.error(e); toast("Error: " + e.message, 5000); }

// ---------- audio helpers ----------
let audio = new Audio();
function playTTS(text) { audio.pause(); audio = new Audio(`/api/tts?text=${encodeURIComponent(text)}&lang=de`); return audio.play().catch(fail); }

// ---------- block state ----------
const STEPS = [["review", "Review", 180], ["read", "Read", 360], ["speak", "Speak", 300], ["wrap", "Wrap-up", 60]];
let block = null;   // { id, plan, cards, item, step, stepStart, start, savedFronts:Set }
let onKey = null;   // current view's key handler

setInterval(() => {
  if (!block || block.step === "wrap") return;
  const [, , budget] = STEPS.find(s => s[0] === block.step);
  const left = budget - Math.round((Date.now() - block.stepStart) / 1000);
  const total = Math.round((Date.now() - block.start) / 1000);
  const c = $("#clock");
  c.hidden = false; c.classList.toggle("over", left < 0);
  const f = s => `${Math.floor(Math.abs(s) / 60)}:${String(Math.abs(s) % 60).padStart(2, "0")}`;
  c.textContent = `${left < 0 ? "+" : ""}${f(left)} · ${f(total)} of 15:00`;
}, 1000);

function renderSteps() {
  const n = $("#steps");
  n.hidden = !block;
  if (!block) { $("#clock").hidden = true; return; }
  const idx = STEPS.findIndex(s => s[0] === block.step);
  n.innerHTML = STEPS.map(([k, l, b], i) => `<span class="${i < idx ? "done" : i === idx ? "on" : ""}">${l} ${Math.round(b / 60)}m</span>`).join("");
}

function goStep(step) {
  block.step = step; block.stepStart = Date.now();
  api("/api/event", { json: { type: "step_started", block_id: block.id, item_id: block.item?.id, payload: { step } } }).catch(() => {});
  renderSteps();
  ({ review: showReview, read: () => showReader(block.item, true), speak: () => showSpeak(block.item, true), wrap: showWrap })[step]();
}
function nextStep() { const i = STEPS.findIndex(s => s[0] === block.step); if (i < STEPS.length - 1) goStep(STEPS[i + 1][0]); }

// ---------- home ----------
async function showHome() {
  block = null; renderSteps(); coach.stop();
  view.innerHTML = `<p class="muted">Loading…</p>`;
  let st;
  try { st = await api("/api/state"); } catch (e) { view.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  const p = st.progress;
  const bySeries = {};
  for (const c of st.catalog) (bySeries[c.series || "Other"] ||= []).push(c);
  const last = p.recent_blocks[0];
  view.innerHTML = `
    <section class="row" style="justify-content:space-between;align-items:end">
      <div><h1>Guten Tag!</h1><p class="muted" style="margin:6px 0 0">${p.cards.due} cards due · ${st.catalog.length} texts and clips</p></div>
      <button class="btn primary big" id="start">Start a 15-minute block <kbd>Enter</kbd></button>
    </section>
    <section class="stats">
      <div class="card stat"><b>${p.streak_days}</b><span>day streak</span></div>
      <div class="card stat"><b>${p.blocks_completed}</b><span>blocks done</span></div>
      <div class="card stat"><b>${p.cards.learned}/${p.cards.cards}</b><span>words learned / saved</span></div>
      <div class="card stat"><b>${p.pronunciation.avg_score_14d == null ? "–" : Math.round(p.pronunciation.avg_score_14d * 100) + "%"}</b><span>sounds right, last 14 days</span></div>
    </section>
    ${last?.summary ? `<section class="card"><h2>Last block</h2><p style="margin:0;font:17px/1.6 var(--serif)">${esc(last.summary)}</p></section>` : ""}
    ${p.pronunciation.top_issues.length ? `<section><h2>Sounds to work on (expected → heard)</h2><div class="issues">${p.pronunciation.top_issues.slice(0, 8).map(i => `<span class="issue">${esc(i.expected)} → ${esc(i.heard)} ×${i.count} <span class="muted">${esc(i.example_word)}</span></span>`).join("")}</div></section>` : ""}
    <section class="card"><h2>New story by Claude</h2>
      <div class="row"><input type="text" id="setting" placeholder="Setting, e.g. Kaguya-sama: the student council plans a festival" value="Kaguya-sama: the student council room">
      <select id="level" class="btn"><option>A1</option><option>A2</option></select>
      <button class="btn" id="gen">Write it</button></div></section>
    <section class="lib"><h2>Library</h2>
      ${Object.entries(bySeries).map(([s, items]) => `<div class="series"><h3>${esc(s)}</h3><div class="items">${items.map(i =>
        `<button class="${i.status}" data-id="${esc(i.id)}" title="${esc(i.title)} · ${esc(i.level || "")}">${esc(i.order ? i.order + ". " : "")}${esc((i.title || i.id).slice(0, 38))}</button>`).join("")}</div></div>`).join("")}
    </section>`;
  $("#start").onclick = startBlock;
  view.querySelectorAll(".items button").forEach(b => b.onclick = () => location.hash = "read/" + b.dataset.id);
  $("#gen").onclick = async () => {
    $("#gen").disabled = true; $("#gen").textContent = "Writing…";
    try { const it = await api("/api/story", { json: { setting: $("#setting").value, level: $("#level").value } }); location.hash = "read/" + it.id; }
    catch (e) { fail(e); $("#gen").disabled = false; $("#gen").textContent = "Write it"; }
  };
  keys([["Enter", "start block"]]);
  onKey = e => { if (e.key === "Enter" && document.activeElement?.tagName !== "INPUT") startBlock(); };
}

async function startBlock() {
  view.innerHTML = `<div class="card"><p>Planning your block…</p></div>`;
  try {
    const r = await api("/api/block/start", { method: "POST" });
    block = { id: r.block_id, plan: r.plan, cards: r.cards, item: r.item, start: Date.now(), savedFronts: new Set() };
    location.hash = "block";
    goStep(r.cards.length ? "review" : "read");
    if (r.plan.tip) toast(r.plan.tip, 6000);
  } catch (e) { fail(e); showHome(); }
}

// ---------- review ----------
function showReview() {
  const cards = [...block.cards];
  let i = 0, shown = false;
  const draw = () => {
    if (i >= cards.length) { view.innerHTML = `<div class="card flash"><div class="front">Fertig!</div><p class="muted">All due cards reviewed.</p><button class="btn primary" id="nx">Read <kbd>N</kbd></button></div>`; $("#nx").onclick = nextStep; return; }
    const c = cards[i];
    view.innerHTML = `<div class="card flash">
      <div class="muted">${i + 1} / ${cards.length}</div>
      <div class="front" lang="de">${esc(c.front)}</div>
      ${shown ? `<div class="back">${esc(c.back)}</div>${c.context_de ? `<div class="ctx" lang="de">${esc(c.context_de)}</div>` : ""}
        <div class="rate">${["Again", "Hard", "Good", "Easy"].map((l, k) => `<button class="btn${k === 2 ? " primary" : ""}" data-r="${k + 1}"><kbd>${k + 1}</kbd> ${l}</button>`).join("")}</div>`
        : `<button class="btn" id="show"><kbd>Space</kbd> Show meaning</button>`}
    </div>`;
    if (!shown) { $("#show").onclick = reveal; playTTS(c.front); }
    view.querySelectorAll("[data-r]").forEach(b => b.onclick = () => rate(+b.dataset.r));
  };
  const reveal = () => { shown = true; draw(); };
  const rate = async r => { const c = cards[i]; api(`/api/cards/${c.id}/review`, { json: { rating: r, block_id: block.id } }).catch(fail); if (r === 1) cards.push(c); i++; shown = false; draw(); };
  keys([["Space", "show"], ["1–4", "rate"], ["P", "play"], ["N", "next step"]]);
  onKey = e => {
    if (e.key === " ") { e.preventDefault(); if (!shown && i < cards.length) reveal(); }
    else if (shown && "1234".includes(e.key)) rate(+e.key);
    else if (e.key === "p" && cards[i]) playTTS(cards[i].front);
    else if (e.key === "n") nextStep();
  };
  draw();
}

// ---------- reader ----------
let yt = null;
function loadYT() {
  if (window.YT?.Player) return Promise.resolve();
  return new Promise(res => { window.onYouTubeIframeAPIReady = res; const s = document.createElement("script"); s.src = "https://www.youtube.com/iframe_api"; document.head.append(s); });
}
const tokenize = t => t.split(/([\p{L}\p{M}ß'’-]+)/u);

async function showReader(item, inBlock) {
  if (!item) { view.innerHTML = `<p class="err">No item to read.</p>`; return; }
  const startedAt = Date.now();
  api(`/api/item/${item.id}/progress`, { json: { status: "started", block_id: block?.id } }).catch(() => {});
  const lines = item.lines || [];
  let sel = Math.max(0, lines.findIndex(l => l.lang === "de"));
  let hideEn = false;
  const m = item.media;
  view.innerHTML = `<div class="reader">
    <div><div class="muted" style="font:12px var(--mono)">${esc(item.series || "")} · ${esc(item.level || "")}${item.generated ? " · written by Claude" : ""}</div>
      <h1>${esc(item.title)}</h1>
      ${block?.plan?.why && inBlock ? `<p class="muted" style="margin:6px 0 0">${esc(block.plan.why)}</p>` : ""}
      ${item.external_link ? `<p style="margin:6px 0 0"><a href="${esc(item.external_link.url)}" target="_blank" rel="noopener">${esc(item.external_link.label || "Watch the full episode")} ↗</a></p>` : ""}
    </div>
    ${m ? `<div class="media">${m.type === "youtube" ? `<div class="yt"><div id="ytp"></div></div>` : m.type === "video" ? `<video id="av" controls src="/media/${esc(m.path.replace(/^media\//, ""))}" style="width:100%;max-height:42vh"></video>` : `<audio id="av" controls src="/media/${esc(m.path.replace(/^media\//, ""))}"></audio>`}</div>` : ""}
    <div class="lines" id="lines">${lines.map((l, i) => l.lang === "de"
      ? `<div class="line${l.uncertain ? " uncertain" : ""}" data-i="${i}"><div>${l.speaker ? `<div class="spk">${esc(l.speaker)}</div>` : ""}<p class="de" lang="de">${tokenize(l.text).map((t, k) => k % 2 ? `<span class="w${block?.savedFronts?.has(t) ? " saved" : ""}">${esc(t)}</span>` : esc(t)).join("")}</p></div><p class="tr">${esc(l.en || "")}</p></div>`
      : `<div class="line en" data-i="${i}"><p>${esc(l.text)}</p></div>`).join("")}</div>
    <div class="row">${inBlock ? `<button class="btn primary" id="nx">Done reading: speak <kbd>N</kbd></button>` : `<button class="btn" id="done">Mark as done <kbd>D</kbd></button><button class="btn" id="prac">Practise speaking these lines <kbd>K</kbd></button>`}</div>
  </div>`;
  const av = $("#av");
  if (m?.type === "youtube") {
    await loadYT();
    yt = new YT.Player("ytp", { videoId: m.youtube_id, playerVars: { start: Math.floor(m.start || 0), rel: 0, cc_load_policy: 0 } });
  } else yt = null;

  let stopAt = null;
  const tick = setInterval(() => {
    if (!document.body.contains($("#lines"))) return clearInterval(tick);
    const t = yt?.getCurrentTime ? yt.getCurrentTime() : av ? av.currentTime : null;
    if (t == null) return;
    if (stopAt && t >= stopAt) { yt ? yt.pauseVideo() : av.pause(); stopAt = null; }
  }, 100);

  const drawSel = () => { view.querySelectorAll(".line").forEach(el => el.classList.toggle("sel", +el.dataset.i === sel)); view.querySelector(`.line[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }); };
  const play = () => {
    const l = lines[sel]; if (!l) return;
    if (l.start != null && (yt || av)) {
      if (yt) { yt.seekTo(l.start, true); yt.playVideo(); } else { av.currentTime = l.start; av.play(); }
      stopAt = l.end ?? null;
    } else if (l.lang === "de") playTTS(l.text);
  };
  const move = d => { sel = Math.min(lines.length - 1, Math.max(0, sel + d)); drawSel(); };
  const finish = async () => {
    await api(`/api/item/${item.id}/progress`, { json: { status: "done", seconds: Math.round((Date.now() - startedAt) / 1000), block_id: block?.id } }).catch(fail);
  };

  view.querySelectorAll(".line").forEach(el => el.onclick = e => { sel = +el.dataset.i; drawSel(); if (!e.target.classList.contains("w")) play(); });
  view.querySelectorAll(".w").forEach(w => w.onclick = e => { const i = +w.closest(".line").dataset.i; showGloss(w, lines[i], item); });
  $("#nx") && ($("#nx").onclick = async () => { await finish(); nextStep(); });
  $("#done") && ($("#done").onclick = async () => { await finish(); toast("Marked as done"); });
  $("#prac") && ($("#prac").onclick = () => location.hash = "speak/" + item.id);
  drawSel();
  keys([["↑ ↓", "line"], ["Space", "play line"], ["click word", "meaning"], ["E", "hide English"], ...(inBlock ? [["N", "next step"]] : [["D", "done"], ["K", "speak"]])]);
  onKey = async e => {
    if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === " ") { e.preventDefault(); play(); }
    else if (e.key === "e") { hideEn = !hideEn; $("#lines").classList.toggle("hide-en", hideEn); }
    else if (e.key === "n" && inBlock) { await finish(); nextStep(); }
    else if (e.key === "d" && !inBlock) $("#done").click();
    else if (e.key === "k" && !inBlock) location.hash = "speak/" + item.id;
    else if (e.key === "Escape") $("#pop").hidden = true;
  };
}

async function showGloss(el, line, item) {
  const pop = $("#pop"), r = el.getBoundingClientRect();
  pop.style.left = Math.min(window.scrollX + r.left, window.scrollX + innerWidth - 340) + "px";
  pop.style.top = window.scrollY + r.bottom + 6 + "px";
  pop.innerHTML = `<span class="muted">Looking up “${esc(el.textContent)}”…</span>`; pop.hidden = false;
  try {
    const g = await api("/api/gloss", { json: { word: el.textContent, sentence: line.text } });
    pop.innerHTML = `<div class="lemma" lang="de">${esc(g.lemma)}</div><div>${esc(g.meaning)}</div>${g.note ? `<div class="note">${esc(g.note)}</div>` : ""}
      <div class="note">Card: <b lang="de">${esc(g.card_front)}</b> = ${esc(g.card_back)}</div>
      <div class="row"><button class="btn primary" id="save">Save card <kbd>S</kbd></button><button class="btn" id="say">Hear it</button></div>`;
    const save = async () => {
      await api("/api/cards", { json: { front: g.card_front, back: g.card_back, context_de: line.text, context_en: line.en, item_id: item.id, line_id: line.id } });
      block?.savedFronts.add(el.textContent); el.classList.add("saved"); pop.hidden = true; toast("Saved: " + g.card_front);
    };
    $("#save").onclick = save; $("#say").onclick = () => playTTS(g.card_front);
    pop.onkey = e => { if (e.key === "s") save(); };
  } catch (e) { pop.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
}
document.addEventListener("click", e => { if (!e.target.closest("#pop, .w")) $("#pop").hidden = true; });

// ---------- speak ----------
const coach = new VoiceCoach({ onState: s => { const d = $("#coachdot"), l = $("#coachlbl"); if (d) d.className = "dot " + s; if (l) l.textContent = { off: "Voice coach off", connecting: "Connecting…", live: "Voice coach listening for results", talk: "Talking to coach…" }[s] || s; },
  onTranscript: (who, text) => { const t = $("#transcript"); if (t) { t.insertAdjacentHTML("beforeend", `<div><b>${who}:</b> ${esc(text)}</div>`); t.scrollTop = 1e6; } } });

function pickSpeakLines(item) {
  const de = (item.lines || []).filter(l => l.lang === "de" && !l.uncertain);
  const n = l => l.text.split(/\s+/).length;
  const good = de.filter(l => n(l) >= 2 && n(l) <= 10);
  const pool = good.length >= 3 ? good : de;
  // Spread picks across the text so they cover different sounds.
  const k = Math.min(5, pool.length), out = [];
  for (let i = 0; i < k; i++) out.push(pool[Math.floor(i * pool.length / k)]);
  return out;
}

async function showSpeak(item, inBlock) {
  if (!item) return;
  const targets = pickSpeakLines(item);
  let t = 0, recorder = null, chunks = [], busy = false, results = {};
  view.innerHTML = `<div class="speak">
    <div class="row" style="justify-content:space-between"><h1>Say it</h1>
      <div class="coach"><span class="dot" id="coachdot"></span><span id="coachlbl">Voice coach off</span><button class="btn" id="cbtn">Turn on <kbd>V</kbd></button></div></div>
    ${block?.plan?.focus_sounds?.length && inBlock ? `<p class="muted" style="margin:0">Focus sounds today: <b>${block.plan.focus_sounds.map(esc).join(", ")}</b></p>` : ""}
    <div class="card" id="stage"></div>
    <div class="transcript card" id="transcript"></div>
    <div class="row">${inBlock ? `<button class="btn primary" id="nx">Finish: wrap up <kbd>N</kbd></button>` : `<a class="btn" href="#read/${esc(item.id)}">Back to text</a>`}</div>
  </div>`;
  const draw = () => {
    const l = targets[t], res = results[t];
    $("#stage").innerHTML = !l ? `<p>No German lines to practise in this item.</p>` : `
      <div class="muted" style="font:12px var(--mono)">${t + 1} / ${targets.length}</div>
      <div class="target" lang="de">${res ? res.words.map(w => `<span class="tw ${w.status === "ok" ? "ok" : w.status === "uncertain" ? "unc" : "err"}">${esc(w.word)}</span>`).join(" ") : esc(l.text)}</div>
      <p class="muted" style="margin:4px 0 14px">${esc(l.en || "")}</p>
      <div class="row"><button class="rec${recorder ? " on" : ""}" id="rec">${recorder ? "Stop" : busy ? "…" : "Record"}</button>
        <button class="btn" id="listen"><kbd>L</kbd> Listen</button>
        ${res ? `<span style="font:600 22px var(--serif)">${Math.round((res.score || 0) * 100)}%</span><span class="muted">of sounds matched</span>` : ""}</div>
      ${res ? `<div class="phones" style="margin-top:16px">${res.words.map(w => `<div class="pw"><span class="lbl">${esc(w.word)}</span><span>${(w.phones || []).map(p =>
        `<span class="ph ${p.status}" title="${esc(p.status)}">${esc(p.expected || p.heard)}${p.status === "substituted" ? `<small>${esc(p.heard)}</small>` : p.status === "missing" ? "<small>∅</small>" : ""}</span>`).join("")}</span></div>`).join("")}</div>
        <p class="muted" style="font-size:13px">Red: a different sound was heard (shown below it) or the sound was missing. Yellow: the two recognizers disagree, so treat it as a maybe.</p>` : ""}`;
    if (!l) return;
    $("#rec").onclick = toggleRec; $("#listen").onclick = () => playTTS(l.text);
  };
  const toggleRec = async () => {
    if (busy) return;
    if (recorder) { recorder.stop(); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false } }); }
    catch (e) { return fail(new Error("Microphone blocked: allow it in the browser's address bar")); }
    chunks = []; recorder = new MediaRecorder(stream);
    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach(tr => tr.stop()); recorder = null; busy = true; draw();
      const blob = new Blob(chunks, { type: chunks[0]?.type || "audio/webm" });
      const fd = new FormData(); const l = targets[t];
      fd.append("audio", blob, "a.webm"); fd.append("text_de", l.text); fd.append("item_id", item.id); if (l.id) fd.append("line_id", l.id); if (block) fd.append("block_id", block.id);
      try { results[t] = await api("/api/pronounce", { method: "POST", body: fd }); coach.sendAttempt(l.text, results[t]); }
      catch (e) { fail(e); }
      busy = false; draw();
    };
    recorder.start(); draw();
  };
  $("#cbtn").onclick = () => coach.active ? coach.stop() : coach.start().catch(fail);
  $("#nx") && ($("#nx").onclick = () => { coach.stop(); nextStep(); });
  keys([["R", "record / stop"], ["L", "listen"], ["← →", "sentence"], ["V", "voice coach on/off"], ["hold T", "talk to coach"], ...(inBlock ? [["N", "next step"]] : [])]);
  onKey = e => {
    if (e.repeat) return;
    if (e.key === "r") toggleRec();
    else if (e.key === "l" && targets[t]) playTTS(targets[t].text);
    else if (e.key === "ArrowRight") { t = Math.min(targets.length - 1, t + 1); draw(); }
    else if (e.key === "ArrowLeft") { t = Math.max(0, t - 1); draw(); }
    else if (e.key === "v") $("#cbtn").click();
    else if (e.key === "t") coach.pushToTalk(true);
    else if (e.key === "n" && inBlock) { coach.stop(); nextStep(); }
  };
  onKeyUp = e => { if (e.key === "t") coach.pushToTalk(false); };
  draw();
  if (inBlock) coach.start().catch(fail);
}
let onKeyUp = null;

// ---------- wrap ----------
async function showWrap() {
  keys([["Enter", "home"]]);
  onKey = e => { if (e.key === "Enter") location.hash = "home"; };
  view.innerHTML = `<div class="card"><p>Summing up your block…</p></div>`;
  try {
    const r = await api(`/api/block/${block.id}/end`, { json: { seconds: Math.round((Date.now() - block.start) / 1000) } });
    const mins = Math.round((Date.now() - block.start) / 60000);
    view.innerHTML = `<div class="card" style="display:grid;gap:14px">
      <h1>Gut gemacht.</h1><p style="font:18px/1.6 var(--serif);margin:0">${esc(r.summary)}</p>
      <p class="muted" style="margin:0">${mins} minutes · ${r.progress.cards.cards} cards saved · ${r.progress.streak_days}-day streak</p>
      <div><a class="btn primary" href="#home">Done <kbd>Enter</kbd></a></div></div>`;
  } catch (e) { fail(e); }
}

// ---------- routing and keys ----------
async function route() {
  onKey = null; onKeyUp = null; $("#pop").hidden = true;
  const [r, id] = location.hash.slice(1).split("/");
  if (r === "block" && block) return;
  if (r === "read" && id) { block = null; renderSteps(); return showReader(await api(`/api/item/${id}`).catch(fail), false); }
  if (r === "speak" && id) { block = null; renderSteps(); return showSpeak(await api(`/api/item/${id}`).catch(fail), false); }
  showHome();
}
addEventListener("hashchange", route);
addEventListener("keydown", e => {
  if (e.metaKey || e.ctrlKey || e.altKey || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  if (!$("#pop").hidden && $("#pop").onkey) $("#pop").onkey(e);
  onKey?.(e);
});
addEventListener("keyup", e => onKeyUp?.(e));
route();
