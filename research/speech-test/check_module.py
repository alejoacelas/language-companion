"""Exercise server/speech.py end to end: TTS voices and speed, round-trip latency, podcast segments.

Run: uv run python research/speech-test/check_module.py
"""

import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from server import speech  # noqa: E402

OUT = ROOT / "data" / "speech-test"
REPLY = "Super! Und welchen Film hast du gestern im Kino gesehen?"

# 1. TTS: voices, slow mode, cache hit
for voice, slow in [("tutor", False), ("tutor", True), ("narrator", False)]:
    t = time.perf_counter()
    f = speech.speak(REPLY + f" ({voice}{' slow' if slow else ''})", voice, slow)
    print(f"speak {voice:8} slow={slow!s:5} {time.perf_counter() - t:5.2f}s  {speech._duration(speech.AUDIO / f):.1f}s audio  {f}")
t = time.perf_counter()
speech.speak(REPLY + " (tutor)", "tutor")
print(f"cache hit {time.perf_counter() - t:.3f}s")

# 2. Round trip: a ~4 s learner clip as browser webm/opus, then a 1-sentence reply (uncached)
src = OUT / "s00-es-verse.mp3"
webm = OUT / "roundtrip.webm"
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-c:a", "libopus", str(webm)], check=True)
print(f"clip length {speech._duration(src):.1f}s")
for n in range(3):
    t0 = time.perf_counter()
    text = speech.transcribe(webm.read_bytes(), "audio/webm;codecs=opus", context="Was hast du gestern gemacht?")
    t1 = time.perf_counter()
    speech.speak(f"Ah, du bist ins Kino gegangen! Was hast du gesehen? ({n} {time.time()})")
    t2 = time.perf_counter()
    print(f"round trip {n}: transcribe {t1 - t0:.2f}s + speak {t2 - t1:.2f}s = {t2 - t0:.2f}s  -> {text!r}")

# 3. Segments
fname, timings = speech.speak_segments([("narrator", "Es war einmal ein kleiner Hund."), ("tutor", "Wie heißt der Hund?")])
print("speak_segments", fname, timings)

# 4. Podcast: force small chunks to exercise splitting
pod = OUT / "podcast" / "dw-lgn.mp3"
if pod.exists():
    speech.CHUNK_SECONDS = 240
    t = time.perf_counter()
    segs = speech.transcribe_segments(pod)
    print(f"podcast {speech._duration(pod):.0f}s -> {len(segs)} sentences in {time.perf_counter() - t:.1f}s")
    for s in segs[:6] + segs[len(segs) // 2 - 3: len(segs) // 2 + 3]:
        print(f"  {s['start']:7.2f}-{s['end']:7.2f} {s['text']}")
