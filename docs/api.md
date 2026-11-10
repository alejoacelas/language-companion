# Server API

The server runs at `http://localhost:8790` and owns the one database (`data/app.db`). Every surface (web app, Chrome extension, background jobs) reads and writes through it.

## Endpoints used by the Chrome extension

All JSON. The server allows CORS from `chrome-extension://*`, `https://www.youtube.com` and `https://www.netflix.com`.

- `GET /api/ping` → `{ok: true}`
- `POST /api/words/status` with `{tokens: ["Gestern", "habe", ...]}` → `{tokens: {"Gestern": {lemma, status, gloss}}}`. `status` is `new`, `learning`, `known` or `ignored`. Use it to colour subtitle words.
- `POST /api/lookup` with `{word, sentence, source, external_id, title}` → `{lemma, gloss, article, contextual, status, card_added}`. Call when the learner clicks a word. `contextual` is the meaning in this sentence. A new word becomes a card automatically.
- `POST /api/watch` with `{source, external_id, title, url, seconds, sentences}` → `{ok}`. Call about every 30 s while a video plays, with the seconds watched since the last call. `source` is `youtube` or `netflix`. `sentences` is optional: the German subtitle lines seen so far, `[{de, start, end}]`, sent once per video.
- `POST /api/ignore` with `{lemma}` → `{ok}`. "Don't track this word".

## Speech module (`server/speech.py`)

- `transcribe(audio: bytes, mime: str, context: str | None = None) -> str`: German speech to text, keeping the learner's grammar mistakes as spoken.
- `speak(text: str, voice: str = "tutor", slow: bool = False) -> str`: German text to an mp3 in `data/audio/`, cached by content. Returns the file name.
