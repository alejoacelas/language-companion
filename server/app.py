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

from . import coach, content, db, progress, srs  # noqa: E402

app = FastAPI(title="language-companion")

REALTIME_MODEL = "gpt-realtime-2.1"
REALTIME_VOICE = "marin"


# ---------- state and blocks ----------

@app.get("/api/state")
def state():
    return {"progress": progress.summary(), "catalog": content.catalog()}


@app.post("/api/block/start")
def block_start():
    plan = coach.plan_block()
    block_id = db.run("INSERT INTO blocks (started_at, plan) VALUES (?,?)", db.now(), json.dumps(plan, ensure_ascii=False))
    db.log("block_started", plan.get("item_id"), block_id, plan=plan)
    return {"block_id": block_id, "plan": plan, "cards": srs.due(15), "item": content.get(plan["item_id"])}


class BlockEnd(BaseModel):
    seconds: int = 0


@app.post("/api/block/{block_id}/end")
def block_end(block_id: int, body: BlockEnd):
    db.log("block_ended", None, block_id, seconds=body.seconds)
    summary = coach.summarize_block(block_id)
    db.run("UPDATE blocks SET ended_at=?, summary=? WHERE id=?", db.now(), summary, block_id)
    return {"summary": summary, "progress": progress.summary()}


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


@app.post("/api/gloss")
def gloss(g: Gloss):
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
async def pronounce(audio: UploadFile = File(...), text_de: str = Form(...), item_id: str | None = Form(None),
                    line_id: str | None = Form(None), block_id: int | None = Form(None)):
    from .speech import phonemes
    data = await audio.read()
    rec = phonemes.recognize(data, audio.content_type or "audio/webm")
    result = phonemes.compare(text_de, rec)
    phones = [p for w in result.get("words", []) for p in w.get("phones", [])]
    score = result.get("score")
    if score is None and phones:
        score = round(sum(p.get("status") == "ok" for p in phones) / len(phones), 2)
    result["score"] = score
    db.run("INSERT INTO attempts (block_id, item_id, line_id, text_de, score, result, ts) VALUES (?,?,?,?,?,?,?)",
           block_id, item_id, line_id, text_de, score, json.dumps(result, ensure_ascii=False), db.now())
    db.log("pronunciation_attempt", item_id, block_id, text=text_de, score=score)
    return result


VOICE_COACH = """You are a warm, concise German pronunciation coach speaking with an adult beginner (native Spanish, fluent English).
Speak English, and say German words slowly and clearly, exaggerating the target sound once, then at normal speed.
You will receive messages starting with ATTEMPT: they contain the target sentence and a phone-by-phone comparison of what a
speech recognizer heard ("expected" vs "heard"; "uncertain" means the two recognizers disagreed, so be tentative there).
For each ATTEMPT: say in one sentence what went well, then coach the single most important error: name the word, model it,
and give one physical tip (lips, tongue, length). Compare to Spanish or English sounds when helpful. Keep it under 20 seconds.
If everything is ok, say so briefly and model the sentence once with natural rhythm. Never invent errors not in the data.
If the learner speaks to you directly, answer briefly and steer back to practice."""


@app.post("/api/realtime/token")
async def realtime_token():
    focus = ", ".join(f"{i['expected']}→{i['heard']}" for i in progress.pronunciation_issues(top=5))
    instructions = VOICE_COACH + (f"\nRecurring issues so far: {focus}." if focus else "")
    async with httpx.AsyncClient(timeout=20) as cx:
        r = await cx.post("https://api.openai.com/v1/realtime/client_secrets",
                          headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"},
                          json={"session": {"type": "realtime", "model": REALTIME_MODEL, "instructions": instructions,
                                            "audio": {"output": {"voice": REALTIME_VOICE},
                                                      "input": {"transcription": {"model": "gpt-4o-mini-transcribe"}}}}})
    if r.status_code != 200:
        raise HTTPException(502, f"OpenAI realtime token failed: {r.text[:300]}")
    return {"value": r.json()["value"], "model": REALTIME_MODEL}


# ---------- static ----------

app.mount("/media", StaticFiles(directory=ROOT / "data" / "media", check_dir=False), name="media")
app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")
