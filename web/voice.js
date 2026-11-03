// Voice coach over OpenAI Realtime (WebRTC). The server mints a short-lived key; the mic is muted except while T is held.
export class VoiceCoach {
  constructor({ onState, onTranscript }) {
    this.onState = onState; this.onTranscript = onTranscript;
    this.pc = null; this.dc = null; this.track = null; this.active = false;
  }

  async start() {
    if (this.active) return;
    this.active = true; this.onState("connecting");
    try {
      const r = await fetch("/api/realtime/token", { method: "POST" });
      if (!r.ok) throw new Error("Voice coach token: " + (await r.text()).slice(0, 200));
      const { value } = await r.json();
      const pc = new RTCPeerConnection();
      const out = new Audio(); out.autoplay = true;
      pc.ontrack = e => { out.srcObject = e.streams[0]; };
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.track = mic.getTracks()[0]; this.track.enabled = false;
      pc.addTrack(this.track, mic);
      const dc = pc.createDataChannel("oai-events");
      dc.onmessage = e => this.handle(JSON.parse(e.data));
      dc.onopen = () => {
        // Push-to-talk: no automatic turn detection, so recording attempts don't trigger replies.
        this.send({ type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: null } } } });
        this.onState("live");
      };
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      const sdp = await fetch("https://api.openai.com/v1/realtime/calls", { method: "POST", body: offer.sdp, headers: { Authorization: `Bearer ${value}`, "Content-Type": "application/sdp" } });
      if (!sdp.ok) throw new Error("Voice coach connect: " + (await sdp.text()).slice(0, 200));
      await pc.setRemoteDescription({ type: "answer", sdp: await sdp.text() });
      this.pc = pc; this.dc = dc; this.out = out; this.mic = mic;
    } catch (e) { this.stop(); throw e; }
  }

  stop() {
    this.pc?.close(); this.mic?.getTracks().forEach(t => t.stop());
    this.pc = this.dc = this.track = this.mic = null; this.active = false; this.onState("off");
  }

  send(ev) { if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(ev)); }

  handle(ev) {
    if (ev.type === "response.output_audio_transcript.done") this.onTranscript("Coach", ev.transcript);
    else if (ev.type === "conversation.item.input_audio_transcription.completed") this.onTranscript("You", ev.transcript);
    else if (ev.type === "error") console.error("realtime", ev);
  }

  pushToTalk(down) {
    if (!this.track || this.dc?.readyState !== "open") return;
    if (down) { this.send({ type: "response.cancel" }); this.send({ type: "input_audio_buffer.clear" }); this.track.enabled = true; this.onState("talk"); }
    else { this.track.enabled = false; this.send({ type: "input_audio_buffer.commit" }); this.send({ type: "response.create" }); this.onState("live"); }
  }

  sendAttempt(text, result) {
    if (!this.active) return;
    const words = (result.words || []).map(w => ({
      word: w.word, status: w.status,
      issues: (w.phones || []).filter(p => p.status !== "ok").map(p => ({ expected: p.expected, heard: p.heard, status: p.status })),
    }));
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user",
      content: [{ type: "input_text", text: `ATTEMPT\nTarget: "${text}"\nSounds matched: ${Math.round((result.score || 0) * 100)}%\n${JSON.stringify(words)}` }] } });
    this.send({ type: "response.create" });
  }
}
