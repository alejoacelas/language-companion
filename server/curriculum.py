"""The curriculum: a ladder of short lessons that raise German exposure gradually.

Each lesson is an episode of one ongoing story (the "bible"), told in English with German
woven in. Lesson 1 has a few German words; each lesson adds the next few words from the
word ladder (data/curriculum/ladder.json, built by tools/build_ladder.py) and reuses the
ones already met, until German is about half the text. Claude Opus writes each lesson and
picks how many new words to add (3-10) from the learner's recent results.

Inside English narration, German words are marked with asterisks: "She opens her *Tasche*."

A word is "met" once its lesson starts, and "known" once it has two good card reviews, or
has been read in four texts without being looked up.
"""

from __future__ import annotations

import json
import re
import threading
from pathlib import Path

from . import coach, content, db, srs

DIR = db.DATA / "curriculum"
LADDER = DIR / "ladder.json"
BIBLE = DIR / "bible.json"
SERIES = "Lessons"
LESSONS_TO_HALF_GERMAN = 30
WORD = re.compile(r"[\wäöüÄÖÜß]+(?:-[\wäöüÄÖÜß]+)*")
STAR = re.compile(r"\*([^*]+)\*")

db.con.executescript("""
CREATE TABLE IF NOT EXISTS words (
  id TEXT PRIMARY KEY,            -- ladder id
  de TEXT NOT NULL, en TEXT NOT NULL,
  forms TEXT NOT NULL,            -- JSON list of lowercase forms
  lesson INTEGER, met_at TEXT NOT NULL,
  card_id INTEGER,
  seen INTEGER DEFAULT 0,         -- texts finished that contain the word
  clicks INTEGER DEFAULT 0        -- times looked up
);
""")

_gen_lock = threading.Lock()


# ---------- words ----------

def ladder() -> list[dict]:
    return json.loads(LADDER.read_text())


def german_tokens(item: dict) -> list[str]:
    """Lowercase German word tokens of an item: German lines plus *starred* words in English lines."""
    out = []
    for l in item.get("lines", []):
        if l.get("lang") == "de":
            out += WORD.findall(l["text"].lower())
        else:
            for s in STAR.findall(l.get("text", "")):
                out += WORD.findall(s.lower())
    return [t for t in out if not t.isdigit()]


def _good_reviews() -> dict[int, int]:
    return {r["card_id"]: r["n"] for r in db.rows("SELECT card_id, COUNT(*) n FROM reviews WHERE rating >= 3 GROUP BY card_id")}


def word_states() -> list[dict]:
    good = _good_reviews()
    out = []
    for w in db.rows("SELECT * FROM words ORDER BY met_at"):
        w["forms"] = json.loads(w["forms"])
        w["good_reviews"] = good.get(w["card_id"], 0)
        w["known"] = w["good_reviews"] >= 2 or (w["seen"] >= 4 and w["clicks"] == 0)
        out.append(w)
    return out


def form_sets() -> tuple[set[str], set[str]]:
    """(known forms, met forms). Tokens of saved cards count as met."""
    known, met = set(), set()
    for w in word_states():
        met.update(w["forms"])
        if w["known"]:
            known.update(w["forms"])
    for r in db.rows("SELECT front FROM cards"):
        met.update(WORD.findall(r["front"].lower()))
    return known, met


def readiness(item: dict, sets: tuple[set[str], set[str]] | None = None) -> dict:
    known, met = sets or form_sets()
    toks = german_tokens(item)
    if not toks:
        return {"known": None, "met": None}
    return {"known": round(sum(t in known for t in toks) / len(toks), 2),
            "met": round(sum(t in met for t in toks) / len(toks), 2)}


def _word_for_form(form: str) -> dict | None:
    for w in db.rows("SELECT id, forms FROM words"):
        if form in json.loads(w["forms"]):
            return w
    return None


def word_clicked(form: str) -> None:
    w = _word_for_form(form.lower())
    if w:
        db.run("UPDATE words SET clicks = clicks + 1 WHERE id=?", w["id"])


def item_finished(item: dict) -> None:
    """Count one more reading for every met word in the item."""
    toks = set(german_tokens(item))
    for w in db.rows("SELECT id, forms FROM words"):
        if toks & set(json.loads(w["forms"])):
            db.run("UPDATE words SET seen = seen + 1 WHERE id=?", w["id"])


# ---------- lessons ----------

def lessons() -> list[dict]:
    items = [i for i in content.all_items().values() if i.get("kind") == "lesson"]
    return sorted(items, key=lambda i: i["lesson"]["n"])


def _done(item_id: str) -> bool:
    p = db.one("SELECT status FROM item_progress WHERE item_id=?", item_id)
    return bool(p and p["status"] == "done")


def next_lesson() -> dict:
    """The first lesson not yet finished, writing one if none is waiting."""
    for l in lessons():
        if not _done(l["id"]):
            return l
    return generate_next()


def meet(item: dict, block_id: int | None = None) -> list[dict]:
    """Mark a lesson's new words as met and give each a card. Idempotent."""
    out = []
    lines = item.get("lines", [])
    for nw in item["lesson"]["new_words"]:
        forms = nw["forms"]
        ctx = next((l for l in lines if l.get("lang") == "de" and set(WORD.findall(l["text"].lower())) & set(forms)), None)
        card = srs.add(nw["de"], nw["en"], ctx and ctx["text"], ctx and ctx.get("en"), item["id"], ctx and ctx["id"])
        db.run("INSERT OR IGNORE INTO words (id, de, en, forms, lesson, met_at, card_id) VALUES (?,?,?,?,?,?,?)",
               nw["id"], nw["de"], nw["en"], json.dumps(forms, ensure_ascii=False), item["lesson"]["n"], db.now(), card["id"])
        out.append({**nw, "card_id": card["id"]})
    db.log("words_met", item["id"], block_id, words=[w["de"] for w in out])
    return out


def pace_stats() -> dict:
    """What the lesson writer uses to choose how many new words to add."""
    recent = [l for l in lessons() if _done(l["id"])][-3:]
    quiz, clicks = [], []
    for l in recent:
        q = db.one("SELECT payload FROM events WHERE type='quiz' AND item_id=? ORDER BY id DESC LIMIT 1", l["id"])
        if q:
            p = json.loads(q["payload"])
            quiz.append(f"{p.get('correct')}/{p.get('total')}")
        clicks.append(db.one("SELECT COUNT(*) n FROM events WHERE type='word_clicked' AND item_id=?", l["id"])["n"])
    revs = db.rows("SELECT rating FROM reviews WHERE ts >= datetime('now', '-7 days')")
    states = word_states()
    return {
        "lessons_finished": len([l for l in lessons() if _done(l["id"])]),
        "recent_lessons": [l["id"] for l in recent],
        "quiz_scores_recent_lessons": quiz,
        "words_looked_up_in_recent_lessons": clicks,
        "card_reviews_7d": len(revs),
        "card_again_rate_7d": round(sum(r["rating"] == 1 for r in revs) / len(revs), 2) if revs else None,
        "words_met": len(states), "words_known": sum(w["known"] for w in states),
    }


BIBLE_PROMPT = """Create the story bible for a serialized beginner German course of about 40 short episodes.
Style: like DW's "Harry – gefangen in der Zeit": an English narrator carries the plot, characters speak German,
and the story is genuinely fun to follow (light mystery, humour, a few twists, warm characters).
Setting: Berlin today. The listener is a curious adult who knows no German yet.
Keep the cast small (4-6 recurring characters) with distinct voices and simple names that are easy to say.
Return JSON: {"title": German title (2-4 words), "title_en": str, "premise": 3 sentences,
"characters": [{"name": str, "role": str, "description": one sentence, "speech": how they talk}],
"arc": [40 one-sentence episode beats, in order]}"""


def bible() -> dict:
    if BIBLE.exists():
        return json.loads(BIBLE.read_text())
    DIR.mkdir(parents=True, exist_ok=True)
    b = coach._json(coach._ask(coach.SMART, "You are a story editor. Reply with JSON only.", BIBLE_PROMPT, 6000))
    BIBLE.write_text(json.dumps(b, ensure_ascii=False, indent=1))
    return b


LESSON_SYSTEM = """You write episodes of a serialized story that teaches German to an adult who started from zero
(native Spanish, fluent English). An English narrator carries the plot. German appears in two ways:
1. Lines spoken in German by characters (lang "de"), each with an English translation in "en".
2. Single German words or short phrases woven into the English narration, marked with asterisks: She opens her *Tasche*.
   Use this especially in early episodes to show a word in context before characters use it.
The meaning of every German word must be clear from context, so the learner can follow without a dictionary.
German must be correct and natural, the kind a native says in this situation. Reply with JSON only."""


def _lesson_prompt(n: int, b: dict, prev: list[dict], met: list[dict], candidates: list[dict], stats: dict, feedback: str) -> str:
    share = min(0.5, 0.05 + 0.45 * (n - 1) / (LESSONS_TO_HALF_GERMAN - 1))
    beat = b["arc"][n - 1] if n <= len(b["arc"]) else "Continue the story with a new small adventure."
    return f"""Story bible: {json.dumps(b, ensure_ascii=False)}

Previous episodes: {json.dumps([{"n": p["lesson"]["n"], "title": p["title"], "summary": p.get("summary")} for p in prev[-6:]], ensure_ascii=False) if prev else "none, this is episode 1"}
This is episode {n}. Planned beat: {beat}

German the learner has met so far (only these words, the new words below, character names and numbers may appear in German):
{json.dumps([w["de"] + " = " + w["en"] for w in met], ensure_ascii=False) if met else "none yet"}

Next words on the learner's ladder, most useful first (id, German, English):
{json.dumps([[c["id"], c["de"], c["en"]] for c in candidates], ensure_ascii=False)}

Learner's recent results: {json.dumps(stats, ensure_ascii=False)}

Choose how many new words to introduce: {"3 to 5, since this is the very first episode" if n == 1 else "between 3 and 10. Use about 6 by default; fewer if recent quiz scores are low, the card again-rate is above 0.3 or the learner looked up many words; more if everything looks easy"}.
Pick them from the list above, preferring the earliest ones, but skip ones that fit badly in this scene (they stay for later).
Use each new word at least 3 times. Reuse met words generously, especially recent ones, so they get practice.
About {round(share * 100)}% of all words in the episode should be German. Keep German lines short (1-8 words).
Length: 25-40 lines total, about 3 minutes of reading.
Write two multiple-choice comprehension questions in English about the plot, which need the German parts to answer.
{feedback}
Return JSON: {{"title": short English title, "summary": one sentence of what happens,
"pace_reason": one sentence on why this many new words,
"new_words": [{{"id": ladder id, "de": one form to learn, written as it should appear on a flashcard (the ladder form, or a more useful short chunk containing it; no slashes or alternatives), "en": English}}],
"lines": [{{"speaker": name or "Narrator", "lang": "en" | "de", "text": str, "en": English translation (de lines only)}}],
"questions": [{{"q": str, "options": [3 short options], "answer": index of the right option}}]}}"""


def _unknown(item: dict, allowed: set[str], names: set[str]) -> list[str]:
    return sorted({t for t in german_tokens(item) if t not in allowed and t not in names})


def generate(n: int) -> dict:
    b = bible()
    prev = [l for l in lessons() if l["lesson"]["n"] < n]
    lad = ladder()
    by_id = {w["id"]: w for w in lad}
    met_ids = {w["id"] for w in db.rows("SELECT id FROM words")} | {nw["id"] for p in prev for nw in p["lesson"]["new_words"]}
    met = [by_id[i] for i in sorted(met_ids) if i in by_id]
    candidates = [w for w in lad if w["id"] not in met_ids][:16]
    names = {t.lower() for c in b["characters"] for t in WORD.findall(c["name"])}
    stats = pace_stats()

    feedback, unknown, out = "", [], None
    for attempt in range(2):
        out = coach._json(coach._ask(coach.SMART, LESSON_SYSTEM, _lesson_prompt(n, b, prev, met, candidates, stats, feedback), 12000))
        new = [{**nw, "forms": sorted(set(by_id[nw["id"]]["forms"]) | set(WORD.findall(nw["de"].lower())))}
               for nw in out["new_words"] if nw.get("id") in by_id]
        allowed = {f for w in met for f in w["forms"]} | {f for w in new for f in w["forms"]}
        allowed |= {t for r in db.rows("SELECT front FROM cards") for t in WORD.findall(r["front"].lower())}
        unknown = _unknown({"lines": out["lines"]}, allowed, names)
        if len(unknown) <= 2:
            break
        feedback = (f"A previous draft used German words the learner has not met: {', '.join(unknown)}. "
                    "Rewrite so German uses only met words, the new words and names; say anything else in English.")
    item = {
        "id": f"lesson-{n:02d}", "kind": "lesson", "series": f"{SERIES}: {b['title']}", "title": f"{n}. " + re.sub(r"^\s*(episode\s*)?\d+[.:]\s*", "", out["title"], flags=re.I),
        "order": n, "level": "A0" if n < 15 else "A1", "generated": True,
        "summary": out.get("summary"),
        "source": {"name": "Written by Claude", "url": None, "note": "Generated for personal study"},
        "media": None, "external_link": None,
        "lesson": {"n": n, "new_words": new, "questions": out.get("questions", []),
                   "pace_reason": out.get("pace_reason"), "unknown_words": unknown, "stats_at_writing": stats},
        "lines": [{"id": f"l{i + 1}", **{k: v for k, v in l.items() if k in ("speaker", "lang", "text", "en")}}
                  for i, l in enumerate(out["lines"])],
    }
    content.save(item)
    db.log("lesson_written", item["id"], new_words=[w["de"] for w in new], unknown=unknown)
    return item


def generate_next() -> dict:
    with _gen_lock:
        ls = lessons()
        return generate((ls[-1]["lesson"]["n"] if ls else 0) + 1)


def keep_one_ahead() -> None:
    """After a lesson is finished, write the next one in the background so a block can start at once."""
    def run():
        if all(_done(l["id"]) for l in lessons()):
            generate_next()
    threading.Thread(target=run, daemon=True).start()


def status() -> dict:
    ls = lessons()
    states = word_states()
    nxt = next((l for l in ls if not _done(l["id"])), None)
    return {
        "lessons_written": len(ls), "lessons_done": sum(_done(l["id"]) for l in ls),
        "next_lesson": nxt and {"id": nxt["id"], "title": nxt["title"], "new_words": [w["de"] for w in nxt["lesson"]["new_words"]],
                               "summary": nxt.get("summary")},
        "words_met": len(states), "words_known": sum(w["known"] for w in states),
        "ladder_size": len(ladder()) if LADDER.exists() else 0,
        "recent_words": [{"de": w["de"], "en": w["en"], "known": w["known"]} for w in states[-20:]],
    }
