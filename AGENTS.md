# language-companion

Scope: a local web app for learning German from zero in 15-minute blocks, built around a ladder of Claude-written story lessons that raise the share of German gradually. Each block has five steps: review cards, meet the lesson's new words, read the lesson, speak with a voice coach, then two questions and a summary.

- Visibility: public. Content, media, models and the database live in the ignored `data/` folder.
- Still running or billing: none. The app runs only on demand on the Mac.

## Run

```sh
~/best/stash/dotfiles/bin/op-agent inject -i .env.tpl -o .env -f
uv run uvicorn server.app:app --port 8765
```

Then open http://localhost:8765.

To test without touching the learner's progress, run a second server on a scratch database: `APP_DB=data/test.db uv run uvicorn server.app:app --port 8766`.

## Layout

- `server/`: the FastAPI app, which serves `web/` at `/`.
  - `server/curriculum.py`: the word ladder, known words and lesson writing.
  - `server/speech/`: phoneme recognition and text-to-speech.
  - `server/mcp_server.py`: exposes the progress log to any LLM.
- `web/`: the browser front end. It's plain ES modules with no build step. `web/app.js` routes and runs the block; each page lives in `web/pages/<page>.js` with its own `.css`.
- `tools/`: scripts that fetch and prepare content into `data/content/` ([schema](docs/content-schema.md)).
- `data/`: ignored by git. Holds `content/`, `curriculum/` (word ladder and story bible), `media/`, `models/` (Hugging Face cache, set `HF_HOME=data/models`), `tts-cache/` and `app.db`.

## Credentials

`.env` is built from `.env.tpl` with `op-agent inject`.

| Variable | 1Password location |
|---|---|
| `OPENAI_API_KEY` | personal account, vault `mac-agents`, item `MEALS_FEEDBACK_OPENAI_API_KEY — meals-feedback`, field `credential` (shared with the meals-feedback project for now) |
| `ANTHROPIC_API_KEY` | personal account, vault `mac-agents`, item `ANTHROPIC_API_KEY — personal-apps-2026-10`, field `credential` |
