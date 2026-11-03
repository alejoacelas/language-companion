// New words: before reading, hear each of the lesson's new words alone and in a sentence from the story,
// optionally say it and see which sounds matched, or mark it as already known.
import { api, esc, fail, keys, playTTS, playLine, stopAudio, toast, ui, germanHTML, newFormsOf } from "/lib.js";

const SLOW = 0.6;  // Kokoro speaking speed for "slowly"
const spoken = de => de.replace(/\s*\/\s*/g, ". ");   // "gut / Guten Tag" -> "gut. Guten Tag"
const sayable = de => de.replace(/\s*\/\s*/g, " ");

export async function showMeet(view, item, ctx) {
  view.innerHTML = `<p class="muted">Loading new words…</p>`;
  let words;
  try { words = await api(`/api/item/${item.id}/meet?block_id=${ctx.block.id}`, { method: "POST" }); }
  catch (e) { fail(e); return ctx.next(); }
  if (!words.length) return ctx.next();
  const lines = item.lines || [];
  const forms = newFormsOf(item);
  const example = w => lines.find(l => l.lang === "de" && l.text.toLowerCase().split(/[^\p{L}ß-]+/u).some(t => (w.forms || []).includes(t)));
  const known = new Set(), said = new Set();   // indexes marked known / said well
  let i = 0, result = null, rec = null, slow = null;

  const draw = (autoplay = true) => {
    const w = words[i], ex = example(w), last = i === words.length - 1;
    view.innerHTML = `<div class="meet">
      <nav class="mw-list" aria-label="New words in this lesson">${words.map((x, k) =>
        `<button class="${k === i ? "on" : ""} ${known.has(k) ? "known" : said.has(k) ? "said" : ""}" data-k="${k}" lang="de" title="${esc(x.en)}">${esc(x.de)}</button>`).join("")}</nav>
      <div class="card flash mw-card">
        <div class="mw-top"><span class="muted">New word ${i + 1} of ${words.length}</span>
          <button class="mw-quiet" id="skip">Skip to reading <kbd>N</kbd></button></div>
        <button class="mw-word" id="hear" lang="de" title="Hear it again (Space)">${esc(w.de)}<span class="mw-icon" aria-hidden="true">▶</span></button>
        <div class="row mw-hearrow">
          <button class="mw-quiet" id="again"><kbd>Space</kbd> again</button>
          <button class="mw-quiet" id="slow"><kbd>S</kbd> slowly</button>
        </div>
        <div class="back">${esc(w.en)}</div>
        ${ex ? `<button class="mw-ex" id="ex" title="Hear the sentence (E)"><span class="ctx" lang="de">${germanHTML(ex.text, forms)}</span>
          <span class="muted">${esc(ex.en || "")}</span><span class="mw-exkey"><kbd>E</kbd> hear the sentence</span></button>` : ""}
        <div class="mw-said" aria-live="polite">${saidHTML()}</div>
        <div class="row mw-actions">
          <button class="btn mw-say ${rec ? "on" : ""}" id="say"><kbd>T</kbd> ${rec ? "Listening… release to check" : "Hold to say it"}</button>
          <button class="btn primary" id="nx">${last ? "Start reading" : "Next word"} <kbd>→</kbd></button>
        </div>
        <button class="mw-quiet" id="know">${known.has(i) ? "Marked as known ✓" : "I already know this one"} <kbd>K</kbd></button>
      </div></div>`;
    const $ = s => view.querySelector(s);
    view.querySelectorAll(".mw-list button").forEach(b => b.onclick = () => go(+b.dataset.k));
    $("#hear").onclick = $("#again").onclick = () => play(false);
    $("#slow").onclick = playSlow;
    if (ex) $("#ex").onclick = () => playLine(ex);
    $("#nx").onclick = next; $("#skip").onclick = () => ctx.next(); $("#know").onclick = markKnown;
    const say = $("#say");
    say.onpointerdown = e => { e.preventDefault(); startRec(); };
    say.onpointerup = say.onpointerleave = () => stopRec();
    if (autoplay) play(true);
  };

  function saidHTML() {
    if (!result) return "";
    if (result.busy) return `<p class="muted">Checking…</p>`;
    if (result.error) return `<p class="muted">${esc(result.error)}</p>`;
    const s = result.score;
    const msg = s == null ? "Couldn't hear that. Hold T a little longer while you speak."
      : s >= 0.8 ? "That sounds right."
      : s >= 0.5 ? "Close. Red sounds were off: listen again (S for slowly) and retry."
      : "Not quite yet. Listen slowly (S), then hold T and try again.";
    return `<p class="${s >= 0.8 ? "mw-ok" : ""}">${msg}</p>
      ${result.words?.length ? `<div class="phones">${result.words.map(w => `<div class="pw"><span class="lbl">${esc(w.word)}</span><span>${(w.phones || []).map(p =>
        `<span class="ph ${p.status}" title="${esc(p.status)}">${esc(p.expected || p.heard)}${p.status === "substituted" ? `<small>${esc(p.heard)}</small>` : p.status === "missing" ? "<small>∅</small>" : ""}</span>`).join("")}</span></div>`).join("")}</div>` : ""}`;
  }
  const redrawSaid = () => { const el = view.querySelector(".mw-said"); if (el) el.innerHTML = saidHTML(); };

  const stopSlow = () => { slow?.pause(); slow = null; };
  // The word, then (on arrival) its example sentence.
  const play = async withExample => {
    stopSlow();
    const w = words[i], ex = example(w);
    if (await playTTS(spoken(w.de)) && withExample && ex) setTimeout(() => { if (words[i] === w) playLine(ex); }, 400);
  };
  const playSlow = () => playTTS(spoken(words[i].de), "de", SLOW);

  const go = k => { if (k < 0 || k >= words.length || rec) return; i = k; result = null; draw(); };
  const next = () => { if (rec) return; if (i < words.length - 1) go(i + 1); else { stopSlow(); ctx.next(); } };

  const markKnown = async () => {
    if (known.has(i)) return next();
    const w = words[i];
    try { await api(`/api/cards/${w.card_id}/review`, { json: { rating: 4, block_id: ctx.block.id } }); }
    catch (e) { return fail(e); }
    known.add(i);
    api("/api/event", { json: { type: "word_marked_known", block_id: ctx.block.id, item_id: item.id, payload: { word: w.de } } }).catch(() => {});
    toast(`"${w.de}" marked as known. Its card comes back later.`);
    next();
  };

  // Hold T (or the button) to record; release to compare the sounds with the word.
  async function startRec() {
    if (rec) return;
    stopAudio(); stopSlow();
    rec = { chunks: [], t0: Date.now(), released: false };
    const mine = rec;
    draw(false);
    try { mine.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false } }); }
    catch { rec = null; draw(false); return fail(new Error("Microphone blocked: allow it in the browser's address bar")); }
    if (mine.released) { mine.stream.getTracks().forEach(t => t.stop()); return; }
    mine.recorder = new MediaRecorder(mine.stream);
    mine.recorder.ondataavailable = e => mine.chunks.push(e.data);
    mine.recorder.onstop = () => analyse(mine);
    mine.recorder.start();
    mine.timer = setTimeout(stopRec, 6000);
  }
  function stopRec() {
    if (!rec) return;
    const mine = rec; rec = null; mine.released = true; clearTimeout(mine.timer);
    if (mine.recorder?.state === "recording") mine.recorder.stop();
    else { mine.stream?.getTracks().forEach(t => t.stop()); draw(false); }
  }
  async function analyse(mine) {
    mine.stream.getTracks().forEach(t => t.stop());
    if (!view.querySelector(".meet")) return;   // left the page while recording
    const at = i;
    if (Date.now() - mine.t0 < 400) { result = { error: "Too short: hold T while you speak, then let go." }; return draw(false); }
    const blob = new Blob(mine.chunks, { type: mine.chunks[0]?.type || "audio/webm" });
    if (blob.size < 1000) { result = { error: "The microphone sent no sound. Check it's on and try again." }; return draw(false); }
    result = { busy: true }; draw(false);
    const fd = new FormData();
    fd.append("audio", blob, "a.webm");
    fd.append("text_de", sayable(words[at].de)); fd.append("item_id", item.id); fd.append("block_id", ctx.block.id);
    let r;
    try { r = await api("/api/pronounce", { method: "POST", body: fd }); }
    catch (e) { r = { error: "Couldn't check that: " + e.message }; }
    if (at !== i) return;
    result = r;
    if (r.score >= 0.8) said.add(at);
    draw(false);
  }

  keys([["Space", "hear again"], ["S", "slowly"], ["E", "sentence"], ["T", "hold to say it"], ["K", "I know it"], ["← →", "word"], ["N", "start reading"]]);
  ui.onKey = e => {
    const k = e.key.toLowerCase();
    if (e.repeat && k !== " ") return;
    if (k === " ") { e.preventDefault(); if (!e.repeat) play(false); }
    else if (k === "arrowright" || k === "enter") { e.preventDefault(); next(); }
    else if (k === "arrowleft") go(i - 1);
    else if (k === "s") playSlow();
    else if (k === "e") { const ex = example(words[i]); if (ex) { stopSlow(); playLine(ex); } }
    else if (k === "t") startRec();
    else if (k === "k") markKnown();
    else if (k === "n") { stopSlow(); ctx.next(); }
  };
  ui.onKeyUp = e => { if (e.key.toLowerCase() === "t") stopRec(); };
  draw();
}
