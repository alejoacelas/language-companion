"""Self-test for the phone pipeline: synthesise correct and deliberately wrong clips with
macOS `say -v Anna`, run recognize() + compare() against the correct text, and check that the
planted errors are flagged.

    uv run python -m server.speech.selftest
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import time
from pathlib import Path

from server.speech import phonemes as ph

# (target text, what Anna actually says, browser format to encode to, phones that must be flagged)
CASES = [
    ("Das ist sehr schön.", "Das ist sehr schön.", "audio/webm", []),
    ("Das ist sehr schön.", "Das ist sehr schon.", "audio/webm", [("schön", "øː")]),
    ("Die Bücher sind grün.", "Die Bücher sind grün.", "audio/mp4", []),
    ("Die Bücher sind grün.", "Die Bucher sind grun.", "audio/mp4", [("Bücher", "yː"), ("grün", "yː")]),
    ("Ich möchte zwei Brötchen.", "Ich möchte zwei Brötchen.", "audio/wav", []),
    ("Ich möchte zwei Brötchen.", "Isch möchte zwei Brötchen.", "audio/wav", [("Ich", "ç")]),
    ("Ich möchte zwei Brötchen.", "Ich mochte zwei Brotchen.", "audio/webm", [("möchte", "œ"), ("Brötchen", "øː")]),
    ("schön", "schön", "audio/webm", []),
    ("schön", "schon", "audio/webm", [("schön", "øː")]),
]
LONG = "Guten Morgen, ich hätte gern zwei Brötchen und einen Kaffee mit Milch, bitte."

ENCODE = {
    "audio/webm": ["-c:a", "libopus", "-b:a", "48k", "-f", "webm"],
    "audio/mp4": ["-c:a", "aac", "-b:a", "96k", "-f", "ipod"],
    "audio/wav": ["-f", "wav"],
}


def make_clip(spoken: str, mime: str, tmp: Path) -> bytes:
    aiff = tmp / "clip.aiff"
    subprocess.run(["say", "-v", "Anna", "-o", str(aiff), spoken], check=True)
    out = tmp / "clip.bin"
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(aiff), "-ar", "48000",
                    *ENCODE[mime], str(out)], check=True)
    return out.read_bytes()


def flagged(result: dict, word: str, phone: str) -> str:
    """'error' if both models flag it, 'uncertain' if one does, 'missed' otherwise."""
    for w in result["words"]:
        if w["word"] != word:
            continue
        for p in w["phones"]:
            if p["expected"] != phone:
                continue
            if p["status"] in ("substituted", "missing"):
                return "error"
            if p["status"] == "uncertain":
                return "uncertain"
            return "missed"
    return "missed"


def main() -> int:
    t = ph.warm_up()
    print(f"models loaded and warmed in {t:.1f}s\n")
    caught = unsure = total = false_flags = 0
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        for target, spoken, mime, errors in CASES:
            audio = make_clip(spoken, mime, tmp)
            rec = ph.recognize(audio, mime)
            res = ph.compare(target, rec)
            label = "correct" if target.rstrip(".") == spoken.rstrip(".") else "WRONG"
            print(f"=== target {target!r}, said {spoken!r} ({label}, {mime}, {rec['duration_s']}s,"
                  f" {rec['timing_s']['total']:.2f}s)")
            print(ph.format_result(res))
            for word, phone in errors:
                verdict = flagged(res, word, phone)
                total += 1
                caught += verdict == "error"
                unsure += verdict == "uncertain"
                print(f"  check {word}/{phone}: {verdict}")
            if not errors:
                bad = [w["word"] for w in res["words"] if w["status"] == "error"]
                false_flags += len(bad)
                print(f"  check no errors: {'ok' if not bad else 'false errors in ' + ', '.join(bad)}")
            print()

        audio = make_clip(LONG, "audio/webm", tmp)
        times = []
        for _ in range(5):
            s = time.perf_counter()
            rec = ph.recognize(audio, "audio/webm")
            ph.compare(LONG, rec)
            times.append(time.perf_counter() - s)
        print(f"=== timing on a {rec['duration_s']}s webm clip, recognize+compare, 5 runs: "
              + ", ".join(f"{x:.2f}" for x in times) + f" s; last breakdown {rec['timing_s']}")

    print(f"\nplanted errors: {caught}/{total} flagged as errors, {unsure} as uncertain, "
          f"{total - caught - unsure} missed; words wrongly flagged as errors in correct clips: {false_flags}")
    return 0 if caught + unsure == total and false_flags == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
