"""Compare speech-to-text models on German learner sentences with deliberate mistakes.

Run: uv run python research/speech-test/run.py            (OpenAI models)
     uv run --with mlx-whisper python research/speech-test/run.py --local   (adds local mlx-whisper)

Clips and raw results go to data/speech-test/ (git-ignored). Prints a summary table.
"""

import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "speech-test"
OUT.mkdir(parents=True, exist_ok=True)
load_dotenv(ROOT / ".env")
client = OpenAI()

# (sentence as spoken, error markers that must survive verbatim, context = the tutor's question)
SENTENCES = [
    ("Gestern ich habe ins Kino gegangen.", ["gestern ich habe", "habe ins kino gegangen"], "Was hast du gestern gemacht?"),
    ("Ich habe die Popcorn gegessen.", ["die popcorn"], "Was hast du im Kino gegessen?"),
    ("Wir sind nach Berlin gefahrt.", ["gefahrt"], "Wohin seid ihr gefahren?"),
    ("Ich bin mit der Zug gekommen.", ["mit der zug"], "Wie bist du gekommen?"),
    ("Ich habe nach Hause gelauft.", ["ich habe nach hause", "gelauft"], "Wie bist du nach Hause gekommen?"),
    ("Ich gebe der Buch zu meinem Bruder.", ["der buch", "zu meinem bruder"], "Was machst du mit dem Buch?"),
    ("Weil ich bin müde, ich gehe schlafen.", ["weil ich bin müde", "ich gehe schlafen"], "Warum gehst du schon schlafen?"),
    ("Das Mädchen ist sehr schöne.", ["sehr schöne"], "Wie ist das Mädchen?"),
    ("Ich warte auf mein Freund seit zwei Stunden.", ["auf mein freund"], "Auf wen wartest du?"),
    ("Er hat das Fenster geöffnet und dann ist er gegeht.", ["gegeht"], "Was hat er gemacht?"),
    ("Morgen ich fahre mit meine Mutter nach München.", ["morgen ich fahre", "mit meine mutter"], "Was machst du morgen?"),
    ("Am Wochenende habe ich meine Großeltern besucht.", [], "Was hast du am Wochenende gemacht?"),
    ("Ich trinke jeden Morgen einen Kaffee mit Milch.", [], "Was trinkst du am Morgen?"),
]

VOICES = ["coral", "ash", "sage", "verse", "nova", "onyx", "ballad"]
ACCENT = (
    "You are an adult beginner learning German whose native language is Spanish. "
    "Speak with a clear Spanish accent, a little slowly and hesitantly, like a learner. "
    "Read the text exactly as written, word for word, including its grammar mistakes. Never correct it."
)
VERBATIM = (
    "Transcribe verbatim. The speaker is a German learner; do not correct grammar or word choice."
)
MODELS = ["whisper-1", "gpt-4o-mini-transcribe", "gpt-4o-transcribe", "gpt-transcribe"]


def norm(s: str) -> str:
    s = s.lower().replace("ß", "ss")
    s = re.sub(r"[^\w\s]", " ", s)
    return " ".join(s.split())


def word_errors(ref: str, hyp: str) -> int:
    a, b = norm(ref).split(), norm(hyp).split()
    d = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(b) + 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] != b[j - 1]))
    return d[len(b)]


def make_clips() -> list[dict]:
    clips = []
    for i, (text, markers, ctx) in enumerate(SENTENCES):
        for accent in (False, True):
            voice = VOICES[(i + 3 * accent) % len(VOICES)]
            path = OUT / f"s{i:02d}-{'es' if accent else 'de'}-{voice}.mp3"
            if not path.exists():
                kw = {"instructions": ACCENT} if accent else {
                    "instructions": "Speak natural, clear German at a normal pace. Read the text exactly as written."
                }
                r = client.audio.speech.create(model="gpt-4o-mini-tts", voice=voice, input=text, response_format="mp3", **kw)
                path.write_bytes(r.content)
            clips.append({"i": i, "text": text, "markers": markers, "ctx": ctx, "accent": accent, "path": path})
    return clips


def openai_stt(model: str, path: Path, prompt: str | None) -> str:
    kw = {"prompt": prompt} if prompt else {}
    with path.open("rb") as f:
        r = client.audio.transcriptions.create(model=model, file=f, language="de", **kw)
    return r.text


_mlx = None


def local_stt(path: Path, prompt: str | None) -> str:
    global _mlx
    import mlx_whisper

    _mlx = mlx_whisper
    r = mlx_whisper.transcribe(
        str(path), path_or_hf_repo="mlx-community/whisper-large-v3-turbo", language="de",
        initial_prompt=prompt, condition_on_previous_text=False,
    )
    return r["text"].strip()


def prompts(ctx: str) -> dict[str, str | None]:
    return {"none": None, "verbatim": VERBATIM, "verbatim+context": f"{VERBATIM} The tutor just asked: {ctx}"}


def run_one(job):
    model, cond, prompt, clip = job
    t = time.perf_counter()
    for attempt in range(3):
        try:
            hyp = local_stt(clip["path"], prompt) if model == "mlx-whisper-turbo" else openai_stt(model, clip["path"], prompt)
            break
        except Exception as e:  # report failures in the results instead of crashing the batch
            hyp = f"<error {type(e).__name__}: {e}>"
            time.sleep(2)
    return {
        "model": model, "cond": cond, "clip": clip["path"].name, "accent": clip["accent"], "ref": clip["text"],
        "hyp": hyp, "secs": time.perf_counter() - t,
        "kept": sum(m in norm(hyp) for m in map(norm, clip["markers"])), "markers": len(clip["markers"]),
        "exact": norm(hyp) == norm(clip["text"]), "wer_words": word_errors(clip["text"], hyp),
    }


def main():
    clips = make_clips()
    jobs = [(m, c, p, clip) for m in MODELS for clip in clips for c, p in prompts(clip["ctx"]).items()]
    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(run_one, jobs))
    if "--local" in sys.argv:
        local_stt(clips[0]["path"], None)  # load the model before timing
        results += [run_one(("mlx-whisper-turbo", c, p, clip)) for clip in clips for c, p in prompts(clip["ctx"]).items()]
    (OUT / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=1))

    print(f"{'model':24} {'prompt':17} {'markers kept':>13} {'exact':>7} {'word errs':>9} {'median s':>8}")
    for key in dict.fromkeys((r["model"], r["cond"]) for r in results):
        rs = [r for r in results if (r["model"], r["cond"]) == key]
        kept, tot = sum(r["kept"] for r in rs), sum(r["markers"] for r in rs)
        secs = sorted(r["secs"] for r in rs)[len(rs) // 2]
        print(f"{key[0]:24} {key[1]:17} {kept:>6}/{tot:<6} {sum(r['exact'] for r in rs):>3}/{len(rs):<3} "
              f"{sum(r['wer_words'] for r in rs):>9} {secs:>8.2f}")


if __name__ == "__main__":
    main()
