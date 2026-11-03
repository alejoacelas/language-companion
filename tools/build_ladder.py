"""Build the word ladder: the order in which the curriculum introduces German words.

Counts every German word form in the DW courses the learner will graduate into (Radio D,
Mission Berlin and the first 40 Harry episodes; earlier episodes weigh more), then asks
Claude to group the most frequent forms into dictionary entries with an English gloss.
Entries are ordered by the summed frequency of their forms, so the ladder teaches first
the words that cover the most of those episodes.

Output: data/curriculum/ladder.json, a list of
  {"id": "w0001", "de": "der Tag", "en": "day", "forms": ["tag", "tage"], "freq": 123}
`forms` are lowercase surface forms used to recognise the word in any text.

Run:
  uv run python -I tools/build_ladder.py [--top 1400]
Model replies are cached in data/curriculum/ladder-raw/.
"""

import argparse
import json
import os
import re
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anthropic
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "curriculum"
RAW = OUT / "ladder-raw"
MODEL = "claude-opus-5-5"
WORD = re.compile(r"[\wäöüÄÖÜß]+(?:-[\wäöüÄÖÜß]+)*")
CHUNK = 350

SYSTEM = """You are a German lexicographer preparing a beginner's vocabulary list. Reply with JSON only."""

PROMPT = """Below are lowercase German word forms from beginner course dialogues, with their counts.
Group them into dictionary entries. For each entry give:
- "de": the dictionary form a beginner should learn. Nouns with article and capitalised ("der Tag"), verbs in the infinitive ("sein"),
  adjectives in base form. For very common fixed greetings or expressions you may use the whole expression ("guten Morgen").
- "en": a short English gloss (1-4 words).
- "forms": every form from the list that belongs to this entry (lowercase, exactly as listed). A form belongs to one entry only.
Skip forms that are personal or place names, interjections without meaning ("hm", "äh"), English words, or fragments.
Return JSON: {{"entries": [{{"de": str, "en": str, "forms": [str]}}], "skipped": [str]}}

Forms (form: count):
{forms}"""


def counts() -> Counter:
    c: Counter = Counter()
    for p in sorted((DATA / "content").glob("*.json")):
        it = json.loads(p.read_text())
        sid = it["id"]
        if sid.startswith("harry-") and it.get("order", 999) > 40:
            continue
        if not sid.startswith(("harry-", "radio-d-", "mission-berlin-")):
            continue
        weight = 1 / (1 + (it.get("order") or 1) / 15)  # earlier episodes matter more
        for line in it["lines"]:
            if line.get("lang") == "de":
                for w in WORD.findall(line["text"].lower()):
                    if not w.isdigit():
                        c[w] += weight
    return c


def group(i: int, forms: list[tuple[str, float]], client: anthropic.Anthropic) -> dict:
    cache = RAW / f"chunk-{i:02d}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    listing = "\n".join(f"{w}: {round(n, 1)}" for w, n in forms)
    with client.messages.stream(model=MODEL, max_tokens=32000, system=SYSTEM,
                                messages=[{"role": "user", "content": PROMPT.format(forms=listing)}]) as s:
        r = s.get_final_message()
    text = "".join(b.text for b in r.content if b.type == "text")
    data = json.loads(re.search(r"\{.*\}", text, re.S).group(0))
    cache.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    return data


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=1400, help="how many of the most frequent forms to group")
    args = ap.parse_args()
    load_dotenv(ROOT / ".env")
    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    RAW.mkdir(parents=True, exist_ok=True)

    freq = counts()
    top = freq.most_common(args.top)
    chunks = [top[i:i + CHUNK] for i in range(0, len(top), CHUNK)]
    with ThreadPoolExecutor(len(chunks)) as ex:
        results = list(ex.map(lambda a: group(*a, client), enumerate(chunks)))

    # Merge entries with the same dictionary form across chunks.
    merged: dict[str, dict] = {}
    claimed: set[str] = set()
    for res in results:
        for e in res["entries"]:
            forms = [f for f in (x.lower() for x in e["forms"]) if f in freq and f not in claimed]
            if not forms:
                continue
            claimed.update(forms)
            key = e["de"].strip()
            m = merged.setdefault(key, {"de": key, "en": e["en"].strip(), "forms": []})
            m["forms"] += forms
    ladder = []
    for m in merged.values():
        m["freq"] = round(sum(freq[f] for f in m["forms"]), 1)
        ladder.append(m)
    ladder.sort(key=lambda m: -m["freq"])
    for i, m in enumerate(ladder):
        m["id"] = f"w{i + 1:04d}"
    ladder = [{"id": m["id"], "de": m["de"], "en": m["en"], "forms": m["forms"], "freq": m["freq"]} for m in ladder]
    (OUT / "ladder.json").write_text(json.dumps(ladder, ensure_ascii=False, indent=1))

    covered = sum(freq[f] for m in ladder for f in m["forms"])
    print(f"{len(ladder)} entries from {len(top)} forms; they cover {covered / sum(freq.values()):.0%} of weighted German tokens")
    print("first 40:", ", ".join(f"{m['de']} ({m['en']})" for m in ladder[:40]))


if __name__ == "__main__":
    sys.exit(main())
