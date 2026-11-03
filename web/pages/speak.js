// Speak: a live session led by the voice coach. Hold Space to talk; the coach hears your audio and also gets a
// phone-by-phone transcription compared with the sentence on screen, then decides what to do next.
// Quick buttons send the coach short requests (again slowly, easier, next) and let you pick a sentence yourself.
// Without the coach (offline or turned off), you step through the text's lines and still get the comparison.
import { $, $$, api, esc, fail, keys, playTTS, stopAudio, toast, ui } from "/lib.js";
import { VoiceCoach } from "/voice.js";

const STATE_LABEL = { off: "Coach off", connecting: "Connecting…", live: "Coach listening", speaking: "Coach speaking", talk: "Listening to you…", thinking: "Coach thinking…" };
// Short requests a learner can send the coach with one key.
const ASKS = {
  again: `(The learner pressed "Again, slowly". Say the sentence on screen once more, slowly and clearly, then ask them to repeat it.)`,
  easier: `(The learner pressed "Easier": this is too hard right now. Use show_sentence to show something easier, such as a shorter part of it or one word, and ask them to say it.)`,
  next: `(The learner pressed "Next". Move on: use show_sentence to show a new sentence and ask them to say it.)`,
};
let coach = null, own = null;   // own: the Audio element that plays the learner's recording or slowed-down speech
const stopOwn = () => { own?.pause(); own = null; };
export function stopCoach() { coach?.stop(); stopOwn(); }

function defaultTargets(item) {
  const de = (item.lines || []).filter(l => l.lang === "de" && !l.uncertain);
  const n = l => l.text.split(/\s+/).length;
  const good = de.filter(l => n(l) <= 10 && (item.kind === "lesson" || n(l) >= 2));
  const pool = good.length >= 3 ? good : de;
  const k = Math.min(8, pool.length), out = [];
  for (let i = 0; i < k; i++) { const l = pool[Math.floor(i * pool.length / k)]; out.push({ text: l.text, en: l.en, id: l.id }); }
  return out;
}

// `lineId` (from #speak/<item>/<line>) starts on that line instead of letting the coach choose.
export function showSpeak(view, item, ctx, lineId) {
  if (!item) return;
  const inBlock = !!ctx.block;
  const targets = defaultTargets(item);
  const chosen = lineId && (item.lines || []).find(l => l.id === lineId && l.lang === "de");
  if (chosen) { const i = targets.findIndex(x => x.id === chosen.id); if (i >= 0) targets.splice(i, 1); targets.unshift({ text: chosen.text, en: chosen.en, id: chosen.id }); }
  const choices = (item.lines || []).filter(l => l.lang === "de" && !l.uncertain).map(l => ({ text: l.text, en: l.en, id: l.id }));
  let t = 0, target = targets[0] || null, result = null, showSounds = false, picking = false, state = "off";
  let recorder = null, ownStream = null, chunks = [], busy = false, talking = false, mine = null;   // mine: URL of the last recording

  view.innerHTML = `<div class="speak">
    <div class="row" style="justify-content:space-between"><h1>Say it</h1>
      <div class="coach"><span class="dot" id="coachdot"></span><span id="coachlbl">Coach off</span><button class="btn" id="cbtn">Turn coach on <kbd>V</kbd></button></div></div>
    <div class="card" id="stage"></div>
    <div class="talkrow"><button class="talk" id="talk"><span>Hold to talk</span><kbd>Space</kbd></button>
      <div class="talkside"><span class="muted" id="hint"></span><div class="asks" id="asks"></div></div></div>
    <div class="card picker" id="picker" hidden></div>
    <div class="transcript card" id="transcript" hidden></div>
    <div class="row">${inBlock ? `<button class="btn primary" id="nx">Finish: wrap up <kbd>N</kbd></button>` : `<a class="btn" href="#read/${esc(item.id)}">Back to text</a>`}</div>
  </div>`;

  // ---------- audio: the native voice, slowed down, and your own recording ----------
  const playUrl = (url, rate = 1) => new Promise(res => {
    stopAudio(); stopOwn();
    const a = own = new Audio(url); a.playbackRate = rate; a.preservesPitch = true;
    a.onended = () => res(own === a); a.onerror = () => res(false); a.play().catch(() => res(false));
  });
  const hear = () => target && playTTS(target.text);
  const hearSlow = () => target && playUrl(`/api/tts?text=${encodeURIComponent(target.text)}&lang=de`, 0.7);
  const hearMine = () => mine && playUrl(mine);
  const compare = async () => { if (!mine || !target) return; if (await playUrl(mine)) playTTS(target.text); };

  // ---------- coach ----------
  const live = () => coach?.live;
  // Interrupt whatever the coach is saying, then send it a request.
  const ask = text => {
    if (!live()) return;
    stopAudio(); stopOwn();
    if (state === "speaking" || state === "thinking") { coach.send({ type: "response.cancel" }); coach.send({ type: "output_audio_buffer.clear" }); }
    coach.say(`${text}\nSentence on screen now: ${target ? `"${target.text}"` : "none"}.`);
  };
  const choose = c => {
    picking = false; target = c; result = null; mine = null;
    const k = targets.findIndex(x => x.text === c.text); if (k >= 0) t = k;
    draw();
    if (live()) ask(`(The learner chose this sentence to practise: "${c.text}" = ${c.en || ""}. It is on screen now, so don't call show_sentence for it. Ask them to say it.)`);
  };

  const setState = s => {
    state = s;
    const d = $("#coachdot"), l = $("#coachlbl"), b = $("#cbtn");
    if (!d) return;
    if (s === "off" && !target && targets.length) { target = targets[t]; result = null; mine = null; }
    d.className = "dot " + s; l.textContent = STATE_LABEL[s] || s;
    b.innerHTML = s === "off" ? `Turn coach on <kbd>V</kbd>` : `Turn coach off <kbd>V</kbd>`;
    draw();
  };
  const addTranscript = (who, text) => { const tr = $("#transcript"); if (tr && text) { tr.hidden = false; tr.insertAdjacentHTML("beforeend", `<div><b>${who}:</b> ${esc(text)}</div>`); tr.scrollTop = 1e6; } };
  coach?.stop();
  coach = new VoiceCoach({
    onState: setState, onTranscript: addTranscript,
    onTool: (name, args) => {
      if (name === "show_sentence") { target = { text: args.text_de, en: args.en }; result = null; mine = null; draw(); return { shown: true }; }
      if (name === "end_practice") { addTranscript("Coach", args.summary); toast("Practice finished", 3000); if (inBlock) $("#nx")?.focus(); return { ok: true }; }
      return { error: "unknown tool" };
    },
  });

  // ---------- drawing ----------
  const btn = (id, k, label) => `<button class="btn" id="${id}"><kbd>${k}</kbd> ${label}</button>`;
  const draw = () => {
    const st = $("#stage"); if (!st) return;
    if (!target) st.innerHTML = `<p class="muted">Waiting for the coach to pick a sentence… or just hold Space and talk.</p>`;
    else st.innerHTML = `
      ${!coach.active && targets[t] === target ? `<div class="muted mono">${t + 1} / ${targets.length}</div>` : ""}
      <div class="target" lang="de">${result?.words?.length ? result.words.map(w => `<span class="tw ${w.status === "ok" ? "ok" : w.status === "uncertain" ? "unc" : "err"}">${esc(w.word)}</span>`).join(" ") : esc(target.text)}</div>
      <p class="muted" style="margin:4px 0 12px">${esc(target.en || "")}</p>
      <div class="row">${btn("listen", "L", "Hear it")}
        ${mine ? btn("mine", "R", "Hear me") + btn("compare", "C", "Me, then native") : ""}
        ${busy ? `<span class="muted">Checking sounds…</span>` : ""}
        ${result?.score != null ? `<span class="score"><b>${Math.round(result.score * 100)}%</b> <span class="muted">of sounds matched</span></span>${btn("sounds", "S", `${showSounds ? "Hide" : "Show"} sounds`)}` : ""}</div>
      ${result?.words?.length && showSounds ? `<div class="phones" style="margin-top:16px">${result.words.map(w => `<div class="pw"><span class="lbl">${esc(w.word)}</span><span>${(w.phones || []).map(p =>
        `<span class="ph ${p.status}" title="${esc(p.status)}">${esc(p.expected || p.heard)}${p.status === "substituted" ? `<small>${esc(p.heard)}</small>` : p.status === "missing" ? "<small>∅</small>" : ""}</span>`).join("")}</span></div>`).join("")}</div>
        <p class="muted" style="font-size:13px">Red: a different sound was heard (shown below it) or the sound was missing. Yellow: the two recognizers disagree, so treat it as a maybe.</p>` : ""}`;
    const on = (id, f) => { const b = $("#" + id); if (b) b.onclick = f; };
    on("listen", hear); on("mine", hearMine); on("compare", compare);
    on("sounds", () => { showSounds = !showSounds; draw(); });
    drawSide();
  };
  // The quick actions next to the talk button, the sentence list and the footer keys depend on whether the coach runs.
  const drawSide = () => {
    const asks = $("#asks"); if (!asks) return;
    const c = state !== "off";
    $("#hint").textContent = !c ? "Coach is off: hold Space, say the sentence, release to see which sounds matched."
      : state === "connecting" ? "Connecting to the coach…"
      : "Hold Space to answer the coach; it stops talking while you speak. You can also just ask it something.";
    asks.innerHTML = c
      ? `<button class="btn" data-a="again"><kbd>A</kbd> Again, slowly</button><button class="btn" data-a="easier"><kbd>E</kbd> Easier</button><button class="btn" data-a="next"><kbd>→</kbd> Next</button><button class="btn" data-a="pick"><kbd>P</kbd> Choose sentence</button>`
      : `<button class="btn" data-a="prev"><kbd>←</kbd> Previous</button><button class="btn" data-a="next"><kbd>→</kbd> Next</button><button class="btn" data-a="again"><kbd>A</kbd> Hear it slowly</button><button class="btn" data-a="pick"><kbd>P</kbd> Choose sentence</button>`;
    $$("button", asks).forEach(b => { b.onclick = () => act(b.dataset.a); b.disabled = c && !live() && b.dataset.a !== "pick"; });
    const pk = $("#picker"); pk.hidden = !picking;
    if (picking && !pk.dataset.drawn) {
      pk.dataset.drawn = "1";
      pk.innerHTML = `<h2>Choose a sentence from the text</h2><div class="choices">${choices.map((x, i) => `<button data-i="${i}"><span lang="de">${esc(x.text)}</span> <span class="muted">${esc(x.en || "")}</span></button>`).join("")}</div>`;
      $$("button", pk).forEach(b => b.onclick = () => choose(choices[+b.dataset.i]));
    }
    keys([["hold Space", c ? "talk / interrupt" : "talk"], ["L", "hear it"], ...(mine ? [["R", "hear me"], ["C", "me, then native"]] : []),
      ...(result?.score != null ? [["S", "sounds"]] : []),
      ...(c ? [["A", "again, slowly"], ["E", "easier"], ["→", "next"]] : [["← →", "sentence"], ["A", "hear it slowly"]]),
      ["P", "choose sentence"], ["V", c ? "coach off" : "coach on"], ...(inBlock ? [["N", "finish"]] : [])]);
  };
  const act = a => {
    if (a === "pick") { picking = !picking; drawSide(); if (picking) $("#picker").scrollIntoView({ block: "nearest" }); return; }
    if (state !== "off") return ASKS[a] && ask(ASKS[a]);
    if (a === "next") step(1); else if (a === "prev") step(-1); else if (a === "again") hearSlow();
  };

  // ---------- talking ----------
  const talkDown = async () => {
    if (talking || busy) return;
    talking = true; stopAudio(); stopOwn();
    let stream;
    if (coach.talkStart()) stream = coach.mic;
    else {
      try { stream = ownStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false } }); }
      catch { talking = false; return fail(new Error("Microphone blocked: allow it in the browser's address bar")); }
    }
    if (!talking) { ownStream?.getTracks().forEach(tr => tr.stop()); ownStream = null; return; }  // released before the mic opened
    chunks = []; recorder = new MediaRecorder(stream); recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = analyse; recorder.start();
    $("#talk").classList.add("on");
  };
  const talkUp = () => {
    if (!talking) return;
    talking = false; $("#talk")?.classList.remove("on");
    coach.talkEnd();
    if (recorder?.state === "recording") recorder.stop();
  };
  const analyse = async () => {
    ownStream?.getTracks().forEach(tr => tr.stop()); ownStream = null; recorder = null;
    const blob = new Blob(chunks, { type: chunks[0]?.type || "audio/webm" });
    if (mine) URL.revokeObjectURL(mine);
    mine = URL.createObjectURL(blob);
    const fd = new FormData();
    fd.append("audio", blob, "a.webm"); fd.append("text_de", target?.text || ""); fd.append("item_id", item.id);
    if (target?.id) fd.append("line_id", target.id); if (ctx.block) fd.append("block_id", ctx.block.id);
    busy = true; draw();
    let r = null;
    try { r = await api("/api/pronounce", { method: "POST", body: fd }); if (target) result = r; }
    catch (e) { fail(e); }
    busy = false; draw();
    if (coach.live) coach.sendPhonetics(`Sentence on screen: ${target ? `"${target.text}"` : "none"}\n${r?.for_coach || "Phonetic analysis failed; rely on the audio."}`);
  };

  const talk = $("#talk");
  talk.onpointerdown = e => { e.preventDefault(); talkDown(); };
  talk.onpointerup = talk.onpointerleave = () => talkUp();
  // While the coach runs it chooses the sentence; without it, the text's lines are the targets.
  const startCoach = () => {
    const keep = chosen && target?.id === chosen.id;   // the learner picked this line in the reader
    if (!keep) target = null;
    result = null; mine = null; draw();
    const opening = keep ? `(The learner opened speaking practice to work on this sentence, already on screen: "${chosen.text}" (${chosen.en || ""}). Greet them in one short sentence and ask them to say it. Don't call show_sentence for it.)` : undefined;
    coach.start(item.id, opening).catch(e => { fail(e); target = targets[t] || null; draw(); });
  };
  const stopIt = () => { coach.stop(); target = targets[t] || null; result = null; mine = null; draw(); };
  $("#cbtn").onclick = () => coach.active ? stopIt() : startCoach();
  $("#nx") && ($("#nx").onclick = () => { coach.stop(); ctx.next(); });
  const step = d => { if (coach.active || !targets.length) return; t = Math.max(0, Math.min(targets.length - 1, t + d)); target = targets[t]; result = null; mine = null; draw(); };
  ui.onKey = e => {
    if (e.key === " ") { e.preventDefault(); if (!e.repeat) talkDown(); return; }
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === "l") hear();
    else if (k === "r") hearMine();
    else if (k === "c") compare();
    else if (k === "s" && result) { showSounds = !showSounds; draw(); }
    else if (k === "a") act("again");
    else if (k === "e") act("easier");
    else if (k === "p") act("pick");
    else if (e.key === "ArrowRight") act("next");
    else if (e.key === "ArrowLeft") act("prev");
    else if (e.key === "Escape" && picking) act("pick");
    else if (k === "v") $("#cbtn").click();
    else if (k === "n" && inBlock) $("#nx").click();
  };
  ui.onKeyUp = e => { if (e.key === " ") talkUp(); };
  setState("off"); startCoach();
}
