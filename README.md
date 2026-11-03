# Sprechstunde

A local app for learning German from zero in 15-minute blocks.

The core is a ladder of short lessons. Each lesson is an episode of one ongoing story that Claude writes for you: an English narrator tells it and the characters speak German. Lesson 1 has a handful of German words. Each lesson adds 3–10 new words from a list ordered by how often they appear in DW's beginner courses, and reuses the ones you've met, until German is about half the text. Claude picks the number of new words from your quiz answers, card reviews and how often you look words up.

A block runs:

1. **Review (3 min):** spaced-repetition cards, including every word a lesson introduced.
2. **New words (1 min):** hear each new word alone and in a sentence from the story.
3. **Read (6 min):** the lesson, read aloud with an English voice for the narrator and a German voice for German. Click a word for its meaning; new words are highlighted.
4. **Speak (4 min):** a live session with an OpenAI voice coach. Hold Space and talk. The coach hears you and also receives a sound-by-sound transcription from two phoneme recognizers on your Mac, compared with the sentence it put on screen. It decides what to practise next.
5. **Wrap-up (1 min):** two questions about the story, then Claude's summary.

The home page also lists the real material you're working towards (DW's *Harry*, *Mission Berlin* and *Radio D*, and German-dub anime clips), each with the share of its German words you already know.

## Audio course

A second app, in `course/`, teaches by speaking only, in 15-minute lessons that follow graduated-interval recall:

- Each lesson opens with a short dialogue. Then it teaches 6–8 items: an English narrator gives a cue, you answer aloud, and a native voice gives the answer.
- Each item comes back after about 5 s, 25 s, 2 min and 10 min, and sooner after a miss. Earlier lessons' items return on a schedule of 1, 5, 25 and 120 days.
- Long words are built from the end ("-gung", "-digung", … "Entschuldigung"). Combinations are attempted before you hear them.
- The lesson ends with the dialogue again, and then you play one of the two parts.
- After every answer, the phoneme check marks the sounds you got wrong. The narrator gives a tip for that sound and has you repeat the word slowly. If you get an item wrong twice in a row, the voice coach takes a short break with you on it.
- Move on once you recall 80% of the prompts. Otherwise, repeat the lesson. Claude writes the next lesson from your results, the word ladder and your pronunciation errors.

```sh
uv run uvicorn course.app:app --port 8770
```

Then open http://localhost:8770. Lesson scripts are saved in `data/course/`.

Your progress is available to any LLM through the MCP server in `.mcp.json`.

## Run

```sh
~/best/stash/dotfiles/bin/op-agent inject -i .env.tpl -o .env -f
uv run uvicorn server.app:app --port 8765
```

Open http://localhost:8765. The content, media and models are not in git. `tools/` has the scripts that rebuild them into `data/`.
