"""Spaced-repetition cards, scheduled with FSRS."""

import time
from datetime import datetime, timezone

from fsrs import Card, Rating, Scheduler

from . import db

scheduler = Scheduler(desired_retention=0.9)
RATINGS = {1: Rating.Again, 2: Rating.Hard, 3: Rating.Good, 4: Rating.Easy}


def _ts(dt: datetime) -> float:
    return dt.timestamp()


def add(kind: str, front: str, back: str, note: str = "", source: str = "", source_ref: str = "",
        lemma: str | None = None) -> int | None:
    """Create a card due now. Returns its id, or None if a word card for this lemma exists."""
    if lemma and kind == "word" and db.one("SELECT id FROM cards WHERE kind='word' AND lemma=?", (lemma,)):
        return None
    c = Card()
    cid = db.x("INSERT INTO cards (kind, lemma, front, back, note, source, source_ref, fsrs, due, created_ts) "
               "VALUES (?,?,?,?,?,?,?,?,?,?)",
               (kind, lemma, front, back, note, source, source_ref, c.to_json(), time.time(), time.time()))
    db.log("card", f'New card: {front.replace("___", "…")[:60]}', source or "app", card_id=cid, card_kind=kind)
    return cid


def due(limit: int = 200) -> list[dict]:
    return db.q("SELECT * FROM cards WHERE suspended=0 AND due <= ? ORDER BY due LIMIT ?", (time.time(), limit))


def due_count() -> int:
    return db.one("SELECT COUNT(*) n FROM cards WHERE suspended=0 AND due <= ?", (time.time(),))["n"]


def review(card_id: int, rating: int) -> dict:
    row = db.one("SELECT * FROM cards WHERE id=?", (card_id,))
    card = Card.from_json(row["fsrs"])
    card, _ = scheduler.review_card(card, RATINGS[rating], datetime.now(timezone.utc))
    db.x("UPDATE cards SET fsrs=?, due=? WHERE id=?", (card.to_json(), _ts(card.due), card_id))
    db.x("INSERT INTO reviews (card_id, ts, rating) VALUES (?,?,?)", (card_id, time.time(), rating))
    if row["lemma"] and rating >= 3 and card.stability and card.stability > 21:
        db.x("UPDATE word_state SET status='known' WHERE lemma=? AND status='learning'", (row["lemma"],))
    return {"due": _ts(card.due)}


def push_later(card_id: int, rating: int = 3) -> None:
    """Count using a word correctly elsewhere (e.g. in conversation) as a successful review."""
    row = db.one("SELECT due FROM cards WHERE id=?", (card_id,))
    if row and row["due"] <= time.time() + 86400:
        review(card_id, rating)
