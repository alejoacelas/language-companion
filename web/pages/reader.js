// Reader: English narration with German lines (and *German* words inside narration), real media when the item has it.
// One default action (Space plays the selected line); the sticky bar and the footer keys offer the rest.
import { $, $$, api, esc, fail, keys, toast, ui, playLine, stopAudio, germanHTML, narrationHTML, newFormsOf } from "/lib.js";

let yt = null;
function loadYT() {
  if (window.YT?.Player) return Promise.resolve();
  return new Promise(res => { window.onYouTubeIframeAPIReady = res; const s = document.createElement("script"); s.src = "https://www.youtube.com/iframe_api"; document.head.append(s); });
}

// Per-viewer preferences that should survive a reload.
const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem("reader." + k) === "1"; localStorage.setItem("reader." + k, v ? "1" : "0"); } catch { return false; } };
const SLOW = 0.75;
const hideLabel = hidden => `<span>${hidden ? "Show" : "Hide"} <span class="long">English</span><span class="short">EN</span></span> <kbd>E</kbd>`;

export async function showReader(view, item, ctx) {
  if (!item) { view.innerHTML = `<p class="err">No item to read.</p>`; return; }
  const inBlock = !!ctx.block;
  const startedAt = Date.now();
  api(`/api/item/${item.id}/progress`, { json: { status: "started", block_id: ctx.block?.id } }).catch(() => {});
  const lines = item.lines || [];
  const forms = newFormsOf(item);
  const m = item.media;
  const hasMedia = !!m;
  let sel = 0, hideEn = pref("hideEn"), slow = pref("slow");
  let mode = null;          // null | "listen" | "repeat": what the play loop is doing
  let playing = false;      // a single line or a loop is playing through our controls
  const done = inBlock
    ? `<button class="btn primary" data-act="next">Done reading: speak <kbd>N</kbd></button>`
    : `<button class="btn primary" data-act="done">Mark as done <kbd>D</kbd></button><a class="btn" href="#speak/${esc(item.id)}">Practise speaking <kbd>K</kbd></a>`;

  view.innerHTML = `<div class="reader">
    <div><div class="muted mono">${esc(item.series || "")} · ${esc(item.level || "")}${item.generated ? " · written by Claude" : ""}</div>
      <h1>${esc(item.title)}</h1>
      ${item.external_link ? `<p style="margin:6px 0 0"><a href="${esc(item.external_link.url)}" target="_blank" rel="noopener">${esc(item.external_link.label || "Watch the full episode")} ↗</a></p>` : ""}
      <p class="muted" style="margin:6px 0 0">Click a line to hear it. Click any German word for its meaning${forms.size ? `; new words are <span class="w new">highlighted</span>` : ""}.</p>
    </div>
    <div class="rstick" id="rstick">
      ${m ? `<div class="media">${m.type === "youtube" ? `<div class="yt"><div id="ytp"></div></div>` : m.type === "video" ? `<video id="av" controls src="/media/${esc(m.path.replace(/^media\//, ""))}"></video>` : `<audio id="av" controls src="/media/${esc(m.path.replace(/^media\//, ""))}"></audio>`}</div>` : ""}
      <div class="rbar" role="toolbar" aria-label="Reading controls">
        <button class="btn primary" id="play" title="Play the selected line (Space)">▶ <span>Play<span class="long"> line</span></span> <kbd>Space</kbd></button>
        <button class="btn" id="listen" title="Play every line from here on (A)"><span>Listen<span class="long"> from here</span></span> <kbd>A</kbd></button>
        <button class="btn" id="repeat" title="Repeat the selected line until you stop it (R)">Repeat <kbd>R</kbd></button>
        <button class="btn" id="slow" aria-pressed="${slow}" title="Play German at ${SLOW}× speed (S)">${SLOW}× <kbd>S</kbd></button>
        <button class="btn" id="speakline" title="Practise saying the selected German line (P)">Say this line <kbd>P</kbd></button>
        <button class="btn" id="hide" aria-pressed="${hideEn}" title="Hide or show the English translations (E)">${hideLabel(hideEn)}</button>
        <span class="rprog" title="Selected line"><span id="pos">1</span> / ${lines.length}<span class="rtrack"><span id="fill"></span></span></span>
        <button class="btn quiet" data-act="${inBlock ? "next" : "done"}">${inBlock ? "Done: speak" : "Done"}</button>
      </div>
    </div>
    <div class="lines${hideEn ? " hide-en" : ""}" id="lines">${lines.map((l, i) => l.lang === "de"
      ? `<div class="line${l.uncertain ? " uncertain" : ""}" data-i="${i}"><div>${l.speaker ? `<div class="spk">${esc(l.speaker)}</div>` : ""}<p class="de" lang="de">${germanHTML(l.text, forms)}</p></div><p class="tr" title="Click to show (T)">${esc(l.en || "")}</p></div>`
      : `<div class="line en" data-i="${i}"><p>${narrationHTML(l.text, forms)}</p></div>`).join("")}</div>
    <div class="rend"><span class="muted">End of the text.</span><div class="row">${done}</div></div>
  </div>`;

  const stick = $("#rstick");
  stick.style.top = ($(".topbar")?.offsetHeight ?? 56) + "px";
  const av = $("#av");
  const applyRate = () => { const r = slow ? SLOW : 1; if (av) av.playbackRate = r; yt?.setPlaybackRate?.(r); };
  if (m?.type === "youtube") {
    await loadYT();
    yt = new YT.Player("ytp", { videoId: m.youtube_id, playerVars: { start: Math.floor(m.start || 0), rel: 0, cc_load_policy: 0 }, events: { onReady: applyRate } });
  } else yt = null;
  applyRate();

  const alive = () => document.body.contains($("#lines"));
  const mediaTime = () => yt?.getCurrentTime ? yt.getCurrentTime() : av ? av.currentTime : null;
  const mediaPlaying = () => yt?.getPlayerState ? yt.getPlayerState() === 1 : av ? !av.paused : false;
  const pauseMedia = () => { yt?.pauseVideo?.(); av?.pause(); };

  // Media lines stop at their end time; when the learner drives the native player, the highlight follows the recording.
  let stopAt = null, onStop = null;
  const tick = setInterval(() => {
    if (!alive()) { clearInterval(tick); return; }
    const t = mediaTime();
    if (t == null) return;
    if (stopAt && t >= stopAt) { pauseMedia(); stopAt = null; const f = onStop; onStop = null; f?.(); }
    else if (!playing && mediaPlaying()) {
      const i = lines.findIndex(l => l.start != null && t >= l.start && t < (l.end ?? Infinity));
      if (i >= 0 && i !== sel) { sel = i; drawSel(); }
    }
  }, 100);

  const drawSel = () => {
    $$(".line", view).forEach(el => el.classList.toggle("sel", +el.dataset.i === sel));
    // Keep the selected line clear of the sticky media/controls above and the key bar below.
    view.style.setProperty("--stick-bottom", (parseFloat(stick.style.top) + stick.offsetHeight) + "px");
    view.style.setProperty("--keys-h", ($("#keys")?.offsetHeight ?? 40) + "px");
    view.querySelector(`.line[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    $("#pos").textContent = sel + 1;
    $("#fill").style.width = (lines.length > 1 ? sel / (lines.length - 1) * 100 : 100) + "%";
  };
  const drawButtons = () => {
    $("#listen").classList.toggle("on", mode === "listen");
    $("#listen").innerHTML = mode === "listen" ? `■ Stop <kbd>A</kbd>` : `<span>Listen<span class="long"> from here</span></span> <kbd>A</kbd>`;
    $("#repeat").classList.toggle("on", mode === "repeat");
    $("#repeat").innerHTML = mode === "repeat" ? `■ Stop <kbd>R</kbd>` : `Repeat <kbd>R</kbd>`;
    $("#hide").setAttribute("aria-pressed", hideEn);
    $("#hide").innerHTML = hideLabel(hideEn);
    $("#slow")?.setAttribute("aria-pressed", slow);
  };

  // Play the selected line once; resolves when it ends (true) or is interrupted (false).
  const playOnce = () => new Promise(res => {
    const l = lines[sel]; if (!l) return res(false);
    if (l.start != null && (yt || av)) {
      stopAudio();
      const prev = onStop; onStop = null; prev?.(false);
      if (yt) { yt.seekTo(l.start, true); yt.playVideo(); } else { av.currentTime = l.start; av.play(); }
      stopAt = l.end ?? null; onStop = ok => res(ok !== false);
    } else { pauseMedia(); stopAt = null; playLine(l, { speed: slow ? SLOW : 1 }).then(res); }
  });
  // Stop whatever is playing and leave loop mode.
  const stop = () => {
    mode = null; playing = false; stopAudio(); pauseMedia(); stopAt = null;
    const f = onStop; onStop = null; f?.(false);
    drawButtons();
  };
  const play = async () => { stop(); playing = true; await playOnce(); if (!mode) playing = false; };
  const loop = async kind => {
    stop(); mode = kind; playing = true; drawButtons();
    while (mode === kind && alive()) {
      drawSel();
      if (!(await playOnce()) || mode !== kind) break;
      if (kind === "listen") { if (sel < lines.length - 1) sel++; else break; }
      await new Promise(r => setTimeout(r, kind === "repeat" ? 700 : 250));
    }
    if (mode === kind) { mode = null; playing = false; drawButtons(); }
  };
  const toggleLoop = kind => mode === kind ? stop() : loop(kind);
  const move = d => { stop(); sel = Math.min(lines.length - 1, Math.max(0, sel + d)); drawSel(); };
  const toggleHide = () => { hideEn = !hideEn; pref("hideEn", hideEn); $("#lines").classList.toggle("hide-en", hideEn); $$(".line.show", view).forEach(el => el.classList.remove("show")); drawButtons(); };
  const reveal = i => view.querySelector(`.line[data-i="${i}"]`)?.classList.toggle("show");
  const toggleSlow = () => { slow = !slow; pref("slow", slow); applyRate(); drawButtons(); toast(slow ? `German at ${SLOW}× speed` : "German at normal speed"); };
  // Practise the selected German line (or the next German line after it) on the speak page.
  const speakLine = () => { const l = lines.slice(sel).find(x => x.lang === "de"); if (!l) return; stop(); location.hash = `speak/${item.id}/${l.id}`; };
  const finish = () => api(`/api/item/${item.id}/progress`, { json: { status: "done", seconds: Math.round((Date.now() - startedAt) / 1000), block_id: ctx.block?.id } }).catch(fail);
  const act = async a => {
    stop();
    if (a === "next") { await finish(); ctx.next(); }
    else if (a === "done") { await finish(); toast("Marked as done"); }
  };

  $$(".line", view).forEach(el => el.onclick = e => {
    if (e.target.classList.contains("w")) return;
    const i = +el.dataset.i;
    if (hideEn && e.target.classList.contains("tr")) { reveal(i); return; }
    sel = i; drawSel(); play();
  });
  $$(".w", view).forEach(w => w.onclick = () => { const i = +w.closest(".line").dataset.i; showGloss(w, lines[i], item, ctx); });
  $$("[data-act]", view).forEach(b => b.onclick = () => act(b.dataset.act));
  $("#play").onclick = play;
  $("#listen").onclick = () => toggleLoop("listen");
  $("#repeat").onclick = () => toggleLoop("repeat");
  $("#hide").onclick = toggleHide;
  $("#slow").onclick = toggleSlow;
  $("#speakline").onclick = speakLine;
  drawSel(); drawButtons();

  keys([["Space", "play line"], ["↑ ↓", "line"], ["A", "listen from here"], ["R", "repeat line"], ["S", "slower"], ["P", "say this line"],
    ["E", "hide or show English"], ["T", "show this translation"], ["Esc", "stop"], ...(inBlock ? [["N", "next step"]] : [["D", "done"], ["K", "speak"]])]);
  ui.onKey = e => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === "ArrowDown" || k === "j") { e.preventDefault(); move(1); }
    else if (k === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (k === " ") { e.preventDefault(); play(); }
    else if (k === "a") toggleLoop("listen");
    else if (k === "r") toggleLoop("repeat");
    else if (k === "s") toggleSlow();
    else if (k === "p") speakLine();
    else if (k === "e") toggleHide();
    else if (k === "t") { if (hideEn) reveal(sel); }
    else if (k === "Escape") stop();
    else if (k === "n" && inBlock) act("next");
    else if (k === "d" && !inBlock) act("done");
    else if (k === "k" && !inBlock) { stop(); location.hash = "speak/" + item.id; }
  };
}

async function showGloss(el, line, item, ctx) {
  const pop = $("#pop"), r = el.getBoundingClientRect();
  pop.style.left = Math.max(window.scrollX + 8, Math.min(window.scrollX + r.left, window.scrollX + innerWidth - 340)) + "px";
  pop.style.top = window.scrollY + r.bottom + 6 + "px";
  pop.innerHTML = `<span class="muted">Looking up “${esc(el.textContent)}”…</span>`; pop.hidden = false; pop.onkey = null;
  const sentence = line.lang === "de" ? line.text : el.closest(".de-inline")?.textContent || el.textContent;
  try {
    const g = await api("/api/gloss", { json: { word: el.textContent, sentence, item_id: item.id, block_id: ctx.block?.id } });
    pop.innerHTML = `<div class="lemma" lang="de">${esc(g.lemma)}</div><div>${esc(g.meaning)}</div>${g.note ? `<div class="note">${esc(g.note)}</div>` : ""}
      <div class="note">Card: <b lang="de">${esc(g.card_front)}</b> = ${esc(g.card_back)}</div>
      <div class="row"><button class="btn primary" id="save">Save card <kbd>S</kbd></button><button class="btn" id="say">Hear it <kbd>H</kbd></button><span class="muted note">Esc closes</span></div>`;
    const save = async () => {
      await api("/api/cards", { json: { front: g.card_front, back: g.card_back, context_de: line.lang === "de" ? line.text : null, context_en: line.en, item_id: item.id, line_id: line.id } }).catch(fail);
      el.classList.add("saved"); pop.hidden = true; toast("Saved: " + g.card_front);
    };
    const say = () => playLine({ lang: "de", text: g.card_front });
    $("#save").onclick = save; $("#say").onclick = say;
    pop.onkey = e => { const k = e.key.toLowerCase(); if (k === "s") save(); else if (k === "h") say(); else return false; };
  } catch (e) { pop.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
}
document.addEventListener("click", e => { if (!e.target.closest("#pop, .w")) $("#pop").hidden = true; });
