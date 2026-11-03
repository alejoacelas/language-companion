"""Loads content items from data/content (see docs/content-schema.md)."""

import json
from pathlib import Path

from . import db

CONTENT = db.DATA / "content"


def _load() -> dict[str, dict]:
    items = {}
    for p in sorted(CONTENT.glob("*.json")):
        try:
            d = json.loads(p.read_text())
            items[d["id"]] = d
        except (json.JSONDecodeError, KeyError) as e:
            print(f"Skipping {p.name}: {e}")
    return items


def all_items() -> dict[str, dict]:
    # Reload on every call: content files are added while the app runs.
    return _load()


def get(item_id: str) -> dict | None:
    p = CONTENT / f"{item_id}.json"
    return json.loads(p.read_text()) if p.exists() else None


def save(item: dict) -> None:
    CONTENT.mkdir(parents=True, exist_ok=True)
    (CONTENT / f"{item['id']}.json").write_text(json.dumps(item, ensure_ascii=False, indent=2))


def summary(item: dict) -> dict:
    de = [l for l in item.get("lines", []) if l.get("lang") == "de"]
    prog = db.one("SELECT status, last_ts FROM item_progress WHERE item_id=?", item["id"]) or {}
    return {
        "id": item["id"], "kind": item.get("kind"), "series": item.get("series"),
        "title": item.get("title"), "order": item.get("order", 0), "level": item.get("level"),
        "media": (item.get("media") or {}).get("type"), "generated": item.get("generated", False),
        "german_lines": len(de), "status": prog.get("status", "new"), "last_ts": prog.get("last_ts"),
    }


def catalog() -> list[dict]:
    out = [summary(i) for i in all_items().values()]
    out.sort(key=lambda s: (s["series"] or "", s["order"] or 0, s["id"]))
    return out
