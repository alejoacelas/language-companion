// Course home: the list of lessons, the next one to take, and the result screen after a lesson.
import { $, api, esc, fail, keys } from "/shared/lib.js";
import { Lesson } from "/player.js";

const view = $("#view");
let current = null;

async function home(note = "") {
  current = null;
  const c = await api("/api/course");
  const next = c.next ?? (c.generating ? null : "write");
  view.innerHTML = `<div class="home">
    ${note}
    <div class="card hero">
      <h1>${c.lessons.length ? "Next lesson" : "Start the course"}</h1>
      <p class="muted">15 minutes, audio only. You'll be asked to say things in German; answer out loud before you hear the answer.
        Use headphones. Move on once you recall ${Math.round(c.pass_share * 100)}% of the prompts; otherwise repeat the lesson.</p>
      <div class="row">${typeof next === "number"
        ? `<button class="btn primary big" id="go" data-n="${next}">Start lesson ${next} <kbd>Enter</kbd></button>`
        : c.generating ? `<span class="muted">Writing the next lesson… (about a minute)</span>`
        : `<button class="btn primary big" id="write">Write lesson ${c.lessons.length + 1} <kbd>Enter</kbd></button>`}</div>
    </div>
    <div><h2>Lessons · ${c.items_known} items learned</h2><div class="lessons">${c.lessons.map(l => `
      <div class="card lrow"><div><b>${l.n}. ${esc(l.title)}</b><div class="muted">${esc(l.scenario)}</div>
        <div class="muted small" lang="de">${l.items.map(esc).join(" · ")}</div></div>
        <div class="lscore">${l.best != null ? `<b class="${l.passed ? "ok" : "warn"}">${Math.round(l.best * 100)}%</b><span class="muted">${l.runs} run${l.runs > 1 ? "s" : ""}</span>` : `<span class="muted">not taken</span>`}
        <button class="btn" data-n="${l.n}">${l.runs ? "Repeat" : "Start"}</button></div></div>`).join("") || `<p class="muted">No lessons yet.</p>`}</div></div>
  </div>`;
  keys([["Enter", "start"]]);
  view.querySelectorAll("[data-n]").forEach(b => b.onclick = () => take(+b.dataset.n));
  $("#write") && ($("#write").onclick = write);
  if (c.generating) setTimeout(() => !current && home(note), 4000);
}

async function write() {
  await api("/api/lesson/write", { method: "POST" });
  home();
}

async function take(n) {
  const lesson = await api(`/api/lesson/${n}`);
  current = window.lesson = new Lesson(lesson, view, { onDone: done });  // window.lesson: for inspection from the console
  current.start();
}

function done(r, items) {
  const missed = items.filter(i => i.misses).map(i => `<span lang="de">${esc(i.d.de)}</span> (${i.misses})`);
  const untaught = items.filter(i => i.k < 0).length;
  home(`<div class="card result ${r.passed ? "pass" : "again"}"><h2>Lesson finished</h2>
    <h1>${r.score == null ? "–" : Math.round(r.score * 100) + "%"} recalled</h1>
    <p>${r.passed ? "Good: go on to the next lesson. It is being written now." : "Repeat this lesson before moving on; the items will stick much better."}</p>
    ${missed.length ? `<p class="muted">Missed: ${missed.join(", ")}</p>` : ""}
    ${untaught ? `<p class="muted">${untaught} item${untaught > 1 ? "s" : ""} didn't fit in the time; the next lesson teaches ${untaught > 1 ? "them" : "it"} first.</p>` : ""}</div>`);
}

document.addEventListener("keydown", e => {
  if (current) return current.key(e, false);
  if (e.key === "Enter") ($("#go") || $("#write"))?.click();
});
document.addEventListener("keyup", e => current?.key(e, true));
home().catch(fail);
