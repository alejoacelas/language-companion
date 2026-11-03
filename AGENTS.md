# language-companion

Scope: a local web app for learning German from zero in 15-minute blocks. Each block has four steps: review spaced-repetition cards, read or watch a text that mixes English and German, practise pronunciation with feedback, then a wrap-up. A coach model reads the activity log and plans the next block.

- Visibility: public. Content, media, models and the database live in the ignored `data/` folder.
- Still running or billing: none. The app runs only on demand on the Mac.

## Run

```sh
~/best/stash/dotfiles/bin/op-agent inject -i .env.tpl -o .env -f
uv run uvicorn server.app:app --port 8765
```

Then open http://localhost:8765.

## Layout

- `server/`: the FastAPI app, which serves `web/` at `/`.
  - `server/speech/`: phoneme recognition and text-to-speech.
  - `server/mcp_server.py`: exposes the progress log to any LLM.
- `web/`: the browser front end. It's plain ES modules with no build step.
- `tools/`: scripts that fetch and prepare content into `data/content/` ([schema](docs/content-schema.md)).
- `data/`: ignored by git. Holds `content/`, `media/`, `models/` (Hugging Face cache, set `HF_HOME=data/models`), `tts-cache/` and `app.db`.

## Credentials

`.env` is built from `.env.tpl` with `op-agent inject`.

| Variable | 1Password location |
|---|---|
| `OPENAI_API_KEY` | personal account, vault `mac-agents`, item `MEALS_FEEDBACK_OPENAI_API_KEY — meals-feedback`, field `credential` (shared with the meals-feedback project for now) |
| `ANTHROPIC_API_KEY` | personal account, vault `mac-agents`, item `ANTHROPIC_API_KEY — personal-apps-2026-10`, field `credential` |
