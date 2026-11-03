// Wrap-up: two quick questions about the lesson, then Claude's summary, the words met today and what comes next.
import { api, esc, fail, keys, ui, playTTS } from "/lib.js";

export function showWrap(view, item, ctx) {
  const qs = item?.lesson?.questions || [];
  const words = item?.lesson?.new_words || [];
  const answers = [];
  let finished = false;

  const askOne = () => {
    const i = answers.length;
    if (i >= qs.length) return finish();
    const q = qs[i];
    view.innerHTML = `<div class="card quiz">
      <div class="muted mono">Question ${i + 1} / ${qs.length}</div>
      <h1>${esc(q.q)}</h1>
      <div class="options">${q.options.map((o, k) => `<button class="btn" data-k="${k}"><kbd>${k + 1}</kbd> ${esc(o)}</button>`).join("")}</div>
      <div class="wrap-fb" id="fb"><button class="wrap-quiet" id="skip">Skip the questions <kbd>S</kbd></button></div></div>`;
    const answered = () => answers.length > i;
    const choose = k => {
      if (answered() || k >= q.options.length) return;
      const ok = k === q.answer; answers.push(ok);
      view.querySelectorAll("[data-k]").forEach(b => { b.disabled = true; if (+b.dataset.k === q.answer) b.classList.add("right"); else if (+b.dataset.k === k) b.classList.add("wrong"); });
      view.querySelector("#fb").innerHTML = `<p>${ok ? "Richtig!" : `Not quite. The answer is <b>${esc(q.options[q.answer])}</b>${/[.?!]$/.test(q.options[q.answer]) ? "" : "."}`}</p>
        <button class="btn primary" id="go">${i + 1 < qs.length ? "Next question" : "See your summary"} <kbd>Enter</kbd></button>`;
      view.querySelector("#go").onclick = askOne;
      keys([["Enter", "continue"]]);
    };
    view.querySelectorAll("[data-k]").forEach(b => b.onclick = () => choose(+b.dataset.k));
    view.querySelector("#skip").onclick = finish;
    keys([[`1–${q.options.length}`, "answer"], ["S", "skip questions"]]);
    ui.onKey = e => {
      if (e.repeat) return;
      if (/^[1-9]$/.test(e.key)) choose(+e.key - 1);
      else if (e.key === "Enter" && answered()) { e.preventDefault(); askOne(); }
      else if (e.key.toLowerCase() === "s" && !answered()) finish();
    };
  };

  // The summary screen shows at once; Claude's summary and the counts fill in when the block-end call returns.
  const finish = async () => {
    if (finished) return;
    finished = true;
    const right = answers.filter(Boolean).length;
    // Save the answers before ending the block: the server shares one database connection across requests.
    const saved = answers.length ? api("/api/quiz", { json: { item_id: item.id, correct: right, total: answers.length, block_id: ctx.block.id } }).catch(fail) : null;
    const shownAt = Date.now();
    view.innerHTML = `<div class="card wrap">
      <h1>Gut gemacht.</h1>
      <p class="serif wrap-summary" id="summary"><span class="muted">Claude is summing up your block…</span></p>
      <p class="muted wrap-stats" id="stats"></p>
      ${words.length ? `<section><h2>Words from this lesson · click to hear</h2>
        <div class="wrap-words">${words.map((w, k) => `<button class="wrap-word" data-w="${k}"><span lang="de">${esc(w.de)}</span> <small>${esc(w.en)}</small></button>`).join("")}</div></section>` : ""}
      <p class="wrap-next" id="next" hidden></p>
      <div class="row">
        <button class="btn primary" id="home">Done <kbd>Enter</kbd></button>
        <button class="btn" id="again">Next lesson now <kbd>L</kbd></button>
        <a class="btn" href="#read/${esc(item.id)}">Reread the lesson <kbd>R</kbd></a>
        <a class="btn" href="#speak/${esc(item.id)}">Practise speaking <kbd>P</kbd></a>
      </div></div>`;
    view.querySelectorAll("[data-w]").forEach(b => b.onclick = () => playTTS(words[+b.dataset.w].de));
    view.querySelector("#home").onclick = ctx.exit;
    view.querySelector("#again").onclick = ctx.startNext;
    keys([["Enter", "done, go home"], ["L", "next lesson now"], ["R", "reread lesson"], ["P", "practise speaking"]]);
    ui.onKey = e => {
      // Ignore a held or doubled Enter from the last question so the summary is not skipped by accident.
      if (e.repeat || Date.now() - shownAt < 600) return;
      const k = e.key.toLowerCase();
      if (e.key === "Enter") { e.preventDefault(); ctx.exit(); }
      else if (k === "l") ctx.startNext();
      else if (k === "r") location.hash = `read/${item.id}`;
      else if (k === "p") location.hash = `speak/${item.id}`;
    };
    try {
      await saved;
      const r = await api(`/api/block/${ctx.block.id}/end`, { json: { seconds: Math.round((Date.now() - ctx.block.start) / 1000) } });
      if (!view.querySelector("#summary")) return;  // the learner already left
      const mins = Math.round((Date.now() - ctx.block.start) / 60000), c = r.curriculum;
      view.querySelector("#summary").textContent = r.summary;
      view.querySelector("#stats").textContent = [mins < 1 ? "under a minute" : `${mins} minute${mins === 1 ? "" : "s"}`, answers.length ? `${right}/${answers.length} questions right` : "",
        `${c.words_known} of ${c.words_met} words known`, `${r.progress.streak_days}-day streak`].filter(Boolean).join(" · ");
      const nx = c.next_lesson, el = view.querySelector("#next");
      if (nx) {
        el.innerHTML = nx.id === item.id
          ? `Next block: <b>${esc(nx.title)}</b> again, because the lesson isn't marked as read yet.`
          : `Next up: <b>${esc(nx.title)}</b>. Start it from home with <kbd>Enter</kbd>.`;
        el.hidden = false;
      }
    } catch (e) {
      const s = view.querySelector("#summary");
      if (s) s.innerHTML = `<span class="err">The summary didn't load.</span>`;
      fail(e);
    }
  };
  askOne();
}
