# German pronunciation feedback: services, models and evidence

Researched 2026-11-03. Goal: find APIs we could build on that catch real pronunciation errors in German, for an adult beginner, and say which sound was wrong (and ideally what it sounded like instead).

## Bottom line

- **No option has public evidence that it catches real German learner errors.** There is no public, human-rated corpus of German learner speech used to benchmark any of these systems. Every German number below comes from native speech with errors planted in the reference text, run by a vendor, or from tests on native speech only.
- **Most specific German feedback: Lingolix.** It is the only commercial API found that returns, for German, both the expected IPA and the IPA it actually heard, per syllable (e.g. expected `mɔʁ`, heard `ma`). Its own benchmark puts it ahead of Azure on German. It is new (model version `2026-10`), small (Berlin UG), and the benchmark is self-run.
- **Safest mature option: Azure Pronunciation Assessment (de-DE).** Cheap, 5 free hours a month, big vendor. But for German it only gives a score per phoneme position: no phoneme names, no "what it sounded like", no prosody, no syllables. Those are documented as en-US only.
- **SpeechSuper** sits between the two: German phoneme labels with a score each, plus fluency and rhythm, per-request pricing, and a no-code demo. No German accuracy evidence of any kind.
- **Audio LLMs (GPT-4o, Gemini) should not be the judge.** On English learner data GPT-4o's phoneme-level agreement with humans is about a third of a specialised model's, and a 2026 study found LLMs "diagnose" stereotyped errors that are not in the audio. Use an LLM to turn a specialised engine's output into friendly advice, not to detect errors.
- **Before building, run our own 30-minute test** (protocol at the end). It is the only way to find out whether any of these hears ü vs u, vowel length, or ich vs ach in your voice.

## Comparison table

| Option | German support | Feedback granularity for German | Evidence quality for German | Cost | Try-it-now link |
|---|---|---|---|---|---|
| **Lingolix** | Yes (`de`), 1 of 17 languages | Per syllable: expected IPA vs detected IPA, accuracy, missing/extra syllables, pitch class (high/low/flat), timing; word and sentence scores; fluency, speaking rate. Unscripted mode transcribes if no sentence given | Vendor-run benchmark on planted errors in native German speech: error-detection AUC 0.95 (Azure 0.87). No human-rated learner data | Free 15 min/month (non-commercial); €5/mo for 180 min; €19/mo for 720 min; overage €0.02–0.05/min | https://lingolix.com/en#demo (rate-limited, no account stated) |
| **Azure Speech Pronunciation Assessment** | Yes (`de-DE`), 1 of 33 locales | Accuracy score per phoneme position (no phoneme name), word accuracy, word error type (mispronunciation / omission / insertion), fluency, completeness. Scripted and unscripted. **en-US only:** prosody, syllables, phoneme names, "spoken phoneme" (what it sounded like), content scores | Microsoft claims >0.5 Pearson with human judges, not broken down by language. Competitor's planted-error test: German AUC 0.87, with 22% of correct words falsely flagged when catching 80% of errors. Forum reports of German scores stuck at 100 in continuous mode, and of missing German phonemes in the portal | $1 per audio hour (S1); 5 free hours/month (F0); prosody add-on $0.30/hour (irrelevant for German) | https://ai.azure.com/explore/aiservices/speech → Pronunciation assessment (needs sign-in) |
| **SpeechSuper** | Yes, scripted only (word, sentence ≤200 words, paragraph ≤500 words) | Demo shows, per word, each phoneme with a score; sentence-level overall, pronunciation, fluency, completeness ("integrity"), rhythm, speed. No sign of a "heard as" field. API core types `word.eval.de`, `sent.eval.de` | None. Vendor gives no accuracy numbers for any language; no independent German evaluation found | $0.004 / word, $0.006 / sentence, $0.008 / paragraph request; $20 monthly minimum; free trial (size not stated) | https://www.speechsuper.com/demo/german/sentence-evaluation.html |
| **TonePerfect** | Yes (`de-DE`), but every language pack is labelled "experimental" | 0–100 score per sentence, word and sound; unclear whether it reports the detected sound | Vendor says scores are "display scores", not accuracy. In Lingolix's test: German AUC 0.79, 42% false alarms at 80% recall (tested before a later engine update) | 50 free credits (1 credit = 15 s), then from $10/month | No web demo found; API docs https://api.toneperfect.app/docs |
| **Speechace** | **No.** Docs list en-US, en-GB, fr-FR, fr-CA, es-ES, es-MX | n/a | n/a | n/a | n/a |
| **ELSA API** | **No evidence of German.** API is described as English | English: sentence, word, phoneme, stress, fluency | n/a | $0.008–0.025 per 15 s | English only: https://elsaspeak.com/en/experience |
| **Language Confidence** | **No evidence of German.** Product is framed around spoken English; no language list published | Not documented | n/a | Not published | None found |
| **Open source: wav2vec2 XLS-R phoneme recogniser + alignment** (`facebook/wav2vec2-xlsr-53-espeak-cv-ft`) | German was a training language (≈393 h of Common Voice German, per the paper's appendix) | Recognises the phones actually spoken; align to expected phones (espeak-ng) to get substitutions, deletions, insertions. Full "expected vs heard" | No German learner evaluation. English analogues: see benchmarks below | Free; needs a GPU or a slow CPU; you build the pipeline | Built on it: https://huggingface.co/spaces/SergejKurt/german-pronunciation-trainer (running today) |
| **Open source: forced alignment + GOP** (Montreal Forced Aligner German v3.0.0 model, Kaldi-style GOP) | Yes, MFA ships German acoustic models (v2.0.0, v2.0.0a, v3.0.0) | Per-phoneme confidence score at known positions; no "heard as" unless you add it | No German learner evaluation. English GOP baselines ≈0.6 phone-level correlation | Free; most engineering effort | None found for German |
| **german-phoneme-validator** (pip package, same author as the HF Space) | German only, 22 confusable pairs (e.g. ç–x, s–ʃ, iː–ɪ, aː–a, ʁ–ɐ, b–p) | Yes/no plus confidence for one target phoneme at a given time stamp | Reports 95.8% average accuracy, but tested on **native** speech segments, not learner errors. Weakest: aː–a (84.5%), ʁ–ɐ (86.8%), eː–ɛ (87.5%). No y–u or ø–o pair | Free | Used inside the HF Space above |
| **Audio LLMs as judges** (GPT-4o audio, Gemini) | They accept German audio | Free-text feedback at any level you ask for | No German study found. English: GPT-4o phoneme-level correlation 0.21–0.24 vs 0.61–0.69 for specialised models; >40% of utterances got no usable score. 2026 study: LLMs cite stereotyped errors not in the audio | Per-token API pricing | Any chat app with audio input |

## 1. Commercial APIs in detail

### Lingolix

- Berlin company (Lingolix UG). REST API, 17 languages including German. Can be hosted in Germany or self-hosted.
- German response, from the official docs example for "Guten Morgen":
  - word `Morgen`, accuracy 0.42
  - syllable `Mor`: expected `mɔʁ`, detected `ma`, accuracy 0.33, pitch "high"
  - syllable `gen`: expected `ɡn̩`, detected `ɡn̩`, accuracy 1.0
  - This is the kind of feedback the learner wants: it tells you the /ʁ/ was missing and the vowel was off.
- It reports per syllable, not per phoneme. You see the phonemes inside the syllable as IPA strings and can diff them yourself.
- No word-stress score and no sentence intonation score. It gives a pitch class per syllable.
- Benchmark (vendor-run, published Oct 2026, code and data public at https://github.com/lingolix/pronunciation-benchmark):
  - Test 1: 200 Common Voice clips per language, native speakers. They edit one word of the reference text so it no longer matches the audio (swapped sound, added or dropped sound, dropped word). A good system flags only that word.
  - German: AUC 0.95 (Lingolix), 0.87 (Azure), 0.79 (TonePerfect). Correct words wrongly flagged when the system is tuned to catch 80% of the planted errors: 2%, 22%, 42%.
  - English learner data (speechocean762, human ratings): sentence-level correlation 0.74 Lingolix vs 0.76 Azure; word-level 0.51 vs 0.61. So on the only human-rated test, Azure was **ahead**.
- Limits of that evidence:
  - Planted errors are the reverse of the real case. The audio is perfect native German and the text is wrong. A learner's error is usually subtle: a sound half-way between two phonemes. Catching a full swap like "Mutter" read against the text "Müller" is much easier than hearing a slightly rounded u.
  - The vendor built the test and won it.
  - Planted swaps are full phoneme changes, so the test says little about vowel length or vocalised r.

### Azure Speech Pronunciation Assessment

- German (`de-DE`) is supported, in scripted (reading) and unscripted (speaking) modes, and in all Speech regions.
- What German gets:
  - Accuracy score for each phoneme, word, and the whole text.
  - Word error type: `Mispronunciation` (word accuracy below 60), `Omission`, `Insertion`. Miscue detection is not available in continuous mode (audio over 30 s); you diff against the reference yourself.
  - Fluency and completeness scores.
- What German does not get, per the docs' "Supported features per locale" table and notes:
  - **Phoneme names.** "For locales that support phoneme name, the phoneme name is provided together with the score… For other locales, you can only get the phoneme score." Phoneme names exist only for en-US (IPA, SAPI) and zh-CN (SAPI). For German you get a list of scores and must map them to the expected phonemes yourself (e.g. from your own G2P), which only works if Azure's internal German phone set and yours line up.
  - **What it sounded like** (`NBestPhonemes`, "spoken phoneme"): en-US only.
  - **Syllable scores**: en-US only.
  - **Prosody** (stress, intonation, rhythm; `Monotone`, `UnexpectedBreak`, `MissingBreak`): en-US only.
  - **Content scores** (vocabulary, grammar, topic): en-US only, and retired from SDK 1.46 onward.
- Pricing: billed as standard speech-to-text. Azure retail price API, East US: S1 speech-to-text $1.00 per audio hour; "Enhanced Feature" add-on $0.30/hour (this is the prosody charge). Free tier: 5 audio hours per month.
- Evidence:
  - Microsoft's transparency note: ">0.5 Pearson correlation with human judges". No language, granularity or dataset given.
  - The GPT-4o paper below cites Azure on English speechocean762: word accuracy 0.623, sentence 0.782.
  - German: only Lingolix's planted-error test (AUC 0.87).
  - Warning signs from Microsoft Q&A: a developer testing English, German and French in 2024 got 100 for every word and phoneme ("guten morgen" scored 100 however badly said) after switching to continuous recognition, while single-shot recognition worked. No fix was posted. Another 2024 thread lists German among locales with missing phonemes in the Speech Studio view.
- No-code demo: Microsoft Foundry portal, https://ai.azure.com/explore/aiservices/speech → Pronunciation assessment → Reading tab → pick German. Needs a Microsoft/Azure sign-in. Hovering over a word shows its phoneme scores.

### SpeechSuper

- Suzhou-based vendor; 8 languages including German.
- German is scripted only: single word, sentence (up to 200 words), paragraph (up to 500 words). Unscripted and semi-scripted modes are English or Mandarin only.
- From the German demo pages' templates (not from written API docs, which are a JavaScript app I could not read):
  - word demo (`word.eval.de`): overall score, then a table of each phoneme `/x/` with a score.
  - sentence demo (`sent.eval.de`): overall, pronunciation, fluency, integrity (completeness), rhythm, speed; per word an overall score and its phonemes with scores.
  - No field for "heard as" was visible. Stress and linking are advertised for English.
- Pricing per request, not per minute: $0.004 word, $0.006 sentence, $0.008 paragraph (pay-as-you-go, $20/month minimum). Prepaid tiers are ~15–30% cheaper.
- Evidence: none. The site says "world-leading" and gives no numbers.

### TonePerfect

- 10 languages including `de-DE`; every pack is marked "experimental" in its own capabilities endpoint, and the vendor says grades are "display scores calibrated per language, not accuracy percentages".
- Scores per sentence, word and sound. Whether it reports the detected sound is not documented in what I read.
- Scored worst of three on German in the Lingolix test (AUC 0.79), but was tested before an engine update.

### Not usable for German

- **Speechace:** official docs list only English, French and Spanish dialects.
- **ELSA API:** described everywhere as English (sentence, word, phoneme, stress). Pricing $0.008–0.025 per 15 s.
- **Language Confidence:** no published language list; marketing is about spoken English. Treat as English-only unless they confirm otherwise.

## 2. Open-source and model-based approaches

### Phoneme recognition plus alignment ("what did you actually say?")

- `facebook/wav2vec2-xlsr-53-espeak-cv-ft` outputs IPA-like phones directly from audio. It does not use a German dictionary, so it can in principle report that you said [u] where [y] was expected.
- German was one of its training languages: about 393 hours of Common Voice German, per the appendix of Xu, Baevski & Auli (2021, arXiv 2109.11680). The model card itself names no languages and reports no error rate.
- Pipeline: convert the target sentence to IPA with espeak-ng, recognise the spoken phones, align the two sequences, report substitutions, deletions and insertions.
- Working German examples:
  - **German Pronunciation Trainer** HF Space (https://huggingface.co/spaces/SergejKurt/german-pronunciation-trainer, running as of today): Whisper ASR, espeak-ng G2P, the XLS-R espeak phoneme model, Needleman-Wunsch alignment with a phonetic similarity matrix, optional MFA alignment, then a second-stage check with `german-phoneme-validator`. Colour-coded expected vs recognised phonemes plus tips. No evaluation published.
  - **PhonoScore German** (https://github.com/RefNull/phonoscore-german, MIT, 1 star): self-hosted web app, CLI and HTTP API. Qwen3-ASR plus OpenPronounce wav2vec2 models; returns per-word errors with expected IPA and actual IPA. No evaluation numbers.
- Risks I could not check (unverified, but worth testing):
  - A recogniser trained mostly on native speech may "snap" a learner's in-between sound to the nearest German phoneme, either hiding the error or exaggerating it.
  - Whether the model's output reliably marks vowel length (ː) for German is not documented.
  - espeak-ng's German transcriptions set the "expected" answer, so G2P mistakes become false alarms.

### Forced alignment plus GOP ("how confident is the model that this was the right sound?")

- Montreal Forced Aligner has German acoustic models v2.0.0, v2.0.0a and v3.0.0 (CC BY 4.0, MFA phone set). The docs page gives no training corpus or accuracy figures.
- Goodness of Pronunciation (GOP) aligns the expected phonemes and scores each one by how strongly the acoustic model believes it. It tells you *which* phoneme is weak, not what it sounded like.
- No German learner evaluation found. English reference points: a public wav2vec2 CTC-alignment + GOP project reports Pearson 0.431 on speechocean762 phonemes; a 2022 Interspeech paper's GOP baseline reached ≈0.63–0.66.

### Allosaurus

- Universal phone recogniser. Published error rates are on unseen low-resource languages (e.g. 77–84% phone error rate on Tusom and Inuktitut). I found no German number. For German the XLS-R espeak model is the more relevant choice, since German was in its training data.

### Audio LLMs as pronunciation judges

Evidence is all on English, and it is negative at the phoneme level.

- **GPT-4o on speechocean762** (arXiv 2503.11229): correlation with human scores

  | Level | GPT-4o (best run) | GOPT (2022 specialised model) | 3MH (specialised) | Azure |
  |---|---|---|---|---|
  | Phoneme | 0.21–0.24 | 0.612 | 0.693 | not reported |
  | Word accuracy | 0.271 | 0.533 | 0.682 | 0.623 |
  | Sentence total | 0.502 | 0.742 | 0.811 | 0.782 |

  Also: over 40% of utterances produced no usable score in any run; stress correlation 0.15–0.25 and inconsistent between runs. Authors: GPT-4o "may not be as proficient as baseline models… without domain-specific data fine-tuning."
- **"Prior over Evidence: Stereotype-Driven Diagnosis in LLM-Based L2 Pronunciation Feedback"** (arXiv 2606.15325, 2026; gemini-3.0-flash, GPT-4o audio, Qwen 3.5 Omni on 1,800 L2-ARCTIC utterances):
  - The models' phoneme complaints came from a fixed set of "typical English learner" sounds (θ, ð, ɹ, v) across all six native-language groups.
  - Only 15.8% of judged answers combined sound reasoning with a correct, evidence-based rating; 39.6% had coherent-sounding reasoning supporting a wrong rating.
  - Shown only the text and an "L2 learner" label, the models flagged a stress error on 82–96% of utterances, against a true rate of about 4%. Telling them the speaker's native language made it worse.
  - For German this predicts feedback like "watch your ü and your ch" whether or not you got them wrong, because those are the famous German difficulties.
- **German:** no study found. A 2025 Turkish conference paper on ChatGPT and Gemini in German pronunciation teaching exists, but only its title was available.
- Fine-tuned speech LLMs (several 2025–2026 papers) do better on English, but none is an off-the-shelf German API.

## 3. Benchmarks and what the numbers mean

### Pearson correlation on speechocean762 (English, Mandarin speakers)

- speechocean762 has 5,000 English utterances read by Mandarin speakers, with expert scores for every phoneme (0–2), word and sentence.
- Correlation 1.0 means the machine ranks every phoneme exactly as humans do; 0 means no relationship.
- **A phoneme-level correlation of 0.6 means:** across many phonemes, the machine's scores clearly lean the same way as the experts', but squaring it (0.36) shows only about a third of the variation in expert scores is explained. On any single phoneme the machine will often disagree with the expert. Good for "this word/sound needs work over time", not trustworthy as a verdict on one attempt.
- Current specialised systems: phoneme 0.61–0.69, word 0.53–0.68, sentence 0.74–0.81. Sentence scores are easier because errors average out.
- GPT-4o's 0.21–0.24 at phoneme level is close to Microsoft's own "low: not significantly aligned with humans" band (0.1–0.3).

### Mispronunciation detection F1 on L2-ARCTIC (English, 24 speakers, 6 native languages)

- Xu et al. 2021 (Interspeech), wav2vec 2.0 fine-tuned: precision 0.58, recall 0.64, F1 0.61, false-rejection rate 8%. In plain terms:
  - It catches about **2 in 3** real phoneme errors (recall 0.64).
  - About **4 in 10** of its flags are false alarms (precision 0.58).
  - About **8 in 100** correctly said phonemes get flagged. In a 10-word German sentence with ~40 phonemes, that is about 3 false alarms per sentence if nothing is wrong.
- A November 2025 retrieval-based method reports F1 0.696 (abstract only; I did not verify the details).
- F1 near 0.6–0.7 has been the state of the art for years. Even the best research systems are noticeably wrong on single phonemes, so feedback should be framed as "likely issue" and aggregated over attempts.

### German-specific evidence

- **Learner corpora exist but are not used as benchmarks.** The IFCASL corpus (≈100 speakers, French learners of German and German learners of French, phone-level segmentation, >50% manually corrected; Trouvain et al., LREC 2016) is the closest thing. I found no published evaluation of any of the above systems on it.
- **Lingolix benchmark:** only multi-vendor German comparison, planted errors in native speech, vendor-run (numbers above).
- **german-phoneme-validator:** 95.8% average accuracy at telling 22 German sound pairs apart, but measured on native speech segments aligned by MFA, with a random 70/15/15 split. It shows the sounds are acoustically separable, not that learner errors are caught. Per-pair results show where the difficulty is:
  - ç vs x (ich-Laut vs ach-Laut): 99.9%
  - s vs ʃ: 99.2%
  - b vs p, d vs t, g vs k (relevant to final devoicing): 94–96%
  - iː vs ɪ: 91.5%; uː vs ʊ: 90.9%; oː vs ɔ: 89.5%; eː vs ɛ: 87.5%
  - ʁ vs ɐ (consonantal vs vocalised r): 86.8%
  - aː vs a (pure vowel length): 84.5%, the hardest pair
  - **y vs u (ü vs u) and ø vs o (ö vs o) are not covered.**
  - Reading: vowel length and vocalised r are the hardest distinctions even on clean native speech, so expect every system to be least reliable there.

### Vivid examples and failure cases

- Lingolix docs: "Morgen" with expected `mɔʁ`, heard `ma` (missing uvular r, wrong vowel), syllable score 0.33.
- Azure docs (English only, since German lacks this): "hello" expected `h ɛ l oʊ`, spoken phonemes `h ə l oʊ`. This "what it sounded like" output is exactly the feature German lacks in Azure.
- Azure failure report: "guten morgen" scored 100 for every phoneme regardless of pronunciation in continuous mode (Microsoft Q&A, 2024, unresolved).
- LLM failure: models flagged stress errors on up to 96% of sentences where only ~4% had one, and blamed the same textbook sounds for every speaker.
- I found no published sample output showing any system catching or missing ü/u, ö/o, final devoicing, or ich/ach in real learner German.

## Recommended next step: a 30-minute test with your own voice

Run the same recordings through Lingolix, Azure (Foundry portal) and SpeechSuper (demo). For each item, record the correct version and a deliberately wrong version. A system passes an item if it flags the wrong version at the right sound and leaves the correct version alone.

| Error type | Say correctly | Then say wrongly |
|---|---|---|
| ü vs u | müssen [ˈmʏsn̩] | "mussen" with [ʊ] |
| ö vs o | schön [ʃøːn] | "schon" [ʃoːn] |
| Vowel length | Staat [ʃtaːt] | short [a] as in Stadt |
| Final devoicing | Rad [ʁaːt] | with a voiced [d] at the end |
| ich-Laut | ich [ɪç] | [ɪʃ] or [ɪk] |
| ach-Laut | Buch [buːx] | [buːk] |
| Vocalised r | Wasser [ˈvasɐ] | English-style [ɹ] |
| Uvular r | rot [ʁoːt] | English [ɹ] |

Count hits and false alarms per system. This takes about 30 minutes and answers the main open question better than any published number.

## Sources

Vendor documentation and pricing
- Azure how-to (feature-per-locale table, prosody en-US only, error types): https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-pronunciation-assessment
- Azure supported languages (33 locales incl. de-DE): https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=pronunciation-assessment
- Azure no-code tool and pricing table: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/pronunciation-assessment-tool
- Azure characteristics and limitations (>0.5 Pearson claim): https://learn.microsoft.com/en-us/azure/ai-foundry/responsible-ai/speech-service/pronunciation-assessment/characteristics-and-limitations-pronunciation-assessment
- Azure retail prices API (S1 $1/h, enhanced feature $0.30/h): https://prices.azure.com/api/retail/prices
- Azure free tier (5 h/month): https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/
- Azure Q&A, scores stuck at 100 in German: https://learn.microsoft.com/en-us/answers/questions/1680083/cognitive-services-pronunciation-assessment-always
- Azure Q&A, missing phonemes for German and others: https://learn.microsoft.com/en-us/answers/questions/2029373/how-do-we-get-sapi-or-ipa-phoneme-results-for-en-g
- SpeechSuper German demos: https://www.speechsuper.com/demo/german/index.html
- SpeechSuper pricing: https://www.speechsuper.com/pricing.html
- Lingolix home and demo: https://lingolix.com/en
- Lingolix API docs (German example): https://lingolix.com/en/api-portal/docs
- Lingolix pricing: https://lingolix.com/en/pricing
- TonePerfect client package (languages, experimental flag, pricing): https://pub.dev/packages/toneperfect
- Speechace supported languages: https://api-docs.speechace.com/getting-started/supported-languages.md
- ELSA API page: https://elsaspeak.com/en/elsa-api/
- Language Confidence: https://languageconfidence.ai/

Benchmarks and papers
- Lingolix benchmark write-up (vendor-run): https://lingolix.com/en/blog/best-pronunciation-assessment-api-2026
- Lingolix benchmark code and data: https://github.com/lingolix/pronunciation-benchmark
- GPT-4o for pronunciation assessment on speechocean762: https://arxiv.org/abs/2503.11229
- Prior over Evidence, stereotype-driven LLM feedback: https://arxiv.org/html/2606.15325v1
- Xu et al. 2021, wav2vec 2.0 for mispronunciation detection on L2-ARCTIC: https://www.isca-archive.org/interspeech_2021/xu21k_interspeech.pdf
- Xu, Baevski & Auli 2021, zero-shot cross-lingual phoneme recognition: https://arxiv.org/abs/2109.11680
- Wav2vec2/HuBERT vs GOP on English: https://arxiv.org/pdf/2204.03863
- Allosaurus: https://arxiv.org/pdf/2002.11800
- IFCASL corpus: https://hal.univ-lorraine.fr/LORIA-NLPKD/hal-01293935v1

Open-source models and demos
- facebook/wav2vec2-xlsr-53-espeak-cv-ft: https://huggingface.co/facebook/wav2vec2-xlsr-53-espeak-cv-ft
- MFA German acoustic models: https://mfa-models.readthedocs.io/en/latest/acoustic/German/index.html
- German Pronunciation Trainer (HF Space): https://huggingface.co/spaces/SergejKurt/german-pronunciation-trainer
- german-phoneme-validator: https://pypi.org/project/german-phoneme-validator/ and technical report https://github.com/SergejKurtasch/german-phoneme-validator/blob/main/TECHNICAL_REPORT.md
- PhonoScore German: https://github.com/RefNull/phonoscore-german
- GOP on speechocean762 (Pearson 0.431): https://github.com/Victus0904/phoneme-mispronunciation-detection
