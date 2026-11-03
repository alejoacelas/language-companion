"""Audio course lessons: Claude writes each lesson script; the database remembers every item across lessons.

A lesson script (data/course/lesson-NN.json) holds an opening dialogue, the new items in teaching order,
combinations the learner builds from items they already know, and the earlier items to review.
The browser player turns the script into timed audio and decides when each item comes back.
"""

import json
import re
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from server import coach, db, progress

ROOT = Path(__file__).resolve().parent.parent
DIR = ROOT / "data" / "course"
LADDER = ROOT / "data" / "curriculum" / "ladder.json"

# Gaps between lessons for an item recalled well, in days. Inside a lesson the player uses 5 s, 25 s, 2 min, 10 min.
LONG_TERM_DAYS = [1, 5, 25, 120, 730]
PASS_SHARE = 0.8  # below this share of correct recalls, the learner should repeat the lesson

VOICES = {"narrator": "af_heart", "m": "thorsten", "f": "openai:coral"}
# Fixed narrator phrases the player uses; generated with each lesson so playback never waits for them.
STOCK_PHRASES = [
    "Listen and repeat.", "Listen again.", "Say it again.", "Now say the whole word.", "Once more.",
    "Repeat each part after the speaker, starting at the end.", "Listen to the conversation.",
    "Listen to the conversation again. This time you'll understand it.", "Try to say it.", "Let's go on.",
]

db.con.executescript("""
CREATE TABLE IF NOT EXISTS course_items (
  key TEXT PRIMARY KEY,           -- "L03-i2": lesson number and item id
  lesson INTEGER NOT NULL,
  de TEXT NOT NULL, en TEXT NOT NULL,
  cues TEXT NOT NULL,             -- JSON list of English prompts
  introduced INTEGER DEFAULT 0,   -- 0 until the player has taught it
  lt_step INTEGER DEFAULT 0,      -- index into LONG_TERM_DAYS
  due TEXT,                       -- next time it should be reviewed
  recalls INTEGER DEFAULT 0, misses INTEGER DEFAULT 0,
  last_ts TEXT
);
CREATE TABLE IF NOT EXISTS course_runs (
  id INTEGER PRIMARY KEY, lesson INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
  score REAL, results TEXT
);
""")


def path(n: int) -> Path:
    return DIR / f"lesson-{n:02d}.json"


def get(n: int) -> dict | None:
    p = path(n)
    if not p.exists():
        return None
    lesson = json.loads(p.read_text())
    lesson["tips"] = TIPS
    return lesson


def numbers() -> list[int]:
    return sorted(int(m.group(1)) for p in DIR.glob("lesson-*.json") if (m := re.match(r"lesson-(\d+)\.json", p.name)))


def runs(n: int) -> list[dict]:
    return db.rows("SELECT id, lesson, started_at, ended_at, score FROM course_runs WHERE lesson=? AND ended_at IS NOT NULL ORDER BY id", n)


def passed(n: int) -> bool:
    return any((r["score"] or 0) >= PASS_SHARE for r in runs(n))


def overview() -> dict:
    ls = []
    for n in numbers():
        l = get(n)
        rs = runs(n)
        ls.append({"n": n, "title": l["title"], "scenario": l["scenario"], "items": [i["de"] for i in l["items"]],
                   "runs": len(rs), "best": max((r["score"] or 0 for r in rs), default=None), "passed": passed(n)})
    nxt = next((l["n"] for l in ls if not l["passed"]), None)
    return {"lessons": ls, "next": nxt, "pass_share": PASS_SHARE, "generating": _generating.is_set(),
            "items_known": db.one("SELECT COUNT(*) n FROM course_items WHERE introduced=1")["n"]}


# ---------- review selection ----------

def _now() -> datetime:
    return datetime.now(timezone.utc)


def review_items(before_lesson: int, limit: int = 8) -> list[dict]:
    """Earlier items to bring back: everything from the previous lesson, then the most overdue and weakest."""
    rows = db.rows("SELECT * FROM course_items WHERE introduced=1 AND lesson < ? ORDER BY due", before_lesson)
    now = _now().isoformat()
    prev = [r for r in rows if r["lesson"] == before_lesson - 1]
    due = [r for r in rows if r["lesson"] < before_lesson - 1 and (r["due"] or "") <= now]
    due.sort(key=lambda r: (-(r["misses"] - r["recalls"] / 3), r["due"] or ""))
    picked = (prev + due)[:limit]
    return [{"key": r["key"], "de": r["de"], "en": r["en"], "cues": json.loads(r["cues"])} for r in picked]


def carryover(before_lesson: int) -> list[dict]:
    """Items the previous lesson ran out of time to teach."""
    return [{"de": r["de"], "en": r["en"]} for r in
            db.rows("SELECT de, en FROM course_items WHERE lesson=? AND introduced=0", before_lesson - 1)]


def next_ladder_words(k: int = 25) -> list[str]:
    if not LADDER.exists():
        return []
    taught = " ".join(r["de"].lower() for r in db.rows("SELECT de FROM course_items"))
    words = set(re.findall(r"[\wäöüß]+", taught))
    out = []
    for w in json.loads(LADDER.read_text()):
        if not (set(w["forms"]) & words):
            out.append(f"{w['de']} = {w['en']}")
        if len(out) >= k:
            break
    return out


# ---------- writing a lesson ----------

SYSTEM = """You write lessons for a spoken-only German course in the tradition of graduated-interval-recall audio courses.
The learner is an adult starting from zero: native Spanish, fluent English. Lessons are 15 minutes of audio, no reading.
Method you must follow:
- Teach a small set of high-value items (words or short phrases) inside one practical situation.
- The learner always produces language: an English cue asks them to say something, they answer aloud, then a native speaker gives the answer.
- New combinations come from parts the learner already knows; the learner is asked to try them before hearing them.
- Long or hard words are learned by repeating parts from the END of the word backwards ("-gung", "-digung", "-schuldigung", "Entschuldigung").
- Almost no grammar explanation: at most one short note per item, only when it prevents a likely mistake.
- German must be correct, natural, standard spoken German. Use formal Sie between strangers.
Reply with JSON only."""

PROMPT = """Write lesson {n}.

Items already taught in earlier lessons (reuse them in the dialogue and combinations): {known}
Earlier items the course will review in this lesson (use several in combinations): {review}
{carry}Preferred new vocabulary, most useful first (from the episodes the learner will watch later; take what fits the situation): {ladder}
The learner's recurring pronunciation errors (expected→heard): {issues}
{previous}

Requirements:
- 6 to 8 new items in teaching order, each 1 to 5 words. Lesson 1 starts from nothing.
- 3 to 5 combinations: short sentences built only from new and earlier items, ordered so each needs only items taught before it.
- A dialogue of 6 to 10 short lines between two people (one man "m", one woman "f") that uses only taught items and combinations
  (a few function words are fine). The learner later plays the part named in learner_speaker.
- Cues are English, spoken by a narrator. The first cue is direct ("How do you say 'excuse me'?"). Add one or two role-play
  cues that ask for the same German in the situation ("You want to get a passer-by's attention. What do you say?").
  A cue must make the exact German answer unambiguous. A role-play cue sets up a situation; it never says "again"
  and never gives pronunciation hints (put those in "note").
- buildup: only for items with three or more syllables or a hard sound cluster. Pieces from the end of the item backwards,
  written in German spelling, each a pronounceable syllable sequence, the last piece being the full item. Otherwise [].
- intro_en: one narrator sentence introducing the item, e.g. "Here's how you say 'excuse me'."

Return JSON:
{{"title": short English title, "scenario": one English sentence setting the scene,
 "speakers": {{"m": English role, "f": English role}}, "learner_speaker": "m" or "f",
 "dialogue": [{{"speaker": "m"|"f", "de": str, "en": str}}],
 "items": [{{"id": "i1", "de": str, "en": str, "intro_en": str, "cues": [str], "buildup": [str], "note": str or ""}}],
 "combos": [{{"id": "c1", "de": str, "en": str, "cues": [str], "uses": [item ids or earlier German items]}}]}}"""


def _known_items(before: int) -> list[str]:
    return [f"{r['de']} = {r['en']}" for r in db.rows("SELECT de, en FROM course_items WHERE introduced=1 AND lesson < ?", before)]


def write(n: int) -> dict:
    review = review_items(n)
    carry = carryover(n)
    prev = get(n - 1)
    issues = ", ".join(f"{i['expected']}→{i['heard']} ({i['example_word']})" for i in progress.pronunciation_issues(top=6))
    user = PROMPT.format(
        n=n, known="; ".join(_known_items(n)) or "none (first lesson)",
        review="; ".join(f"{r['de']} = {r['en']}" for r in review) or "none",
        carry=(f"Items the previous lesson ran out of time for; teach these first: {'; '.join(c['de'] + ' = ' + c['en'] for c in carry)}\n" if carry else ""),
        ladder="; ".join(next_ladder_words()) or "none",
        issues=issues or "none recorded yet",
        previous=(f"Previous lesson's situation: {prev['scenario']}. Continue the same story or move to a related everyday situation."
                  if prev else ""))
    lesson = coach._json(coach._ask(coach.SMART, SYSTEM, user, 6000))
    lesson.update(n=n, review=review, voices=VOICES, written_at=db.now())
    DIR.mkdir(parents=True, exist_ok=True)
    path(n).write_text(json.dumps(lesson, ensure_ascii=False, indent=1))
    for it in lesson["items"] + lesson.get("combos", []):
        db.run("INSERT OR REPLACE INTO course_items (key, lesson, de, en, cues, introduced) VALUES (?,?,?,?,?,0)",
               f"L{n:02d}-{it['id']}", n, it["de"], it["en"], json.dumps(it["cues"], ensure_ascii=False))
    db.log("course_lesson_written", f"course-L{n:02d}", title=lesson["title"])
    prerender(lesson)
    return lesson


def phrases(lesson: dict) -> list[tuple[str, str, str]]:
    """Every (text, lang, voice) the player may need for this lesson."""
    v = lesson["voices"]
    out = [(p, "en", v["narrator"]) for p in STOCK_PHRASES] + [(t["text"], "en", v["narrator"]) for t in TIPS]
    out += [(f"Lesson {lesson['n']}. {lesson['scenario']}", "en", v["narrator"]),
            (f"Now you are the {lesson['speakers'][lesson['learner_speaker']]}.", "en", v["narrator"]),
            (f"That's the end of lesson {lesson['n']}.", "en", v["narrator"])]
    for d in lesson["dialogue"]:
        out.append((d["de"], "de", v[d["speaker"]]))
        if d["speaker"] == lesson["learner_speaker"]:
            out.append((f"Say: {d['en']}", "en", v["narrator"]))
    for it in lesson["items"] + lesson.get("combos", []) + lesson.get("review", []):
        out += [(it["de"], "de", v["m"]), (it["de"], "de", v["f"])]
        out += [(c, "en", v["narrator"]) for c in it.get("cues", [])]
        out += [(it[k], "en", v["narrator"]) for k in ("intro_en", "note") if it.get(k)]
        out += [(b, "de", v["m"]) for b in it.get("buildup", [])]
    return list(dict.fromkeys(out))


def prerender(lesson: dict) -> None:
    from server.speech import tts
    for text, lang, voice in phrases(lesson):
        tts.speak(text, lang=lang, voice=voice)


# Spoken once per lesson, the first time the learner gets one of these sounds wrong. From a Spanish speaker's starting point.
TIPS = [
    {"id": "ü", "phones": ["y", "yː", "ʏ"], "text": "For the German ü, say the Spanish i, then round your lips tightly as for u, without moving your tongue."},
    {"id": "ö", "phones": ["ø", "øː", "œ"], "text": "For the German ö, say the Spanish e, then round your lips as for o, without moving your tongue."},
    {"id": "ä", "phones": ["ɛ", "ɛː"], "text": "The German ä is an open e, a little wider than the e in perro."},
    {"id": "ich", "phones": ["ç"], "text": "This ch is soft: whisper the y of the Spanish word ya, with your tongue high. Not sh, and not the Spanish j."},
    {"id": "ach", "phones": ["x"], "text": "After a, o or u, the ch is like a soft Spanish j, as in jamón."},
    {"id": "r", "phones": ["ʁ"], "text": "The German r is made at the back of the throat, like a soft gargle. Never tap or roll it."},
    {"id": "er", "phones": ["ɐ"], "text": "At the end of a syllable, the r turns into a short, relaxed a sound."},
    {"id": "schwa", "phones": ["ə"], "text": "An unstressed e is a weak, short uh sound, never a full Spanish e."},
    {"id": "z", "phones": ["ts"], "text": "The German z is always ts, as in pizza."},
    {"id": "h", "phones": ["h"], "text": "The German h is a breath, softer than the Spanish j."},
]


_generating = threading.Event()


def ensure_next_written() -> None:
    """Write the lesson after the last one in the background, so it is ready when the learner gets there."""
    if _generating.is_set():
        return
    n = (numbers() or [0])[-1] + 1

    def job():
        try:
            write(n)
        finally:
            _generating.clear()
    _generating.set()
    threading.Thread(target=job, daemon=True).start()


# ---------- results ----------

def start_run(n: int) -> int:
    return db.run("INSERT INTO course_runs (lesson, started_at) VALUES (?,?)", n, db.now())


def finish_run(run_id: int, n: int, results: dict) -> dict:
    """Store a finished lesson and move each item's next review date.

    results = {"items": {item_key: {"introduced": bool, "recalls": int, "misses": int, "reached": int}}, "seconds": int}
    """
    items = results.get("items", {})
    ok = sum(r["recalls"] for r in items.values())
    total = ok + sum(r["misses"] for r in items.values())
    score = round(ok / total, 2) if total else None
    db.run("UPDATE course_runs SET ended_at=?, score=?, results=? WHERE id=?",
           db.now(), score, json.dumps(results, ensure_ascii=False), run_id)
    for key, r in items.items():
        row = db.one("SELECT * FROM course_items WHERE key=?", key)
        if not row or not (r.get("introduced") or row["introduced"]):
            continue
        # Reaching the 10-minute recall with at most one miss counts as a good lesson for the item.
        good = r.get("reached", 0) >= 3 and r["misses"] <= 1 or (row["lesson"] < n and r["misses"] == 0 and r["recalls"] > 0)
        step = min(row["lt_step"] + 1, len(LONG_TERM_DAYS) - 1) if good and row["introduced"] else 0
        due = (_now() + timedelta(days=LONG_TERM_DAYS[step] if good else 1)).isoformat()
        db.run("UPDATE course_items SET introduced=1, lt_step=?, due=?, recalls=recalls+?, misses=misses+?, last_ts=? WHERE key=?",
               step, due, r["recalls"], r["misses"], db.now(), key)
    db.log("course_lesson_done", f"course-L{n:02d}", score=score, seconds=results.get("seconds"),
           passed=score is not None and score >= PASS_SHARE)
    if score is not None and score >= PASS_SHARE and n == numbers()[-1]:
        ensure_next_written()
    return {"score": score, "passed": score is not None and score >= PASS_SHARE}
