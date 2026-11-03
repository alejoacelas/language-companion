"""Turn the DW manuscripts fetched by tools/fetch_dw_courses.py into content items.

Claude splits each manuscript into English and German lines and translates the German.
Every line's text is then checked against the manuscript: it must appear verbatim
(after whitespace and quote-style normalisation) or it is dropped and reported.
Accepted text is replaced by the exact manuscript wording.

Run:
  ANTHROPIC_API_KEY=op://mac-agents/mj6dyf42xml2ughfxqzpxey3zi/credential \
    ~/best/stash/dotfiles/bin/op-agent run -- \
    uv run --with anthropic python -I tools/build_dw_scripts.py [mission-berlin|radio-d ...] [--force] [--only ID]

Model replies are cached in data/raw/<series>/<id>.segments.json; --force redoes them.
"""

import argparse
import json
import re
import sys
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anthropic

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
MODEL = "claude-opus-5-5"

BOILERPLATE = [
    r"Deutsch lernen und unterrichten\s*[–-]\s*Arbeitsmaterialien",
    r"Mission Berlin",
    r"Radio D\s*[–-]\s*Teil \d",
    r"Ihr Deutsch ist unser Auftrag!",
    r"DW-WORLD\.DE/\S*",
    r"©\s*Deutsche Welle",
    r"Seite \d+ von \d+",
]
BOILER_RE = re.compile(r"^\s*(?:" + "|".join(BOILERPLATE) + r")\s*$")
START_RE = re.compile(r"^\s*Manus[ck]ript (of|der) (the )?(Episode|Folge)\b.*$", re.I)

SYSTEM = """You turn manuscripts of bilingual radio language courses into line-by-line JSON for a German-learning app. The listener is an English speaker. The manuscript mixes English (narrators, hosts, the player, characters who think in English) with German dialogue.

Reply with JSON listing every spoken line, in manuscript order.

Rules:
- `text` must be copied character for character from the manuscript. Do not fix typos, spelling, punctuation or grammar, and do not add or drop words. You may only join text that the manuscript breaks across lines.
- Leave out things that are not spoken: section and scene headings (INTRODUCTION, SITUATION 1 – ..., DECODAGE 1, CONCLUSION, FLASHBACK labels, "Szene 1: ...", "Manuscript of ..."), speaker labels, page furniture, and closing production credits or author names that are printed but not read out. Keep spoken openings and closings such as "You're listening to Radio D ...".
- Split each speaker turn into lines at sentence or clause boundaries whenever the language changes, so every line is wholly English (`lang: "en"`) or wholly German (`lang: "de"`). Example: "Oh, yes. Guten Morgen!" becomes an "en" line "Oh, yes." and a "de" line "Guten Morgen!". Long single-language passages may stay as one line per paragraph, but split German into sentence-sized lines (one or two short sentences each) so a learner can study them one at a time.
- A word or short phrase of the other language embedded inside a sentence stays in that sentence's line: "He's on his way to "Zimmer vierzehn"!" is one "en" line; "Also die Polizei, the police, ist hier im Hotel." is one "de" line.
- Every "de" line gets `en`: an accurate, natural English translation. If the manuscript itself glosses the phrase nearby, follow that gloss. Lines that are only a German name or number still count as German.
- `speaker`: a short readable English label for who speaks. Translate German role labels (SPIELER → Player, REZEPTIONIST → Receptionist, Sprecher → Announcer, Sprecherin → Announcer, Nachrichtensprecher → Newsreader, Mutter → Mother, Kellnerin → Waitress); keep personal names as they are (Anna, Ogur, Paula, Philipp, Frau Frisch). Use "Moderator" for the course host and "Professor" for the professor. For flashback replays, use the original speaker if clear from context, otherwise "Flashback".
"""

SCHEMA = {
        "type": "object",
        "properties": {
            "lines": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "speaker": {"type": "string"},
                        "lang": {"type": "string", "enum": ["en", "de"]},
                        "text": {"type": "string"},
                        "en": {"type": "string", "description": "English translation for de lines; empty string for en lines"},
                    },
                    "required": ["speaker", "lang", "text", "en"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["lines"],
        "additionalProperties": False,
}

QUOTE_FOLD = str.maketrans({"’": "'", "‘": "'", "‚": "'", "´": "'", "`": "'", "“": '"', "”": '"', "„": '"', "«": '"', "»": '"', "–": "-", "—": "-", " ": " ", "­": ""})


PUNCT = set(".,!?;:")


def clean_manuscript(raw):
    lines = raw.replace("\f", "\n").split("\n")
    start = next((i for i, l in enumerate(lines) if START_RE.match(l)), None)
    if start is None:
        raise ValueError("no 'Manuscript of the Episode' heading")
    kept = [l.rstrip() for l in lines[start + 1 :] if not BOILER_RE.match(l)]
    # Drop invisible format characters (e.g. U+202D) that some PDFs put inside sentences.
    # U+F02D is a Symbol-font dash in some Radio D PDFs.
    text = "\n".join(kept).replace("\uf02d", "–")
    text = "".join(c for c in text if unicodedata.category(c) != "Cf")
    # Rejoin words that the PDF hyphenated across a line or page break ("Ger-\nman").
    text = re.sub(r"(\w)-\n\s*(?=[a-zäöüß])", r"\1", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


class Source:
    """Normalised manuscript text with a map back to the original characters."""

    def __init__(self, text):
        self.orig = text
        norm, idx, prev_space = [], [], True
        for i, ch in enumerate(text):
            if ch.isspace():
                if not prev_space:
                    norm.append(" ")
                    idx.append(i)
                prev_space = True
                continue
            folded = ch.translate(QUOTE_FOLD)
            if folded in PUNCT and norm and norm[-1] == " ":
                # Layout sometimes puts a break before punctuation ("anderer\n\n.").
                norm.pop()
                idx.pop()
            for c in folded:
                norm.append(c)
                idx.append(i)
            prev_space = False
        self.norm = "".join(norm)
        self.idx = idx
        self.covered = [False] * len(self.norm)

    @staticmethod
    def normalise(s):
        return re.sub(r" (?=[.,!?;:])", "", re.sub(r"\s+", " ", s.translate(QUOTE_FOLD))).strip()

    def find(self, text, pos):
        needle = self.normalise(text)
        if not needle:
            return None, pos
        at = self.norm.find(needle, pos)
        if at < 0:
            at = self.norm.find(needle)
        if at < 0:
            return None, pos
        end = at + len(needle)
        for k in range(at, end):
            self.covered[k] = True
        original = self.orig[self.idx[at] : self.idx[end - 1] + 1]
        return re.sub(r"\s+(?=[.,!?;:])", "", re.sub(r"\s+", " ", original)).strip(), end

    def coverage(self):
        letters = [i for i, c in enumerate(self.norm) if c.isalpha()]
        return sum(self.covered[i] for i in letters) / max(1, len(letters))

    def uncovered_snippets(self, min_len=25):
        out, run = [], []
        for i, c in enumerate(self.norm):
            if not self.covered[i]:
                run.append(c)
            else:
                if len("".join(run).strip()) >= min_len:
                    out.append("".join(run).strip())
                run = []
        if len("".join(run).strip()) >= min_len:
            out.append("".join(run).strip())
        return out


def segment(client, entry, manuscript):
    user = (
        f"Course: {entry['series']}, episode {entry['order']}: {entry['title']}\n\n"
        f"<manuscript>\n{manuscript}\n</manuscript>"
    )
    with client.messages.stream(
        model=MODEL,
        max_tokens=48000,
        system=SYSTEM,
        output_config={"format": {"type": "json_schema", "schema": SCHEMA}},
        messages=[{"role": "user", "content": user}],
    ) as stream:
        msg = stream.get_final_message()
    if msg.stop_reason == "max_tokens":
        raise RuntimeError("model output hit max_tokens")
    text = "".join(b.text for b in msg.content if b.type == "text")
    return json.loads(text)["lines"]


def build(entry, client, force):
    raw_dir = DATA / "raw" / entry["id"].rsplit("-", 1)[0]
    if not entry.get("text_path"):
        return entry["id"], None, "no manuscript"
    manuscript = clean_manuscript((DATA / entry["text_path"]).read_text())
    cache = raw_dir / f"{entry['id']}.segments.json"
    if cache.exists() and not force:
        proposed = json.loads(cache.read_text())
    else:
        proposed = segment(client, entry, manuscript)
        cache.write_text(json.dumps(proposed, ensure_ascii=False, indent=2))

    src = Source(manuscript)
    lines, dropped, pos = [], [], 0
    for p in proposed:
        verbatim, pos = src.find(p.get("text", ""), pos)
        if verbatim is None:
            dropped.append(p)
            continue
        line = {"id": f"l{len(lines) + 1}", "speaker": p["speaker"].strip(), "lang": p["lang"], "text": verbatim}
        if p["lang"] == "de":
            if not (p.get("en") or "").strip():
                dropped.append(p)
                continue
            line["en"] = p["en"].strip()
        lines.append(line)

    item = {
        "id": entry["id"],
        "kind": "episode",
        "series": entry["series"],
        "title": entry["title"],
        "order": entry["order"],
        "level": entry["level"],
        "source": {
            "name": "Deutsche Welle",
            "url": entry["url"],
            "note": "Free DW course (manuscript PDF and MP3 from learngerman.dw.com); personal use. Translations of German lines by Claude.",
        },
        "media": {"type": "audio", "path": entry["media_path"]} if entry.get("media_path") else None,
        "external_link": {"label": "DW episode page", "url": entry["url"]},
        "lines": lines,
    }
    (DATA / "content" / f"{entry['id']}.json").write_text(json.dumps(item, ensure_ascii=False, indent=2))
    report = {
        "lines": len(lines),
        "de": sum(l["lang"] == "de" for l in lines),
        "dropped": [d.get("text") for d in dropped],
        "coverage": round(src.coverage(), 3),
        "uncovered": src.uncovered_snippets(),
    }
    (raw_dir / f"{entry['id']}.report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    return entry["id"], report, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("series", nargs="*", default=["mission-berlin", "radio-d"])
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--only", action="append")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()

    (DATA / "content").mkdir(parents=True, exist_ok=True)
    client = anthropic.Anthropic(max_retries=6)
    entries = []
    for key in args.series:
        entries += json.loads((DATA / "raw" / key / "manifest.json").read_text())
    if args.only:
        entries = [e for e in entries if e["id"] in args.only]

    def run(e):
        try:
            return build(e, client, args.force)
        except Exception as exc:  # report and continue with the other episodes
            return e["id"], None, f"{type(exc).__name__}: {exc}"

    failures = 0
    with ThreadPoolExecutor(args.workers) as pool:
        for item_id, rep, err in pool.map(run, entries):
            if err:
                failures += 1
                print(f"{item_id}: FAILED {err}")
            else:
                print(
                    f"{item_id}: {rep['lines']} lines ({rep['de']} de), coverage {rep['coverage']:.0%}, "
                    f"dropped {len(rep['dropped'])}, uncovered chunks {len(rep['uncovered'])}"
                )
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
