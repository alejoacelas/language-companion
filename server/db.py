"""SQLite storage for cards, reviews, pronunciation attempts, blocks and the activity log."""

import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
DB_PATH = Path(os.environ.get("APP_DB") or DATA / "app.db")  # APP_DB points tests at a scratch database

SCHEMA = """
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY,
  front TEXT NOT NULL,            -- German word or expression
  back TEXT NOT NULL,             -- English meaning
  context_de TEXT,                -- the sentence it came from
  context_en TEXT,
  item_id TEXT, line_id TEXT,
  created_at TEXT NOT NULL,
  due TEXT NOT NULL,
  fsrs TEXT NOT NULL,             -- serialized fsrs.Card
  suspended INTEGER DEFAULT 0,    -- 1: never shown for review
  UNIQUE(front)
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY, card_id INTEGER NOT NULL, block_id INTEGER,
  rating INTEGER NOT NULL, ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY, block_id INTEGER, item_id TEXT, line_id TEXT,
  text_de TEXT NOT NULL, score REAL, result TEXT NOT NULL, ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT,
  plan TEXT, summary TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, block_id INTEGER,
  type TEXT NOT NULL, item_id TEXT, payload TEXT
);
CREATE TABLE IF NOT EXISTS item_progress (
  item_id TEXT PRIMARY KEY, status TEXT NOT NULL, last_ts TEXT NOT NULL, seconds INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS glosses (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    DATA.mkdir(exist_ok=True)
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    if "suspended" not in {r[1] for r in con.execute("PRAGMA table_info(cards)")}:
        con.execute("ALTER TABLE cards ADD COLUMN suspended INTEGER DEFAULT 0")
    return con


con = connect()
_lock = threading.RLock()  # FastAPI runs handlers on several threads; they share this one connection


def rows(sql: str, *args) -> list[dict]:
    with _lock:
        return [dict(r) for r in con.execute(sql, args).fetchall()]


def one(sql: str, *args) -> dict | None:
    with _lock:
        r = con.execute(sql, args).fetchone()
    return dict(r) if r else None


def run(sql: str, *args) -> int:
    with _lock:
        cur = con.execute(sql, args)
        con.commit()
        return cur.lastrowid


def log(type_: str, item_id: str | None = None, block_id: int | None = None, **payload) -> None:
    run("INSERT INTO events (ts, block_id, type, item_id, payload) VALUES (?,?,?,?,?)",
        now(), block_id, type_, item_id, json.dumps(payload, ensure_ascii=False))
