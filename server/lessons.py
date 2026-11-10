"""Tutor lessons: pulled from Granola, then mined for mistakes, corrections and new words.

Granola keeps the learner's microphone and the call audio apart (speaker.source is
"microphone" or "speaker"), so "me" and "tutor" come straight from the recording.
"""

import json
import os
import time
from datetime import datetime, timedelta, timezone

import httpx

from . import db, llm, srs, words

API = "https://public-api.granola.ai/v1"


class GranolaNotConfigured(Exception):
    pass


def _client() -> httpx.Client:
    key = os.environ.get("GRANOLA_API_KEY")
    if not key:
        raise GranolaNotConfigured("GRANOLA_API_KEY is not set")
    return httpx.Client(base_url=API, headers={"Authorization": f"Bearer {key}"}, timeout=30)


def configured() -> bool:
    return bool(os.environ.get("GRANOLA_API_KEY"))


def _german_share(text: str) -> float:
    toks = words.tokens(text)
    if not toks:
        return 0
    return sum(1 for t in toks if words.lemma_of(t)) / len(toks)


def _list_notes(c: httpx.Client, since: str) -> list[dict]:
    notes, cursor = [], None
    while True:
        params = {"created_after": since}
        if cursor:
            params["cursor"] = cursor
        r = c.get("/notes", params=params)
        r.raise_for_status()
        d = r.json()
        notes += d.get("notes", [])
        if not d.get("hasMore"):
            return notes
        cursor = d.get("cursor")


def _transcript(c: httpx.Client, note_id: str) -> list[dict]:
    r = c.get(f"/notes/{note_id}", params={"include": "transcript"})
    if r.status_code == 413:
        r = c.get(f"/notes/{note_id}/transcript")
        r.raise_for_status()
        d = r.json()
        return d.get("transcript", d if isinstance(d, list) else [])
    r.raise_for_status()
    return r.json().get("transcript") or []


def sync() -> dict:
    """Import new German lessons from Granola. Safe to run often."""
    since = db.setting("granola_since") or (datetime.now(timezone.utc) - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    imported, skipped = [], 0
    with _client() as c:
        for n in _list_notes(c, since):
            nid = n["id"]
            if db.one("SELECT 1 FROM sessions WHERE kind='lesson' AND json_extract(meta,'$.granola_id')=?", (nid,)) \
                    or nid in (db.setting("granola_skipped") or []):
                continue
            tr = _transcript(c, nid)
            text = " ".join(t.get("text", "") for t in tr)
            if _german_share(text) < 0.35 or len(text) < 400:
                skipped += 1
                db.set_setting("granola_skipped", (db.setting("granola_skipped") or []) + [nid])
                continue
            imported.append(ingest(n, tr))
    db.set_setting("granola_since", since if not imported and skipped == 0 else started)
    db.set_setting("granola_last_sync", time.time())
    return {"imported": imported, "skipped_not_german": skipped}


def ingest(note: dict, transcript: list[dict]) -> int:
    meeting_at = note.get("meeting_at") or note.get("created_at")
    try:
        started = datetime.fromisoformat(meeting_at.replace("Z", "+00:00")).timestamp()
    except Exception:
        started = time.time()
    lines = []
    for t in transcript:
        src = (t.get("speaker") or {}).get("source", "")
        who = "me" if src == "microphone" else "tutor"
        if t.get("text", "").strip():
            lines.append({"speaker": who, "text": t["text"].strip()})
    sid = db.x("INSERT INTO sessions (kind, started, title, meta) VALUES ('lesson', ?, ?, ?)",
               (started, note.get("title") or "Lesson",
                json.dumps({"granola_id": note["id"], "owner": note.get("owner")})))
    for ln in lines:
        db.x("INSERT INTO utterances (session_id, ts, speaker, text) VALUES (?,?,?,?)",
             (sid, started, ln["speaker"], ln["text"]))
    db.log("lesson", f'Lesson captured from Granola: "{note.get("title")}"', "granola", session_id=sid)
    try:
        analyse(sid)
    except Exception as e:
        db.log("agent", f"Could not analyse lesson {sid}: {e}", "granola")
    return sid


ANALYSE = """Below is the transcript of a German lesson between a beginner learner ("me") and a tutor.
Speaker labels come from separate audio tracks, so they're reliable; the text may have transcription slips.

Return JSON only:
{"tutor": "tutor's first name if said, else null",
 "duration_min": estimated minutes,
 "summary": "2-3 sentence English summary of what was covered",
 "mistakes": [{"category": "short reusable English label, e.g. 'sein with motion verbs', 'noun gender', 'verb second word order'",
               "wrong": "what the learner said", "right": "the correct version (the tutor's correction if given)",
               "explanation": "one short English sentence", "corrected_by_tutor": true/false, "self_corrected": true/false}],
 "new_words": [{"lemma": "dictionary form", "meaning": "English", "example": "sentence from the lesson"}],
 "pronunciation": ["short notes on sounds the tutor corrected, if any"],
 "tutor_requests": ["things the tutor asked the learner to practise or prepare"],
 "next_time": "one sentence: what to work on next time with this tutor"}
Only include mistakes the learner actually made. new_words = German words the learner didn't know (asked for, looked up, or tutor taught).

Transcript:
"""


def analyse(sid: int) -> dict:
    lines = db.q("SELECT speaker, text FROM utterances WHERE session_id=? ORDER BY id", (sid,))
    text = "\n".join(f"{'Me' if l['speaker'] == 'me' else 'Tutor'}: {l['text']}" for l in lines)
    data = llm.ask_json(ANALYSE + text[:150000], max_tokens=8000)
    sess = db.one("SELECT * FROM sessions WHERE id=?", (sid,))
    meta = json.loads(sess["meta"] or "{}")
    meta.update({k: data.get(k) for k in ("tutor", "duration_min", "summary", "pronunciation", "tutor_requests", "next_time")})
    added_cards, added_words = 0, 0
    made: dict[tuple, int] = {}  # one card per sentence, even when it has several mistakes
    for m in data.get("mistakes", []):
        card = None
        if m.get("right"):
            key = (m.get("wrong", ""), m["right"])
            if key in made:
                card = made[key]
                db.x("UPDATE cards SET note = note || ? WHERE id=?", (f'; {m.get("category")}: {m.get("explanation", "")}', card))
            else:
                card = made[key] = srs.add("correction", m.get("wrong", ""), m["right"],
                                           f'{m.get("category")}: {m.get("explanation", "")}', "lesson", str(sid))
                added_cards += 1
        db.x("INSERT INTO errors (ts, source, source_ref, category, wrong, right, explanation, self_corrected, card_id) "
             "VALUES (?,?,?,?,?,?,?,?,?)",
             (sess["started"], "lesson", str(sid), m.get("category", "other"), m.get("wrong"), m.get("right"),
              m.get("explanation"), 1 if m.get("self_corrected") else 0, card))
    for w in data.get("new_words", []):
        lem = words.lemma_of(w["lemma"]) or w["lemma"]
        if not db.one("SELECT 1 FROM words WHERE lemma=?", (lem,)):
            db.x("INSERT INTO words (lemma, rank, gloss, example) VALUES (?,?,?,?)",
                 (lem, None, w.get("meaning", ""), w.get("example", "")))
        if words.start_learning(lem, "lesson", str(sid), note=f'From your lesson: "{w.get("example", "")}"'):
            added_words += 1
    for p in data.get("pronunciation", []) or []:
        srs.add("pronunciation", p, "Say it slowly, then at normal speed.", "Tutor's pronunciation note", "lesson", str(sid))
    duration = (data.get("duration_min") or 30) * 60
    meta.update({"cards_added": added_cards, "words_added": added_words, "duration_s": duration})
    db.x("UPDATE sessions SET meta=?, ended=? WHERE id=?", (json.dumps(meta, ensure_ascii=False), sess["started"] + duration, sid))
    db.add_practice("tutor", duration)
    db.log("agent", f"From the lesson{' with ' + data['tutor'] if data.get('tutor') else ''}: "
                    f"{len(data.get('mistakes', []))} mistakes, {added_words} new words, {added_cards} correction cards",
           "granola", session_id=sid)
    return data


def lessons() -> list[dict]:
    rows = db.q("SELECT id, started, ended, title, meta FROM sessions WHERE kind='lesson' ORDER BY started DESC")
    for r in rows:
        r["meta"] = json.loads(r["meta"] or "{}")
    return rows


def tutors() -> list[str]:
    names = []
    for l in lessons():
        t = l["meta"].get("tutor")
        if t and t not in names:
            names.append(t)
    return names


BRIEF = """Write a short message the learner will paste into the italki chat before a German lesson.
Write it in the learner's voice, in English with a German greeting, friendly and concrete, under 140 words.
{first_time}
Use the data below. Mention at most 3 focus points. No headings; a short list is fine. Don't invent facts.

Data:
{data}"""

FIRST = """This tutor hasn't taught the learner before. Include: level (learning from scratch, vocabulary size),
native Spanish and fluent English; how to correct (correct every mistake, let me try to fix it myself first,
then say the correct version clearly once, speak slowly in simple German, end with 2-3 things to practise);
current focus; and ask permission to record the lesson with Granola, a note-taking app, for the learner's own
flashcards (only the learner sees the transcript), saying it's fine to decline."""

AGAIN = """The learner has had lessons with this tutor before. Open with what changed since the last lesson with
them (words learned, mistakes improving or still recurring), then what to focus on today. Remind them in
one line of the correction style. Recording was already agreed; mention it in a few words only."""


def brief(tutor: str) -> str:
    from . import course
    past = [l for l in lessons() if (l["meta"].get("tutor") or "").lower() == tutor.lower()]
    since = past[0]["started"] if past else 0
    learned = db.q("SELECT lemma FROM word_state WHERE first_ts > ? ORDER BY first_ts DESC LIMIT 40", (since,))
    errs = course.recurring_errors(5)
    fixed = db.q("SELECT category, SUM(self_corrected) f, COUNT(*) n FROM errors WHERE ts > ? GROUP BY category", (since,))
    data = {
        "tutor": tutor, "vocabulary_size": course.vocab_counts(),
        "hours_practised": round(course.total_hours(), 1),
        "previous_lessons_with_tutor": [{"date": time.strftime("%d %b", time.localtime(l["started"])),
                                         "summary": l["meta"].get("summary"), "next_time": l["meta"].get("next_time"),
                                         "tutor_requests": l["meta"].get("tutor_requests")} for l in past[:3]],
        "words_learned_since": [r["lemma"] for r in learned],
        "recurring_mistakes": errs, "mistakes_since_last_lesson": fixed,
        "today_new_words": course.day_state()["new_words"],
    }
    return llm.ask(BRIEF.format(first_time=FIRST if not past else AGAIN, data=json.dumps(data, ensure_ascii=False, default=str)),
                   max_tokens=800).strip()
