// Audio course player. Turns a lesson script into a 15-minute spoken lesson:
// opening dialogue, then teaching with graduated-interval recall (an item comes back after about 5 s, 25 s, 2 min
// and 10 min of lesson time, and sooner after a miss), then the dialogue again with the learner playing one part.
// Every answer is recorded, the end of speech is detected, and the two phoneme recognizers check it.
import { $, api, esc, fail, keys, toast } from "/shared/lib.js";
import { VoiceCoach } from "/shared/voice.js";

const INTERVALS = [5, 25, 120, 600];   // seconds of lesson time before the next recall, by recall level
const DUE_SLACK = 8;                    // an item due within this many seconds is asked now
const NEW_CUTOFF = 9.5 * 60;            // no new items after this point
const TEACH_END = 12.5 * 60;            // then the closing dialogue
const LESSON_LEN = 15 * 60;
const RECALL_PASS = 0.6;                // share of expected sounds heard for an answer to count as recalled
const MAX_COACH_BREAKS = 2;

class Stop extends Error {}

export class Lesson {
  constructor(lesson, view, { onDone }) {
    this.L = lesson; this.view = view; this.onDone = onDone;
    this.v = lesson.voices;
    this.paused = false; this.stopped = false; this.waiters = [];
    this.active = 0; this.since = null;          // lesson clock: active milliseconds, excluding pauses and coach breaks
    this.audio = null; this.abortListen = null;
    this.showText = false; this.lastDe = null; this.tipsSaid = new Set(); this.coachBreaks = 0;
    const key = id => `L${String(lesson.n).padStart(2, "0")}-${id}`;
    const mk = (d, kind, k = -1, due = 0) => ({ key: d.key || key(d.id), d, kind, k, due, recalls: 0, misses: 0, reached: -1, errStreak: 0, coached: false });
    this.items = lesson.items.map(d => mk(d, "new"));
    this.combos = (lesson.combos || []).map(d => mk(d, "combo"));
    // Earlier items start at the 2-minute level, spread over the first minutes.
    this.reviews = (lesson.review || []).map((d, i) => mk(d, "review", 2, 50 + i * 35));
    this.all = [...this.reviews, ...this.items, ...this.combos];
  }

  // ---------- clock and pause ----------
  clock() { return (this.active + (this.since ? performance.now() - this.since : 0)) / 1000; }
  run() { if (!this.since) this.since = performance.now(); }
  hold() { if (this.since) { this.active += performance.now() - this.since; this.since = null; } }
  async gate() {
    while (this.paused) await new Promise(r => this.waiters.push(r));
    if (this.stopped) throw new Stop();
  }
  setPaused(p) {
    if (p === this.paused || this.stopped) return;
    this.paused = p;
    if (p) { this.hold(); this.audio?.pause(); this.abortListen?.(); }
    else { this.run(); this.audio?.play(); this.waiters.splice(0).forEach(r => r()); }
    this.drawStatus();
  }
  stop() { this.stopped = true; this.hold(); this.audio?.pause(); this.abortListen?.(); this.coach?.stop(); this.mic?.getTracks().forEach(t => t.stop()); this.waiters.splice(0).forEach(r => r()); }

  // ---------- audio ----------
  url(text, lang, voice, speed = 1) { return `/api/tts?text=${encodeURIComponent(text)}&lang=${lang}&voice=${encodeURIComponent(voice)}&speed=${speed}`; }
  async play(text, lang, voice, speed = 1) {
    await this.gate();
    await new Promise((res, rej) => {
      const a = new Audio(this.url(text, lang, voice, speed)); this.audio = a;
      a.onended = () => { this.audio = null; res(); };
      a.onerror = () => { this.audio = null; rej(new Error("Audio failed: " + text)); };
      a.play().catch(rej);
    });
    await this.gate();
  }
  narrate(text) { this.status("narrator"); return this.play(text, "en", this.v.narrator); }
  async native(text, voice = this.v.m, speed = 1) { this.status("native"); this.lastDe = { text, voice }; await this.play(text, "de", voice, speed); }

  // ---------- microphone ----------
  async openMic() {
    this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false } });
    const ctx = new AudioContext(); const src = ctx.createMediaStreamSource(this.mic);
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 1024; src.connect(this.analyser);
  }

  // Record until the learner has spoken and gone quiet, or gave up. Pausing aborts the recording.
  listen(expectedWords = 2) {
    const waitMs = 5000 + 400 * expectedWords, maxMs = 4000 + 900 * expectedWords;
    return new Promise(res => {
      const rec = new MediaRecorder(this.mic); const chunks = [];
      rec.ondataavailable = e => chunks.push(e.data);
      const buf = new Float32Array(this.analyser.fftSize);
      let spoke = false, speechMs = 0, silentMs = 0, floor = 0, done = false;
      const t0 = performance.now();
      const finish = why => {
        if (done) return; done = true; clearInterval(iv); this.abortListen = null; this.meter(0);
        rec.onstop = () => res({ blob: new Blob(chunks, { type: rec.mimeType }), spoke: spoke && why !== "abort", aborted: why === "abort" });
        rec.stop();
      };
      this.abortListen = () => finish("abort");
      rec.start(); this.status("listen");
      const iv = setInterval(() => {
        this.analyser.getFloatTimeDomainData(buf);
        let s = 0; for (const x of buf) s += x * x; const rms = Math.sqrt(s / buf.length);
        const el = performance.now() - t0;
        if (el < 150) { floor = Math.min(0.02, Math.max(floor, rms)); return; }
        const thr = Math.max(0.012, floor * 2.5);
        if (rms > thr) { speechMs += 30; silentMs = 0; if (speechMs >= 120) spoke = true; }
        else if (spoke) silentMs += 30;
        this.meter(Math.min(1, rms / thr / 3));
        if (spoke && silentMs >= 900) finish("end");
        else if (!spoke && el > waitMs) finish("none");
        else if (el > maxMs) finish("max");
      }, 30);
    });
  }

  // Play a prompt, then record the answer. If the learner pauses while recording, the prompt is repeated after resuming.
  async ask(prompt, target) {
    for (;;) {
      await prompt();
      const r = await this.listen(target.split(/\s+/).length);
      if (r.aborted) { await this.gate(); continue; }
      return r;
    }
  }

  check(r, text, item) {
    if (!r.spoke) return Promise.resolve(null);
    const fd = new FormData();
    fd.append("audio", r.blob, "a.webm"); fd.append("text_de", text); fd.append("item_key", item?.key || ""); fd.append("lesson_n", this.L.n);
    this.status("checking");
    return api("/api/check", { method: "POST", body: fd }).catch(e => { fail(e); return null; });
  }

  // Words with a clear error: a different sound heard by both recognizers (not a near miss), or a missing sound.
  errorWords(res) {
    return (res?.words || []).map(w => ({ w, bad: (w.phones || []).filter(p => (p.status === "substituted" && !p.near) || p.status === "missing") }))
      .filter(x => x.bad.length).sort((a, b) => b.bad.length - a.bad.length);
  }

  // ---------- lesson ----------
  async start() {
    this.drawFrame();
    try {
      await this.openMic();
      this.run(); this.tick = setInterval(() => this.drawClock(), 500);
      this.run_id = (await api(`/api/lesson/${this.L.n}/start`, { method: "POST" })).run_id;
      await this.opening();
      await this.teach();
      await this.closing();
      await this.finish();
    } catch (e) { if (!(e instanceof Stop)) fail(e); }
    finally { clearInterval(this.tick); }
  }

  async opening() {
    this.phase = "Opening dialogue"; this.show({});
    await this.narrate(`Lesson ${this.L.n}. ${this.L.scenario}`);
    await this.narrate("Listen to the conversation.");
    await this.dialogue(false);
  }

  async dialogue(learnerPlays) {
    for (const line of this.L.dialogue) {
      const mine = learnerPlays && line.speaker === this.L.learner_speaker;
      if (mine) {
        this.show({ cue: line.en, de: line.de, hideDe: true, label: "Your line" });
        const r = await this.ask(() => this.narrate(`Say: ${line.en}`), line.de);
        const checking = this.check(r, line.de, null);
        this.show({ cue: line.en, de: line.de, label: "Your line" });
        await this.native(line.de, this.v[line.speaker]);
        this.show({ cue: line.en, de: line.de, label: "Your line", res: await checking });
      } else {
        // The opening is heard before anything is taught, so no translation; the closing shows it.
        this.show({ de: line.de, cue: this.phase === "Opening dialogue" ? "" : line.en, label: this.L.speakers[line.speaker], hideDe: this.phase === "Opening dialogue" && !this.showText });
        await this.native(line.de, this.v[line.speaker]);
      }
    }
  }

  ready(item) {
    if (item.kind !== "combo") return true;
    const ids = new Set(this.items.filter(i => i.k >= 0).map(i => i.d.id));
    return (item.d.uses || []).every(u => !/^i\d+$/.test(u) || ids.has(u));
  }

  async teach() {
    this.phase = "Teaching";
    const live = () => this.all.filter(i => i.k >= 0 && i.k < INTERVALS.length);
    while (this.clock() < TEACH_END) {
      const t = this.clock();
      const due = live().filter(i => i.due <= t + DUE_SLACK).sort((a, b) => a.due - b.due)[0];
      if (due) { await this.recall(due); continue; }
      if (t < NEW_CUTOFF) {
        const next = this.combos.find(i => i.k < 0 && this.ready(i)) || this.items.find(i => i.k < 0);
        if (next) { await (next.kind === "combo" ? this.introduceCombo(next) : this.introduce(next)); continue; }
      }
      // Nothing due and nothing new: bring the next item forward rather than sit in silence.
      const soonest = live().sort((a, b) => a.due - b.due)[0];
      if (!soonest) break;
      await this.recall(soonest);
    }
  }

  async repeatAfter(text, item) {
    this.show({ de: text, label: "Repeat", hideDe: !this.showText, item });
    const r = await this.ask(() => this.native(text), text);
    const res = await this.check(r, text, item);
    this.show({ de: text, label: "Repeat", res, item });
    return res;
  }

  async introduce(item) {
    const d = item.d;
    this.show({ cue: d.en, label: "New", item, hideDe: !this.showText, de: d.de });
    await this.narrate(d.intro_en);
    await this.native(d.de);
    await this.narrate("Listen and repeat.");
    const res = await this.repeatAfter(d.de, item);
    const pieces = (d.buildup || []).filter(Boolean);
    if (pieces.length > 1) {
      await this.narrate("Repeat each part after the speaker, starting at the end.");
      for (const p of pieces) await this.repeatAfter(p, item);
    } else if (this.errorWords(res).length) {
      await this.narrate("Once more.");
      await this.repeatAfter(d.de, item);
    }
    if (d.note) { this.show({ cue: d.note, label: "Note", item, de: d.de }); await this.narrate(d.note); }
    item.k = 0; item.due = this.clock() + INTERVALS[0];
  }

  // A combination is first attempted from its parts, before the learner hears it.
  async introduceCombo(item) {
    const d = item.d;
    this.show({ cue: d.cues[0], label: "Try it", item, hideDe: true, de: d.de });
    const r = await this.ask(() => this.narrate(d.cues[0]), d.de);
    const checking = this.check(r, d.de, item);
    await this.native(d.de);
    this.show({ cue: d.cues[0], label: "Try it", item, de: d.de, res: await checking });
    await this.narrate("Listen and repeat.");
    await this.repeatAfter(d.de, item);
    item.k = 0; item.due = this.clock() + INTERVALS[0];
  }

  cueFor(item) {
    const c = item.d.cues || [];
    if (item.k <= 0 || c.length < 2) return c[0];
    return c[1 + Math.floor(Math.random() * (c.length - 1))];
  }

  async recall(item) {
    const d = item.d, cue = this.cueFor(item);
    this.show({ cue, label: "Recall", item, hideDe: true, de: d.de });
    const r = await this.ask(() => this.narrate(cue), d.de);
    const checking = this.check(r, d.de, item);
    this.show({ cue, label: "Recall", item, de: d.de });
    await this.native(d.de);
    const res = await checking;
    const ok = !!res && res.recall_score >= RECALL_PASS;
    this.show({ cue, label: ok ? "Recalled" : r.spoke ? "Not quite" : "No answer heard", item, de: d.de, res });
    if (ok) {
      item.recalls++; item.k++; item.reached = Math.max(item.reached, item.k - 1);
      item.due = this.clock() + (INTERVALS[item.k] ?? Infinity);
      await this.pronFeedback(item, res);
    } else {
      item.misses++; item.errStreak = 0;
      await this.narrate("Listen and repeat.");
      await this.repeatAfter(d.de, item);
      item.k = 0; item.due = this.clock() + INTERVALS[0];
    }
    this.drawItems();
  }

  async pronFeedback(item, res) {
    const errs = this.errorWords(res);
    if (!errs.length) { item.errStreak = 0; return; }
    item.errStreak++;
    const { w, bad } = errs[0];
    const tip = (this.L.tips || []).find(t => t.phones.includes(bad[0].expected));
    if (tip && !this.tipsSaid.has(tip.id)) { this.tipsSaid.add(tip.id); this.show({ cue: tip.text, label: "Sound tip", item, de: w.word }); await this.narrate(tip.text); }
    await this.narrate("Listen again.");
    const again = await this.repeatSlow(w.word, item);
    if (!this.errorWords(again).length) item.errStreak = 0;
    if (item.errStreak >= 2 && !item.coached && this.coachBreaks < MAX_COACH_BREAKS) await this.coachBreak(item);
  }

  async repeatSlow(word, item) {
    this.show({ de: word, label: "Repeat slowly", item });
    const r = await this.ask(() => this.native(word, this.v.m, 0.8), word);
    const res = await this.check(r, word, item);
    this.show({ de: word, label: "Repeat slowly", item, res });
    return res;
  }

  // ---------- voice coach break ----------
  async coachBreak(item) {
    item.coached = true; this.coachBreaks++;
    this.hold(); this.inCoach = true;
    const panel = $("#coach"); panel.hidden = false;
    $("#coachlog").innerHTML = ""; this.coachTarget = item.d.de;
    const log = (who, text) => text && $("#coachlog").insertAdjacentHTML("beforeend", `<div><b>${who}:</b> ${esc(text)}</div>`);
    await new Promise(resolve => {
      const end = () => { this.coach?.stop(); this.coach = null; resolve(); };
      this.endCoach = end;
      this.coach = new VoiceCoach({
        onState: s => { $("#coachstate").textContent = { off: "Coach off", connecting: "Connecting…", live: "Your turn: hold T and speak", speaking: "Coach speaking", talk: "Listening…", thinking: "Coach thinking…" }[s] || s; },
        onTranscript: log,
        onTool: (name, args) => {
          if (name === "show_sentence") { this.coachTarget = args.text_de; $("#coachtarget").textContent = args.text_de; return { shown: true }; }
          if (name === "end_practice") { log("Coach", args.summary); setTimeout(end, 4000); return { ok: true }; }
          return { error: "unknown tool" };
        },
      });
      $("#coachtarget").textContent = item.d.de;
      this.coach.start(item.key).catch(e => { fail(e); end(); });
    });
    panel.hidden = true; this.inCoach = false; this.endCoach = null;
    await this.narrate("Let's go on.");
    this.run();
  }

  coachTalk(down) {
    if (!this.coach) return;
    if (down) {
      if (this.coachRec || !this.coach.talkStart()) return;
      const chunks = []; const rec = new MediaRecorder(this.coach.mic); this.coachRec = rec;
      rec.ondataavailable = e => chunks.push(e.data);
      rec.onstop = async () => {
        const fd = new FormData(); fd.append("audio", new Blob(chunks, { type: rec.mimeType }), "a.webm");
        fd.append("text_de", this.coachTarget); fd.append("lesson_n", this.L.n);
        let res = null; try { res = await api("/api/check", { method: "POST", body: fd }); } catch (e) { fail(e); }
        this.coach?.sendPhonetics(`Sentence on screen: "${this.coachTarget}"\n${res?.for_coach || "Phonetic analysis failed; rely on the audio."}`);
      };
      rec.start();
    } else if (this.coachRec) {
      this.coach.talkEnd(); this.coachRec.stop(); this.coachRec = null;
    }
  }

  // ---------- closing ----------
  async closing() {
    this.phase = "Closing dialogue";
    await this.narrate("Listen to the conversation again. This time you'll understand it.");
    await this.dialogue(false);
    await this.narrate(`Now you are the ${this.L.speakers[this.L.learner_speaker]}.`);
    await this.dialogue(true);
    await this.narrate(`That's the end of lesson ${this.L.n}.`);
  }

  async finish() {
    this.hold();
    const items = Object.fromEntries(this.all.map(i => [i.key, { introduced: i.k >= 0, recalls: i.recalls, misses: i.misses, reached: i.reached }]));
    const r = await api(`/api/lesson/${this.L.n}/finish`, { json: { run_id: this.run_id, items, seconds: Math.round(this.clock()) } });
    this.stop();
    this.onDone(r, this.all);
  }

  // ---------- drawing ----------
  drawFrame() {
    this.view.innerHTML = `<div class="lesson">
      <div class="lhead"><div><h2>Lesson ${this.L.n}</h2><h1>${esc(this.L.title)}</h1></div>
        <div class="lclock"><span id="phase"></span><b id="clk">0:00</b><span class="muted">/ 15:00</span></div></div>
      <div class="bar"><i id="bar"></i></div>
      <div class="card stage" id="stage"></div>
      <div class="statusrow"><span class="dot" id="sdot"></span><span id="stxt"></span><span class="meter"><i id="meter"></i></span></div>
      <div class="card coachpanel" id="coach" hidden><h2>Voice coach break</h2>
        <div class="target" id="coachtarget" lang="de"></div><p id="coachstate" class="muted"></p>
        <div class="transcript" id="coachlog"></div><p class="muted">Hold <kbd>T</kbd> to talk. <kbd>Esc</kbd> goes back to the lesson.</p></div>
      <div><h2>Items in this lesson</h2><div class="items" id="items"></div></div>
    </div>`;
    keys([["Space", "pause"], ["R", "hear the German again (paused)"], ["S", "show German before answering"], ["hold T", "talk to coach"], ["Esc", "end coach break"]]);
    this.drawItems();
  }
  drawClock() {
    const t = this.clock(); const m = Math.floor(t / 60), s = Math.floor(t % 60);
    $("#clk") && ($("#clk").textContent = `${m}:${String(s).padStart(2, "0")}`);
    $("#bar") && ($("#bar").style.width = `${Math.min(100, t / LESSON_LEN * 100)}%`);
    $("#phase") && ($("#phase").textContent = this.phase || "");
  }
  drawItems() {
    const el = $("#items"); if (!el) return;
    el.innerHTML = this.all.map(i => `<div class="it ${i.k < 0 ? "todo" : ""}" title="${esc(i.d.en)}">
      <span class="pips">${INTERVALS.map((_, j) => `<i class="${i.k > j ? "on" : ""}"></i>`).join("")}</span>
      <span lang="de">${i.k < 0 && !this.showText ? "…" : esc(i.d.de)}</span>
      <span class="muted">${esc(i.d.en)}</span>
      <span class="kind">${i.kind === "review" ? "review" : i.kind === "combo" ? "combo" : ""}${i.misses ? ` · ${i.misses} missed` : ""}</span></div>`).join("");
  }
  show(s) { this.cur = s; this.drawStage(); }
  drawStage() {
    const s = this.cur || {}, st = $("#stage"); if (!st) return;
    const words = s.res?.words?.length
      ? s.res.words.map(w => `<span class="tw ${this.errorWords({ words: [w] }).length ? "err" : w.status === "ok" ? "ok" : "unc"}">${esc(w.word)}</span>`).join(" ")
      : esc(s.de || "");
    const hide = s.hideDe && !this.showText;
    const bad = this.errorWords(s.res);
    st.innerHTML = `<div class="label">${esc(s.label || this.phase || "")}</div>
      ${s.cue ? `<p class="cue">${esc(s.cue)}</p>` : ""}
      ${s.de ? `<div class="target" lang="de">${hide ? `<span class="hidden-de">${"•".repeat(Math.min(24, s.de.length))}</span>` : words}</div>` : ""}
      ${s.res?.recall_score != null ? `<p class="muted">${Math.round(s.res.score * 100)}% of sounds matched${bad.length ? ` · check ${bad.map(b => `<b lang="de">${esc(b.w.word)}</b> (${b.bad.map(p => `${esc(p.expected)}→${esc(p.heard || "∅")}`).join(", ")})`).join("; ")}` : ""}</p>` : ""}`;
  }
  status(kind) { this.st = kind; this.drawStatus(); }
  drawStatus() {
    const label = this.paused ? "Paused: press Space to go on" : { narrator: "Narrator", native: "Listen", listen: "Your turn: speak now", checking: "Checking your sounds…" }[this.st] || "";
    $("#stxt") && ($("#stxt").textContent = label);
    $("#sdot") && ($("#sdot").className = "dot " + (this.paused ? "off" : this.st === "listen" ? "talk" : "live"));
  }
  meter(x) { $("#meter") && ($("#meter").style.width = `${Math.round(x * 100)}%`); }

  key(e, up) {
    if (e.key === "t" || e.key === "T") { if (this.inCoach && !e.repeat) this.coachTalk(!up); return; }
    if (up || e.repeat) return;
    if (e.key === "Escape" && this.inCoach) this.endCoach?.();
    else if (e.key === " " && !this.inCoach) { e.preventDefault(); this.setPaused(!this.paused); }
    else if ((e.key === "r" || e.key === "R") && this.paused && this.lastDe) new Audio(this.url(this.lastDe.text, "de", this.lastDe.voice)).play();
    else if (e.key === "s" || e.key === "S") { this.showText = !this.showText; this.drawStage(); this.drawItems(); toast(this.showText ? "German shown before you answer" : "German hidden until the answer", 1500); }
  }
}

