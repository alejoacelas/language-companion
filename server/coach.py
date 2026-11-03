"""Claude-powered coach: plans blocks, summarises them, glosses words and writes new stories."""

import json
import os
import re

import anthropic

from . import content, db, progress

SMART = "claude-opus-5-5"   # planning, summaries, stories
FAST = "claude-haiku-5-5"   # word glosses, where latency matters

_client = None


def client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    return _client


def _json(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    return json.loads(m.group(0))


def _ask(model: str, system: str, user: str, max_tokens: int = 2000) -> str:
    with client().messages.stream(model=model, max_tokens=max_tokens, system=system,
                                  messages=[{"role": "user", "content": user}]) as s:
        r = s.get_final_message()
    return "".join(b.text for b in r.content if b.type == "text")


COACH_SYSTEM = """You are a German coach for an adult who started from zero (native Spanish, fluent English).
They study in 15-minute blocks built around a ladder of story lessons that add German gradually:
review cards, meet the lesson's new words, read the lesson, practise speaking with a voice coach, answer two questions.
They enjoy material that mixes English narration with German dialogue (DW's "Harry"), and anime (Kaguya-sama, Chainsaw Man).
Be concrete and brief. Reply with JSON only."""


def summarize_block(block_id: int) -> str:
    events = db.rows("SELECT ts, type, item_id, payload FROM events WHERE block_id=? ORDER BY ts", block_id)
    attempts = db.rows("SELECT text_de, score, result FROM attempts WHERE block_id=?", block_id)
    compact = [{"text": a["text_de"], "score": a["score"],
                "errors": [(p.get("expected"), p.get("heard")) for w in json.loads(a["result"]).get("words", [])
                           for p in w.get("phones", []) if p.get("status") in ("substituted", "missing")]}
               for a in attempts]
    user = f"""Events in this block: {json.dumps(events, ensure_ascii=False)}
Pronunciation attempts: {json.dumps(compact, ensure_ascii=False)}
Write 2-3 sentences for the learner: what they did, one specific win, one thing to focus on next. Plain text, no JSON."""
    return _ask(SMART, COACH_SYSTEM.replace("Reply with JSON only.", ""), user, 400).strip()


def gloss(word: str, sentence: str) -> dict:
    key = f"{word}|{sentence}"
    hit = db.one("SELECT value FROM glosses WHERE key=?", key)
    if hit:
        return json.loads(hit["value"])
    user = f"""German word or phrase: "{word}"
In this sentence: "{sentence}"
Return JSON: {{"lemma": dictionary form with article for nouns, "meaning": English meaning in this context (few words),
"card_front": the most useful chunk to memorise (the word, or a short expression from the sentence containing it),
"card_back": English for card_front, "note": optional 1 short grammar note for a beginner or ""}}"""
    out = _json(_ask(FAST, "You are a concise German-English dictionary for a beginner. Reply with JSON only.", user, 300))
    db.run("INSERT OR REPLACE INTO glosses (key, value) VALUES (?,?)", key, json.dumps(out, ensure_ascii=False))
    return out


STORY_SYSTEM = """You write short episodes for an adult beginner learning German, in the style of DW's "Harry – gefangen in der Zeit":
English narration carries the plot; characters speak short, natural, everyday German lines that the narration makes understandable.
German must be correct, natural and present tense, mostly main clauses, high-frequency words. No English-flavoured German.
Reply with JSON only."""


def generate_story(setting: str, level: str = "A1", previous: str | None = None) -> dict:
    state = progress.summary()
    user = f"""Setting: {setting}
Level: {level}. Words the learner has saved recently (reuse several): {', '.join(state['known_words_sample'][:40]) or 'none yet'}
{('Previous episode summary: ' + previous) if previous else 'This is episode 1.'}
Write about 12-18 German lines (3-9 words each) interleaved with English narration. Introduce at most 8 new words.
Return JSON: {{"title": str, "summary": one sentence, "lines": [{{"speaker": str, "lang": "en"|"de", "text": str, "en": English for de lines}}]}}"""
    story = _json(_ask(SMART, STORY_SYSTEM, user, 4000))
    slug = re.sub(r"[^a-z0-9]+", "-", setting.lower()).strip("-")[:30]
    n = 1 + sum(1 for i in content.all_items().values() if i.get("generated") and i.get("series", "").endswith(setting))
    item = {
        "id": f"gen-{slug}-{n:02d}", "kind": "story", "series": f"New stories: {setting}", "title": story["title"],
        "order": n, "level": level, "generated": True,
        "generated_from": {"setting": setting, "level": level, "previous": previous},
        "summary": story.get("summary"),
        "source": {"name": "Written by Claude", "url": None, "note": "Generated for personal study"},
        "media": None, "external_link": None,
        "lines": [{"id": f"l{i+1}", **l} for i, l in enumerate(story["lines"])],
    }
    content.save(item)
    db.log("story_generated", item["id"], setting=setting)
    return item
