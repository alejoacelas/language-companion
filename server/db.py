"""One SQLite database shared by every part of the app.

Every surface writes events; tables below are the current state derived from them.
"""

import json
import os
import sqlite3
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DB_PATH = Path(os.environ.get("APP_DB", DATA / "app.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ts REAL NOT NULL,
  kind TEXT NOT NULL,          -- review, card, input, lookup, watch, speak, lesson, agent, settings, course
  source TEXT,                 -- app, youtube, netflix, granola, ...
  summary TEXT NOT NULL,       -- one human-readable line
  payload TEXT                 -- json
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);

-- dictionary: lemmas ranked by frequency
CREATE TABLE IF NOT EXISTS words (
  lemma TEXT PRIMARY KEY,
  rank INTEGER,
  gloss TEXT,                  -- short English meaning
  article TEXT,                -- der/die/das for nouns
  example TEXT                 -- short German example sentence
);
CREATE INDEX IF NOT EXISTS words_rank ON words(rank);

-- what the learner knows about each lemma
CREATE TABLE IF NOT EXISTS word_state (
  lemma TEXT PRIMARY KEY,
  status TEXT NOT NULL,        -- learning, known, ignored
  first_ts REAL,
  first_source TEXT,
  seen INTEGER DEFAULT 0,
  lookups INTEGER DEFAULT 0,
  introduced_by_course INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,          -- word, correction, pronunciation
  lemma TEXT,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  note TEXT,                   -- where it came from and why
  source TEXT,                 -- course, story, youtube, netflix, speak, lesson
  source_ref TEXT,
  fsrs TEXT NOT NULL,          -- serialized fsrs Card
  due REAL NOT NULL,
  created_ts REAL NOT NULL,
  suspended INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS cards_due ON cards(due);
CREATE UNIQUE INDEX IF NOT EXISTS cards_word ON cards(lemma) WHERE kind = 'word';

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL,
  ts REAL NOT NULL,
  rating INTEGER NOT NULL
);

-- recurring mistakes, grouped by a short category label
CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY,
  ts REAL NOT NULL,
  source TEXT NOT NULL,        -- speak, lesson
  source_ref TEXT,
  category TEXT NOT NULL,      -- e.g. "sein with motion verbs"
  wrong TEXT,
  right TEXT,
  explanation TEXT,
  self_corrected INTEGER DEFAULT 0,
  card_id INTEGER
);

-- anything to listen to or read: generated stories, podcasts, articles, videos
CREATE TABLE IF NOT EXISTS content (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,          -- story, dialogue, podcast, article, youtube, netflix
  title TEXT NOT NULL,
  url TEXT,
  external_id TEXT,
  sentences TEXT NOT NULL,     -- json [{de, en, start, end}]
  audio TEXT,                  -- file name under data/audio
  new_words TEXT,              -- json list of lemmas this text introduces
  created_ts REAL NOT NULL,
  finished_ts REAL,
  progress INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS content_ext ON content(kind, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,          -- speak, lesson
  started REAL NOT NULL,
  ended REAL,
  title TEXT,
  meta TEXT                    -- json
);

CREATE TABLE IF NOT EXISTS utterances (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL,
  ts REAL NOT NULL,
  speaker TEXT NOT NULL,       -- me, ai, tutor
  text TEXT NOT NULL,
  extra TEXT                   -- json
);

-- practice time per source per day, in seconds
CREATE TABLE IF NOT EXISTS practice (
  day TEXT NOT NULL,
  source TEXT NOT NULL,
  seconds REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
"""

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None


def conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        c = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.executescript(SCHEMA)
        _conn = c
    return _conn


def q(sql: str, args=()) -> list[dict]:
    with _lock:
        return [dict(r) for r in conn().execute(sql, args).fetchall()]


def one(sql: str, args=()) -> dict | None:
    rows = q(sql, args)
    return rows[0] if rows else None


def x(sql: str, args=()) -> int:
    with _lock:
        cur = conn().execute(sql, args)
        return cur.lastrowid


def log(kind: str, summary: str, source: str = "app", **payload) -> None:
    x("INSERT INTO events (ts, kind, source, summary, payload) VALUES (?,?,?,?,?)",
      (time.time(), kind, source, summary, json.dumps(payload, ensure_ascii=False) if payload else None))


def add_practice(source: str, seconds: float) -> None:
    day = time.strftime("%Y-%m-%d")
    x("INSERT INTO practice (day, source, seconds) VALUES (?,?,?) "
      "ON CONFLICT(day, source) DO UPDATE SET seconds = seconds + excluded.seconds",
      (day, source, seconds))


def setting(key: str, default=None):
    r = one("SELECT value FROM settings WHERE key = ?", (key,))
    return json.loads(r["value"]) if r else default


def set_setting(key: str, value) -> None:
    x("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      (key, json.dumps(value)))
