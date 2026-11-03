"""Text-to-speech with an on-disk cache.

    speak(text, lang="de", voice=None) -> Path to a WAV file in data/tts-cache/

Engines:
  kokoro  (default) Kokoro-82M German fine-tune "Thorsten-Voice/Kokoro", local, CPU, ~0.4 s per sentence.
  openai  gpt-4o-mini-tts (needs OPENAI_API_KEY in .env), ~1.2 s per sentence over the network.

Pick the engine with the TTS_ENGINE environment variable or by passing voice="openai:coral".
`voice` is "<engine>:<voice name>" or just a voice name for the default engine.
Why Kokoro (2026-11-03 comparison on 3 German sentences; samples in data/tts-samples/):
Whisper round-trip WER 0, UTMOS 3.76, 0.38 s/sentence, 330 MB, Apache-2.0, native German speaker.
Qwen3-TTS 1.7B, Audio8 0.6B and Voxtral 4B scored higher on UTMOS (4.2-4.3) but take 4-18 s per
sentence; Piper thorsten is 0.06 s but flatter (UTMOS 3.4); XTTS-v2 and Chatterbox invented words;
OpenAI coral scored 4.25. UTMOS is English-trained and rated real Thorsten recordings only 3.28, so
listen rather than trust it. Skipped as over 8 GB: KugelAudio 7B, Fish Audio Drama 3.
"""

from __future__ import annotations

import hashlib
import os
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
os.environ.setdefault("HF_HOME", str(ROOT / "data" / "models"))
CACHE = ROOT / "data" / "tts-cache"

DEFAULT_ENGINE = os.environ.get("TTS_ENGINE", "kokoro")
DEFAULT_VOICES = {"kokoro": "thorsten", "openai": "coral"}
OPENAI_MODEL = "gpt-4o-mini-tts"
OPENAI_INSTRUCTIONS = {
    "de": "Speak natural, clear standard German (Hochdeutsch) with native pronunciation, at a calm, normal pace.",
    "en": "Speak clearly and warmly at a calm, normal pace.",
}

KOKORO_REPO = "Thorsten-Voice/Kokoro"
KOKORO_BASE = "hexgrad/Kokoro-82M"
KOKORO_RATE = 24000

_lock = threading.Lock()
_kokoro: dict = {}


def _parse_voice(voice: str | None) -> tuple[str, str]:
    if voice and ":" in voice:
        engine, name = voice.split(":", 1)
    else:
        engine, name = DEFAULT_ENGINE, voice
    if engine not in DEFAULT_VOICES:
        raise ValueError(f"unknown TTS engine {engine!r}; use one of {sorted(DEFAULT_VOICES)}")
    return engine, name or DEFAULT_VOICES[engine]


def _load_kokoro(voice: str):
    with _lock:
        if "pipe" not in _kokoro:
            import torch
            from huggingface_hub import hf_hub_download
            from kokoro import KModel, KPipeline

            model = KModel(repo_id=KOKORO_BASE, config=hf_hub_download(KOKORO_REPO, "config.json"),
                           model=hf_hub_download(KOKORO_REPO, "model.pth")).to("cpu").eval()
            pipe = KPipeline(lang_code="d", repo_id=KOKORO_BASE, model=model)
            g2p = pipe.g2p

            def g2p_fixed(text):  # Kokoro's vocabulary has 'y' but no short ü 'ʏ' (per the model card)
                ph, tokens = g2p(text)
                return ph.replace("ʏ", "y"), tokens

            pipe.g2p = g2p_fixed
            _kokoro.update(pipe=pipe, voices={}, torch=torch, hf=hf_hub_download)
        if voice not in _kokoro["voices"]:
            path = _kokoro["hf"](KOKORO_REPO, f"voices/{voice}.pt")
            _kokoro["voices"][voice] = _kokoro["torch"].load(path, map_location="cpu", weights_only=True)
        return _kokoro["pipe"], _kokoro["voices"][voice]


def _kokoro_speak(text: str, lang: str, voice: str, speed: float, out: Path) -> None:
    if lang != "de":
        raise ValueError("the local Kokoro voice is German only; use voice='openai:<name>' for other languages")
    import numpy as np
    import soundfile as sf

    pipe, pack = _load_kokoro(voice)
    with _lock:  # the pipeline isn't documented as thread-safe
        chunks = [np.asarray(a) for _, _, a in pipe(text, voice=pack, speed=speed)]
    sf.write(out, np.concatenate(chunks), KOKORO_RATE)


def _openai_speak(text: str, lang: str, voice: str, speed: float, out: Path) -> None:
    from dotenv import load_dotenv
    from openai import OpenAI

    load_dotenv(ROOT / ".env")
    instructions = OPENAI_INSTRUCTIONS.get(lang, OPENAI_INSTRUCTIONS["en"])
    if speed < 1:
        instructions += " Speak slowly, for a beginner."
    resp = OpenAI().audio.speech.create(model=OPENAI_MODEL, voice=voice, input=text,
                                        response_format="wav", instructions=instructions)
    out.write_bytes(resp.read())


def speak(text: str, lang: str = "de", voice: str | None = None, speed: float = 1.0) -> Path:
    """Return the path of a WAV file saying `text`, generating it on first request.

    Cached in data/tts-cache/ by a hash of engine, voice, language, speed and text.
    """
    engine, name = _parse_voice(voice)
    key = hashlib.sha256(f"{engine}|{name}|{lang}|{speed}|{text}".encode()).hexdigest()[:24]
    out = CACHE / f"{key}.wav"
    if out.exists():
        return out
    CACHE.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp.wav")
    (_kokoro_speak if engine == "kokoro" else _openai_speak)(text, lang, name, speed, tmp)
    tmp.replace(out)
    return out


def warm_up() -> None:
    """Load the default local model so the first real request is fast."""
    if DEFAULT_ENGINE == "kokoro":
        _load_kokoro(DEFAULT_VOICES["kokoro"])
