# Speech layer choice

`server/speech.py` uses `gpt-4o-transcribe` with a verbatim prompt for the learner's speech, `gpt-4o-mini-tts` for speaking, and `whisper-1` for podcast transcripts.

## Test

`research/speech-test/run.py` speaks 13 learner sentences (11 with deliberate mistakes, 2 correct) with `gpt-4o-mini-tts`, once in neutral German and once with a "Spanish-speaking beginner" accent instruction, in 7 voices. Each of the 26 clips goes through every model three ways: no prompt, the verbatim prompt, and the verbatim prompt plus the tutor's question as context. "Mistakes kept" counts 32 mistake phrases (e.g. "gestern ich habe", "die Popcorn", "gefahrt") found exactly in the transcript.

| Model | Prompt | Mistakes kept | Exact sentences | Word errors | Median s/clip |
|---|---|---|---|---|---|
| whisper-1 | verbatim | 22/32 | 18/26 | 13 | 0.74 |
| gpt-4o-mini-transcribe | verbatim + context | 22/32 | 16/26 | 10 | 0.59 |
| gpt-4o-transcribe | none | 21/32 | 15/26 | 11 | 0.59 |
| **gpt-4o-transcribe** | **verbatim (± context)** | **28/32** | **22/26** | **4** | **0.59** |
| gpt-transcribe (newest) | verbatim | 21/32 | 15/26 | 11 | 0.55 |
| mlx-whisper large-v3-turbo, local | none | 26/32 | 20/26 | 6 | 1.11 |

Rows show each model's best prompt, plus gpt-4o-transcribe without a prompt. Two of the 32 phrases were missed by every model, so the TTS voice probably said the corrected form ("mit dem Zug", "begeht"). Excluding them, gpt-4o-transcribe kept 28/30 in the first run and 56/60 in two repeat runs: 4 real grammar corrections in 90 (e.g. "gefahrt" → "gefahren", "mit meine" → "mit meiner"), plus misspellings of the made-up word "gegeht".

## Choice and reasons

- `transcribe()`: `gpt-4o-transcribe`, `language="de"`, `temperature=0`, verbatim prompt. It kept the most mistakes and made the fewest other errors. The prompt is what makes it work (21 → 28). Adding the tutor's question as context did not cause corrections. The newest `gpt-transcribe` ignores the prompt and corrects grammar freely. The local model was second best but slower and needs a 1.6 GB download.
- `speak()`: `gpt-4o-mini-tts`, voice `marin` for "tutor" and `cedar` for "narrator", with a style instruction. `slow=True` adds `speed=0.8` and a "speak slowly" instruction: about 30% longer audio that still sounds natural. Files are cached in `data/audio/` by the hash of text, voice, slow, model and instructions.
- `speak_segments()`: speaks each (voice, text) pair through `speak()` and joins them with ffmpeg; timings come from each part's duration.
- `transcribe_segments()`: `whisper-1`, the only OpenAI model that returns timestamps. Episodes are cut into ~10-minute chunks at silences (48 kbps mono, under the 25 MB limit), transcribed in parallel and offset. Whisper's segments are joined and split into sentences; times inside a segment are interpolated by character count, so sentence starts can be off by a second or two. A 10-minute DW news episode took 10 s.

## Latency and cost

- Round trip (4 s clip transcribed + 1-sentence reply spoken, uncached): 1.6–2.6 s; transcribe ~0.55 s, speak 1.1–2.0 s. `speak()` returns only after the whole mp3 is written; streaming would cut the wait.
- List prices as I understand them (not checked against today's price page): transcribe and whisper-1 ~$0.006 per audio minute; TTS ~$0.015 per spoken minute.

## Known limits

- All test audio is synthetic. TTS voices speak cleanly and sometimes "fix" the mistake themselves. Real learners hesitate, restart and mispronounce. Re-run `run.py` on real recordings before trusting the numbers.
- Preservation is about 95%, not 100%: the model still occasionally corrects a case ending or a past participle. Feedback built on transcripts should allow for this, e.g. by letting the learner see and edit the transcript.
- Made-up words ("gegeht") are often spelled differently ("gegäht", "begeht").
