// Wrap-up: two quick questions about the lesson, then Claude's summary of the block and what changed on the ladder.
import { api, esc, fail, keys, ui } from "/lib.js";

export function showWrap(view, item, ctx) {
  const qs = item?.lesson?.questions || [];
  const answers = [];
  const askOne = () => {
    const i = answers.length;
    if (i >= qs.length) return finish();
    const q = qs[i];
    view.innerHTML = `<div class="card quiz">
      <div class="muted mono">Question ${i + 1} / ${qs.length}</div>
      <h1>${esc(q.q)}</h1>
      <div class="options">${q.options.map((o, k) => `<button class="btn" data-k="${k}"><kbd>${k + 1}</kbd> ${esc(o)}</button>`).join("")}</div>
      <div id="fb"></div></div>`;
    const choose = k => {
      if (answers.length > i) return;
      const ok = k === q.answer; answers.push(ok);
      view.querySelectorAll("[data-k]").forEach(b => { b.disabled = true; if (+b.dataset.k === q.answer) b.classList.add("right"); else if (+b.dataset.k === k) b.classList.add("wrong"); });
      view.querySelector("#fb").innerHTML = `<p>${ok ? "Richtig!" : "Not quite."}</p><button class="btn primary" id="go">Continue <kbd>Enter</kbd></button>`;
      view.querySelector("#go").onclick = askOne; view.querySelector("#go").focus();
    };
    view.querySelectorAll("[data-k]").forEach(b => b.onclick = () => choose(+b.dataset.k));
    keys([["1–3", "answer"], ["Enter", "continue"]]);
    ui.onKey = e => { if ("123".includes(e.key)) choose(+e.key - 1); else if (e.key === "Enter" && answers.length > i) askOne(); };
  };

  const finish = async () => {
    keys([["Enter", "home"]]);
    ui.onKey = e => { if (e.key === "Enter") ctx.exit(); };
    if (qs.length) api("/api/quiz", { json: { item_id: item.id, correct: answers.filter(Boolean).length, total: qs.length, block_id: ctx.block.id } }).catch(fail);
    view.innerHTML = `<div class="card"><p>Summing up your block…</p></div>`;
    try {
      const r = await api(`/api/block/${ctx.block.id}/end`, { json: { seconds: Math.round((Date.now() - ctx.block.start) / 1000) } });
      const mins = Math.round((Date.now() - ctx.block.start) / 60000), c = r.curriculum;
      view.innerHTML = `<div class="card" style="display:grid;gap:14px">
        <h1>Gut gemacht.</h1><p class="serif" style="margin:0">${esc(r.summary)}</p>
        <p class="muted" style="margin:0">${mins} minutes · ${qs.length ? `${answers.filter(Boolean).length}/${qs.length} questions · ` : ""}${c.words_known} words known of ${c.words_met} met · ${r.progress.streak_days}-day streak</p>
        <div><button class="btn primary" id="home">Done <kbd>Enter</kbd></button></div></div>`;
      view.querySelector("#home").onclick = ctx.exit;
    } catch (e) { fail(e); }
  };
  askOne();
}
