// Reader: English narration with German lines (and *German* words inside narration), real media when the item has it.
import { $, $$, api, esc, fail, keys, toast, ui, playLine, stopAudio, germanHTML, narrationHTML, newFormsOf } from "/lib.js";

let yt = null;
function loadYT() {
  if (window.YT?.Player) return Promise.resolve();
  return new Promise(res => { window.onYouTubeIframeAPIReady = res; const s = document.createElement("script"); s.src = "https://www.youtube.com/iframe_api"; document.head.append(s); });
}

export async function showReader(view, item, ctx) {
  if (!item) { view.innerHTML = `<p class="err">No item to read.</p>`; return; }
  const inBlock = !!ctx.block;
  const startedAt = Date.now();
  api(`/api/item/${item.id}/progress`, { json: { status: "started", block_id: ctx.block?.id } }).catch(() => {});
  const lines = item.lines || [];
  const forms = newFormsOf(item);
  let sel = 0, hideEn = false, auto = false;
  const m = item.media;
  view.innerHTML = `<div class="reader">
    <div><div class="muted mono">${esc(item.series || "")} · ${esc(item.level || "")}${item.generated ? " · written by Claude" : ""}</div>
      <h1>${esc(item.title)}</h1>
      ${item.external_link ? `<p style="margin:6px 0 0"><a href="${esc(item.external_link.url)}" target="_blank" rel="noopener">${esc(item.external_link.label || "Watch the full episode")} ↗</a></p>` : ""}
      ${forms.size ? `<p class="muted" style="margin:6px 0 0">New words are <span class="w new">highlighted</span>. Click any German word for its meaning.</p>` : ""}
    </div>
    ${m ? `<div class="media">${m.type === "youtube" ? `<div class="yt"><div id="ytp"></div></div>` : m.type === "video" ? `<video id="av" controls src="/media/${esc(m.path.replace(/^media\//, ""))}" style="width:100%;max-height:42vh"></video>` : `<audio id="av" controls src="/media/${esc(m.path.replace(/^media\//, ""))}"></audio>`}</div>` : ""}
    <div class="lines" id="lines">${lines.map((l, i) => l.lang === "de"
      ? `<div class="line${l.uncertain ? " uncertain" : ""}" data-i="${i}"><div>${l.speaker ? `<div class="spk">${esc(l.speaker)}</div>` : ""}<p class="de" lang="de">${germanHTML(l.text, forms)}</p></div><p class="tr">${esc(l.en || "")}</p></div>`
      : `<div class="line en" data-i="${i}"><p>${narrationHTML(l.text, forms)}</p></div>`).join("")}</div>
    <div class="row">${inBlock ? `<button class="btn primary" id="nx">Done reading: speak <kbd>N</kbd></button>` : `<button class="btn" id="done">Mark as done <kbd>D</kbd></button><a class="btn" href="#speak/${esc(item.id)}">Practise speaking <kbd>K</kbd></a>`}
      <button class="btn" id="all">Play from here <kbd>A</kbd></button></div>
  </div>`;
  const av = $("#av");
  if (m?.type === "youtube") {
    await loadYT();
    yt = new YT.Player("ytp", { videoId: m.youtube_id, playerVars: { start: Math.floor(m.start || 0), rel: 0, cc_load_policy: 0 } });
  } else yt = null;

  let stopAt = null, onStop = null;
  const tick = setInterval(() => {
    if (!document.body.contains($("#lines"))) { clearInterval(tick); return; }
    const t = yt?.getCurrentTime ? yt.getCurrentTime() : av ? av.currentTime : null;
    if (t == null) return;
    if (stopAt && t >= stopAt) { yt ? yt.pauseVideo() : av.pause(); stopAt = null; const f = onStop; onStop = null; f?.(); }
  }, 100);

  const drawSel = () => { $$(".line", view).forEach(el => el.classList.toggle("sel", +el.dataset.i === sel)); view.querySelector(`.line[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }); };
  // Play the selected line; resolves when it ends (true) or is interrupted (false).
  const play = () => new Promise(res => {
    const l = lines[sel]; if (!l) return res(false);
    if (l.start != null && (yt || av)) {
      stopAudio();
      if (yt) { yt.seekTo(l.start, true); yt.playVideo(); } else { av.currentTime = l.start; av.play(); }
      stopAt = l.end ?? null; onStop = () => res(true);
    } else playLine(l).then(res);
  });
  const playAll = async () => {
    auto = true; $("#all").textContent = "Stop";
    while (auto && sel < lines.length) {
      drawSel();
      if (!(await play()) || !auto) break;
      if (sel < lines.length - 1) sel++; else break;
      await new Promise(r => setTimeout(r, 250));
    }
    stopAll();
  };
  const stopAll = () => { auto = false; const b = $("#all"); if (b) b.innerHTML = `Play from here <kbd>A</kbd>`; };
  const move = d => { stopAll(); sel = Math.min(lines.length - 1, Math.max(0, sel + d)); drawSel(); };
  const finish = () => api(`/api/item/${item.id}/progress`, { json: { status: "done", seconds: Math.round((Date.now() - startedAt) / 1000), block_id: ctx.block?.id } }).catch(fail);

  $$(".line", view).forEach(el => el.onclick = e => { if (e.target.classList.contains("w")) return; stopAll(); sel = +el.dataset.i; drawSel(); play(); });
  $$(".w", view).forEach(w => w.onclick = () => { const i = +w.closest(".line").dataset.i; showGloss(w, lines[i], item, ctx); });
  $("#nx") && ($("#nx").onclick = async () => { stopAll(); await finish(); ctx.next(); });
  $("#done") && ($("#done").onclick = async () => { await finish(); toast("Marked as done"); });
  $("#all").onclick = () => auto ? (stopAll(), stopAudio(), yt?.pauseVideo?.(), av?.pause()) : playAll();
  drawSel();
  keys([["↑ ↓", "line"], ["Space", "play line"], ["A", "play from here"], ["click word", "meaning"], ["E", "hide English"], ...(inBlock ? [["N", "next step"]] : [["D", "done"], ["K", "speak"]])]);
  ui.onKey = async e => {
    if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === " ") { e.preventDefault(); stopAll(); play(); }
    else if (e.key === "a") $("#all").click();
    else if (e.key === "e") { hideEn = !hideEn; $("#lines").classList.toggle("hide-en", hideEn); }
    else if (e.key === "n" && inBlock) $("#nx").click();
    else if (e.key === "d" && !inBlock) $("#done").click();
    else if (e.key === "k" && !inBlock) location.hash = "speak/" + item.id;
  };
}

async function showGloss(el, line, item, ctx) {
  const pop = $("#pop"), r = el.getBoundingClientRect();
  pop.style.left = Math.min(window.scrollX + r.left, window.scrollX + innerWidth - 340) + "px";
  pop.style.top = window.scrollY + r.bottom + 6 + "px";
  pop.innerHTML = `<span class="muted">Looking up “${esc(el.textContent)}”…</span>`; pop.hidden = false; pop.onkey = null;
  const sentence = line.lang === "de" ? line.text : el.closest(".de-inline")?.textContent || el.textContent;
  try {
    const g = await api("/api/gloss", { json: { word: el.textContent, sentence, item_id: item.id, block_id: ctx.block?.id } });
    pop.innerHTML = `<div class="lemma" lang="de">${esc(g.lemma)}</div><div>${esc(g.meaning)}</div>${g.note ? `<div class="note">${esc(g.note)}</div>` : ""}
      <div class="note">Card: <b lang="de">${esc(g.card_front)}</b> = ${esc(g.card_back)}</div>
      <div class="row"><button class="btn primary" id="save">Save card <kbd>S</kbd></button><button class="btn" id="say">Hear it <kbd>H</kbd></button></div>`;
    const save = async () => {
      await api("/api/cards", { json: { front: g.card_front, back: g.card_back, context_de: line.lang === "de" ? line.text : null, context_en: line.en, item_id: item.id, line_id: line.id } }).catch(fail);
      el.classList.add("saved"); pop.hidden = true; toast("Saved: " + g.card_front);
    };
    const say = () => playLine({ lang: "de", text: g.card_front });
    $("#save").onclick = save; $("#say").onclick = say;
    pop.onkey = e => { if (e.key === "s") save(); else if (e.key === "h") say(); else return false; };
  } catch (e) { pop.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
}
document.addEventListener("click", e => { if (!e.target.closest("#pop, .w")) $("#pop").hidden = true; });
