// Home: the next lesson front and centre, progress on the word ladder, and the library with how ready you are for each text.
import { $, $$, api, esc, keys, ui, fmtPct } from "/lib.js";

export async function showHome(view, { startBlock }) {
  view.innerHTML = `<p class="muted">Loading…</p>`;
  let st;
  try { st = await api("/api/state"); } catch (e) { view.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  const p = st.progress, cur = st.curriculum, nxt = cur.next_lesson;
  const lessons = st.catalog.filter(c => c.kind === "lesson");
  const others = st.catalog.filter(c => c.kind !== "lesson");
  const bySeries = {};
  for (const c of others) (bySeries[c.series || "Other"] ||= []).push(c);
  const last = p.recent_blocks[0];
  view.innerHTML = `
    <section class="card hero">
      <div>
        <div class="muted mono">${nxt ? `Next lesson · ${cur.lessons_done} of ${cur.lessons_written} done` : "Next lesson"}</div>
        <h1>${nxt ? esc(nxt.title) : "Your first lesson"}</h1>
        ${nxt?.summary ? `<p class="muted" style="margin:6px 0 0">${esc(nxt.summary)}</p>` : `<p class="muted" style="margin:6px 0 0">Claude will write it when you start (about a minute).</p>`}
        ${nxt?.new_words?.length ? `<div class="chips">${nxt.new_words.map(w => `<span class="chip" lang="de">${esc(w)}</span>`).join("")}</div>` : ""}
      </div>
      <button class="btn primary big" id="start">Start 15 minutes <kbd>Enter</kbd></button>
    </section>
    <section class="stats">
      <div class="card stat"><b>${cur.words_known}<small> / ${cur.words_met}</small></b><span>words known / met</span></div>
      <div class="card stat"><b>${cur.lessons_done}</b><span>lessons done</span></div>
      <div class="card stat"><b>${p.streak_days}</b><span>day streak</span></div>
      <div class="card stat"><b>${fmtPct(p.pronunciation.avg_score_14d)}</b><span>sounds right, last 14 days</span></div>
    </section>
    ${last?.summary ? `<section class="card"><h2>Last block</h2><p class="serif" style="margin:0">${esc(last.summary)}</p></section>` : ""}
    ${p.pronunciation.top_issues.length ? `<section><h2>Sounds to work on (expected → heard)</h2><div class="issues">${p.pronunciation.top_issues.slice(0, 8).map(i => `<span class="issue">${esc(i.expected)} → ${esc(i.heard)} ×${i.count} <span class="muted">${esc(i.example_word)}</span></span>`).join("")}</div></section>` : ""}
    ${lessons.length ? `<section class="lib"><h2>Lessons</h2><div class="items">${lessons.map(i => itemButton(i)).join("")}</div></section>` : ""}
    <section class="lib"><h2>Real episodes and clips · % of their German words you know</h2>
      ${Object.entries(bySeries).map(([s, items]) => `<div class="series"><h3>${esc(s)}</h3><div class="items">${items.map(i => itemButton(i, true)).join("")}</div></div>`).join("")}
    </section>`;
  $("#start").onclick = startBlock;
  $$(".items button", view).forEach(b => b.onclick = () => location.hash = "read/" + b.dataset.id);
  keys([["Enter", "start lesson"]]);
  ui.onKey = e => { if (e.key === "Enter") startBlock(); };
}

function itemButton(i, showReady) {
  const label = `${i.order && i.kind !== "lesson" ? i.order + ". " : ""}${(i.title || i.id).slice(0, 38)}`;
  const ready = showReady && i.ready != null ? `<span class="ready" style="--r:${i.ready}">${fmtPct(i.ready)}</span>` : "";
  return `<button class="${i.status}" data-id="${esc(i.id)}" title="${esc(i.title)} · ${esc(i.level || "")}">${esc(label)}${ready}</button>`;
}
