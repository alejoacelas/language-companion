# Sprechstunde

A local app for learning German from zero in 15-minute blocks.

1. **Review (3 min):** spaced-repetition cards made from words you saved while reading.
2. **Read or watch (6 min):** DW's *Harry – gefangen in der Zeit*, *Mission Berlin* and *Radio D*, German-dub anime clips (Kaguya-sama, Chainsaw Man), or new stories Claude writes. All mix English with German. Click a word to see its meaning and save it as a card. Press Space to hear the selected line.
3. **Speak (5 min):** say 3–5 lines from the text. Two phoneme recognizers on your Mac write down the sounds you made, and the app compares them sound by sound with the target. An OpenAI live voice coach then talks you through the main error. Hold T to talk to the coach.
4. **Wrap-up (1 min):** Claude summarises the block and plans the next one from your activity log.

Your progress is available to any LLM through the MCP server in `.mcp.json`.

## Run

```sh
~/best/stash/dotfiles/bin/op-agent inject -i .env.tpl -o .env -f
uv run uvicorn server.app:app --port 8765
```

Open http://localhost:8765. The content, media and models are not in git. `tools/` has the scripts that rebuild them into `data/`.
