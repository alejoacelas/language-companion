"""HTTP server: the web app, the Chrome extension and background jobs all go through here."""

import json
import threading
import time
from pathlib import Path

from dotenv import load_dotenv

from . import db

load_dotenv(db.ROOT / ".env")

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

from . import content, course, lessons, speak, srs, words  # noqa: E402

app = FastAPI(title="Sprachraum")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome-extension://.*|https://www\.youtube\.com|https://www\.netflix\.com|http://localhost(:\d+)?)$",
    allow_methods=["*"], allow_headers=["*"],
)
WEB = db.ROOT / "web"


@app.middleware("http")
async def no_stale_pages(request, call_next):
    # the app's own files change while it's being developed; make the browser revalidate them
    resp = await call_next(request)
    if not request.url.path.startswith(("/api/", "/audio/")):
        resp.headers["Cache-Control"] = "no-cache"
    return resp
(db.DATA / "audio").mkdir(parents=True, exist_ok=True)


# ---------- today ----------

@app.get("/api/today")
def today():
    p = course.plan()
    since = time.time() - 36 * 3600
    feed = db.q("SELECT ts, kind, source, summary FROM events WHERE ts > ? AND kind IN ('agent','lesson','watch','course') "
                "ORDER BY ts DESC LIMIT 8", (since,))
    p["feed"] = feed
    p["errors"] = course.recurring_errors(4)
    p["onboarded"] = bool(db.setting("onboarded"))
    p["granola"] = lessons.configured()
    return p


@app.get("/api/onboarding/words")
def onboarding_words():
    return db.q("SELECT lemma, article, gloss FROM words WHERE rank IS NOT NULL ORDER BY rank LIMIT 300")


@app.post("/api/onboarding")
def onboarding(body: dict = Body(...)):
    for lem in body.get("known", []):
        words.mark_known(lem, "onboarding")
    db.set_setting("new_per_day", int(body.get("new_per_day", course.DEFAULT_NEW_PER_DAY)))
    db.set_setting("onboarded", True)
    db.log("settings", f"Set up: {len(body.get('known', []))} words already known, "
                       f"{body.get('new_per_day', course.DEFAULT_NEW_PER_DAY)} new words a day")
    return {"ok": True}


# ---------- review ----------

@app.get("/api/review")
def review_queue():
    course.day_state()
    return {"cards": srs.due(100), "due": srs.due_count()}


@app.post("/api/review")
def review(body: dict = Body(...)):
    r = srs.review(int(body["card_id"]), int(body["rating"]))
    db.add_practice("review", float(body.get("seconds", 8)))
    return r


@app.post("/api/cards/{cid}/suspend")
def suspend(cid: int):
    db.x("UPDATE cards SET suspended=1 WHERE id=?", (cid,))
    db.log("card", "Removed a card")
    return {"ok": True}


# ---------- listen & read ----------

@app.get("/api/library")
def library():
    return content.library()


@app.get("/api/story/today")
def story_today():
    return {"id": content.todays_story()}


@app.get("/api/content/{cid}")
def get_content(cid: int):
    r = content.item(cid)
    if not r:
        raise HTTPException(404)
    return r


@app.post("/api/content/generate")
def generate(body: dict = Body(...)):
    return {"id": content.generate(body.get("kind", "story"), body.get("topic", ""), body.get("new_words"))}


@app.post("/api/content/{cid}/finish")
def finish(cid: int, body: dict = Body(...)):
    content.finish(cid, float(body.get("seconds", 0)))
    return {"ok": True}


@app.post("/api/content/{cid}/progress")
def progress(cid: int, body: dict = Body(...)):
    db.x("UPDATE content SET progress=? WHERE id=?", (int(body.get("i", 0)), cid))
    return {"ok": True}


@app.get("/api/podcasts/search")
def podcast_search(q: str):
    return content.search_podcasts(q)


@app.get("/api/podcasts/episodes")
def podcast_episodes(feed: str):
    return content.episodes(feed)


@app.post("/api/podcasts/import")
def podcast_import(body: dict = Body(...)):
    return {"id": content.import_episode(body["audio"], body.get("title", ""), body.get("show", ""), body.get("id") or body["audio"])}


@app.post("/api/articles/import")
def article_import(body: dict = Body(...)):
    return {"id": content.import_article(body.get("url", ""), body.get("text", ""))}


@app.get("/api/tts")
def tts(text: str, voice: str = "tutor", slow: bool = False):
    from . import speech
    return {"audio": speech.speak(text[:500], voice=voice, slow=slow)}


@app.get("/audio/{name}")
def audio(name: str):
    p = (db.DATA / "audio" / name).resolve()
    if p.parent != (db.DATA / "audio").resolve() or not p.exists():
        raise HTTPException(404)
    return FileResponse(p)


# ---------- words (used by the web app and the Chrome extension) ----------

@app.get("/api/ping")
def ping():
    return {"ok": True}


@app.post("/api/words/status")
def word_status(body: dict = Body(...)):
    return {"tokens": words.statuses(body.get("tokens", [])[:5000])}


@app.post("/api/lookup")
def lookup(body: dict = Body(...)):
    return words.lookup(body.get("word", ""), body.get("sentence", ""), body.get("source", "app"),
                        str(body.get("external_id", "")), body.get("title", ""))


@app.post("/api/ignore")
def ignore(body: dict = Body(...)):
    words.ignore(body["lemma"])
    return {"ok": True}


@app.post("/api/watch")
def watch(body: dict = Body(...)):
    content.record_watch(body.get("source", "youtube"), str(body.get("external_id", "")), body.get("title", ""),
                         body.get("url", ""), float(body.get("seconds", 0)), body.get("sentences"))
    return {"ok": True}


@app.get("/api/words")
def word_list(status: str = "learning"):
    return db.q("SELECT s.lemma, s.status, s.first_source, s.first_ts, s.seen, s.lookups, w.gloss, w.article "
                "FROM word_state s LEFT JOIN words w ON w.lemma = s.lemma WHERE s.status = ? "
                "ORDER BY s.first_ts DESC", (status,))


# ---------- speak ----------

@app.post("/api/speak/start")
def speak_start(body: dict = Body(default={})):
    out = speak.start(body.get("topic", ""))
    out["audio"] = _tts(out["reply"])
    return out


def _tts(text: str) -> str | None:
    from . import speech
    try:
        return speech.speak(text, voice="tutor")
    except Exception as e:
        db.log("agent", f"Voice failed: {e}")
        return None


@app.post("/api/speak/turn")
async def speak_turn(session_id: int = Form(...), audio: UploadFile | None = File(None), text: str = Form("")):
    from . import speech
    said = text
    if audio is not None:
        data = await audio.read()
        last_ai = db.one("SELECT text FROM utterances WHERE session_id=? AND speaker='ai' ORDER BY id DESC LIMIT 1", (session_id,))
        said = speech.transcribe(data, audio.content_type or "audio/webm", (last_ai or {}).get("text"))
    if not said.strip():
        return {"heard": "", "reply": "", "empty": True}
    out = speak.turn(session_id, said)
    out["heard"] = said
    out["audio"] = _tts(out["reply"])
    return out


@app.post("/api/speak/end")
def speak_end(body: dict = Body(...)):
    return speak.end(int(body["session_id"]))


@app.get("/api/speak/{sid}")
def speak_history(sid: int):
    return speak.history(sid)


# ---------- tutor lessons ----------

@app.get("/api/lessons")
def lesson_list():
    return {"lessons": lessons.lessons(), "configured": lessons.configured(),
            "last_sync": db.setting("granola_last_sync"), "tutors": lessons.tutors()}


@app.get("/api/lessons/{sid}")
def lesson(sid: int):
    s = db.one("SELECT * FROM sessions WHERE id=? AND kind='lesson'", (sid,))
    if not s:
        raise HTTPException(404)
    s["meta"] = json.loads(s["meta"] or "{}")
    s["lines"] = db.q("SELECT speaker, text FROM utterances WHERE session_id=? ORDER BY id", (sid,))
    s["errors"] = db.q("SELECT * FROM errors WHERE source='lesson' AND source_ref=?", (str(sid),))
    s["cards"] = db.q("SELECT id, kind, front, back, suspended FROM cards WHERE source='lesson' AND source_ref=?", (str(sid),))
    return s


@app.post("/api/lessons/sync")
def lesson_sync():
    if not lessons.configured():
        raise HTTPException(400, "Granola API key not set")
    return lessons.sync()


@app.get("/api/brief")
def brief(tutor: str):
    return {"text": lessons.brief(tutor)}


@app.post("/api/tutor/started")
def tutor_started(body: dict = Body(default={})):
    course.mark_done("tutor")
    db.log("lesson", "Opened italki to find a tutor")
    return {"ok": True}


# ---------- me ----------

@app.get("/api/me")
def me():
    return {"vocab": course.vocab_counts(), "errors": course.recurring_errors(10, days=365),
            "practice": course.practice_week(), "hours": round(course.total_hours(), 1),
            "events": db.q("SELECT ts, kind, source, summary FROM events ORDER BY id DESC LIMIT 150"),
            "settings": {"new_per_day": db.setting("new_per_day", course.DEFAULT_NEW_PER_DAY)}}


@app.post("/api/settings")
def settings(body: dict = Body(...)):
    if "new_per_day" in body:
        db.set_setting("new_per_day", int(body["new_per_day"]))
        db.log("settings", f"New words per day: {body['new_per_day']}")
    return {"ok": True}


# ---------- background ----------

def _background():
    while True:
        try:
            if lessons.configured():
                lessons.sync()
        except Exception as e:
            db.log("agent", f"Granola sync failed: {e}", "granola")
        time.sleep(600)


@app.on_event("startup")
def _start():
    threading.Thread(target=_background, daemon=True).start()


app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
