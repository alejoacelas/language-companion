# Phonetic transcription of German learner speech

Date: 2026-11-03. Goal: turn a learner's 2–10 s clip into IPA of what they actually said, align it with the expected IPA, and hand both to a speaking LLM for feedback.

## Answer

1. **Run it yourself on the M4. This beats every hosted option.** ZIPA-CR-Large (ONNX, 300M parameters, CC BY 4.0) took about 0.05 s per clip on CPU, needs no account, and costs nothing. It heard every planted vowel error in my test. Keep `facebook/wav2vec2-xlsr-53-espeak-cv-ft` as a second opinion: it is the best published model on non-native speech, but it missed ü in my test.
2. **If it must be hosted:** Modal (Google sign-in) running ZIPA plus wav2vec2 on a CPU container. Estimated ~$6/month of compute, covered by Modal's $30 monthly free credit, so about $0. Runner-up: a Hugging Face PRO account ($9/month, email sign-in) hosting your own CPU Space. No ready-made hosted deployment returns a raw IPA string for these models, so either way we deploy our own (~50 lines).
3. **Commercial API:** Lingolix is the only one with a confirmed German "heard IPA" output, but it costs about €26/month at 900 min, over budget, and it does not say whether "heard" is free recognition. Uttera is the best design on paper (free phone recognition, explicit missing/extra/substitution errors) but its per-clip price is unpublished.
4. **Feedback voice:** A text model (Claude) reasons over the target and heard IPA, then a cheap TTS speaks the reply: `gpt-4o-mini-tts` (~$0.015 per minute of speech) or Gemini Flash TTS (~$0.014/min, doubling on 1 Jan 2027). If you want one live voice conversation instead, Gemini Live (~$0.018/min of output audio) costs a quarter of OpenAI `gpt-realtime-2.1` (~$0.077/min). Per-minute figures are my derivation from per-token prices.
5. **Main uncertainty:** no published phone-error numbers exist for adult learners speaking German. All L2 numbers are for English, and my test used synthetic speech. A 20-minute test with the user's own recordings, where we know what was said, is the only way to settle the model choice.

## 1. Open phone recognizers

All numbers below are from papers, not from me. PFER is a phonetic-feature error rate (a near-miss like ø→œ costs less than ø→a); PER counts exact phone matches. Lower is better.

### Native German (authors' own benchmarks)

| Model | Size | German PFER (ZIPA paper) | German PFER (POWSM paper) |
|---|---|---|---|
| Allosaurus | 11M | 30.3 | 17.7 |
| wav2vec2-lv-60-espeak-cv-ft | 300M | 18.1 | – |
| wav2vec2-xlsr-53-espeak-cv-ft | 300M | 11.6 | 7.9 |
| MultIPA | 300M | 27.0 | 16.3 |
| Allophant | 300M | – | 9.4 |
| ZIPA-CR-Large (CC BY) | 300M | 3.3 | 3.3 |
| ZIPA-CR-NS-Large (non-commercial licence) | 300M | 3.1 | 3.2 |
| POWSM (CC BY) | 350M | – | 3.4 |

Caveat: ZIPA and POWSM were trained and tested on IPAPack++, which uses the same transcription conventions as their test sets. Part of their large lead on native German is matching the label style, not hearing better.

### Non-native and accented speech (what matters here)

| Model | L2-ARCTIC PFER (POWSM paper) | SpeechOcean762 PFER | EpaDB PFER | L2-ARCTIC PER (Fluently, vendor) | Conversational L2 PER (Fluently, vendor) |
|---|---|---|---|---|---|
| Allosaurus | 13.4 | 21.6 | 19.3 | – | – |
| wav2vec2-xlsr-53-espeak | 9.9 | **13.6** | **9.9** | 21.5 | **29.9** |
| ZIPA-CR-Large | 9.7 | 15.6 | 17.4 | **20.5** | 31.3 |
| POWSM | 11.3 | 17.8 | 11.9 | 21.3 (CTC head) | 34.9 |

What this shows:
- On learner speech the gap closes. All three modern models get roughly 1 phone in 5 wrong on read L2 English, and 1 in 3 on conversational L2 speech (Fluently benchmark, vendor-run, perceived-phone references).
- **ZIPA normalises toward the native pronunciation.** Its own paper scores it against both the dictionary pronunciation ("L2-Standard", 1.75) and what annotators heard ("L2-Perceived", 3.67). It is far closer to the dictionary form than to what was said. That is exactly the error-hiding we want to avoid. wav2vec2 shows a much smaller gap (3.69 vs 4.09). The POWSM authors say the same: wav2vec2 does best on accent and dialect variation, which they credit to its self-supervised pretraining on 60k+ hours.
- **POWSM must be run in free mode.** It can also take the target text as a prompt (audio-guided G2P), and its authors show that this pulls the output toward standard pronunciations. Use the `<pr>` task with no text.
- Independent evidence that word-level recognition hides errors: "Intent vs. Surface" (BEA 2026) found lower word-error-rate recognisers mask more mispronunciations; on speechocean762, 82% of utterances had at least one error corrected away.
- Independent evidence on LLMs as phone recognizers: PEDBench (arXiv 2610.20830, English only) found GPT-Audio and Gemini about as good as ZIPA and Azure at detecting pronunciation errors (F1 ~75), all with low precision. "Prior over Evidence" (arXiv 2606.15325) found that audio LLMs giving pronunciation feedback fall back on stock learner errors (θ, ð, r, v) whatever was said. So the LLM should explain phones computed by a recognizer, not diagnose them itself.
- No published PER for learners speaking German was found for any model.

## 2. Local test on the M4

Setup: macOS `say -v Anna` (German TTS) for the correct and deliberately wrong sentences, and `say -v Samantha` (US English voice) reading German-ish spellings to imitate an English accent. 16 kHz mono. Everything ran on CPU.

Expected IPA (espeak-ng, `de`): schön `ʃøːn`, schon `ʃoːn`, "Das ist sehr schön" `das ɪst zeːɾ ʃøːn`, "Ich möchte zwei Brötchen" `ɪç mœçtə tsvaɪ bɾøːtçən`, "Die Bücher sind grün" `diː byːçɜ zɪnt ɡɾyːn`.

| Clip (what was spoken) | wav2vec2-xlsr-53-espeak | ZIPA-CR-Large 500k | ZIPA-CR-NS-Large | POWSM `<pr>` | Allosaurus (deu) |
|---|---|---|---|---|---|
| Das ist sehr **schön** | d a s ɪ s t z eː ɾ ʃ **ø** n | d aː s ɪ s t z eː ɾ ʃ **øː** n | d a s ɪ s t z e ɾ ʃ **øː** n | d a s ɪ s t z e ɾ ʃ **øː** n | d a ʁ e s t e ə s œ n |
| Das ist sehr **schon** | … ʃ **oː** n | … ʃ **oː** n | … ʃ **oː** n | … ʃ **oː** n | d a s e s p e ə s ɔ n |
| Ich **möchte** zwei **Brötchen** | ɪ ç m **ə** ç t ə ts ts v aɪ b ɾ **yː** t ç ə n | iː ç m **œ** ç tʰ ə t s v a ɪ b ʀ **œ** t x ə n | iː ç m **œ** x tʰ ə t s v a ɪ p ʀ **ʏ** t x ə n | ɪ ç m **œ** ç tʰ ə t͡s v a ɪ̯ b r **yː** t ç ə n | iː v e t ə a ɪ k ʀ œ tʰ i n |
| Ich **mochte** zwei **Brotchen** | ɪ ç m **ɔ** x t ə ts v aɪ b ɾ **oː** t ç ə n | iː ç m **ɔ** x t ə t s v a ɪ b ʀ **ɔ** t x ə n | i ç m **ɔ** x t ə t s v a ɪ p ʀ **oː** t x ə n | (dropped "Ich mochte") t͡s v a ɪ̯ b r **oː** t ə n | iː z m ʁ ə f a ɪ k ʁ tʰ i |
| **Isch** möchte zwei Brötchen | ɪ **ʃ** m ə ç t ə … | iː **ç** m œ ç tʰ ə … (missed) | ɪ **ʃ** m œ x t ə … | (dropped "Isch") m œ ç tʰ ə … | iː v œ t e ʀ … |
| Die **Bücher** sind **grün** | d iː b **uː** ç ɜ z ɪ n t ɡ ɾ **uː** n (missed ü twice) | d iː b **yː** ç ɐ z ɪ n d g ɾ **yː** n | d iː b **yː** ç ɐ z ɪ n t g ɾ **yː** n | d iː b **yː** ç ɐ z ɪ n t ɡ ɾ **yː** n | d i b ʏ s i a s e n k ʀ uː n |
| Die **Bucher** sind **grun** | d iː b **uː** x ɛ ɾ z ɪ n t ɡ ɾ **uː** n | d iː b **uː** x ɐ z ɪ n d g ɾ **uː** n | d iː b **uː** x ɐ z ɪ n t g ɾ **uː** n | d iː b **ʊ** x ɐ̯ z ɪ n t ɡ ɾ **uː** n | d iː d u x a s z e n k u n |
| English voice: "Ish mukte tsvai broetchen" | ɪ ʃ m ʌ k s v eɪ b ɹ oʊ tʃ ə n | ɪ ʃ m ə k t s f e ɪ p ɹ o ʊ t ʃ ə n | ɪ ʃ m ə k s v e ɪ b ɹ o ʊ t ʃ ə n | ʃ m a ɾ k t s v e ɪ b ɹ o ʊ t ʃ ə n | iː s m a t v e j b ʀ ɔ tʰ ə n |
| English voice: "Dass ist sair shern" | t æ s ɪ s t s ɛ ʃ ɚ n | ɑ s ɪ z t s ɛ ɹ ʃ o ʊ n | æ s ɪ s t s ɑ ɹ ʃ ʊ ɹ n | (dropped "Das ist") z ɛ ɾ ʃ ʊ ɾ n | d a s ə s ɛ s œ n |
| Isolated word **schön** (0.4 s, no silence) | ʃ ə5 n | (empty) | s ə n | ʃ **øː** n | s ə n |
| Isolated word **schon** (0.4 s, no silence) | s. o n | s o n | s o n | ʃ **oː** n | s ə n |
| Same two words with 0.5 s silence added | schön ʃ əɜ n / schon ʃ o n | schön ʃ **œ** n / schon ʃ **u** n | – | – | – |
| Time per clip on M4 CPU | ~0.1 s | ~0.05 s (ONNX) | ~0.05 s | 1–3 s | ~0.3 s |

What the test shows:
- **Every model except Allosaurus told schön from schon in a sentence**, and möchte from mochte. The English-voice clips came out with English sounds (ɹ, oʊ, ɚ, æ), so none of them forced German phones onto accented speech.
- **ZIPA-CR-Large heard all six planted vowel errors**, but it transcribed "Isch" as "ɪç", the correct form. That is one example of the normalisation its paper reports. The NS variant caught it, but its licence is non-commercial (fine for personal use).
- **wav2vec2-xlsr missed ü** in both Bücher and grün, and heard ö as yː. With this model, a learner who says "Bucher" would look correct. That is a false "you said it right".
- **POWSM handles isolated words best but deletes whole words** in 4 of 11 clips. That behaviour (an attention decoder skipping audio) is worse than a wrong phone, because the feedback would say a word was missing. Running it with a higher CTC weight may fix this; I did not test that.
- **Allosaurus is unusable** for this.
- Pad very short clips with ~0.5 s of silence; the CTC models need it.
- Big caveat: this is synthetic speech. It shows the models can hear these contrasts, not how often they will on a real beginner.

Recommendation for the local pipeline: run ZIPA-CR-Large (ONNX) and wav2vec2-xlsr on every clip. Where they agree, trust the phone; where they disagree, pass both to the LLM as "uncertain". Align each against espeak-ng's expected IPA with a phone-level edit distance (substitution / deletion / insertion), which is a few dozen lines of Python. Total cost of the two models: about 0.15 s per clip on the M4, ~1.5 GB of downloads.

Reproduce: scripts in `/private/tmp/claude-501/-Users-alejo-best-projects-2026-11-03-language-companion/a335a9e5-b91d-44d1-83ea-9551f9360656/scratchpad/phoneme-test/scripts/` (`w2v.py`, `zipa.py`, `powsm.py`, `allo.py`), audio in `.../phoneme-test/audio/`, venv in `.../phoneme-test/venv/`, models in `.../phoneme-test/models/`.

## 3. Hosted options for the open models

Sign-in methods and prices are from the vendors' pages (checked 2026-11-03). Monthly costs are estimates: ~12,000 clips of ~4.5 s, and serverless containers billed for 30–45 h of practice sessions a month. They are not measured. ZIPA's ONNX model took ~0.05 s per clip on the M4 CPU, so a CPU container is enough; a GPU is not needed.

| Platform | Sign-in | Meets the sign-in rule? | Estimated monthly cost | Notes |
|---|---|---|---|---|
| **Modal** | Google, GitHub, SSO | Yes | CPU (2 cores, 4 GB) ~$6; T4 GPU ~$20–29. **$30/month free credit covers either.** | Python-native deploy; cold start est. 5–20 s, so keep the container warm during a session |
| **Hugging Face PRO + own CPU Space** | Email | Yes | **$9** | Free 2-vCPU CPU hardware, but creating a Space now needs PRO. Called with `gradio_client`. The SergejKurt Space shows this model takes ~1.4 s per 5 s clip on that hardware. |
| HF ZeroGPU Space | Email | Yes | $0–9 (5 min/day GPU free, 40 min/day with PRO; we'd need ~3–7 min/day) | Queues for a GPU on every call, so latency varies |
| HF Inference Endpoint (CPU, scale-to-zero) | Email | Yes | ~$2 (scale-to-zero) / ~$22 (always on) | Needs a custom handler: the default container lacks `phonemizer`. Cold start "can take a few minutes". |
| Fly.io (auto-stop machine) | Email, Google, GitHub | Yes | ~$1–2 | You run a small web server yourself |
| Baseten | Email, Google, GitHub | Yes | CPU ~$3–5; T4 ~$19–28 | One-time starting credit (~$30, secondary source) |
| RunPod serverless | Email, Google, GitHub | Yes | ~$6 (GPU, per second) | No CPU serverless tier listed |
| Replicate | GitHub only | **No** | ~$1–2 as a public CPU model; $24–36 private T4 | No phoneme or IPA model there |
| fal.ai | Google, GitHub, Microsoft | Yes | $60–180 | GPU only, idle billed. Over budget. |
| HF Inference Providers | – | – | – | Not usable: no provider serves these models |

Ready-made deployments:
- `SergejKurt/german-pronunciation-trainer` is up on free CPU and uses wav2vec2-xlsr-espeak, but its API returns chat-formatted analysis, not raw IPA, and depends on one person keeping it up. Duplicate it rather than call it.
- `espnet/powsm-ctc` runs on ZeroGPU with a `/predict` API callable from `gradio_client`. It is the only hosted, callable free phone recognizer found. Given the POWSM deletions in my test, use it only after testing the CTC variant.
- Other xlsr-espeak Spaces are broken. No running ZIPA Space was found.

## 4. Commercial APIs that return the phones heard

| Option | German | Returns what was heard? | Free or biased toward expected | Sign-in | Cost at ~900 min/month |
|---|---|---|---|---|---|
| **Lingolix** | Yes | Yes, per syllable: `expected_ipa` vs `detected_ipa` (docs example: expected `mɔʁ`, detected `ma`). No phone-by-phone alignment. | Not documented. Output is grouped into expected syllables, which suggests alignment to the text. | Google, Apple or email | Learner plan €19 for 720 min + €0.04/min → about **€26** (about €38 at 1,200 min). Free: 15 min/month. |
| **Uttera** | Yes | Yes: whole-utterance `target_ipa` vs `heard_ipa`, plus typed missing / extra / substitution errors | **Free** recognition, per its docs. It also drops confusions the recognizer makes on a synthetic correct reading. | Not verified | Unclear: billed in GPU-second credits (€19 = 7,500 credits); a docs example with LLM explanation cost 61 credits for 2.6 s. Free plan exists. |
| **TonePerfect** | "Experimental" | Yes, per phoneme expected / heard | **Partly biased**: its docs say `heard` is set to `expected` when the sound decoder misses a sound or hears a close variant | Not verified | ~$40–50 (1 credit per clip) |
| **Langcraft** | Not confirmed | Yes: free IPA string plus aligned match / substitution / deletion / insertion | Looks free | API key by email request | No public pricing |
| SpeechSuper | Yes | No: scores against expected phonemes only | Constrained | Contact form | ~$72 ($0.006/sentence, $20 minimum) |
| Azure Pronunciation Assessment | Scores only | No for de-DE: spoken phoneme output is en-US only | Constrained | Azure account | ~$15–20 |
| Speechace, ELSA, Chivox | No German | – | – | – | – |
| Deepgram, AssemblyAI, Speechmatics, Google, AWS | Words only | No | – | – | – |

All quality claims for Lingolix, Uttera, TonePerfect and Langcraft are the vendors' own. Lingolix's benchmark (German error detection AUC 0.95 vs Azure 0.87) is self-authored, uses native speech with planted errors, and its code is public at github.com/lingolix/pronunciation-benchmark. I found no independent reviews.

## 5. Voice LLM for the feedback step

The LLM should explain phones a recognizer found, not diagnose the audio itself (see section 1: audio LLMs fall back on stock learner errors). So the input is text: target sentence, expected IPA, heard IPA, and the aligned differences. That makes a text model plus TTS the natural fit.

Per-minute prices are derived from official per-token prices and an assumed ~1,000 characters or ~1,200 OpenAI audio tokens per minute of speech, so treat them as estimates.

| Option | Cost per minute of spoken feedback | Notes |
|---|---|---|
| Claude (text) + `gpt-4o-mini-tts` | ~$0.015 + text (<$2/month total) | **Recommended.** Strong reasoning over the IPA; the TTS takes style instructions like "speak slowly". |
| Claude (text) + Gemini 3.8 Flash TTS / Flash Lite TTS | ~$0.0135 / $0.009 until 31 Dec 2026, then double | Pace and pronunciation control (vendor claim) |
| Claude (text) + Google Cloud TTS (WaveNet/Standard) | ~$0.004, and 4M characters/month free | Supports IPA through the SSML `<phoneme>` tag, so it could say a target word exactly as written in IPA, slowly. German support for that tag is unconfirmed. |
| Gemini 3.8 Live | ~$0.018 (audio out); free tier exists | Best value if you want one live spoken conversation |
| OpenAI `gpt-realtime-2.1-mini` / `gpt-audio-mini` | ~$0.024 | |
| OpenAI `gpt-realtime-2.1` / `gpt-audio-1.5` | ~$0.077 | Over budget at heavy use |
| Claude + ElevenLabs / Cartesia | ~$0.04–0.08 | Best voices, but 3–5× the price |

At 1,000 minutes of feedback a month: ~$15 with `gpt-4o-mini-tts`, ~$13.50 with Gemini Flash TTS, ~$0 with Google WaveNet inside its free tier, ~$77 with `gpt-realtime-2.1`. Realistically feedback will be a fraction of the 900 practice minutes.

I found no evidence that any of these can reliably produce an isolated or exaggerated German sound (for example a held ü). The most controllable route is TTS of the target word at a slow rate, optionally with an SSML IPA tag. Untested for German.

## Main uncertainties

- No published phone-error rates for learners speaking German. All L2 evidence is English.
- My test used TTS voices, not a human beginner.
- Commercial "heard IPA" quality is unverified beyond vendor claims.
- Hosting costs are estimates from list prices; none was deployed.

## Sources

- ZIPA paper: https://arxiv.org/abs/2505.23170 ; code and ONNX checkpoints: https://github.com/lingjzhu/zipa (HF `anyspeech/zipa-large-crctc-500k`)
- POWSM paper: https://arxiv.org/abs/2510.24992 ; model: https://huggingface.co/espnet/powsm
- Fluently L2 phone-recognition benchmark (vendor): https://getfluently.app/research/phone-recognition
- wav2vec2 espeak model: https://huggingface.co/facebook/wav2vec2-xlsr-53-espeak-cv-ft
- PEDBench: https://arxiv.org/abs/2610.20830 ; Intent vs. Surface: https://aclanthology.org/2026.bea-1.23.pdf ; Prior over Evidence: https://arxiv.org/html/2606.15325
- Lingolix: https://lingolix.com/en/api-portal/docs , https://lingolix.com/en/pricing
- Uttera: https://uttera.ai/de/docs/aussprache , https://uttera.ai/pricing
- TonePerfect: https://api.toneperfect.app/docs ; Langcraft: https://platform.langcraft.world/docs
- Azure: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-pronunciation-assessment
- SpeechSuper: https://docs.speechsuper.com/Languages/German/sent.eval.de.md
- Hosting: https://modal.com/pricing , https://huggingface.co/docs/hub/spaces-zerogpu , https://huggingface.co/pricing , https://replicate.com/pricing , https://fal.ai/pricing , https://www.baseten.co/pricing/ , https://www.runpod.io/pricing , https://docs.fly.io/about/pricing
- Spaces: https://huggingface.co/spaces/SergejKurt/german-pronunciation-trainer , https://huggingface.co/spaces/espnet/powsm-ctc
- Voice: https://developers.openai.com/api/docs/pricing , https://aistudio.google.com/docs/pricing , https://cloud.google.com/text-to-speech/pricing , https://elevenlabs.io/pricing/api , https://cartesia.ai/pricing
- LLM phonology evidence: https://arxiv.org/html/2502.09940 , https://arxiv.org/html/2503.11229
