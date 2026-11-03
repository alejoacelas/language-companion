"""FastAPI app: JSON API under /api, media under /media, the web front end at /."""

import json
import os
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
os.environ.setdefault("HF_HOME", str(ROOT / "data" / "models"))

from . import coach, content, curriculum, db, progress, srs  # noqa: E402

app = FastAPI(title="language-companion")


@app.on_event("startup")
def warm_speech_models():
    # Cold model loads take about 20 s; do them in the background so the first recording is fast.
    import threading

    def warm():
        from .speech import phonemes, tts
        phonemes.warm_up()
        tts.warm_up()
    threading.Thread(target=warm, daemon=True).start()


@app.middleware("http")
async def no_stale_frontend(request, call_next):
    # The front end has no build step, so make the browser revalidate it on every load.
    resp = await call_next(request)
    if not request.url.path.startswith(("/api", "/media")):
        resp.headers["Cache-Control"] = "no-cache"
    return resp

REALTIME_MODEL = "gpt-realtime-2.1"
REALTIME_VOICE = "marin"


# ---------- state and blocks ----------

@app.get("/api/state")
def state():
    sets = curriculum.form_sets()
    cat = content.catalog()
    items = content.all_items()
    for c in cat:
        c["ready"] = curriculum.readiness(items[c["id"]], sets)["known"] if c["id"] in items else None
    return {"progress": progress.summary(), "curriculum": curriculum.status(), "catalog": cat}


@app.post("/api/block/start")
def block_start():
    """A block covers the next lesson: due cards, its new words, the text, speaking, two questions."""
    item = curriculum.next_lesson()
    plan = {"item_id": item["id"], "why": item.get("summary"),
            "focus_sounds": [i["expected"] for i in progress.pronunciation_issues(top=2)]}
    block_id = db.run("INSERT INTO blocks (started_at, plan) VALUES (?,?)", db.now(), json.dumps(plan, ensure_ascii=False))
    db.log("block_started", item["id"], block_id, plan=plan)
    return {"block_id": block_id, "plan": plan, "cards": srs.due(15), "item": item}


@app.post("/api/item/{item_id}/meet")
def meet(item_id: str, block_id: int | None = None):
    item = content.get(item_id)
    if not item or item.get("kind") != "lesson":
        raise HTTPException(404, f"No lesson {item_id}")
    return curriculum.meet(item, block_id)


class Quiz(BaseModel):
    item_id: str
    correct: int
    total: int
    block_id: int | None = None


@app.post("/api/quiz")
def quiz(q: Quiz):
    db.log("quiz", q.item_id, q.block_id, correct=q.correct, total=q.total)
    return {"ok": True}


class BlockEnd(BaseModel):
    seconds: int = 0


@app.post("/api/block/{block_id}/end")
def block_end(block_id: int, body: BlockEnd):
    db.log("block_ended", None, block_id, seconds=body.seconds)
    summary = coach.summarize_block(block_id)
    db.run("UPDATE blocks SET ended_at=?, summary=? WHERE id=?", db.now(), summary, block_id)
    return {"summary": summary, "progress": progress.summary(), "curriculum": curriculum.status()}


@app.get("/api/curriculum")
def curriculum_status():
    return curriculum.status()


class Event(BaseModel):
    type: str
    item_id: str | None = None
    block_id: int | None = None
    payload: dict = {}


@app.post("/api/event")
def event(e: Event):
    db.log(e.type, e.item_id, e.block_id, **e.payload)
    return {"ok": True}


# ---------- content ----------

@app.get("/api/catalog")
def catalog():
    return content.catalog()


@app.get("/api/item/{item_id}")
def item(item_id: str):
    it = content.get(item_id)
    if not it:
        raise HTTPException(404, f"No item {item_id}")
    return it


class ItemProgress(BaseModel):
    status: str  # started | done
    seconds: int = 0
    block_id: int | None = None


@app.post("/api/item/{item_id}/progress")
def item_progress(item_id: str, p: ItemProgress):
    db.run("INSERT INTO item_progress (item_id, status, last_ts, seconds) VALUES (?,?,?,?) "
           "ON CONFLICT(item_id) DO UPDATE SET status=excluded.status, last_ts=excluded.last_ts, "
           "seconds=item_progress.seconds+excluded.seconds", item_id, p.status, db.now(), p.seconds)
    db.log(f"item_{p.status}", item_id, p.block_id, seconds=p.seconds)
    if p.status == "done" and (it := content.get(item_id)):
        curriculum.item_finished(it)
        if it.get("kind") == "lesson":
            curriculum.keep_one_ahead()
    return {"ok": True}


class StoryReq(BaseModel):
    setting: str
    level: str = "A1"


@app.post("/api/story")
def story(req: StoryReq):
    prev = [i for i in content.all_items().values() if i.get("generated") and i["series"].endswith(req.setting)]
    prev.sort(key=lambda i: i.get("order", 0))
    return coach.generate_story(req.setting, req.level, prev[-1].get("summary") if prev else None)


# ---------- vocabulary ----------

class Gloss(BaseModel):
    word: str
    sentence: str
    item_id: str | None = None
    block_id: int | None = None


@app.post("/api/gloss")
def gloss(g: Gloss):
    db.log("word_clicked", g.item_id, g.block_id, word=g.word)
    curriculum.word_clicked(g.word)
    return coach.gloss(g.word, g.sentence)


class NewCard(BaseModel):
    front: str
    back: str
    context_de: str | None = None
    context_en: str | None = None
    item_id: str | None = None
    line_id: str | None = None


@app.post("/api/cards")
def add_card(c: NewCard):
    return srs.add(**c.model_dump())


@app.get("/api/cards/due")
def cards_due(limit: int = 20):
    return srs.due(limit)


class Review(BaseModel):
    rating: int  # 1 again, 2 hard, 3 good, 4 easy
    block_id: int | None = None


@app.post("/api/cards/{card_id}/review")
def review(card_id: int, r: Review):
    return srs.review(card_id, r.rating, r.block_id)


# ---------- speech ----------

@app.get("/api/tts")
def tts(text: str, lang: str = "de", voice: str | None = None):
    from .speech import tts as tts_mod
    path = tts_mod.speak(text, lang=lang, voice=voice)
    return FileResponse(path)


@app.post("/api/pronounce")
async def pronounce(audio: UploadFile = File(...), text_de: str = Form(""), item_id: str | None = Form(None),
                    line_id: str | None = Form(None), block_id: int | None = Form(None)):
    """Phone-by-phone comparison of a recording with its target sentence.

    Without a target (free speech in the voice coach) it returns only what the recognizers heard.
    `for_coach` is a compact text rendering the voice model receives along with the learner's audio.
    """
    from .speech import phonemes
    data = await audio.read()
    rec = phonemes.recognize(data, audio.content_type or "audio/webm")
    if not text_de.strip():
        heard = {k: "".join(v) for k, v in rec["phones"].items()}
        return {"text": "", "heard_ipa": heard, "words": [], "score": None,
                "for_coach": "No target sentence. Heard: " + " | ".join(f"{k}: {v}" for k, v in heard.items())}
    result = phonemes.compare(text_de, rec)
    phones = [p for w in result.get("words", []) for p in w.get("phones", [])]
    result["score"] = round(sum(p.get("status") == "ok" for p in phones) / len(phones), 2) if phones else None
    result["for_coach"] = phonemes.format_result(result)
    db.run("INSERT INTO attempts (block_id, item_id, line_id, text_de, score, result, ts) VALUES (?,?,?,?,?,?,?)",
           block_id, item_id, line_id, text_de, result["score"], json.dumps(result, ensure_ascii=False), db.now())
    db.log("pronunciation_attempt", item_id, block_id, text=text_de, score=result["score"])
    return result


VOICE_COACH = """You are a warm, playful German pronunciation coach in a live voice session with an adult beginner
(native Spanish, fluent English). You lead the session. Speak mostly English; say German slowly and clearly.

How the session works:
- Each time the learner speaks you get their audio, followed by a message starting with PHONETICS. It contains what two
  phoneme recognizers heard, compared phone by phone with the sentence on screen ([e→h] means expected e, heard h;
  [-e] missing; [+h] extra; [e? ...] the recognizers disagree, so be tentative there). Use both your own listening and
  this data. Never invent errors that neither shows. The recognizers are imperfect: if they flag something you clearly
  heard right, trust your ears and say nothing about it.
- Use show_sentence to put the next German sentence or word on the learner's screen before asking them to say it.
  Pick from the practice material below, or make a short sentence from it. Start easy, build up.
- You decide the flow: model a sound, drill one word, go back to a whole sentence, chat briefly in simple German,
  or move on when it's good. Keep each turn short (under 15 seconds) and end it with a clear request.
- Coach one thing at a time: the most important error. Give one physical tip (lips, tongue, length) and model it,
  exaggerated once, then at normal speed. Celebrate real progress briefly.
- If the learner asks something, answer briefly and steer back to practice.
- When the learner says they want to stop, or after about 5 minutes, sum up in two sentences and call end_practice.

Tips (from Spanish) for German sounds:
- ö (ø/œ): tongue says Spanish "e", lips round as for "o". Hold "eee", then round the lips without moving the tongue.
- ü (y/ʏ): tongue says Spanish "i", lips round tightly as for "u". Hold "iii", then round the lips.
- ä (ɛ): an open "e", like the "e" in Spanish "perro" but a bit wider.
- ch after i/e/ä/ö/ü or a consonant (ç, "ich"): whisper the "y" of Spanish "ya" with the tongue high; not "sh" (ʃ), not Spanish "j".
- ch after a/o/u (x, "Buch"): like a soft Spanish "j" in "jamón".
- r (ʁ): at the back of the throat, close to a soft gargle or a French r; never a Spanish tapped or rolled r.
  After a vowel at a syllable end ("Tor", "sehr") it becomes a short "a"-like vowel (ɐ).
- Long vs short vowels change meaning ("Staat" vs "Stadt"): stretch long vowels clearly; Spanish has no length difference.
- Final b/d/g sound like p/t/k ("Tag" ends in k, "Rad" in t).
- z is "ts"; w is English "v"; v is usually "f"; s before a vowel is a buzzing "z"; sp/st at a word start is "shp/sht".
- Unstressed -e and -en are a weak schwa (ə), never a full Spanish "e"."""

COACH_TOOLS = [
    {"type": "function", "name": "show_sentence",
     "description": "Show a German sentence or word on the learner's screen as the current thing to say. The phonetic comparison of their next attempt is made against it.",
     "parameters": {"type": "object", "properties": {
         "text_de": {"type": "string", "description": "German text to say"},
         "en": {"type": "string", "description": "English meaning"}}, "required": ["text_de", "en"]}},
    {"type": "function", "name": "end_practice",
     "description": "End the speaking practice after summing up.",
     "parameters": {"type": "object", "properties": {"summary": {"type": "string"}}, "required": ["summary"]}},
]


@app.post("/api/realtime/token")
async def realtime_token(item_id: str | None = None):
    issues = ", ".join(f"{i['expected']}→{i['heard']} (e.g. {i['example_word']})" for i in progress.pronunciation_issues(top=5))
    material = ""
    if item_id and (it := content.get(item_id)):
        de = [f"{l['text']} = {l.get('en', '')}" for l in it.get("lines", []) if l.get("lang") == "de"][:40]
        new = [f"{w['de']} = {w['en']}" for w in (it.get("lesson") or {}).get("new_words", [])]
        material = (f"\n\nPractice material, from the text the learner just read ({it.get('title')}):\n" + "\n".join(de)
                    + (f"\nNew words in this lesson: {'; '.join(new)}" if new else ""))
    known = [w["de"] for w in curriculum.word_states()][-80:]
    instructions = (VOICE_COACH + material
                    + (f"\n\nGerman words the learner has met: {', '.join(known)}. Use only these in your own German." if known else "")
                    + (f"\nRecurring pronunciation issues so far: {issues}." if issues else ""))
    async with httpx.AsyncClient(timeout=20) as cx:
        r = await cx.post("https://api.openai.com/v1/realtime/client_secrets",
                          headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"},
                          json={"session": {"type": "realtime", "model": REALTIME_MODEL, "instructions": instructions,
                                            "tools": COACH_TOOLS, "tool_choice": "auto",
                                            "audio": {"output": {"voice": REALTIME_VOICE},
                                                      "input": {"turn_detection": None,
                                                                "transcription": {"model": "gpt-4o-mini-transcribe"}}}}})
    if r.status_code != 200:
        raise HTTPException(502, f"OpenAI realtime token failed: {r.text[:300]}")
    return {"value": r.json()["value"], "model": REALTIME_MODEL}


# ---------- static ----------

app.mount("/media", StaticFiles(directory=ROOT / "data" / "media", check_dir=False), name="media")
app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")
