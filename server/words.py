"""Turning German text into lemmas, and tracking what the learner knows."""

import json
import re
import time
from functools import lru_cache

import simplemma

from . import db, llm, srs

TOKEN = re.compile(r"[A-Za-zÄÖÜäöüß]+(?:-[A-Za-zÄÖÜäöüß]+)*")


def tokens(text: str) -> list[str]:
    return TOKEN.findall(text)


@lru_cache(maxsize=50000)
def lemma_of(token: str) -> str | None:
    """Dictionary lemma for a surface form, or None if it isn't in the dictionary."""
    tries = [token, token.lower(), token.capitalize()]
    for t in tries:
        for cand in (simplemma.lemmatize(t, lang="de"), t):
            for form in (cand, cand.lower(), cand.capitalize()):
                if db.one("SELECT 1 FROM words WHERE lemma=?", (form,)):
                    return form
    return None


def status(lemma: str | None) -> str:
    if not lemma:
        return "new"
    r = db.one("SELECT status FROM word_state WHERE lemma=?", (lemma,))
    return r["status"] if r else "new"


def statuses(toks: list[str]) -> dict:
    out = {}
    for t in set(toks):
        lem = lemma_of(t)
        w = db.one("SELECT gloss, article FROM words WHERE lemma=?", (lem,)) if lem else None
        # words outside the German dictionary are mostly English (in mixed stories) or names: leave them uncoloured
        out[t] = {"lemma": lem or t, "status": status(lem) if lem else "other", "gloss": (w or {}).get("gloss", "")}
    return out


def known_share(text: str) -> float:
    toks = tokens(text)
    if not toks:
        return 1.0
    ok = sum(1 for t in toks if status(lemma_of(t)) in ("known", "learning", "ignored") or lemma_of(t) is None)
    return ok / len(toks)


def word_card_text(lemma: str) -> tuple[str, str, str]:
    w = db.one("SELECT * FROM words WHERE lemma=?", (lemma,)) or {}
    article = (w.get("article") or "")
    shown = f"{article} {lemma}".strip()
    example = w.get("example") or ""
    front = f"{shown}"
    back = f"{w.get('gloss', '')}" + (f"\n{example}" if example else "")
    return front, back, example


def start_learning(lemma: str, source: str, ref: str = "", note: str = "", by_course: bool = False) -> int | None:
    """Mark a lemma as being learned and give it a card. Returns the card id if one was created."""
    now = time.time()
    if not db.one("SELECT 1 FROM word_state WHERE lemma=?", (lemma,)):
        db.x("INSERT INTO word_state (lemma, status, first_ts, first_source, introduced_by_course) VALUES (?,?,?,?,?)",
             (lemma, "learning", now, source, 1 if by_course else 0))
    elif status(lemma) == "ignored":
        return None
    front, back, _ = word_card_text(lemma)
    return srs.add("word", front, back, note or f"Met in {source}", source, ref, lemma=lemma)


def mark_known(lemma: str, source: str = "app") -> None:
    db.x("INSERT INTO word_state (lemma, status, first_ts, first_source) VALUES (?, 'known', ?, ?) "
         "ON CONFLICT(lemma) DO UPDATE SET status='known'", (lemma, time.time(), source))


def ignore(lemma: str) -> None:
    db.x("INSERT INTO word_state (lemma, status, first_ts, first_source) VALUES (?, 'ignored', ?, 'app') "
         "ON CONFLICT(lemma) DO UPDATE SET status='ignored'", (lemma, time.time()))
    db.x("UPDATE cards SET suspended=1 WHERE kind='word' AND lemma=?", (lemma,))
    db.log("lookup", f'Stopped tracking "{lemma}"')


def seen(text: str) -> None:
    """Count every learning word in a text as seen once."""
    for t in set(tokens(text)):
        lem = lemma_of(t)
        if lem:
            db.x("UPDATE word_state SET seen = seen + 1 WHERE lemma=?", (lem,))


@lru_cache(maxsize=4000)
def _contextual(word: str, sentence: str) -> dict:
    return llm.ask_json(
        f'German sentence: "{sentence}"\nWord clicked: "{word}"\n'
        'Return JSON: {"lemma": dictionary form (nouns capitalised), "article": "der/die/das or empty", '
        '"meaning": "English meaning of the word in this sentence, 1-5 words", '
        '"note": "optional: one short grammar hint if the form is tricky (e.g. past participle of gehen), else empty"}',
        model=llm.FAST, max_tokens=300)


def lookup(word: str, sentence: str, source: str, ref: str = "", title: str = "") -> dict:
    lem = lemma_of(word)
    w = db.one("SELECT * FROM words WHERE lemma=?", (lem,)) if lem else None
    ctx = {}
    if sentence:
        try:
            ctx = _contextual(word, sentence)
        except Exception as e:  # shown to the learner as missing context, logged for us
            db.log("agent", f"Contextual gloss failed: {e}")
    lem = lem or ctx.get("lemma") or word
    if not w and ctx.get("lemma"):
        # outside the ranked dictionary: still learnable, store it
        db.x("INSERT OR IGNORE INTO words (lemma, rank, gloss, article, example) VALUES (?,?,?,?,?)",
             (lem, None, ctx.get("meaning", ""), ctx.get("article") or None, sentence))
        w = db.one("SELECT * FROM words WHERE lemma=?", (lem,))
    before = status(lem)
    card = None
    if before == "new":
        card = start_learning(lem, source, ref, note=f'Looked up in {title or source}: "{sentence[:120]}"')
    else:
        db.x("UPDATE word_state SET lookups = lookups + 1 WHERE lemma=?", (lem,))
        # looking a learning word up again means it wasn't remembered: bring the card forward
        db.x("UPDATE cards SET due=? WHERE kind='word' AND lemma=? AND due > ?", (time.time(), lem, time.time()))
    db.log("lookup", f'Looked up "{word}" in {title or source}', source, lemma=lem, sentence=sentence)
    return {"lemma": lem, "gloss": (w or {}).get("gloss", ""), "article": (w or {}).get("article") or "",
            "contextual": ctx.get("meaning", ""), "note": ctx.get("note", ""),
            "status": status(lem), "was": before, "card_added": bool(card)}
