"""Audio course app: lesson scripts, speech checks and the voice coach, with the player in course/web/.

Run: uv run uvicorn course.app:app --port 8770
"""

import json
import os
import threading
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

from server import db, progress  # noqa: E402
from server.app import COACH_TOOLS, REALTIME_MODEL, REALTIME_VOICE, VOICE_COACH  # noqa: E402

from . import lessons  # noqa: E402

app = FastAPI(title="language-companion course")


@app.on_event("startup")
def warm():
    def job():
        from server.speech import phonemes, tts
        phonemes.warm_up()
        tts.warm_up()
        tts.speak("Hallo.", voice="openai:coral")
    threading.Thread(target=job, daemon=True).start()


@app.middleware("http")
async def no_stale_frontend(request, call_next):
    resp = await call_next(request)
    if not request.url.path.startswith("/api"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/api/course")
def course():
    return lessons.overview()


@app.post("/api/lesson/write")
def write_next():
    """Start writing the next lesson in the background; poll /api/course until `generating` is false."""
    lessons.ensure_next_written()
    return {"generating": True}


@app.get("/api/lesson/{n}")
def lesson(n: int):
    l = lessons.get(n)
    if not l:
        raise HTTPException(404, f"lesson {n} is not written yet")
    return l


@app.post("/api/lesson/{n}/start")
def start(n: int):
    if not lessons.get(n):
        raise HTTPException(404)
    return {"run_id": lessons.start_run(n)}


class Results(BaseModel):
    run_id: int
    items: dict
    seconds: int = 0


@app.post("/api/lesson/{n}/finish")
def finish(n: int, r: Results):
    return lessons.finish_run(r.run_id, n, {"items": r.items, "seconds": r.seconds})


@app.get("/api/tts")
def tts(text: str, lang: str = "de", voice: str | None = None, speed: float = 1.0):
    from server.speech import tts as tts_mod
    return FileResponse(tts_mod.speak(text, lang=lang, voice=voice, speed=speed))


VOWELS = set("aeiouyøœɛɪʏʊɔəɐ")
R_VOCALIZED = {"ɐ", "ə", "a", None}


def accept_vocalized_r(result: dict) -> None:
    """espeak expects ʁ in "hier" or "Uhr", but native speakers say a short ɐ there or drop it.

    Without this, a native recording of "hier" is reported as wrong. An r after a vowel that is heard as ɐ,
    or not at all, is marked ok.
    """
    for w in result["words"]:
        ps = w["phones"]
        for i, p in enumerate(ps):
            prev = next((q["expected"] for q in reversed(ps[:i]) if q.get("expected")), None)
            if p.get("expected") != "ʁ" or not prev or prev[0] not in VOWELS:
                continue
            heard = {p.get("heard")} if p["status"] in ("substituted", "missing") else (
                {p.get(m, {}).get("heard") for m in ("zipa", "wav2vec2")} if p["status"] == "uncertain" else set())
            if p["status"] != "ok" and heard <= R_VOCALIZED:
                ps[i] = {"expected": "ʁ", "status": "ok", "note": "vocalized r"}
        statuses = {p["status"] for p in ps}
        w["status"] = ("error" if statuses & {"substituted", "missing", "extra"}
                       else "uncertain" if "uncertain" in statuses else "ok")


@app.post("/api/check")
async def check(audio: UploadFile = File(...), text_de: str = Form(...), item_key: str = Form(""), lesson_n: int = Form(0)):
    """Compare a spoken answer with the expected German, sound by sound, and log it as a pronunciation attempt."""
    from server.speech import phonemes
    rec = phonemes.recognize(await audio.read(), audio.content_type or "audio/webm")
    result = phonemes.compare(text_de, rec)
    accept_vocalized_r(result)
    phones = [p for w in result["words"] for p in w["phones"]]
    ok = sum(p["status"] == "ok" for p in phones)
    maybe = sum(p["status"] == "uncertain" for p in phones)
    result["score"] = round(ok / len(phones), 2) if phones else None
    # Recall is judged leniently: a disagreement between the two recognizers counts in the learner's favour.
    result["recall_score"] = round((ok + maybe) / len(phones), 2) if phones else None
    result["for_coach"] = phonemes.format_result(result)
    result["duration_s"] = rec["duration_s"]
    db.run("INSERT INTO attempts (block_id, item_id, line_id, text_de, score, result, ts) VALUES (?,?,?,?,?,?,?)",
           None, f"course-L{lesson_n:02d}", item_key, text_de, result["score"], json.dumps(result, ensure_ascii=False), db.now())
    return result


@app.post("/api/realtime/token")
async def realtime_token(item_id: str | None = None):
    """Voice coach session focused on one course item the learner keeps mispronouncing (item_id is its key)."""
    row = db.one("SELECT de, en FROM course_items WHERE key=?", item_id) if item_id else None
    issues = ", ".join(f"{i['expected']}→{i['heard']} (e.g. {i['example_word']})" for i in progress.pronunciation_issues(top=5))
    focus = (f"\n\nThis is a short break inside an audio lesson. Work only on \"{row['de']}\" ({row['en']}), which the learner "
             "has mispronounced twice in a row. Start by showing it with show_sentence. Fix the main sound, have them say "
             "the whole thing correctly once or twice, then sum up in one sentence and call end_practice. "
             "Aim for under two minutes." if row else "")
    instructions = VOICE_COACH + focus + (f"\nRecurring pronunciation issues so far: {issues}." if issues else "")
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
    db.log("course_coach_break", item_id, item=row and row["de"])
    return {"value": r.json()["value"], "model": REALTIME_MODEL}


app.mount("/shared", StaticFiles(directory=ROOT / "web"), name="shared")
app.mount("/", StaticFiles(directory=Path(__file__).parent / "web", html=True), name="web")
