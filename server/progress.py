"""A compact picture of the learner's recent activity and progress, shared by the coach and the MCP server."""

import json
from collections import Counter
from datetime import datetime, timedelta, timezone

from . import content, db, srs


def _since(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def recent_activity(days: int = 7, limit: int = 200) -> list[dict]:
    out = []
    for e in db.rows("SELECT ts, block_id, type, item_id, payload FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT ?",
                     _since(days), limit):
        e["payload"] = json.loads(e["payload"] or "{}")
        out.append(e)
    return out


def pronunciation_issues(days: int = 30, top: int = 12) -> list[dict]:
    """Most frequent expected→heard phone confusions in recent attempts."""
    counts: Counter = Counter()
    examples: dict = {}
    for a in db.rows("SELECT text_de, result FROM attempts WHERE ts >= ?", _since(days)):
        res = json.loads(a["result"])
        for w in res.get("words", []):
            for p in w.get("phones", []):
                if p.get("status") in ("substituted", "missing"):
                    key = (p.get("expected"), p.get("heard") or "∅")
                    counts[key] += 1
                    examples.setdefault(key, w.get("word"))
    return [{"expected": k[0], "heard": k[1], "count": n, "example_word": examples[k]}
            for k, n in counts.most_common(top)]


def blocks(limit: int = 10) -> list[dict]:
    out = []
    for b in db.rows("SELECT * FROM blocks ORDER BY id DESC LIMIT ?", limit):
        b["plan"] = json.loads(b["plan"]) if b["plan"] else None
        out.append(b)
    return out


def streak() -> int:
    days = {r["d"] for r in db.rows("SELECT DISTINCT substr(started_at,1,10) d FROM blocks WHERE ended_at IS NOT NULL")}
    n, day = 0, datetime.now(timezone.utc).date()
    if day.isoformat() not in days:
        day -= timedelta(days=1)
    while day.isoformat() in days:
        n += 1
        day -= timedelta(days=1)
    return n


def summary() -> dict:
    """Everything a coach model needs, kept small enough to paste into a prompt."""
    attempts = db.rows("SELECT score FROM attempts WHERE ts >= ? AND score IS NOT NULL", _since(14))
    items = content.catalog()
    return {
        "today": datetime.now(timezone.utc).date().isoformat(),
        "blocks_completed": db.one("SELECT COUNT(*) n FROM blocks WHERE ended_at IS NOT NULL")["n"],
        "streak_days": streak(),
        "cards": srs.stats(),
        "known_words_sample": [r["front"] for r in db.rows("SELECT front FROM cards ORDER BY id DESC LIMIT 60")],
        "pronunciation": {
            "attempts_14d": len(attempts),
            "avg_score_14d": round(sum(a["score"] for a in attempts) / len(attempts), 2) if attempts else None,
            "top_issues": pronunciation_issues(),
        },
        "items_done": [i["id"] for i in items if i["status"] == "done"],
        "items_in_progress": [i["id"] for i in items if i["status"] == "started"],
        "recent_blocks": [{"id": b["id"], "started_at": b["started_at"], "summary": b["summary"]} for b in blocks(5)],
    }
