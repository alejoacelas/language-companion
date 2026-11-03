// Voice coach over OpenAI Realtime (WebRTC). The coach leads the session: it shows sentences with the
// show_sentence tool and reacts to the learner's audio plus a phone-by-phone transcription sent after each turn.
// The mic stays muted except while the learner holds the talk key.
export class VoiceCoach {
  constructor({ onState, onTranscript, onTool }) {
    this.onState = onState; this.onTranscript = onTranscript; this.onTool = onTool;
    this.pc = null; this.dc = null; this.track = null; this.mic = null; this.active = false;
    this.pendingCalls = [];
  }

  get live() { return this.dc?.readyState === "open"; }

  async start(itemId) {
    if (this.active) return;
    this.active = true; this.onState("connecting");
    try {
      const r = await fetch("/api/realtime/token" + (itemId ? `?item_id=${encodeURIComponent(itemId)}` : ""), { method: "POST" });
      if (!r.ok) throw new Error("Voice coach token: " + (await r.text()).slice(0, 200));
      const { value } = await r.json();
      const pc = new RTCPeerConnection();
      const out = new Audio(); out.autoplay = true;
      pc.ontrack = e => { out.srcObject = e.streams[0]; };
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false } });
      this.track = mic.getTracks()[0]; this.track.enabled = false;
      pc.addTrack(this.track, mic);
      const dc = pc.createDataChannel("oai-events");
      dc.onmessage = e => this.handle(JSON.parse(e.data));
      dc.onopen = () => {
        this.onState("live");
        // Let the coach open the session.
        this.say("(The learner just opened the speaking practice. Greet them in one short sentence and show the first thing to say.)");
      };
      pc.onconnectionstatechange = () => { if (["failed", "closed", "disconnected"].includes(pc.connectionState) && this.active) this.stop(); };
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      const sdp = await fetch("https://api.openai.com/v1/realtime/calls", { method: "POST", body: offer.sdp, headers: { Authorization: `Bearer ${value}`, "Content-Type": "application/sdp" } });
      if (!sdp.ok) throw new Error("Voice coach connect: " + (await sdp.text()).slice(0, 200));
      await pc.setRemoteDescription({ type: "answer", sdp: await sdp.text() });
      this.pc = pc; this.dc = dc; this.out = out; this.mic = mic;
    } catch (e) { this.stop(); throw e; }
  }

  stop() {
    this.pc?.close(); this.mic?.getTracks().forEach(t => t.stop());
    if (this.out) this.out.srcObject = null;
    this.pc = this.dc = this.track = this.mic = null; this.active = false; this.onState("off");
  }

  send(ev) { if (this.live) this.dc.send(JSON.stringify(ev)); }

  // A text message from the app to the coach, followed by a reply.
  say(text) {
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    this.send({ type: "response.create" });
  }

  handle(ev) {
    if (ev.type === "response.output_audio_transcript.done") this.onTranscript("Coach", ev.transcript);
    else if (ev.type === "conversation.item.input_audio_transcription.completed") this.onTranscript("You", ev.transcript);
    else if (ev.type === "response.created") this.onState("speaking");
    else if (ev.type === "response.function_call_arguments.done") {
      let args = {}; try { args = JSON.parse(ev.arguments || "{}"); } catch {}
      const output = this.onTool?.(ev.name, args) ?? { ok: true };
      this.pendingCalls.push({ call_id: ev.call_id, output });
    } else if (ev.type === "response.done") {
      if (this.pendingCalls.length) {
        for (const c of this.pendingCalls.splice(0))
          this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: c.call_id, output: JSON.stringify(c.output) } });
        this.send({ type: "response.create" });
      } else this.onState("live");
    } else if (ev.type === "error") console.error("realtime", ev);
  }

  // Hold to talk: interrupt the coach, stream the mic, then (on release) commit the audio.
  talkStart() {
    if (!this.track || !this.live) return false;
    this.send({ type: "response.cancel" }); this.out && (this.out.muted = true);
    this.send({ type: "input_audio_buffer.clear" }); this.track.enabled = true; this.onState("talk");
    return true;
  }
  talkEnd() {
    if (!this.track || !this.live) return;
    this.track.enabled = false; this.out && (this.out.muted = false);
    this.send({ type: "input_audio_buffer.commit" }); this.onState("thinking");
  }

  // After talkEnd: give the coach the phonetic transcription of what was just said, and let it reply.
  sendPhonetics(text) { this.say("PHONETICS\n" + text); }
}
