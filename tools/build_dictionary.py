"""Build the ranked German dictionary in the `words` table.

Source: OpenSubtitles 2018 frequency list (hermitdave/FrequencyWords, CC BY-SA 4.0),
downloaded to data/sources/de_50k.txt. Forms are grouped into lemmas with simplemma,
then Claude Haiku fixes capitalisation, adds the article, a short gloss and an example,
and drops names, English words and junk.

Usage: uv run python tools/build_dictionary.py [--top 6000]
"""

import argparse
import concurrent.futures as cf
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import anthropic
import simplemma
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from server import db  # noqa: E402

load_dotenv(db.ROOT / ".env")
FAST = "claude-haiku-5-5"
SRC = db.DATA / "sources" / "de_50k.txt"
CACHE = db.DATA / "sources" / "gloss-cache.json"

PROMPT = """You are building a German learner's dictionary from a subtitle frequency list.
For each candidate below (lowercased lemma from a lemmatizer, may be wrong), return one JSON object per line:
{"in": "<candidate as given>", "lemma": "<correct dictionary form with correct capitalisation>", "article": "der|die|das|" , "gloss": "<1-4 word English meaning, most common sense>", "example": "<short, simple German sentence using it>"}
Rules:
- If the candidate is a proper name, an English word, a filler/interjection with no meaning, a fragment, or not German, return {"in": "...", "skip": true}.
- Nouns: capitalised lemma, article set. Verbs: infinitive. Adjectives: base form. Others: article "".
- Pronouns and function words are fine; gloss them briefly (e.g. "ich" -> "I").
- Output JSON lines only, same order, nothing else.

Candidates:
"""


def candidates(top: int) -> list[tuple[str, int]]:
    counts: dict[str, int] = defaultdict(int)
    order: list[str] = []
    for line in SRC.read_text().splitlines():
        form, n = line.rsplit(" ", 1)
        if not re.fullmatch(r"[a-zäöüß]+", form):
            continue
        lemma = simplemma.lemmatize(form, lang="de").lower()
        if lemma not in counts:
            order.append(lemma)
        counts[lemma] += int(n)
    ranked = sorted(order, key=lambda l: -counts[l])
    return [(l, counts[l]) for l in ranked[:top]]


def gloss_batch(client: anthropic.Anthropic, batch: list[str]) -> list[dict]:
    msg = client.messages.create(model=FAST, max_tokens=16000,
                                 messages=[{"role": "user", "content": PROMPT + "\n".join(batch)}])
    out = []
    for line in "".join(b.text for b in msg.content if b.type == "text").splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=6000)
    args = ap.parse_args()

    cands = candidates(args.top)
    cache: dict[str, dict] = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    todo = [c for c, _ in cands if c not in cache]
    print(f"{len(cands)} candidates, {len(todo)} to gloss")

    client = anthropic.Anthropic()
    batches = [todo[i:i + 150] for i in range(0, len(todo), 150)]
    with cf.ThreadPoolExecutor(8) as pool:
        for res in pool.map(lambda b: gloss_batch(client, b), batches):
            for r in res:
                if "in" in r:
                    cache[r["in"]] = r
            CACHE.write_text(json.dumps(cache, ensure_ascii=False))
            print(".", end="", flush=True)
    print()

    rank, seen = 0, set()
    rows = []
    for c, _ in cands:
        r = cache.get(c)
        if not r or r.get("skip") or not r.get("lemma"):
            continue
        lemma = r["lemma"].strip()
        if lemma in seen:
            continue
        seen.add(lemma)
        rank += 1
        rows.append((lemma, rank, r.get("gloss", ""), r.get("article", "") or None, r.get("example", "")))
    with db._lock:
        c = db.conn()
        c.execute("DELETE FROM words")
        c.executemany("INSERT INTO words (lemma, rank, gloss, article, example) VALUES (?,?,?,?,?)", rows)
    print(f"{len(rows)} lemmas written; missing from cache: {sum(1 for c, _ in cands if c not in cache)}")


if __name__ == "__main__":
    main()
