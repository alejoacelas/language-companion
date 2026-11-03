"""Turn the raw DW Harry manuscripts into content items (data/content/harry-NNN.json).

Reads data/raw/harry/lesson-NNN.json (from fetch_dw_harry.py), splits the HTML
manuscript into speaker turns, then asks Claude to split each turn into English
and German segments and translate the German ones. Every segment must reproduce
the manuscript text exactly (whitespace aside), so German stays verbatim; a
turn whose segments don't match is retried, then reported and written as a
single unsplit line flagged with `"unsplit": true`.

Model output is cached in data/raw/harry/segments-NNN.json, so reruns only call
the API for missing episodes.

    ANTHROPIC_API_KEY=... uv run --with anthropic python -I tools/build_dw_harry.py [episode numbers]
"""

import html
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from pathlib import Path

import anthropic

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "harry"
CONTENT = ROOT / "data" / "content"
MODEL = "claude-opus-5-5"


class ManuscriptParser(HTMLParser):
    """Collects <p> blocks as lists of (bold?, text) runs, with <br> as newline."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.paras: list[list[tuple[bool, str]]] = []
        self.cur: list[tuple[bool, str]] | None = None
        self.bold = 0

    def handle_starttag(self, tag, attrs):
        if tag == "p":
            self.cur = []
        elif tag in ("strong", "b"):
            self.bold += 1
        elif tag == "br" and self.cur is not None:
            self.cur.append((False, "\n"))

    def handle_endtag(self, tag):
        if tag == "p" and self.cur is not None:
            self.paras.append(self.cur)
            self.cur = None
        elif tag in ("strong", "b"):
            self.bold -= 1

    def handle_data(self, data):
        if self.cur is not None:
            self.cur.append((self.bold > 0, data))


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s.replace("\xa0", " ")).strip()


def speaker_name(label: str) -> str:
    """'WEATHER FORECASTER:' -> 'Weather Forecaster', 'NEIGHBOR (HELGA)' -> 'Neighbor (Helga)'."""
    label = norm(label).rstrip(":").strip().lower()
    name = re.sub(r"(?<![\w'’])(\w)", lambda m: m.group(1).upper(), label)
    return {"Narrartor": "Narrator", "Taxidriver": "Taxi Driver"}.get(name, name)


LABEL = re.compile(r"^([A-ZÄÖÜ][^:a-zäöüß]*(?:\([^)]*\))?[^:a-zäöüß]*?)\s*:\s*(.*)$")
HEADING = re.compile(r"^[A-ZÄÖÜ][A-ZÄÖÜ0-9 '’&,.\-]+$")


def parse_turns(manuscript: str) -> list[dict]:
    """Speaker turns from the manuscript HTML.

    A line that starts with an upper-case label and a colon ("HARRY:", "TAXI
    DRIVER (dialect):") starts a turn, wherever the bold tags are. An
    all-caps line without a colon is a scene heading and is dropped. Other lines
    continue the current speaker as a new turn.
    """
    p = ManuscriptParser()
    p.feed(manuscript)
    turns: list[dict] = []
    for runs in p.paras:
        for raw in "".join(t for _, t in runs).split("\n"):
            line = norm(raw)
            if not line:
                continue
            m = LABEL.match(line)
            if m and len(re.sub(r"[^A-Za-zÄÖÜäöü]", "", m.group(1))) >= 2:
                speaker, text = speaker_name(m.group(1)), norm(m.group(2))
                turns.append({"speaker": speaker, "text": text})
                continue
            if HEADING.match(line) and len(line) > 3 and " " in line:
                continue
            if turns and not turns[-1]["text"]:
                turns[-1]["text"] = line
            elif turns:
                turns.append({"speaker": turns[-1]["speaker"], "text": line})
    return [t for t in turns if t["text"]]


SYSTEM = """You prepare scripts from the DW radio drama "Harry – gefangen in der Zeit" for an app that teaches German to absolute beginners. Narration and Harry's speech are mostly English; other characters speak German; many turns mix both.

For each numbered turn, split the text into consecutive segments, each entirely English ("en") or entirely German ("de"), and give every German segment an accurate, natural English translation.

Rules:
- Concatenating a turn's segment texts must reproduce the turn text exactly, character for character, apart from whitespace between segments. Do not fix, drop or add anything, including punctuation and ellipses.
- Split at sentence or clause boundaries. Keep a turn as one segment when it is all one language.
- A German word or phrase embedded inside an English sentence (a gloss like "Die Welt, the world, ist, is", a name of a German thing, a quoted German word) stays inside the English segment. Make a separate German segment only for German that is spoken as German: a German sentence, greeting, exclamation or stand-alone phrase such as "Guten Morgen!" or "Nein danke!".
- If the script itself translates the German right before or after (often the narrator or Harry repeats it in English), use that meaning for the translation.
- Names, "Okay", "Hm" and similar fillers go with the neighbouring segment's language.
Return all turns via the tool."""

TOOL = {
    "name": "segments",
    "description": "Segmented turns.",
    "input_schema": {
        "type": "object",
        "properties": {
            "turns": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "n": {"type": "integer"},
                        "segments": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "lang": {"enum": ["en", "de"]},
                                    "text": {"type": "string"},
                                    "en": {"type": "string", "description": "English translation; German segments only"},
                                },
                                "required": ["lang", "text"],
                            },
                        },
                    },
                    "required": ["n", "segments"],
                },
            }
        },
        "required": ["turns"],
    },
}


def squash(s: str) -> str:
    return re.sub(r"\s+", "", s)


def check(turn: dict, segs: list[dict]) -> str | None:
    if not segs:
        return "no segments"
    if squash("".join(s["text"] for s in segs)) != squash(turn["text"]):
        return "segments do not reproduce the turn text"
    for s in segs:
        if s["lang"] == "de" and not (s.get("en") or "").strip():
            return "German segment without translation"
    return None


def ask(client: anthropic.Anthropic, turns: list[dict], numbers: list[int], note: str = "") -> dict[int, list]:
    body = "\n".join(f"[{n}] {turns[n]['speaker']}: {turns[n]['text']}" for n in numbers)
    if note:
        body = note + "\n\n" + body
    with client.messages.stream(
        model=MODEL,
        max_tokens=64000,
        system=SYSTEM,
        tools=[TOOL],
        tool_choice={"type": "auto"},
        messages=[{"role": "user", "content": body}],
    ) as stream:
        msg = stream.get_final_message()
    out = next(b.input for b in msg.content if b.type == "tool_use")
    return {t["n"]: t["segments"] for t in out["turns"]}


def segment_episode(client: anthropic.Anthropic, n: int, turns: list[dict]) -> tuple[dict[int, list], list[str]]:
    cache = RAW / f"segments-{n:03d}.json"
    if cache.exists():
        cached = json.loads(cache.read_text())
        if len(cached["turns"]) == len(turns) and all(cached["turns"][i]["text"] == t["text"] for i, t in enumerate(turns)):
            return {int(k): v for k, v in cached["segments"].items()}, cached.get("problems", [])
    result = ask(client, turns, list(range(len(turns))))
    bad = [i for i in range(len(turns)) if check(turns[i], result.get(i, []))]
    if bad:
        retry = ask(client, turns, bad, note="Earlier output for these turns did not reproduce the text exactly. Copy every character.")
        for i in bad:
            if not check(turns[i], retry.get(i, [])):
                result[i] = retry[i]
    problems = []
    for i in range(len(turns)):
        err = check(turns[i], result.get(i, []))
        if err:
            problems.append(f"turn {i}: {err}: {turns[i]['text'][:80]}")
            result.pop(i, None)
    cache.write_text(json.dumps({"turns": turns, "segments": result, "problems": problems}, ensure_ascii=False, indent=1))
    return result, problems


def guess_lang(text: str) -> str:
    de_hits = len(re.findall(r"\b(ich|ist|und|nicht|der|die|das|Sie|wir|ja|nein|was|wie|ein|eine|zu|es)\b|[äöüß]", text))
    en_hits = len(re.findall(r"\b(the|is|and|not|you|I|we|yes|no|what|how|a|to|it|that)\b", text))
    return "de" if de_hits > en_hits else "en"


def build(client: anthropic.Anthropic, n: int) -> tuple[int, int, list[str]]:
    lesson = json.loads((RAW / f"lesson-{n:03d}.json").read_text())
    turns = parse_turns(lesson["manuscript"])
    segs, problems = segment_episode(client, n, turns)
    lines = []
    for i, turn in enumerate(turns):
        parts = segs.get(i)
        if parts is None:
            lang = guess_lang(turn["text"])
            lines.append({"speaker": turn["speaker"], "lang": lang, "text": turn["text"], "unsplit": True})
            continue
        for s in parts:
            line = {"speaker": turn["speaker"], "lang": s["lang"], "text": norm(s["text"])}
            if s["lang"] == "de":
                line["en"] = norm(s["en"])
            lines.append(line)
    for k, line in enumerate(lines, 1):
        line_id = {"id": f"l{k}"}
        line_id.update(line)
        lines[k - 1] = line_id
    title = re.sub(r"^\d+\s+", "", lesson["name"]).strip()
    media_path = f"media/harry-{n:03d}.mp3"
    item = {
        "id": f"harry-{n:03d}",
        "kind": "episode",
        "series": "Harry – gefangen in der Zeit",
        "title": title,
        "order": n,
        "level": "A1" if n <= 50 else "A2",
        "source": {
            "name": "Deutsche Welle",
            "url": "https://learngerman.dw.com" + lesson["namedUrl"],
            "note": "Free DW course (English-narrated version); personal use. German verbatim from DW's manuscript; segment split and translations by Claude.",
        },
        "media": {"type": "audio", "path": media_path} if (ROOT / "data" / media_path).exists() else None,
        "external_link": {"label": "Episode on DW Learn German", "url": "https://learngerman.dw.com" + lesson["namedUrl"]},
        "lines": lines,
    }
    CONTENT.mkdir(parents=True, exist_ok=True)
    (CONTENT / f"harry-{n:03d}.json").write_text(json.dumps(item, ensure_ascii=False, indent=1))
    return n, len(lines), problems


def main() -> None:
    episodes = [int(a) for a in sys.argv[1:]] or sorted(int(p.stem.split("-")[1]) for p in RAW.glob("lesson-*.json"))
    client = anthropic.Anthropic(max_retries=5)
    with ThreadPoolExecutor(8) as pool:
        for n, count, problems in pool.map(lambda e: build(client, e), episodes):
            print(f"harry-{n:03d}: {count} lines" + (f", {len(problems)} unsplit turns" if problems else ""))
            for p in problems:
                print("   ", p)


if __name__ == "__main__":
    main()
