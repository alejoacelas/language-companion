"""Speech layer: learner speech to text, German text to speech, podcast transcripts.

Model choices and test results are in docs/speech-choice.md.
"""

import hashlib
import json
import re
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

ROOT = Path(__file__).resolve().parent.parent
AUDIO = ROOT / "data" / "audio"
load_dotenv(ROOT / ".env")

STT_MODEL = "gpt-4o-transcribe"
PODCAST_MODEL = "whisper-1"  # the only OpenAI model that returns timestamps
TTS_MODEL = "gpt-4o-mini-tts"

# The verbatim prompt raised error preservation from 21/32 to 28/32 in research/speech-test/run.py.
VERBATIM = "Transcribe verbatim. The speaker is a German learner; do not correct grammar or word choice."

VOICES = {
    "tutor": ("marin", "Speak German like a warm, friendly tutor talking to a beginner. Clear, natural pronunciation."),
    "narrator": ("cedar", "Speak like a calm storyteller reading aloud. Clear, natural pronunciation."),
}
SLOW = " Speak slowly, with short pauses between phrases, but keep natural intonation."
SLOW_SPEED = 0.8

_client = None


def client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI()
    return _client


def transcribe(audio: bytes, mime: str, context: str | None = None) -> str:
    """German speech to text that keeps the learner's grammar mistakes as spoken.

    `context` (e.g. the tutor's last question) is appended to the prompt; tests showed it does not cause corrections.
    """
    ext = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav",
           "audio/x-wav": "wav", "audio/mp4": "m4a", "audio/m4a": "m4a", "audio/x-m4a": "m4a"}.get(mime.split(";")[0], "webm")
    prompt = VERBATIM + (f" The tutor just asked: {context}" if context else "")
    r = client().audio.transcriptions.create(
        model=STT_MODEL, file=(f"speech.{ext}", audio, mime), language="de", prompt=prompt, temperature=0,
    )
    return r.text.strip()


def _voice(voice: str) -> tuple[str, str]:
    if voice not in VOICES:
        raise ValueError(f"unknown voice {voice!r}; use one of {list(VOICES)}")
    return VOICES[voice]


def speak(text: str, voice: str = "tutor", slow: bool = False) -> str:
    """German text to an mp3 in data/audio/. Returns the file name; identical requests reuse the cached file."""
    name, instructions = _voice(voice)
    key = json.dumps([text, voice, slow, TTS_MODEL, name, instructions, SLOW if slow else ""], ensure_ascii=False)
    fname = hashlib.sha256(key.encode()).hexdigest()[:24] + ".mp3"
    path = AUDIO / fname
    if not path.exists():
        AUDIO.mkdir(parents=True, exist_ok=True)
        r = client().audio.speech.create(
            model=TTS_MODEL, voice=name, input=text, response_format="mp3",
            instructions=instructions + (SLOW if slow else ""), speed=SLOW_SPEED if slow else 1.0,
        )
        tmp = path.with_suffix(".part")
        tmp.write_bytes(r.content)
        tmp.rename(path)
    return fname


def _duration(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True, check=True)
    return float(out.stdout)


def speak_segments(segments: list[tuple[str, str]], slow: bool = False) -> tuple[str, list[dict]]:
    """Speak (voice, text) pairs into one mp3. Returns (file name, [{voice, text, start, end}]) with times in seconds."""
    with ThreadPoolExecutor(4) as ex:
        parts = list(ex.map(lambda s: speak(s[1], s[0], slow), segments))
    key = json.dumps(parts)
    fname = "seg-" + hashlib.sha256(key.encode()).hexdigest()[:24] + ".mp3"
    path = AUDIO / fname
    timings, t = [], 0.0
    for (voice, text), part in zip(segments, parts):
        d = _duration(AUDIO / part)
        timings.append({"voice": voice, "text": text, "start": round(t, 2), "end": round(t + d, 2)})
        t += d
    if not path.exists():
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
            f.writelines(f"file '{AUDIO / p}'\n" for p in parts)
        # Re-encode so the joined file has one consistent stream; durations above come from the parts.
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", f.name,
                        "-c:a", "libmp3lame", "-b:a", "128k", str(path.with_suffix(".part.mp3"))], check=True)
        path.with_suffix(".part.mp3").rename(path)
        Path(f.name).unlink()
    return fname, timings


# ---- podcasts -------------------------------------------------------------

CHUNK_SECONDS = 600  # each upload stays well under the 25 MB API limit at 48 kbps mono


def _cut_points(path: Path, total: float) -> list[float]:
    """Cut near every CHUNK_SECONDS, at the middle of the nearest silence, so sentences are rarely split."""
    out = subprocess.run(["ffmpeg", "-v", "info", "-i", str(path), "-af", "silencedetect=n=-30dB:d=0.3", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", out)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", out)]
    mids = [(s + e) / 2 for s, e in zip(starts, ends)]
    cuts, target = [], CHUNK_SECONDS
    while target < total - 60:
        near = [m for m in mids if abs(m - target) < 60]
        cuts.append(min(near, key=lambda m: abs(m - target)) if near else target)
        target = cuts[-1] + CHUNK_SECONDS
    return cuts


# A sentence ends at . ! ? … (optionally followed by a closing quote), but not at a German ordinal like "10." in
# "10. November".
SENTENCE_END = r"(?<![\s(]\d)(?<![\s(]\d\d)[.!?…][\"»“]?"


def _split_sentences(seg_text: str, start: float, end: float) -> list[dict]:
    """Split one whisper segment into sentences; times inside a segment are interpolated by character count."""
    text = seg_text.strip()
    cuts = [m.end() for m in re.finditer(SENTENCE_END + r"\s+", text)]
    parts = [p.strip() for p in (text[a:b] for a, b in zip([0, *cuts], [*cuts, len(text)])) if p.strip()]
    total = sum(len(p) for p in parts) or 1
    out, t = [], start
    for p in parts:
        d = (end - start) * len(p) / total
        out.append({"text": p, "start": t, "end": t + d})
        t += d
    return out


def transcribe_segments(path: Path) -> list[dict]:
    """Transcribe a podcast episode into sentence-level segments [{text, start, end}] (seconds)."""
    path = Path(path)
    total = _duration(path)
    bounds = [0.0, *_cut_points(path, total), total]
    with tempfile.TemporaryDirectory() as tmp:
        chunks = []
        for i, (a, b) in enumerate(zip(bounds, bounds[1:])):
            out = Path(tmp) / f"{i}.mp3"
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(a), "-t", str(b - a), "-i", str(path),
                            "-ac", "1", "-ar", "16000", "-b:a", "48k", str(out)], check=True)
            chunks.append((a, out))

        def run(chunk):
            offset, p = chunk
            with p.open("rb") as f:
                r = client().audio.transcriptions.create(model=PODCAST_MODEL, file=f, language="de",
                                                         response_format="verbose_json", timestamp_granularities=["segment"])
            return [(s.text, s.start + offset, s.end + offset) for s in r.segments]

        with ThreadPoolExecutor(4) as ex:
            raw = [s for chunk in ex.map(run, chunks) for s in chunk]

    # Whisper segments break mid-sentence; join them until a sentence ends, then split multi-sentence text.
    sentences, buf = [], None
    for text, a, b in raw:
        for s in _split_sentences(text, a, b):
            buf = s if buf is None else {"text": f"{buf['text']} {s['text']}", "start": buf["start"], "end": s["end"]}
            if re.search(SENTENCE_END + "$", buf["text"]):
                sentences.append(buf)
                buf = None
    if buf:
        sentences.append(buf)
    return [{"text": s["text"], "start": round(s["start"], 2), "end": round(s["end"], 2)} for s in sentences]
