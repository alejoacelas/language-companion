# Content items

Each text, episode or clip is one JSON file in `data/content/<id>.json`. The `data/` folder is ignored by git because most content is copyrighted.

```json
{
  "id": "harry-001",
  "kind": "episode",
  "series": "Harry – gefangen in der Zeit",
  "title": "Ferien im Schwarzwald",
  "order": 1,
  "level": "A1",
  "source": { "name": "Deutsche Welle", "url": "https://...", "note": "Free DW course; personal use" },
  "media": { "type": "audio", "path": "media/harry-001.mp3" },
  "external_link": null,
  "lines": [
    { "id": "l1", "speaker": "Narrator", "lang": "en", "text": "Harry arrives in the Black Forest..." },
    { "id": "l2", "speaker": "Hotel clerk", "lang": "de", "text": "Guten Tag! Wie heißen Sie?", "en": "Good afternoon! What's your name?", "start": 12.4, "end": 14.1 }
  ]
}
```

- `kind` is `episode` for a course episode, `story` for a written story (including ones Claude generates), `clip` for an anime scene, and `lesson` for a curriculum lesson.
- `series` groups items, and `order` sorts them within a series.
- `level` is the CEFR level: `A0`, `A1`, `A2` or `B1`.
- `media` is `null` or one of the following. `path` is relative to `data/`, and `start` and `end` are optional seconds.
  - `{"type": "audio", "path": ...}`
  - `{"type": "video", "path": ...}`
  - `{"type": "youtube", "youtube_id": ..., "start": ..., "end": ...}`
- `external_link` is an optional `{label, url}`, such as the Crunchyroll episode a clip comes from.
- Each line is English (`lang: "en"`) or German (`lang: "de"`). A German line has an `en` translation. `start` and `end` give the line's position in the item's media, in seconds, when known.
- `generated: true` marks items Claude wrote. `generated_from` gives the prompt inputs: the setting, the target words and the level.

## Lessons

Lessons (`lesson-NN.json`) are written by `server/curriculum.py`. They have the fields above plus:

```json
"lesson": {
  "n": 1,
  "new_words": [{ "id": "w0003", "de": "ich", "en": "I", "forms": ["ich"] }],
  "questions": [{ "q": "What does Herr Klein ask Sam?", "options": ["Who are you?", "..."], "answer": 0 }],
  "pace_reason": "Why this many new words.",
  "unknown_words": ["German words used that the learner hasn't met"],
  "stats_at_writing": { "...": "the learner results the writer saw" }
}
```

- `new_words[].id` points into the word ladder, `data/curriculum/ladder.json`. `forms` are the lowercase forms that count as this word in any text.
- In English lines, German words are wrapped in asterisks: `She opens her *Tasche*.` The reader renders them as German, and the voice switches for them.
