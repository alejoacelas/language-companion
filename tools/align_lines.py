"""Add per-line `start`/`end` timestamps to DW episode items from their audio.

Transcribes each episode with mlx-whisper (word timestamps, language auto-detected
because episodes mix English narration and German; plus a forced-German pass when
auto-detection picks another language, see `transcribe`), then aligns the item's lines,
in order, to the transcript's word stream with a fuzzy word-level global alignment.
Lines that match confidently get `start`/`end` (padded by PAD seconds); others are
left without times. Line text is never changed.

Idempotent and resumable: raw transcripts are cached in data/raw/align/<id>.json and
items whose lines already carry timestamps are skipped (use --force to realign).

Run:
    HF_HOME=data/models uv run --no-project --with mlx-whisper --with rapidfuzz \
        python tools/align_lines.py [ids or prefixes ...] [--force] [--show N]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import unicodedata
from pathlib import Path

import numpy as np
from rapidfuzz.distance import Levenshtein
from rapidfuzz.process import cdist

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CONTENT = DATA / "content"
RAW = DATA / "raw" / "align"
MODEL = "mlx-community/whisper-large-v3-turbo"
PREFIXES = ("harry-", "mission-berlin-", "radio-d-")

PAD = 0.15
GAP = -0.6           # alignment score for skipping a word on either side
MATCH_SIM = 0.75     # word similarity that counts as a match
MIN_COVER = 0.6      # share of a line's words that must match
MAX_SEC_PER_WORD = 2.5


def norm_words(text: str) -> list[str]:
    t = text.lower()
    for a, b in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")):
        t = t.replace(a, b)
    t = unicodedata.normalize("NFKD", t)
    t = "".join(c for c in t if not unicodedata.combining(c))
    t = re.sub(r"[’'`´]", "", t)
    t = re.sub(r"[^a-z0-9]+", " ", t)
    return t.split()


def _segments(r: dict, offset: float = 0.0) -> list[dict]:
    return [
        {
            "start": round(s["start"] + offset, 2),
            "end": round(s["end"] + offset, 2),
            "text": s["text"],
            "words": [
                {"w": w["word"], "start": round(w["start"] + offset, 2), "end": round(w["end"] + offset, 2)}
                for w in s.get("words", [])
            ],
        }
        for s in r["segments"]
    ]


def _save(cache: Path, out: dict) -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    tmp = cache.with_suffix(".tmp")
    tmp.write_text(json.dumps(out, ensure_ascii=False))
    tmp.rename(cache)


def _run(audio, language: str | None) -> dict:
    import mlx_whisper

    t0 = time.time()
    r = mlx_whisper.transcribe(
        audio, path_or_hf_repo=MODEL, word_timestamps=True,
        condition_on_previous_text=False, language=language,
    )
    return {"language": r.get("language"), "seconds": round(time.time() - t0, 1), "segments": _segments(r)}


def transcribe(item_id: str, audio: Path) -> dict:
    """Pass 1 auto-detects the language; pass 2 forces German when pass 1 did not pick it.

    Whisper detects one language from the opening 30 s. Episodes that open with
    English narration get detected as English, and whisper then translates the
    German dialogue into English instead of transcribing it. The forced-German
    pass recovers those lines; English speech still comes out as English in it.
    """
    from mlx_whisper.audio import load_audio

    cache = RAW / f"{item_id}.json"
    out = json.loads(cache.read_text()) if cache.exists() else None
    if out and (out["language"] == "de" or "de_segments" in out):
        return out
    samples = load_audio(str(audio))
    if out is None:
        out = {"model": MODEL, **_run(samples, None)}
        _save(cache, out)
    if out["language"] != "de":
        de = _run(samples, "de")
        out["de_segments"] = de["segments"]
        out["de_seconds"] = de["seconds"]
        _save(cache, out)
    return out


def word_stream(segments: list[dict]) -> list[tuple[str, float, float]]:
    """Normalised transcript tokens with times (a whisper word can split into several)."""
    out = []
    for s in segments:
        for w in s["words"]:
            for tok in norm_words(w["w"]):
                out.append((tok, w["start"], w["end"]))
    return out


def align(line_toks: list[str], tr_toks: list[str]):
    """Needleman-Wunsch over words; returns list of (i_line_tok, j_tr_tok, sim) pairs."""
    n, m = len(line_toks), len(tr_toks)
    if not n or not m:
        return []
    sim = cdist(line_toks, tr_toks, scorer=Levenshtein.normalized_similarity, dtype=np.float32)
    score = np.where(sim >= MATCH_SIM, sim, sim - 1.0)  # mismatches are penalised
    H = np.zeros((n + 1, m + 1), dtype=np.float32)
    H[0, :] = GAP * np.arange(m + 1)
    H[:, 0] = GAP * np.arange(n + 1)
    ptr = np.zeros((n + 1, m + 1), dtype=np.int8)  # 0 diag, 1 up (skip line tok), 2 left (skip tr tok)
    ptr[0, 1:] = 2
    ptr[1:, 0] = 1
    ks = np.arange(m + 1, dtype=np.float32)
    for i in range(1, n + 1):
        diag = H[i - 1, :-1] + score[i - 1]
        up = H[i - 1, 1:] + GAP
        best = np.maximum(diag, up)
        p = np.where(diag >= up, 0, 1).astype(np.int8)
        row = np.empty(m + 1, dtype=np.float32)
        row[0] = H[i, 0]
        row[1:] = best
        # horizontal gaps: H[i,j] = max_k(row[k] + GAP*(j-k)), via cumulative max
        acc = np.maximum.accumulate(row - GAP * ks) + GAP * ks
        left = acc > row + 1e-4  # tolerance: the cumulative trick adds float error
        left[0] = False
        H[i] = np.where(left, acc, row)
        pr = np.empty(m + 1, dtype=np.int8)
        pr[0] = 1
        pr[1:] = p
        pr[left] = 2
        ptr[i] = pr
    pairs = []
    i, j = n, m
    while i > 0 and j > 0:
        d = ptr[i, j]
        if d == 0:
            pairs.append((i - 1, j - 1, float(sim[i - 1, j - 1])))
            i, j = i - 1, j - 1
        elif d == 1:
            i -= 1
        else:
            j -= 1
    pairs.reverse()
    return pairs


def line_times(lines: list[dict], segments: list[dict]) -> dict[int, tuple[float, float, float]]:
    """Align all lines, in order, to one transcript; return {line index: (start, end, cover)}
    for lines that match confidently."""
    stream = word_stream(segments)
    tr_toks = [t for t, _, _ in stream]
    line_toks, owner = [], []
    for k, line in enumerate(lines):
        toks = norm_words(line["text"])
        line_toks += toks
        owner += [k] * len(toks)
    per_line: dict[int, list] = {}
    for i, j, s in align(line_toks, tr_toks):
        per_line.setdefault(owner[i], []).append((i, j, s))

    out = {}
    for k, ps in per_line.items():
        n_toks = owner.count(k)
        good = [p for p in ps if p[2] >= MATCH_SIM]
        if not good:
            continue
        cover = len(good) / n_toks
        # short lines need every word matched; longer ones a solid majority
        if cover < (1.0 if n_toks <= 2 else MIN_COVER):
            continue
        # span from the first to the last matched transcript word
        j0, j1 = good[0][1], good[-1][1]
        start, end = stream[j0][1], stream[j1][2]
        if end <= start or (end - start) > MAX_SEC_PER_WORD * n_toks + 2:
            continue
        # a transcript span much wider than the line means the match is scattered
        if (j1 - j0 + 1) > 2 * n_toks + 3:
            continue
        out[k] = (start, end, cover)
    return out


def align_item(item: dict, tr: dict) -> dict:
    lines = item["lines"]
    auto = line_times(lines, tr["segments"])
    de = line_times(lines, tr["de_segments"]) if "de_segments" in tr else {}
    stats = {"lines": len(lines), "timed": 0, "de": 0, "de_timed": 0}
    for k, line in enumerate(lines):
        line.pop("start", None)
        line.pop("end", None)
        stats["de"] += line["lang"] == "de"
        # prefer the pass in the line's own language, else whichever matched better
        first, second = (de, auto) if line["lang"] == "de" else (auto, de)
        hit = first.get(k) or second.get(k)
        if not hit:
            continue
        line["start"] = round(max(0.0, hit[0] - PAD), 2)
        line["end"] = round(hit[1] + PAD, 2)
        stats["timed"] += 1
        stats["de_timed"] += line["lang"] == "de"
    return stats


def write_item(path: Path, item: dict) -> None:
    raw = path.read_text()
    m = re.match(r"\{\n( +)", raw)
    indent = len(m.group(1)) if m else 2
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(item, ensure_ascii=False, indent=indent) + ("\n" if raw.endswith("\n") else ""))
    tmp.rename(path)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("targets", nargs="*", help="item ids or id prefixes (default: all DW series)")
    ap.add_argument("--force", action="store_true", help="realign items that already have timestamps")
    ap.add_argument("--show", type=int, default=0, help="print the first N timed lines of each item")
    args = ap.parse_args()

    targets = tuple(args.targets) or PREFIXES
    paths = sorted(p for p in CONTENT.glob("*.json") if p.stem.startswith(PREFIXES) and p.stem.startswith(targets))
    t_all = time.time()
    for path in paths:
        item = json.loads(path.read_text())
        cache = RAW / f"{item['id']}.json"
        tr = json.loads(cache.read_text()) if cache.exists() else None
        done = tr is not None and (tr["language"] == "de" or "de_segments" in tr)
        if not args.force and done and any("start" in l for l in item["lines"]):
            print(f"{item['id']}: already aligned, skipping", flush=True)
            continue
        media = item.get("media") or {}
        audio = DATA / media.get("path", "")
        if media.get("type") != "audio" or not audio.is_file():
            print(f"{item['id']}: no audio, skipping", flush=True)
            continue
        tr = transcribe(item["id"], audio)
        before = [{k: v for k, v in l.items() if k not in ("start", "end")} for l in item["lines"]]
        st = align_item(item, tr)
        after = [{k: v for k, v in l.items() if k not in ("start", "end")} for l in item["lines"]]
        assert before == after, "line content changed"
        write_item(path, item)
        de_note = f" + {tr['de_seconds']}s de" if "de_seconds" in tr else ""
        print(
            f"{item['id']}: {st['de_timed']}/{st['de']} German lines timed, {st['timed']}/{st['lines']} all "
            f"(whisper {tr['seconds']}s auto [{tr['language']}]{de_note})",
            flush=True,
        )
        if args.show:
            shown = [l for l in item["lines"] if "start" in l][: args.show]
            for l in shown:
                print(f"  {l['start']:7.2f}-{l['end']:7.2f} [{l['lang']}] {l['text'][:80]}")
    print(f"done in {time.time() - t_all:.0f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
