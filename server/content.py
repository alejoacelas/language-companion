"""Things to listen to and read: stories written for the learner, podcasts, articles, videos."""

import hashlib
import json
import re
import threading
import time
from pathlib import Path

import feedparser
import httpx

from . import course, db, llm, words

AUDIO = db.DATA / "audio"

STORY_SYSTEM = """You write graded listening material for an adult learning German from zero.
The learner is a native Spanish speaker who is fluent in English.
Write so the learner understands about 95% of every sentence. Use a mix of English and German
when their German vocabulary is small: write a word in German if it is in their known or learning
words, or in today's new words; otherwise write it in English. As vocabulary grows the text
becomes mostly German. Grammar of German parts must be correct and natural.
Use each of today's new words at least 3 times, in different sentences. Recycle learning words often.
Keep sentences short. Make it a real story with a little humour or tension, not a textbook dialogue."""


def _known_lists() -> tuple[list[str], list[str]]:
    known = [r["lemma"] for r in db.q("SELECT lemma FROM word_state WHERE status='known'")]
    learning = [r["lemma"] for r in db.q("SELECT lemma FROM word_state WHERE status='learning' "
                                         "ORDER BY first_ts DESC LIMIT 400")]
    return known, learning


def _speak_async(content_id: int) -> None:
    """Generate audio for every sentence in the background."""
    def run():
        from . import speech
        row = db.one("SELECT sentences FROM content WHERE id=?", (content_id,))
        sents = json.loads(row["sentences"])
        for s in sents:
            if not s.get("audio"):
                try:
                    s["audio"] = speech.speak(s["de"], voice="narrator")
                except Exception as e:
                    db.log("agent", f"Audio failed for a sentence: {e}")
                    return
                db.x("UPDATE content SET sentences=? WHERE id=?", (json.dumps(sents, ensure_ascii=False), content_id))
    threading.Thread(target=run, daemon=True).start()


def generate(kind: str = "story", topic: str = "", new_words: list[str] | None = None) -> int:
    st = course.day_state()
    new = new_words if new_words is not None else st["new_words"]
    known, learning = _known_lists()
    prev = db.one("SELECT title, sentences FROM content WHERE kind='story' ORDER BY id DESC LIMIT 1")
    prev_summary = ""
    if prev and kind == "story":
        prev_summary = " ".join(s.get("en", "") for s in json.loads(prev["sentences"]))[:1500]
    errs = [e["category"] for e in course.recurring_errors(4)]
    vocab_n = len(known) + len(learning)
    prompt = f"""Write a {'short story episode' if kind == 'story' else 'short everyday dialogue'} of 12-20 sentences.
{('Topic: ' + topic) if topic else ''}
{('It continues the previous episode (English summary): ' + prev_summary) if prev_summary else 'Start a new ongoing story with 2-3 recurring characters.'}

Learner's vocabulary size: {vocab_n} words.
Today's new words: {', '.join(new) or '(none)'}
Learning words: {', '.join(learning[:300])}
Known words: {', '.join(known[:600])}
{('Include several correct examples of these points the learner keeps getting wrong: ' + '; '.join(errs)) if errs else ''}

Return JSON only:
{{"title": "German title", "sentences": [{{"de": "the sentence as the learner hears it (German/English mix as needed)", "en": "full English translation"}}]}}"""
    data = llm.ask_json(prompt, system=STORY_SYSTEM, max_tokens=6000)
    sents = [{"de": s["de"].strip(), "en": s.get("en", "").strip()} for s in data["sentences"] if s.get("de")]
    cid = db.x("INSERT INTO content (kind, title, sentences, new_words, created_ts) VALUES (?,?,?,?,?)",
               (kind, data.get("title", "Geschichte"), json.dumps(sents, ensure_ascii=False),
                json.dumps(new), time.time()))
    db.log("input", f'Wrote a {kind} for you: "{data.get("title")}"', content_id=cid)
    _speak_async(cid)
    return cid


def todays_story() -> int:
    st = course.day_state()
    if st.get("story_id") and db.one("SELECT 1 FROM content WHERE id=?", (st["story_id"],)):
        return st["story_id"]
    cid = generate("story")
    course.update_day(story_id=cid)
    return cid


def item(cid: int) -> dict:
    r = db.one("SELECT * FROM content WHERE id=?", (cid,))
    if not r:
        return {}
    r["sentences"] = json.loads(r["sentences"])
    r["new_words"] = json.loads(r["new_words"] or "[]")
    text = " ".join(s["de"] for s in r["sentences"])
    r["known_share"] = round(words.known_share(text), 2)
    r["tokens"] = words.statuses(words.tokens(text))
    return r


def library() -> list[dict]:
    rows = db.q("SELECT id, kind, title, url, created_ts, finished_ts, progress, sentences FROM content "
                "ORDER BY created_ts DESC LIMIT 200")
    out = []
    for r in rows:
        sents = json.loads(r.pop("sentences"))
        text = " ".join(s["de"] for s in sents)
        r["n"] = len(sents)
        r["known_share"] = round(words.known_share(text), 2) if text else None
        r["preview"] = (sents[0]["de"] if sents else "")[:120]
        out.append(r)
    return out


def finish(cid: int, seconds: float) -> None:
    r = db.one("SELECT kind, title, sentences, finished_ts FROM content WHERE id=?", (cid,))
    if not r:
        return
    db.add_practice("listening" if r["kind"] in ("story", "dialogue", "podcast") else "reading", seconds)
    if not r["finished_ts"]:
        db.x("UPDATE content SET finished_ts=? WHERE id=?", (time.time(), cid))
        words.seen(" ".join(s["de"] for s in json.loads(r["sentences"])))
        db.log("input", f'Finished "{r["title"]}" ({round(seconds / 60)} min)', content_id=cid)
    st = course.day_state()
    if st.get("story_id") == cid:
        course.mark_done("listen")


# ---------- podcasts ----------

def search_podcasts(term: str) -> list[dict]:
    r = httpx.get("https://itunes.apple.com/search",
                  params={"term": term, "media": "podcast", "limit": 12, "country": "DE"}, timeout=15)
    return [{"title": p.get("collectionName"), "author": p.get("artistName"), "feed": p.get("feedUrl"),
             "image": p.get("artworkUrl100")} for p in r.json().get("results", []) if p.get("feedUrl")]


def episodes(feed: str) -> list[dict]:
    f = feedparser.parse(feed)
    out = []
    for e in f.entries[:30]:
        audio = next((l.href for l in e.get("links", []) if l.get("type", "").startswith("audio")), None)
        if audio:
            out.append({"title": e.get("title"), "audio": audio, "published": e.get("published", ""),
                        "id": e.get("id") or audio, "show": f.feed.get("title", "")})
    return out


def import_episode(audio_url: str, title: str, show: str, ext_id: str) -> int:
    existing = db.one("SELECT id FROM content WHERE kind='podcast' AND external_id=?", (ext_id,))
    if existing:
        return existing["id"]
    from . import speech
    AUDIO.mkdir(parents=True, exist_ok=True)
    name = "pod-" + hashlib.sha1(audio_url.encode()).hexdigest()[:16] + ".mp3"
    path = AUDIO / name
    if not path.exists():
        with httpx.stream("GET", audio_url, follow_redirects=True, timeout=120) as r:
            r.raise_for_status()
            with open(path, "wb") as fh:
                for chunk in r.iter_bytes():
                    fh.write(chunk)
    segs = speech.transcribe_segments(path)
    sents = [{"de": s["text"].strip(), "start": s["start"], "end": s["end"]} for s in segs if s["text"].strip()]
    cid = db.x("INSERT INTO content (kind, title, url, external_id, sentences, audio, created_ts) VALUES (?,?,?,?,?,?,?)",
               ("podcast", f"{show} · {title}" if show else title, audio_url, ext_id,
                json.dumps(sents, ensure_ascii=False), name, time.time()))
    db.log("input", f'Imported podcast episode "{title}"', content_id=cid)
    return cid


# ---------- articles ----------

def import_article(url: str = "", text: str = "") -> int:
    if url and not text:
        html = httpx.get(url, follow_redirects=True, timeout=20, headers={"User-Agent": "Mozilla/5.0"}).text
        text = re.sub(r"<script.*?</script>|<style.*?</style>", " ", html, flags=re.S)
        text = re.sub(r"<[^>]+>", " ", text)
        text = re.sub(r"\s+", " ", text)[:30000]
    data = llm.ask_json(
        "Extract the main German article text from this page dump. Return JSON "
        '{"title": "...", "sentences": [{"de": "one sentence", "en": "English translation"}]} '
        "with the article split into sentences, nothing from menus or ads. At most 60 sentences.\n\n" + text,
        model=llm.FAST, max_tokens=12000)
    cid = db.x("INSERT INTO content (kind, title, url, sentences, created_ts) VALUES (?,?,?,?,?)",
               ("article", data.get("title", "Artikel"), url or None,
                json.dumps(data["sentences"], ensure_ascii=False), time.time()))
    db.log("input", f'Imported article "{data.get("title")}"', content_id=cid)
    _speak_async(cid)
    return cid


# ---------- videos watched through the extension ----------

def record_watch(source: str, ext_id: str, title: str, url: str, seconds: float, sentences: list | None) -> None:
    row = db.one("SELECT id, sentences FROM content WHERE kind=? AND external_id=?", (source, ext_id))
    if not row:
        db.x("INSERT INTO content (kind, title, url, external_id, sentences, created_ts) VALUES (?,?,?,?,?,?)",
             (source, title or ext_id, url, ext_id, json.dumps(sentences or [], ensure_ascii=False), time.time()))
        db.log("watch", f'Started watching "{title}" on {source.capitalize()}', source)
    else:
        if title:
            db.x("UPDATE content SET title=? WHERE id=?", (title, row["id"]))
        if sentences and row["sentences"] in ("[]", None):
            db.x("UPDATE content SET sentences=? WHERE id=?", (json.dumps(sentences, ensure_ascii=False), row["id"]))
    if seconds:
        db.add_practice(source, seconds)
        db.x("UPDATE content SET progress = progress + ? WHERE kind=? AND external_id=?", (int(seconds), source, ext_id))
