// Review: due flashcards, German first (spoken aloud), rate 1-4 with FSRS.
// Space shows the meaning, then Space again rates Good. A rating is held back for a few seconds
// (until the next rating at the latest) so U can take it back before it reaches the server.
import { api, esc, fail, keys, playTTS, toast, ui } from "/lib.js";

const HOLD_MS = 10000;
const LABELS = ["Again", "Hard", "Good", "Easy"];
const SPEAKER = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>`;

// The rating waiting to be sent. Module-level so it is still sent after the page is left.
let pending = null;   // { card, rating, blockId, timer }
function commit() {
  if (!pending) return;
  const { card, rating, blockId, timer } = pending;
  clearTimeout(timer); pending = null;
  api(`/api/cards/${card.id}/review`, { json: { rating, block_id: blockId } }).catch(fail);
}
addEventListener("pagehide", () => {
  if (!pending) return;
  const { card, rating, blockId } = pending; pending = null;
  fetch(`/api/cards/${card.id}/review`, { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating, block_id: blockId }) });
});

const titles = {};    // item_id -> title, for "from <lesson>"
const titleOf = id => titles[id] ??= api(`/api/item/${encodeURIComponent(id)}`).then(it => it.title || id).catch(() => id);

export function showReview(view, ctx) {
  const cards = [...(ctx.cards || ctx.block.cards)];   // ctx.cards: review outside a block
  const blockId = ctx.block?.id ?? null, after = ctx.block ? "New words" : "Done";
  let i = 0, shown = false;
  let last = null;    // { index, requeued } for undoing the pending rating

  const draw = () => {
    const done = i >= cards.length;
    const c = cards[i];
    const undo = pending && last ? `<button class="rv-quiet" id="undo" title="Take back the last rating (U)">Undo “${esc(LABELS[pending.rating - 1])}” on ${esc(pending.card.front)} <kbd>U</kbd></button>` : "";
    if (done) {
      view.innerHTML = `<div class="card flash rv">
        <div class="front">Fertig!</div><p class="muted">All due cards reviewed.</p>
        <button class="btn primary" id="nx">${after} <kbd>Space</kbd></button>
        <div class="rv-undo">${undo}</div></div>`;
      wire(); setKeys(); return;
    }
    view.innerHTML = `<div class="card flash rv">
      <div class="rv-top">
        <span class="rv-count">Card ${i + 1} of ${cards.length}</span>
        <span class="rv-tools">
          <button class="rv-quiet" id="skip" title="Leave this card for next time (S)">Skip card <kbd>S</kbd></button>
          <button class="rv-quiet" id="suspend" title="Never show this card again (X)">Suspend <kbd>X</kbd></button>
          <button class="rv-quiet" id="nx" title="Stop reviewing (N)">Finish review <kbd>N</kbd></button>
        </span>
      </div>
      <div class="rv-bar"><span style="width:${(i / cards.length) * 100}%"></span></div>
      <div class="rv-word">
        <span class="front" lang="de">${esc(c.front)}</span>
        <button class="rv-say" id="say" title="Hear the word (P)" aria-label="Hear the word">${SPEAKER}<kbd>P</kbd></button>
      </div>
      ${shown ? `<div class="back">${esc(c.back)}</div>
        ${c.context_de ? `<div class="rv-ex">
          <div><div class="ctx" lang="de">${esc(c.context_de)}</div>${c.context_en ? `<div class="rv-ex-en">${esc(c.context_en)}</div>` : ""}</div>
          <button class="rv-say" id="ex" title="Hear the sentence (E)" aria-label="Hear the sentence">${SPEAKER}<kbd>E</kbd></button>
        </div>` : ""}
        ${c.item_id ? `<div class="rv-src" id="src">From ${esc(c.item_id)}</div>` : ""}
        <div class="rate">${LABELS.map((l, k) => `<button class="btn${k === 2 ? " primary" : ""}" data-r="${k + 1}"><kbd>${k === 2 ? "3 / Space" : k + 1}</kbd> ${l}</button>`).join("")}</div>`
        : `<button class="btn primary" id="show">Show meaning <kbd>Space</kbd></button>`}
      <div class="rv-undo">${undo}</div>
    </div>`;
    wire(); setKeys();
    if (shown && c.item_id) titleOf(c.item_id).then(t => { const s = view.querySelector("#src"); if (s && cards[i] === c) s.textContent = `From ${t}`; });
    if (!shown) playTTS(c.front);
  };

  const wire = () => {
    const on = (id, f) => { const b = view.querySelector(id); if (b) b.onclick = f; };
    on("#show", reveal); on("#say", playWord); on("#ex", playExample);
    on("#skip", skip); on("#suspend", suspend); on("#nx", finish); on("#undo", undo);
    view.querySelectorAll("[data-r]").forEach(b => b.onclick = () => rate(+b.dataset.r));
  };

  const setKeys = () => {
    const k = i >= cards.length ? [["Space", after.toLowerCase()]]
      : shown ? [["Space", "good"], ["1–4", "rate"], ["P", "word"], ["E", "sentence"], ["S", "skip"], ["X", "suspend"], ["N", "finish"]]
      : [["Space", "show"], ["P", "word"], ["S", "skip"], ["X", "suspend"], ["N", "finish"]];
    if (pending && last) k.push(["U", "undo"]);
    keys(k);
  };

  const reveal = () => { shown = true; draw(); };
  const playWord = () => cards[i] && playTTS(cards[i].front);
  const playExample = () => shown && cards[i]?.context_de && playTTS(cards[i].context_de);
  const finish = () => { commit(); ctx.next(); };

  const rate = r => {
    const c = cards[i];
    commit();
    const requeued = r === 1;
    if (requeued) cards.push(c);
    pending = { card: c, rating: r, blockId, timer: setTimeout(() => { commit(); if (last) { last = null; if (ui.onKey === onKey) draw(); } }, HOLD_MS) };
    last = { index: i, requeued };
    i++; shown = false; draw();
  };

  const undo = () => {
    if (!pending || !last) return;
    clearTimeout(pending.timer); pending = null;
    if (last.requeued) cards.pop();
    i = last.index; last = null; shown = true; draw();
  };

  // Drop the card from this session without rating it; it stays due for the next block.
  const suspend = async () => {
    if (i >= cards.length) return;
    const c = cards[i];
    try { await api(`/api/cards/${c.id}/suspend`, { json: { suspended: true } }); } catch (e) { return fail(e); }
    commit(); last = null; for (let k = cards.length - 1; k >= i; k--) if (cards[k] === c) cards.splice(k, 1);
    toast(`Suspended: ${c.front}`); shown = false; draw();
  };
  const skip = () => { if (i >= cards.length) return; commit(); last = null; cards.splice(i, 1); shown = false; draw(); };

  const onKey = e => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (i >= cards.length) finish(); else if (!shown) reveal(); else rate(3);
    }
    else if (shown && "1234".includes(e.key)) rate(+e.key);
    else if (k === "p") playWord();
    else if (k === "e") playExample();
    else if (k === "s") skip();
    else if (k === "x") suspend();
    else if (k === "u") undo();
    else if (k === "n") finish();
  };
  ui.onKey = onKey;
  draw();
}
