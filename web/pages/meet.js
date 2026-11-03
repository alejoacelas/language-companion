// New words: before reading, hear each of the lesson's new words alone and in a sentence from the story.
import { api, esc, fail, keys, playTTS, playLine, ui, germanHTML, newFormsOf } from "/lib.js";

export async function showMeet(view, item, ctx) {
  view.innerHTML = `<p class="muted">Loading new words…</p>`;
  let words;
  try { words = await api(`/api/item/${item.id}/meet?block_id=${ctx.block.id}`, { method: "POST" }); }
  catch (e) { fail(e); return ctx.next(); }
  if (!words.length) return ctx.next();
  const lines = item.lines || [];
  const forms = newFormsOf(item);
  const example = w => lines.find(l => l.lang === "de" && l.text.toLowerCase().split(/[^\p{L}ß-]+/u).some(t => (w.forms || []).includes(t)));
  let i = 0;
  const draw = async () => {
    const w = words[i], ex = example(w);
    view.innerHTML = `<div class="card flash">
      <div class="muted">New word ${i + 1} / ${words.length}</div>
      <div class="front" lang="de">${esc(w.de)}</div>
      <div class="back">${esc(w.en)}</div>
      ${ex ? `<div class="ctx" lang="de">${germanHTML(ex.text, forms)}</div><div class="muted">${esc(ex.en || "")}</div>` : ""}
      <p class="muted" style="margin:0">Say it out loud after the voice.</p>
      <div class="row" style="justify-content:center">
        <button class="btn" id="again"><kbd>Space</kbd> Hear again</button>
        <button class="btn primary" id="nx">${i < words.length - 1 ? "Next word" : "Start reading"} <kbd>→</kbd></button>
      </div></div>`;
    view.querySelector("#again").onclick = play; view.querySelector("#nx").onclick = next;
    play();
  };
  const play = async () => { const w = words[i], ex = example(w); if (await playTTS(w.de) && ex) setTimeout(() => playLine(ex), 400); };
  const next = () => { if (i < words.length - 1) { i++; draw(); } else ctx.next(); };
  keys([["Space", "hear again"], ["← →", "word"], ["N", "start reading"]]);
  ui.onKey = e => {
    if (e.key === " ") { e.preventDefault(); play(); }
    else if (e.key === "ArrowRight" || e.key === "Enter") next();
    else if (e.key === "ArrowLeft" && i > 0) { i--; draw(); }
    else if (e.key === "n") ctx.next();
  };
  draw();
}
