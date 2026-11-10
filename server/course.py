"""The course: which words to learn next, and today's plan built around them."""

import threading
import time

from . import db, srs, words

DEFAULT_NEW_PER_DAY = 10
_day_lock = threading.Lock()


def today() -> str:
    return time.strftime("%Y-%m-%d")


def next_new_words(n: int) -> list[str]:
    rows = db.q("SELECT w.lemma FROM words w LEFT JOIN word_state s ON s.lemma = w.lemma "
                "WHERE s.lemma IS NULL AND w.rank IS NOT NULL ORDER BY w.rank LIMIT ?", (n,))
    return [r["lemma"] for r in rows]


def day_state() -> dict:
    """Today's course state, created on first access each day."""
    with _day_lock:
        return _day_state()


def _day_state() -> dict:
    key = f"day:{today()}"
    st = db.setting(key)
    if not db.setting("onboarded"):
        return {"new_words": [], "story_id": None, "speak_session": None, "done": []}
    if st is None:
        n = db.setting("new_per_day", DEFAULT_NEW_PER_DAY)
        new = next_new_words(n)
        for lem in new:
            words.start_learning(lem, "course", today(), note="Today's new word (frequency order)", by_course=True)
        st = {"new_words": new, "story_id": None, "speak_session": None, "done": []}
        db.set_setting(key, st)
        if new:
            db.log("course", f"Today's {len(new)} new words: {', '.join(new)}")
    return st


def update_day(**kw) -> dict:
    with _day_lock:
        st = _day_state()
        st.update(kw)
        db.set_setting(f"day:{today()}", st)
        return st


def mark_done(step: str) -> None:
    with _day_lock:
        st = _day_state()
        if step not in st["done"]:
            st["done"].append(step)
            db.set_setting(f"day:{today()}", st)


def vocab_counts() -> dict:
    r = db.one("SELECT SUM(status='known') known, SUM(status='learning') learning FROM word_state")
    return {"known": r["known"] or 0, "learning": r["learning"] or 0}


def recurring_errors(limit: int = 6, days: int = 30) -> list[dict]:
    since = time.time() - days * 86400
    return db.q("SELECT category, COUNT(*) n, SUM(self_corrected) fixed, MAX(ts) last FROM errors "
                "WHERE ts > ? GROUP BY category ORDER BY n DESC, last DESC LIMIT ?", (since, limit))


def practice_week() -> dict:
    since = time.strftime("%Y-%m-%d", time.localtime(time.time() - 6 * 86400))
    rows = db.q("SELECT source, SUM(seconds) s FROM practice WHERE day >= ? GROUP BY source", (since,))
    return {r["source"]: r["s"] for r in rows}


def total_hours() -> float:
    r = db.one("SELECT SUM(seconds) s FROM practice")
    return (r["s"] or 0) / 3600


def plan() -> dict:
    st = day_state()
    due = srs.due_count()
    steps = [
        {"id": "review", "title": f"Review {due} cards" if due else "Reviews done", "minutes": max(1, round(due * 0.4)),
         "view": "review", "done": due == 0},
        {"id": "listen", "title": "Listen to today's story", "minutes": 8, "view": "listen", "done": "listen" in st["done"]},
        {"id": "speak", "title": "Talk with the AI", "minutes": 10, "view": "speak", "done": "speak" in st["done"]},
        {"id": "tutor", "title": "Tutor lesson (optional)", "minutes": 30, "view": "tutor", "done": "tutor" in st["done"]},
    ]
    return {"date": today(), "new_words": [_word(l) for l in st["new_words"]], "steps": steps,
            "due": due, "story_id": st.get("story_id"), "vocab": vocab_counts(),
            "hours": round(total_hours(), 1), "day_number": _day_number()}


def _word(lemma: str) -> dict:
    w = db.one("SELECT lemma, article, gloss, example FROM words WHERE lemma=?", (lemma,)) or {"lemma": lemma}
    return w


def _day_number() -> int:
    r = db.one("SELECT MIN(ts) t FROM events")
    if not r or not r["t"]:
        return 1
    return int((time.time() - r["t"]) // 86400) + 1
