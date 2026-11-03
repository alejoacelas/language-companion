// Speak: a live session led by the voice coach. Hold Space to talk; the coach hears your audio and also gets a
// phone-by-phone transcription compared with the sentence on screen, then decides what to do next.
// Without the coach (offline or turned off), you can still step through the text's lines and get the comparison.
import { $, api, esc, fail, keys, playTTS, stopAudio, toast, ui } from "/lib.js";
import { VoiceCoach } from "/voice.js";

const STATE_LABEL = { off: "Coach off", connecting: "Connecting…", live: "Coach listening", speaking: "Coach speaking", talk: "Listening to you…", thinking: "Coach thinking…" };
let coach = null;
export function stopCoach() { coach?.stop(); }

function defaultTargets(item) {
  const de = (item.lines || []).filter(l => l.lang === "de" && !l.uncertain);
  const n = l => l.text.split(/\s+/).length;
  const good = de.filter(l => n(l) <= 10 && (item.kind === "lesson" || n(l) >= 2));
  const pool = good.length >= 3 ? good : de;
  const k = Math.min(8, pool.length), out = [];
  for (let i = 0; i < k; i++) out.push({ text: pool[Math.floor(i * pool.length / k)].text, en: pool[Math.floor(i * pool.length / k)].en, id: pool[Math.floor(i * pool.length / k)].id });
  return out;
}

export function showSpeak(view, item, ctx) {
  if (!item) return;
  const inBlock = !!ctx.block;
  const targets = defaultTargets(item);
  let t = 0, target = targets[0] || null, result = null, showSounds = false;
  let recorder = null, ownStream = null, chunks = [], busy = false, talking = false;

  view.innerHTML = `<div class="speak">
    <div class="row" style="justify-content:space-between"><h1>Say it</h1>
      <div class="coach"><span class="dot" id="coachdot"></span><span id="coachlbl">Coach off</span><button class="btn" id="cbtn">Turn coach on <kbd>V</kbd></button></div></div>
    <div class="card" id="stage"></div>
    <div class="talkrow"><button class="talk" id="talk"><span>Hold to talk</span><kbd>Space</kbd></button>
      <span class="muted" id="hint">The coach leads: hold Space and speak, release when done. You can also just ask it something.</span></div>
    <div class="transcript card" id="transcript"></div>
    <div class="row">${inBlock ? `<button class="btn primary" id="nx">Finish: wrap up <kbd>N</kbd></button>` : `<a class="btn" href="#read/${esc(item.id)}">Back to text</a>`}</div>
  </div>`;

  const setState = s => {
    const d = $("#coachdot"), l = $("#coachlbl"), b = $("#cbtn");
    if (!d) return;
    if (s === "off" && !target && targets.length) { target = targets[t]; result = null; setTimeout(draw); }
    d.className = "dot " + s; l.textContent = STATE_LABEL[s] || s;
    b.innerHTML = s === "off" ? `Turn coach on <kbd>V</kbd>` : `Turn coach off <kbd>V</kbd>`;
    $("#hint").textContent = s === "off" ? "Coach is off: hold Space to say the sentence and see which sounds matched. ← → change sentence." : "The coach leads: hold Space and speak, release when done. You can also just ask it something.";
  };
  const addTranscript = (who, text) => { const tr = $("#transcript"); if (tr && text) { tr.insertAdjacentHTML("beforeend", `<div><b>${who}:</b> ${esc(text)}</div>`); tr.scrollTop = 1e6; } };
  coach?.stop();
  coach = new VoiceCoach({
    onState: setState, onTranscript: addTranscript,
    onTool: (name, args) => {
      if (name === "show_sentence") { target = { text: args.text_de, en: args.en }; result = null; draw(); return { shown: true }; }
      if (name === "end_practice") { addTranscript("Coach", args.summary); toast("Practice finished", 3000); if (inBlock) $("#nx")?.focus(); return { ok: true }; }
      return { error: "unknown tool" };
    },
  });

  const draw = () => {
    const st = $("#stage"); if (!st) return;
    if (!target) { st.innerHTML = `<p class="muted">Waiting for the coach to pick a sentence… or just hold Space and talk.</p>`; return; }
    st.innerHTML = `
      ${coach.active ? "" : `<div class="muted mono">${t + 1} / ${targets.length}</div>`}
      <div class="target" lang="de">${result?.words?.length ? result.words.map(w => `<span class="tw ${w.status === "ok" ? "ok" : w.status === "uncertain" ? "unc" : "err"}">${esc(w.word)}</span>`).join(" ") : esc(target.text)}</div>
      <p class="muted" style="margin:4px 0 12px">${esc(target.en || "")}</p>
      <div class="row"><button class="btn" id="listen"><kbd>L</kbd> Hear it</button>
        ${busy ? `<span class="muted">Checking sounds…</span>` : ""}
        ${result?.score != null ? `<span style="font:600 22px var(--serif)">${Math.round(result.score * 100)}%</span><span class="muted">of sounds matched</span><button class="btn" id="sounds"><kbd>S</kbd> ${showSounds ? "Hide" : "Show"} sounds</button>` : ""}</div>
      ${result?.words?.length && showSounds ? `<div class="phones" style="margin-top:16px">${result.words.map(w => `<div class="pw"><span class="lbl">${esc(w.word)}</span><span>${(w.phones || []).map(p =>
        `<span class="ph ${p.status}" title="${esc(p.status)}">${esc(p.expected || p.heard)}${p.status === "substituted" ? `<small>${esc(p.heard)}</small>` : p.status === "missing" ? "<small>∅</small>" : ""}</span>`).join("")}</span></div>`).join("")}</div>
        <p class="muted" style="font-size:13px">Red: a different sound was heard (shown below it) or the sound was missing. Yellow: the two recognizers disagree, so treat it as a maybe.</p>` : ""}`;
    $("#listen").onclick = () => playTTS(target.text);
    $("#sounds") && ($("#sounds").onclick = () => { showSounds = !showSounds; draw(); });
  };

  const talkDown = async () => {
    if (talking || busy) return;
    talking = true; stopAudio();
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
  const startCoach = () => { target = null; result = null; draw(); coach.start(item.id).catch(e => { fail(e); target = targets[t] || null; draw(); }); };
  const stopIt = () => { coach.stop(); target = targets[t] || null; result = null; draw(); };
  $("#cbtn").onclick = () => coach.active ? stopIt() : startCoach();
  $("#nx") && ($("#nx").onclick = () => { coach.stop(); ctx.next(); });
  const step = d => { if (coach.active || !targets.length) return; t = Math.max(0, Math.min(targets.length - 1, t + d)); target = targets[t]; result = null; draw(); };
  keys([["hold Space", "talk"], ["L", "hear the sentence"], ["S", "show sounds"], ["V", "coach on/off"], ["← →", "sentence (coach off)"], ...(inBlock ? [["N", "next step"]] : [])]);
  ui.onKey = e => {
    if (e.key === " ") { e.preventDefault(); if (!e.repeat) talkDown(); return; }
    if (e.repeat) return;
    if (e.key === "l" && target) playTTS(target.text);
    else if (e.key === "s" && result) { showSounds = !showSounds; draw(); }
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "v") $("#cbtn").click();
    else if (e.key === "n" && inBlock) $("#nx").click();
  };
  ui.onKeyUp = e => { if (e.key === " ") talkUp(); };
  setState("off"); startCoach();
}
