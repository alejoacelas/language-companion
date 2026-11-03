"""Fetch official German-dub anime clips from YouTube and transcribe them.

Usage (from the repo root):
  python3 -I tools/anime_clips.py download VIDEO_ID [...]
  HF_HOME=data/models uv run --with mlx-whisper python -I tools/anime_clips.py transcribe VIDEO_ID [...]
  python3 -I tools/anime_clips.py meta VIDEO_ID [...]

Audio goes to data/media/anime/<id>.m4a, yt-dlp metadata to data/raw/anime/<id>.info.json,
and Whisper output (segments with word timestamps) to data/raw/anime/<id>.whisper.json.
The cleaned content items in data/content/ are written by hand from the Whisper output.
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MEDIA = ROOT / "data" / "media" / "anime"
RAW = ROOT / "data" / "raw" / "anime"
MODEL = "mlx-community/whisper-large-v3-mlx"


def url(vid):
    return f"https://www.youtube.com/watch?v={vid}"


def meta(vid):
    RAW.mkdir(parents=True, exist_ok=True)
    out = subprocess.run(["yt-dlp", "--dump-json", "--", url(vid)], capture_output=True, text=True, check=True).stdout
    d = json.loads(out)
    keep = {k: d.get(k) for k in ("id", "title", "channel", "channel_id", "duration", "playable_in_embed", "availability", "upload_date", "description")}
    (RAW / f"{vid}.info.json").write_text(json.dumps(keep, ensure_ascii=False, indent=2))
    print(vid, d["channel"], d["duration"], "embed:", d.get("playable_in_embed"), d["title"])


def download(vid):
    MEDIA.mkdir(parents=True, exist_ok=True)
    subprocess.run(["yt-dlp", "-x", "--audio-format", "m4a", "-o", str(MEDIA / "%(id)s.%(ext)s"), "--", url(vid)], check=True)


def transcribe(vid):
    import mlx_whisper  # only available under `uv run --with mlx-whisper`

    RAW.mkdir(parents=True, exist_ok=True)
    audio = MEDIA / f"{vid}.m4a"
    res = mlx_whisper.transcribe(str(audio), path_or_hf_repo=MODEL, language="de", word_timestamps=True,
                                 condition_on_previous_text=False)
    segs = [{k: s.get(k) for k in ("start", "end", "text", "avg_logprob", "no_speech_prob", "compression_ratio", "words")}
            for s in res["segments"]]
    (RAW / f"{vid}.whisper.json").write_text(json.dumps({"id": vid, "language": res.get("language"), "segments": segs},
                                                        ensure_ascii=False, indent=2))
    for s in segs:
        flag = "?" if (s["avg_logprob"] or 0) < -0.6 or (s["no_speech_prob"] or 0) > 0.5 else " "
        print(f"{flag} {s['start']:6.2f}-{s['end']:6.2f} {s['text'].strip()}")


def detect(vid):
    """Print the language Whisper hears, to tell German dubs from Japanese-audio clips."""
    import mlx_whisper

    res = mlx_whisper.transcribe(str(MEDIA / f"{vid}.m4a"), path_or_hf_repo=MODEL, clip_timestamps=[0, 30])
    print(vid, res.get("language"), res["text"][:120])


NAMES = {
    "kaguya": "Kaguya, Shirogane, Chika Fujiwara, Ishigami, Miko Iino, Hayasaka Ai, Schülersprecher, Fräulein Kaguya.",
    "csm": "Denji, Power, Aki, Himeno, Makima, Kobeni, Pochita, Miezi, Teufelsjäger.",
}


def lowconf(vid, threshold=0.5):
    """List words Whisper was unsure about (probability below threshold)."""
    d = json.loads((RAW / f"{vid}.whisper.json").read_text())
    for s in d["segments"]:
        weak = [f"{w['word'].strip()}({w['probability']:.2f})" for w in s.get("words") or [] if w["probability"] < threshold]
        if weak:
            print(f"{s['start']:6.2f} {s['text'].strip()}\n        weak: {' '.join(weak)}")


def recheck(vid, show, windows):
    """Re-transcribe time windows ("a-b,c-d") with character names as a prompt, as a second opinion."""
    import mlx_whisper

    for w in windows.split(","):
        a, b = (float(x) for x in w.split("-"))
        res = mlx_whisper.transcribe(str(MEDIA / f"{vid}.m4a"), path_or_hf_repo=MODEL, language="de",
                                     clip_timestamps=[a, b], initial_prompt=NAMES[show],
                                     condition_on_previous_text=False)
        for s in res["segments"]:
            print(f"  {s['start']:6.2f}-{s['end']:6.2f} {s['text'].strip()}  (logprob {s['avg_logprob']:.2f})")


if __name__ == "__main__":
    if sys.argv[1] == "recheck":
        recheck(*sys.argv[2:5])
        sys.exit()
    cmd, *ids = sys.argv[1:]
    fn = {"meta": meta, "download": download, "transcribe": transcribe, "detect": detect, "lowconf": lowconf}[cmd]
    for vid in ids:
        print(f"== {vid}", flush=True)
        fn(vid)
