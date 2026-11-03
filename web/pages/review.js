// Review: due flashcards, German first (spoken aloud), rate 1-4 with FSRS.
import { api, esc, fail, keys, playTTS, ui } from "/lib.js";

export function showReview(view, ctx) {
  const cards = [...ctx.block.cards];
  let i = 0, shown = false;
  const draw = () => {
    if (i >= cards.length) {
      view.innerHTML = `<div class="card flash"><div class="front">Fertig!</div><p class="muted">All due cards reviewed.</p><button class="btn primary" id="nx">New words <kbd>N</kbd></button></div>`;
      view.querySelector("#nx").onclick = ctx.next; return;
    }
    const c = cards[i];
    view.innerHTML = `<div class="card flash">
      <div class="muted">${i + 1} / ${cards.length}</div>
      <div class="front" lang="de">${esc(c.front)}</div>
      ${shown ? `<div class="back">${esc(c.back)}</div>${c.context_de ? `<div class="ctx" lang="de">${esc(c.context_de)}</div>` : ""}
        <div class="rate">${["Again", "Hard", "Good", "Easy"].map((l, k) => `<button class="btn${k === 2 ? " primary" : ""}" data-r="${k + 1}"><kbd>${k + 1}</kbd> ${l}</button>`).join("")}</div>`
        : `<button class="btn" id="show"><kbd>Space</kbd> Show meaning</button>`}
    </div>`;
    if (!shown) { view.querySelector("#show").onclick = reveal; playTTS(c.front); }
    view.querySelectorAll("[data-r]").forEach(b => b.onclick = () => rate(+b.dataset.r));
  };
  const reveal = () => { shown = true; draw(); };
  const rate = r => { const c = cards[i]; api(`/api/cards/${c.id}/review`, { json: { rating: r, block_id: ctx.block.id } }).catch(fail); if (r === 1) cards.push(c); i++; shown = false; draw(); };
  keys([["Space", "show"], ["1–4", "rate"], ["P", "play"], ["N", "next step"]]);
  ui.onKey = e => {
    if (e.key === " ") { e.preventDefault(); if (!shown && i < cards.length) reveal(); }
    else if (shown && "1234".includes(e.key)) rate(+e.key);
    else if (e.key === "p" && cards[i]) playTTS(cards[i].front);
    else if (e.key === "n") ctx.next();
  };
  draw();
}
