"""Spaced repetition with FSRS."""

import json
from datetime import datetime, timezone

from fsrs import Card, Rating, Scheduler

from . import db

scheduler = Scheduler(desired_retention=0.9)


def add(front: str, back: str, context_de=None, context_en=None, item_id=None, line_id=None) -> dict:
    existing = db.one("SELECT * FROM cards WHERE front=?", front)
    if existing:
        return existing
    card = Card()
    cid = db.run(
        "INSERT INTO cards (front, back, context_de, context_en, item_id, line_id, created_at, due, fsrs) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        front, back, context_de, context_en, item_id, line_id, db.now(),
        card.due.isoformat(), json.dumps(card.to_dict()),
    )
    db.log("card_added", item_id, front=front, back=back)
    return db.one("SELECT * FROM cards WHERE id=?", cid)


def due(limit: int = 20) -> list[dict]:
    return db.rows("SELECT * FROM cards WHERE due <= ? ORDER BY due LIMIT ?",
                   datetime.now(timezone.utc).isoformat(), limit)


def review(card_id: int, rating: int, block_id: int | None = None) -> dict:
    row = db.one("SELECT * FROM cards WHERE id=?", card_id)
    card = Card.from_dict(json.loads(row["fsrs"]))
    card, _ = scheduler.review_card(card, Rating(rating))
    db.run("UPDATE cards SET due=?, fsrs=? WHERE id=?", card.due.isoformat(), json.dumps(card.to_dict()), card_id)
    db.run("INSERT INTO reviews (card_id, block_id, rating, ts) VALUES (?,?,?,?)", card_id, block_id, rating, db.now())
    return {"id": card_id, "due": card.due.isoformat()}


def stats() -> dict:
    total = db.one("SELECT COUNT(*) n FROM cards")["n"]
    due_now = db.one("SELECT COUNT(*) n FROM cards WHERE due <= ?", datetime.now(timezone.utc).isoformat())["n"]
    # A card counts as learned once FSRS has scheduled it at least 7 days out.
    learned = 0
    for r in db.rows("SELECT fsrs FROM cards"):
        if (json.loads(r["fsrs"]).get("stability") or 0) >= 7:
            learned += 1
    return {"cards": total, "due": due_now, "learned": learned}
