"""Talking with the AI: it waits for the learner to fix mistakes before giving the answer,
and writes every mistake into the shared database."""

import json
import time

from . import course, db, llm, srs, words

SYSTEM = """You are a warm, patient German conversation partner for an adult learning German from zero
(native Spanish, fluent English). You are talking by voice; the learner's words reach you as a
verbatim transcript that keeps their mistakes.

How to respond to each learner turn:
1. If the learner's German has a mistake that matters (grammar, word order, gender, verb form, wrong word),
   do NOT give the correct version yet. Prompt them to fix it themselves: point to where the problem is,
   briefly, in simple German (e.g. "Fast! Noch mal: Gestern …" or "Der, die oder das Popcorn?").
   Pick only the single most important mistake. Ignore tiny slips that don't block meaning.
2. If this is their second try at the same mistake and it is still wrong, give the correct form clearly
   once ("Gestern bin ich ins Kino gegangen."), then carry on with the conversation.
3. If they fixed it, praise briefly and carry on.
4. If they used English because they didn't know a word, give them the German word and ask them to say the sentence.
5. Otherwise, reply naturally and ask a follow-up question that makes them use the target words or grammar.
Keep replies to 1-2 short sentences, at the learner's level, mostly known words. Speak German.
Steer the conversation towards today's target words and their recurring mistakes, but keep it a real conversation.

Return JSON only:
{"reply": "what you say (German)",
 "reply_en": "English translation of your reply",
 "mistake": null or {"category": "short reusable label in English, e.g. 'sein with motion verbs', 'noun gender', 'verb second word order', 'past participle form', 'case after preposition'",
                      "wrong": "the learner's wrong phrase", "right": "the corrected phrase",
                      "explanation": "one short English sentence", "status": "prompted" | "corrected_by_ai" | "self_corrected"},
 "words_used_well": ["lemmas of target or learning words the learner used correctly"],
 "english_words": ["English words the learner used for lack of German"]}
"""


def _context() -> str:
    st = course.day_state()
    errs = course.recurring_errors(5)
    known, learning = [], []
    for r in db.q("SELECT lemma, status FROM word_state WHERE status IN ('known','learning') ORDER BY first_ts DESC LIMIT 500"):
        (known if r["status"] == "known" else learning).append(r["lemma"])
    return (f"Learner vocabulary: {len(known) + len(learning)} words.\n"
            f"Today's target words: {', '.join(st['new_words'])}\n"
            f"Learning words: {', '.join(learning[:200])}\n"
            f"Known words: {', '.join(known[:300])}\n"
            f"Recurring mistakes to steer towards: {'; '.join(f"{e['category']} ({e['n']}x)" for e in errs) or 'none yet'}")


def start(topic: str = "") -> dict:
    ctx = _context()
    opener = llm.ask_json(
        ctx + (f"\nTopic the learner chose: {topic}" if topic else "") +
        "\nStart the conversation with one short, easy question in German that will make the learner use "
        "today's target words or practise a recurring mistake. "
        'Return JSON {"reply": "...", "reply_en": "...", "topic": "3-6 word English description"}',
        system=SYSTEM, model=llm.SMART, max_tokens=500)
    sid = db.x("INSERT INTO sessions (kind, started, title, meta) VALUES ('speak', ?, ?, ?)",
               (time.time(), opener.get("topic", "Conversation"), json.dumps({"context": ctx})))
    _utter(sid, "ai", opener["reply"], {"en": opener.get("reply_en", "")})
    course.update_day(speak_session=sid)
    db.log("speak", f'Started a conversation: {opener.get("topic", "")}', session_id=sid)
    return {"session_id": sid, **opener}


def _utter(sid: int, speaker: str, text: str, extra: dict | None = None) -> None:
    db.x("INSERT INTO utterances (session_id, ts, speaker, text, extra) VALUES (?,?,?,?,?)",
         (sid, time.time(), speaker, text, json.dumps(extra or {}, ensure_ascii=False)))


def turn(sid: int, said: str) -> dict:
    sess = db.one("SELECT * FROM sessions WHERE id=?", (sid,))
    ctx = json.loads(sess["meta"])["context"]
    history = db.q("SELECT speaker, text FROM utterances WHERE session_id=? ORDER BY id", (sid,))
    _utter(sid, "me", said)
    msgs = [{"role": "user", "content": f"[Context]\n{ctx}\n[The conversation starts. You spoke first.]"}]
    for h in history:
        if h["speaker"] == "ai":
            msgs.append({"role": "assistant", "content": json.dumps({"reply": h["text"]}, ensure_ascii=False)})
        else:
            msgs.append({"role": "user", "content": f"Learner said: {h['text']}"})
    msgs.append({"role": "user", "content": f"Learner said: {said}"})
    # the API needs alternating roles starting with user; merge consecutive user turns
    merged = []
    for m in msgs:
        if merged and merged[-1]["role"] == m["role"]:
            merged[-1]["content"] += "\n" + m["content"]
        else:
            merged.append(m)
    out = llm.ask_json("", system=SYSTEM, model=llm.SMART, max_tokens=800, messages=merged)
    _utter(sid, "ai", out["reply"], {"en": out.get("reply_en", ""), "mistake": out.get("mistake")})
    _record(sid, said, out)
    return out


def _record(sid: int, said: str, out: dict) -> None:
    m = out.get("mistake")
    if m and m.get("category"):
        status = m.get("status", "prompted")
        if status == "self_corrected":
            # mark the most recent open error of this category as fixed by the learner
            prev = db.one("SELECT id FROM errors WHERE source='speak' AND source_ref=? AND category=? "
                          "ORDER BY id DESC LIMIT 1", (str(sid), m["category"]))
            if prev:
                db.x("UPDATE errors SET self_corrected=1 WHERE id=?", (prev["id"],))
            db.log("speak", f'You fixed it yourself: {m.get("right", "")}', session_id=sid)
        elif status == "prompted":
            db.x("INSERT INTO errors (ts, source, source_ref, category, wrong, right, explanation) VALUES (?,?,?,?,?,?,?)",
                 (time.time(), "speak", str(sid), m["category"], m.get("wrong"), m.get("right"), m.get("explanation")))
            db.log("speak", f'Mistake: "{m.get("wrong")}" ({m["category"]})', session_id=sid)
        elif status == "corrected_by_ai":
            err = db.one("SELECT id FROM errors WHERE source='speak' AND source_ref=? AND category=? "
                         "ORDER BY id DESC LIMIT 1", (str(sid), m["category"]))
            cid = srs.add("correction", m.get("wrong", ""), m.get("right", ""),
                          f'{m["category"]}: {m.get("explanation", "")}', "speak", str(sid))
            if err:
                db.x("UPDATE errors SET card_id=? WHERE id=?", (cid, err["id"]))
    for lem in out.get("words_used_well", []) or []:
        card = db.one("SELECT id FROM cards WHERE kind='word' AND lemma=?", (lem,))
        if card:
            srs.push_later(card["id"])
    for en in out.get("english_words", []) or []:
        db.log("speak", f'Needed a word for "{en}"', session_id=sid)


def end(sid: int) -> dict:
    sess = db.one("SELECT * FROM sessions WHERE id=?", (sid,))
    if not sess or sess["ended"]:
        return {"ok": True}
    now = time.time()
    db.x("UPDATE sessions SET ended=? WHERE id=?", (now, sid))
    turns = db.q("SELECT speaker, text FROM utterances WHERE session_id=? ORDER BY id", (sid,))
    mine = [t["text"] for t in turns if t["speaker"] == "me"]
    if mine:
        db.add_practice("speaking", min(now - sess["started"], 60 * 60))
        course.mark_done("speak")
    db.log("speak", f"Conversation ended: {len(mine)} things you said", session_id=sid)
    return {"ok": True, "turns": len(mine)}


def history(sid: int) -> list[dict]:
    rows = db.q("SELECT speaker, text, extra FROM utterances WHERE session_id=? ORDER BY id", (sid,))
    for r in rows:
        r["extra"] = json.loads(r["extra"] or "{}")
    return rows
