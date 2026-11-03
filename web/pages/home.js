// Home: one obvious way to start the next lesson, a few quiet ways to practise without the timer, and the library.
import { $, $$, api, esc, fail, keys, ui, fmtPct } from "/lib.js";

export async function showHome(view, { startBlock }) {
  view.innerHTML = `<p class="muted">Loading…</p>`;
  let st;
  try { st = await api("/api/state"); } catch (e) { view.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  const p = st.progress, cur = st.curriculum, nxt = cur.next_lesson;
  const lessons = st.catalog.filter(c => c.kind === "lesson");
  const others = st.catalog.filter(c => c.kind !== "lesson");
  const byId = Object.fromEntries(st.catalog.map(c => [c.id, c]));
  const lastLesson = lessons.filter(l => l.status === "done").sort((a, b) => (b.order || 0) - (a.order || 0))[0];
  const resume = p.items_in_progress.map(id => byId[id]).find(Boolean);
  const bySeries = {};
  for (const c of others) (bySeries[c.series || "Other"] ||= []).push(c);
  const due = Math.min(p.cards.due, 15), last = p.recent_blocks[0], issues = p.pronunciation.top_issues;

  // Practice without the timer: only the actions that make sense right now.
  const practice = [
    resume && ["c", "Continue", resume.title || resume.id, "read/" + resume.id],
    lastLesson && ["r", "Reread", lastLesson.title, "read/" + lastLesson.id],
    lastLesson && ["s", "Speak", lastLesson.title, "speak/" + lastLesson.id],
    p.cards.due && ["v", "Review", `${p.cards.due} due card${p.cards.due === 1 ? "" : "s"}`, "review"],
  ].filter(Boolean);

  view.innerHTML = `
    <section class="card hero">
      <div>
        <div class="muted mono">${nxt ? `Next lesson · ${cur.lessons_done} of ${cur.lessons_written} done` : "Next lesson"}</div>
        <h1>${nxt ? esc(nxt.title) : "Your next lesson"}</h1>
        ${nxt?.summary ? `<p class="muted hero-sub">${esc(nxt.summary)}</p>` : `<p class="muted hero-sub">Claude will write it when you start (about a minute).</p>`}
        ${nxt?.new_words?.length ? `<div class="chips">${nxt.new_words.map(w => `<span class="chip" lang="de">${esc(w)}</span>`).join("")}</div>` : ""}
      </div>
      <div class="hero-go">
        <button class="btn primary big" id="start">Start 15 minutes <kbd>Enter</kbd></button>
        <span class="muted">${due ? `Starts with ${due} card${due === 1 ? "" : "s"} to review` : "No cards due, starts with new words"}</span>
      </div>
    </section>

    ${practice.length ? `<section class="practice"><h2>Practise without the timer</h2><div class="row">
      ${practice.map(([k, verb, title, hash]) => `<a class="btn" href="#${esc(hash)}" data-key="${k}"><kbd>${k.toUpperCase()}</kbd> ${verb} <span class="t">${esc(title)}</span></a>`).join("")}
    </div></section>` : ""}

    <section class="stats">
      <button class="card stat" id="words" aria-expanded="false" title="Show the words you have met"><b>${cur.words_known}<small> / ${cur.words_met}</small></b><span>words known / met <kbd>W</kbd></span></button>
      <div class="card stat"><b>${cur.lessons_done}</b><span>lessons done</span></div>
      <div class="card stat"><b>${p.streak_days}</b><span>day streak</span></div>
      <div class="card stat"><b>${fmtPct(p.pronunciation.avg_score_14d)}</b><span>sounds right, last 14 days</span></div>
    </section>
    <section class="card words" id="wordlist" hidden>
      <h2>${cur.words_met > cur.recent_words.length ? `Your last ${cur.recent_words.length} words of ${cur.words_met}` : "Words you have met"}</h2>
      ${cur.recent_words.length ? `<ul>${[...cur.recent_words].reverse().map(w => `<li class="${w.known ? "known" : ""}"><b lang="de">${esc(w.de)}</b> <span class="muted">${esc(w.en)}</span>${w.known ? ` <span class="tag">known</span>` : ""}</li>`).join("")}</ul>`
        : `<p class="muted">None yet. Each lesson introduces a few.</p>`}
    </section>

    ${last?.summary || issues.length ? `<section class="card">
      <h2>${last?.summary ? "Last block" : "Sounds to work on (expected → heard)"}</h2>
      ${last?.summary ? `<p class="serif" style="margin:0">${esc(last.summary)}</p>` : ""}
      ${issues.length ? `<div class="issues-row">${last?.summary ? `<span class="muted">Sounds to work on (expected → heard)</span>` : ""}<div class="issues">${issues.slice(0, 8).map(i => `<span class="issue">${esc(i.expected)} → ${esc(i.heard)} ×${i.count} <span class="muted">${esc(i.example_word)}</span></span>`).join("")}</div></div>` : ""}
    </section>` : ""}

    ${lessons.length ? `<section class="lib"><h2>Lessons · open any to read it without the timer</h2><div class="items">${lessons.map(i => itemButton(i)).join("")}</div></section>` : ""}

    <section class="lib" id="library">
      <div class="lib-head">
        <h2>Real episodes and clips · % of their German words you know</h2>
        <input type="text" id="filter" placeholder="Filter by title or series  ( / )" aria-label="Filter episodes and clips">
      </div>
      <div class="series" id="closest"><h3>${others.some(i => i.ready > 0) ? "Closest to readable" : "Good first episodes"}</h3><div class="items">${closest(others).map(i => itemButton(i, true, true)).join("")}</div></div>
      ${Object.entries(bySeries).map(([s, items]) => `<details class="series" data-series="${esc(s)}">
        <summary><h3>${esc(s)}</h3> <span class="muted mono">${items.length} · best ${fmtPct(Math.max(...items.map(i => i.ready ?? 0)))}</span></summary>
        <div class="items">${items.map(i => itemButton(i, true)).join("")}</div></details>`).join("")}
      <p class="muted" id="nomatch" hidden>Nothing matches.</p>
      <details class="series" id="story">
        <summary><h3>Write a new story</h3> <span class="muted">Claude writes a short German story in a setting you pick (about a minute)</span></summary>
        <form class="row" id="storyform">
          <input type="text" id="setting" placeholder="Setting, e.g. a bakery in Berlin" required>
          <button class="btn" type="submit">Write it</button>
        </form>
      </details>
    </section>`;

  $("#start").onclick = startBlock;
  $$(".items button", view).forEach(b => b.onclick = () => location.hash = "read/" + b.dataset.id);
  // The full word list loads on first open.
  let loaded = false;
  const toggleWords = async () => {
    const l = $("#wordlist"); l.hidden = !l.hidden; $("#words").setAttribute("aria-expanded", !l.hidden);
    if (l.hidden || loaded) return;
    loaded = true;
    try {
      const ws = await api("/api/words");
      l.innerHTML = `<h2>Words you have met · ${ws.filter(w => w.known).length} known of ${ws.length}</h2>` + (ws.length
        ? `<ul>${ws.map(w => `<li class="${w.known ? "known" : ""}"><b lang="de">${esc(w.de)}</b> <span class="muted">${esc(w.en)}</span>${w.known ? ` <span class="tag">known</span>` : ""}</li>`).join("")}</ul>`
        : `<p class="muted">None yet. Each lesson introduces a few.</p>`);
    } catch (e) { fail(e); }
  };
  $("#words").onclick = toggleWords;

  const filter = $("#filter");
  filter.oninput = () => applyFilter(view, filter.value);
  filter.onkeydown = e => { if (e.key === "Escape") { filter.value = ""; applyFilter(view, ""); filter.blur(); } };

  $("#storyform").onsubmit = async e => {
    e.preventDefault();
    const btn = $("#storyform button"), setting = $("#setting").value.trim();
    if (!setting) return;
    btn.disabled = true; btn.textContent = "Writing…";
    try { const item = await api("/api/story", { json: { setting, level: "A1" } }); location.hash = "read/" + item.id; }
    catch (err) { fail(err); btn.disabled = false; btn.textContent = "Write it"; }
  };

  keys([["Enter", "start lesson"], ...practice.map(([k, verb]) => [k.toUpperCase(), verb.toLowerCase()]), ["W", "words"], ["/", "filter library"]]);
  ui.onKey = e => {
    const k = e.key.toLowerCase();
    if (e.key === "Enter") { if (!document.activeElement?.closest("a, button, summary")) startBlock(); }  // Enter on a focused control activates that control
    else if (e.key === "/") { e.preventDefault(); filter.focus(); filter.scrollIntoView({ block: "center" }); }
    else if (k === "w") toggleWords();
    else { const a = practice.find(([key]) => key === k); if (a) location.hash = a[3]; }
  };
}

// The six episodes or clips with the highest share of known words; ties go to the first episode of each series.
function closest(items) {
  return [...items].sort((a, b) => (b.ready ?? 0) - (a.ready ?? 0) || (a.order || 0) - (b.order || 0)).slice(0, 6);
}

function applyFilter(view, q) {
  q = q.trim().toLowerCase();
  $("#closest", view).hidden = !!q;
  let any = false;
  $$("details[data-series]", view).forEach(d => {
    const seriesHit = d.dataset.series.toLowerCase().includes(q);
    let n = 0;
    $$(".items button", d).forEach(b => { const hit = !q || seriesHit || b.title.toLowerCase().includes(q); b.hidden = !hit; n += hit; });
    d.hidden = !n; d.open = !!q && n > 0; any ||= n > 0;
  });
  $("#nomatch", view).hidden = any || !q;
}

function itemButton(i, showReady, showSeries) {
  const label = `${i.order && i.kind !== "lesson" ? i.order + ". " : ""}${(i.title || i.id).slice(0, 38)}`;
  const ready = showReady && i.ready != null ? `<span class="ready" style="--r:${i.ready}">${fmtPct(i.ready)}</span>` : "";
  const series = showSeries && i.series ? `<span class="muted"> · ${esc(i.series.replace(/^New stories: /, ""))}</span>` : "";
  return `<button class="${i.status}" data-id="${esc(i.id)}" title="${esc(i.title)} · ${esc(i.series || "")} · ${esc(i.level || "")}">${esc(label)}${series}${ready}</button>`;
}
