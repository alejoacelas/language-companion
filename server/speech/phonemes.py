"""Hear which phones a learner said and compare them with the expected German phones.

recognize(audio_bytes, mime) -> runs ZIPA-CR-Large (main) and wav2vec2-xlsr-53-espeak (second opinion)
expected(text_de)            -> expected IPA phones per word, from espeak-ng
compare(text_de, recognition) -> per-word, per-phone verdicts

Both recognizers and espeak-ng use different IPA conventions, so every phone string goes
through `normalize()` before alignment. Models load on first use and stay in memory;
call `warm_up()` at server start to pay the load cost early.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import threading
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
os.environ.setdefault("HF_HOME", str(ROOT / "data" / "models"))

SAMPLE_RATE = 16000
PAD_SECONDS = 0.5  # CTC models drop sounds at the very edge of short clips
ZIPA_REPO = "anyspeech/zipa-large-crctc-500k"
W2V_REPO = "facebook/wav2vec2-xlsr-53-espeak-cv-ft"
MODELS = ("zipa", "wav2vec2")

# ---------------------------------------------------------------------------
# Audio decoding


def decode_audio(audio_bytes: bytes, mime: str = "") -> np.ndarray:
    """Decode any ffmpeg-readable recording (webm/opus, ogg, wav, m4a, mp3) to 16 kHz mono float32."""
    suffix = {
        "audio/webm": ".webm", "audio/ogg": ".ogg", "audio/wav": ".wav", "audio/x-wav": ".wav",
        "audio/wave": ".wav", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/aac": ".aac",
        "audio/mpeg": ".mp3",
    }.get((mime or "").split(";")[0].strip().lower(), "")
    # A file, not a pipe: mp4/m4a often keeps its index at the end and can't be read from stdin.
    with tempfile.NamedTemporaryFile(suffix=suffix) as f:
        f.write(audio_bytes)
        f.flush()
        proc = subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-i", f.name, "-f", "f32le", "-ac", "1",
             "-ar", str(SAMPLE_RATE), "pipe:1"],
            capture_output=True,
        )
    if proc.returncode != 0:
        raise ValueError(f"ffmpeg could not decode audio ({mime}): {proc.stderr.decode()[-500:]}")
    return np.frombuffer(proc.stdout, dtype=np.float32).copy()


# ---------------------------------------------------------------------------
# Models (loaded lazily, once)

_lock = threading.Lock()
_models: dict = {}
_pool = ThreadPoolExecutor(max_workers=2)


def _snapshot(repo: str) -> Path:
    from huggingface_hub import snapshot_download

    try:
        return Path(snapshot_download(repo, local_files_only=True))
    except Exception:
        return Path(snapshot_download(repo))  # first run on a new machine: download into HF_HOME


def _load():
    with _lock:
        if _models:
            return _models
        import onnxruntime as ort
        import torch
        from lhotse.features.kaldi.extractors import Fbank, FbankConfig
        from transformers import AutoModelForCTC

        zdir = _snapshot(ZIPA_REPO)
        zvocab = {}
        for line in open(zdir / "tokens.txt", encoding="utf-8"):
            parts = line.split()
            if len(parts) == 2:
                zvocab[int(parts[1])] = parts[0]
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 4
        zsess = ort.InferenceSession(str(zdir / "model.onnx"), opts, providers=["CPUExecutionProvider"])
        fbank = Fbank(FbankConfig(num_filters=80, dither=0.0, snip_edges=False))

        wdir = _snapshot(W2V_REPO)
        wvocab = {v: k for k, v in json.load(open(wdir / "vocab.json", encoding="utf-8")).items()}
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        wmodel = AutoModelForCTC.from_pretrained(str(wdir)).eval().to(device)
        prep = json.load(open(wdir / "preprocessor_config.json"))

        _models.update(zsess=zsess, zvocab=zvocab, fbank=fbank, wmodel=wmodel, wvocab=wvocab,
                       wdevice=device, wnorm=prep.get("do_normalize", True))
        return _models


def warm_up() -> float:
    """Load both models and run one dummy clip. Returns seconds taken."""
    t = time.perf_counter()
    m = _load()
    silence = np.zeros(SAMPLE_RATE, dtype=np.float32)
    _run_zipa(m, silence)
    _run_w2v(m, silence)
    return time.perf_counter() - t


def _ctc_collapse(ids, vocab, blank=0) -> list[str]:
    out, prev = [], -1
    for i in ids:
        i = int(i)
        if i != blank and i != prev:
            out.append(vocab.get(i, ""))
        prev = i
    return out


def _run_zipa(m, wav: np.ndarray) -> list[str]:
    import torch

    feat = m["fbank"].extract_batch([torch.from_numpy(wav)], sampling_rate=SAMPLE_RATE)[0]
    feat = feat.unsqueeze(0).numpy()
    lp = m["zsess"].run(None, {"x": feat, "x_lens": np.array([feat.shape[1]], dtype=np.int64)})[0][0]
    toks = _ctc_collapse(lp.argmax(-1), m["zvocab"])
    return [t for t in toks if t not in ("▁", "<sos/eos>", "<unk>", "")]


def _run_w2v(m, wav: np.ndarray) -> list[str]:
    import torch

    x = wav
    if m["wnorm"]:
        x = (x - x.mean()) / np.sqrt(x.var() + 1e-7)
    with torch.inference_mode():
        logits = m["wmodel"](torch.from_numpy(x)[None].to(m["wdevice"])).logits[0]
    toks = _ctc_collapse(logits.argmax(-1).cpu().numpy(), m["wvocab"])
    return [t for t in toks if not t.startswith("<")]


def recognize(audio_bytes: bytes, mime: str = "audio/webm") -> dict:
    """Decode a browser recording and run both recognizers.

    Returns {"phones": {"zipa": [...], "wav2vec2": [...]}  (normalised phones, used by compare),
             "raw": {"zipa": "...", "wav2vec2": "..."}     (model output as emitted),
             "duration_s": float, "timing_s": {...}}
    """
    t0 = time.perf_counter()
    wav = decode_audio(audio_bytes, mime)
    return recognize_array(wav, t_start=t0)


def recognize_array(wav: np.ndarray, t_start: float | None = None) -> dict:
    t0 = t_start if t_start is not None else time.perf_counter()
    t_dec = time.perf_counter()
    m = _load()
    pad = np.zeros(int(PAD_SECONDS * SAMPLE_RATE), dtype=np.float32)
    padded = np.concatenate([pad, wav.astype(np.float32), pad])

    def timed(fn):
        s = time.perf_counter()
        r = fn(m, padded)
        return r, time.perf_counter() - s

    fz = _pool.submit(timed, _run_zipa)
    fw = _pool.submit(timed, _run_w2v)
    (zraw, tz), (wraw, tw) = fz.result(), fw.result()
    return {
        "phones": {"zipa": normalize(zraw), "wav2vec2": normalize(wraw)},
        "raw": {"zipa": " ".join(zraw), "wav2vec2": " ".join(wraw)},
        "duration_s": round(len(wav) / SAMPLE_RATE, 2),
        "timing_s": {"decode": round(t_dec - t0, 3), "zipa": round(tz, 3), "wav2vec2": round(tw, 3),
                     "total": round(time.perf_counter() - t0, 3)},
    }


# ---------------------------------------------------------------------------
# Phone notation

_DROP_MARKS = {
    "ˈ", "ˌ", "ʰ", "ʼ", "ˑ", ".", "-", "_", "‿", "|", "‖", "ʔ",  # stress, aspiration, glottal stop, separators
    "‍", "͡", "͜",  # zero-width joiner and tie bars (espeak ts, aɪ)
}
_CHAR_MAP = {
    "g": "ɡ", "r": "ʁ", "ɾ": "ʁ", "ʀ": "ʁ", "ɹ̩": "ɹ",  # German r variants are one phoneme
    "ɑ": "a", "ɜ": "ɐ", "ɚ": "ɐ", "ε": "ɛ",  # espeak writes long a as ɑː and vocalic r as ɜ
    "ʧ": "tʃ", "ʦ": "ts", "ʤ": "dʒ",
}
_LENGTH = "ː"
_DIPHTHONGS = {("a", "ɪ"): "aɪ", ("a", "ʊ"): "aʊ", ("ɔ", "ʏ"): "ɔʏ", ("ɔ", "ɪ"): "ɔʏ",
               ("ɔ", "ø"): "ɔʏ", ("ɔ", "y"): "ɔʏ", ("a", "i"): "aɪ", ("a", "u"): "aʊ", ("ɔ", "i"): "ɔʏ"}


def _segment(s: str) -> list[str]:
    """Split an IPA string into phones: base letter + length mark. Diacritics are dropped."""
    # NFC keeps ç as one letter; any combining mark left after it is a diacritic to drop.
    s = unicodedata.normalize("NFC", s)
    phones: list[str] = []
    for ch in s:
        if ch in _DROP_MARKS or ch.isspace() or ch.isdigit():
            continue
        if unicodedata.combining(ch):
            continue  # ̯ ̩ ̥ ̃ ̪ etc.
        if ch in ("ː", ":"):
            if phones and not phones[-1].endswith(_LENGTH):
                phones[-1] += _LENGTH
            continue
        if ch in ("ʲ", "ʷ", "ˠ", "ˤ", "˞"):
            continue
        ch = _CHAR_MAP.get(ch, ch)
        phones.extend(list(ch) if len(ch) > 1 else [ch])
    return phones


def normalize(tokens) -> list[str]:
    """Bring a model's or espeak's phones into one notation.

    Rules: drop stress, tie bars, aspiration, syllabic/non-syllabic marks and glottal stops;
    r, ɾ, ʀ, ʁ -> ʁ; g -> ɡ; ɑ -> a; ɜ/ɚ -> ɐ; affricates are two phones (ts -> t s);
    diphthongs are one phone (aɪ, aʊ, ɔʏ). Vowel length is kept.
    """
    s = "".join(tokens) if not isinstance(tokens, str) else tokens
    phones = _segment(s)
    out: list[str] = []
    for p in phones:
        if out and (out[-1], p) in _DIPHTHONGS:
            out[-1] = _DIPHTHONGS[(out[-1], p)]
            continue
        out.append(p)
    return out


# ---------------------------------------------------------------------------
# Expected phones (espeak-ng)

_WORD_RE = re.compile(r"[\w'’-]+", re.UNICODE)


def _espeak_lines(lines: list[str]) -> list[str]:
    proc = subprocess.run(
        ["espeak-ng", "-v", "de", "-q", "--ipa", "--sep=_"],
        input="\n".join(lines) + "\n", capture_output=True, text=True, check=True,
    )
    return [ln.strip() for ln in proc.stdout.splitlines() if ln.strip()]


def expected(text_de: str) -> list[dict]:
    """Expected German phones, word by word: [{"word": "schön", "ipa": "ʃøːn", "phones": ["ʃ","øː","n"]}].

    Each word is phonemised on its own line, so the mapping word -> phones is exact.
    """
    words = [w.strip("'’-") for w in _WORD_RE.findall(text_de)]
    words = [w for w in words if w]
    if not words:
        return []
    out_lines = _espeak_lines(words)
    if len(out_lines) != len(words):  # espeak split or merged a line: do it one word at a time
        out_lines = [" ".join(_espeak_lines([w])) for w in words]
    result = []
    for w, ln in zip(words, out_lines):
        phones = normalize(ln.replace(" ", ""))
        result.append({"word": w, "ipa": "".join(phones), "phones": phones})
    return result


# ---------------------------------------------------------------------------
# Phone similarity

# Vowels: (height 0=close..6=open, backness 0=front 1=central 2=back, rounded)
_V = {
    "i": (0, 0, 0), "y": (0, 0, 1), "ɪ": (1, 0, 0), "ʏ": (1, 0, 1), "e": (2, 0, 0), "ø": (2, 0, 1),
    "ɛ": (4, 0, 0), "œ": (4, 0, 1), "æ": (5, 0, 0), "a": (6, 1, 0), "ɐ": (5, 1, 0), "ə": (3, 1, 0),
    "ɨ": (0, 1, 0), "ʉ": (0, 1, 1), "ɘ": (2, 1, 0), "ɵ": (2, 1, 1), "ɞ": (4, 1, 1), "ɶ": (6, 0, 1),
    "u": (0, 2, 1), "ʊ": (1, 2, 1), "o": (2, 2, 1), "ɔ": (4, 2, 1), "ʌ": (4, 2, 0), "ɒ": (6, 2, 1),
    "ɤ": (2, 2, 0), "ɯ": (0, 2, 0),
}
# Consonants: (place, manner, voiced). place 0 bilabial .. 8 glottal.
# manner: 0 stop, 1 nasal, 2 fricative, 3 approximant, 4 trill/tap, 5 lateral
_C = {
    "p": (0, 0, 0), "b": (0, 0, 1), "m": (0, 1, 1), "ɸ": (0, 2, 0), "β": (0, 2, 1), "w": (0, 3, 1),
    "f": (1, 2, 0), "v": (1, 2, 1), "ʋ": (1, 3, 1), "ɱ": (1, 1, 1),
    "θ": (2, 2, 0), "ð": (2, 2, 1),
    "t": (3, 0, 0), "d": (3, 0, 1), "n": (3, 1, 1), "s": (3, 2, 0), "z": (3, 2, 1), "ɹ": (3, 3, 1),
    "l": (3, 5, 1), "ɬ": (3, 2, 0),
    "ʃ": (4, 2, 0), "ʒ": (4, 2, 1), "ʂ": (4, 2, 0), "ʐ": (4, 2, 1), "ɕ": (4.5, 2, 0), "ʑ": (4.5, 2, 1),
    "ç": (5, 2, 0), "ʝ": (5, 2, 1), "j": (5, 3, 1), "ɲ": (5, 1, 1), "ʎ": (5, 5, 1), "c": (5, 0, 0),
    "ɟ": (5, 0, 1),
    "k": (6, 0, 0), "ɡ": (6, 0, 1), "ŋ": (6, 1, 1), "x": (6, 2, 0), "ɣ": (6, 2, 1), "ɰ": (6, 3, 1),
    "q": (7, 0, 0), "ɢ": (7, 0, 1), "ɴ": (7, 1, 1), "χ": (7, 2, 0), "ʁ": (7, 2, 1),
    "ħ": (8, 2, 0), "ʕ": (8, 2, 1), "h": (8, 2, 0), "ɦ": (8, 2, 1),
}
NEAR_MISS = 0.5  # substitutions at or below this cost are flagged "near": true


def _base(p: str) -> tuple[str, bool]:
    return (p[:-1], True) if p.endswith(_LENGTH) and len(p) > 1 else (p, False)


def _vowel_cost(a: str, b: str) -> float:
    (h1, b1, r1), (h2, b2, r2) = _V[a], _V[b]
    return min(1.0, 0.1 * abs(h1 - h2) + 0.25 * abs(b1 - b2) + 0.3 * abs(r1 - r2))


def _parts(p: str) -> list[str]:
    return list(p) if p in ("aɪ", "aʊ", "ɔʏ") else [p]


def phone_cost(a: str, b: str) -> float:
    """Substitution cost 0..1. 0 = same phone; <= NEAR_MISS = near miss (ø/o, yː/uː, ç/ʃ...)."""
    if a == b:
        return 0.0
    (ba, la), (bb, lb) = _base(a), _base(b)
    length = 0.1 if la != lb else 0.0
    if ba == bb:
        return length
    pa, pb = _parts(ba), _parts(bb)
    if all(x in _V for x in pa + pb):
        if len(pa) == len(pb):
            c = sum(_vowel_cost(x, y) for x, y in zip(pa, pb)) / len(pa)
        else:  # diphthong vs monophthong
            mono, diph = (pa, pb) if len(pa) == 1 else (pb, pa)
            c = min(_vowel_cost(mono[0], d) for d in diph) + 0.3
        return min(1.0, c + length)
    if ba in _C and bb in _C:
        (p1, m1, v1), (p2, m2, v2) = _C[ba], _C[bb]
        c = 0.25 * abs(v1 - v2) + 0.1 * min(abs(p1 - p2), 4) + (0.4 if m1 != m2 else 0.0)
        if {ba, bb} <= {"ʁ", "χ", "ɹ", "ɐ"}:  # r-sounds
            c = min(c, 0.4)
        return min(1.0, c)
    if {ba, bb} in ({"ɐ", "ʁ"}, {"ɐ", "ɹ"}):  # vocalic r vs consonantal r
        return 0.4
    return 1.0


# ---------------------------------------------------------------------------
# Alignment

INDEL = 0.7  # deletion/insertion cost; substitutions cost phone_cost (<= 1)


def align(ref: list[str], hyp: list[str]) -> list[tuple[int | None, int | None]]:
    """Weighted edit-distance alignment. Returns pairs (ref_index|None, hyp_index|None)."""
    n, m = len(ref), len(hyp)
    D = np.zeros((n + 1, m + 1))
    D[:, 0] = np.arange(n + 1) * INDEL
    D[0, :] = np.arange(m + 1) * INDEL
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            D[i, j] = min(D[i - 1, j - 1] + phone_cost(ref[i - 1], hyp[j - 1]),
                          D[i - 1, j] + INDEL, D[i, j - 1] + INDEL)
    pairs = []
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and np.isclose(D[i, j], D[i - 1, j - 1] + phone_cost(ref[i - 1], hyp[j - 1])):
            pairs.append((i - 1, j - 1)); i -= 1; j -= 1
        elif i > 0 and np.isclose(D[i, j], D[i - 1, j] + INDEL):
            pairs.append((i - 1, None)); i -= 1
        else:
            pairs.append((None, j - 1)); j -= 1
    return pairs[::-1]


def _verdicts(ref: list[str], hyp: list[str]):
    """Per expected phone: {"status", "heard"}; plus insertions keyed by the expected index they follow."""
    per_ref: list[dict] = [None] * len(ref)  # type: ignore
    extras: dict[int, list[str]] = {}
    last = -1
    for ri, hi in align(ref, hyp):
        if ri is not None and hi is not None:
            same = ref[ri] == hyp[hi]
            length_only = not same and _base(ref[ri])[0] == _base(hyp[hi])[0]
            per_ref[ri] = {"status": "ok" if same or length_only else "substituted", "heard": hyp[hi]}
            last = ri
        elif ri is not None:
            per_ref[ri] = {"status": "missing", "heard": None}
            last = ri
        else:
            extras.setdefault(last, []).append(hyp[hi])
    return per_ref, extras


def _phone_entry(exp: str, v: dict) -> dict:
    e = {"expected": exp, "status": v["status"]}
    if v["status"] == "ok" and v["heard"] != exp:
        e["heard"] = v["heard"]
        e["note"] = "length differs"
    elif v["status"] == "substituted":
        e["heard"] = v["heard"]
        e["near"] = phone_cost(exp, v["heard"]) <= NEAR_MISS
    return e


def compare(text_de: str, recognition: dict) -> dict:
    """Align expected phones of `text_de` with what both models heard.

    Per phone status:
      ok           both models heard the expected phone (vowel length differences are noted, not errors)
      substituted  both models heard a wrong phone, and they agree on it or ZIPA's is clearly off
                   ("heard" is ZIPA's phone, "also_heard" wav2vec2's if different;
                   "near": true if it's a close sound, e.g. øː→oː)
      missing      ZIPA heard nothing there and wav2vec2 also heard it wrong
      extra        both heard an added phone here (entry has "expected": null)
      uncertain    one model heard it right and the other didn't, or both heard different near misses;
                   "zipa" and "wav2vec2" hold each verdict. ZIPA is more accurate on German vowels
                   (wav2vec2 tends to miss ü/ö); ZIPA tends to "correct" consonants like isch→ich.
    Word status: "error" if any phone is substituted/missing/extra, else "uncertain" if any is, else "ok".
    """
    words = expected(text_de)
    ref = [p for w in words for p in w["phones"]]
    owner = [wi for wi, w in enumerate(words) for _ in w["phones"]]
    heard = recognition["phones"]
    per_model = {name: _verdicts(ref, heard[name]) for name in MODELS}

    word_phones: list[list[dict]] = [[] for _ in words]

    def add_extras(idx: int):
        sets = {name: per_model[name][1].get(idx, []) for name in MODELS}
        wi = owner[idx] if idx >= 0 else 0
        if not words:
            return
        main, second = sets["zipa"], sets["wav2vec2"]
        common = [p for p in main if p in second]
        for p in common:
            word_phones[wi].append({"expected": None, "status": "extra", "heard": p})
        for name, ps in sets.items():
            for p in ps:
                if p not in common:
                    word_phones[wi].append({"expected": None, "status": "uncertain", "kind": "extra",
                                            name: {"status": "extra", "heard": p},
                                            **{o: {"status": "ok"} for o in MODELS if o != name}})

    add_extras(-1)
    for i, exp in enumerate(ref):
        vs = {name: per_model[name][0][i] for name in MODELS}
        a, b = vs["zipa"], vs["wav2vec2"]
        if a["status"] == "ok" and b["status"] == "ok":
            entry = _phone_entry(exp, a)
        elif a["status"] != "ok" and b["status"] != "ok" and (
                a["heard"] == b["heard"] or a["status"] == "missing"
                or phone_cost(exp, a["heard"]) > NEAR_MISS):
            # Both heard something wrong, and either they agree on what, or ZIPA heard a clearly
            # different sound. ZIPA's phone is reported; wav2vec2's goes in "also_heard".
            entry = _phone_entry(exp, a)
            if b["heard"] != a["heard"]:
                entry["also_heard"] = b["heard"]
        else:
            entry = {"expected": exp, "status": "uncertain",
                     **{name: _phone_entry(exp, v) for name, v in vs.items()}}
            for name in MODELS:
                entry[name].pop("expected")
        word_phones[owner[i]].append(entry)
        add_extras(i)

    out_words = []
    counts = {"ok": 0, "substituted": 0, "missing": 0, "extra": 0, "uncertain": 0}
    for w, phones in zip(words, word_phones):
        for p in phones:
            counts[p["status"]] += 1
        statuses = {p["status"] for p in phones}
        status = ("error" if statuses & {"substituted", "missing", "extra"}
                  else "uncertain" if "uncertain" in statuses else "ok")
        out_words.append({"word": w["word"], "expected": w["ipa"], "status": status, "phones": phones})
    return {
        "text": text_de,
        "expected_ipa": " ".join(w["ipa"] for w in words),
        "heard_ipa": {name: "".join(heard[name]) for name in MODELS},
        "words": out_words,
        "counts": counts,
    }


def format_result(result: dict) -> str:
    """Readable one-line-per-word rendering of compare() output, for logs and the self-test."""
    lines = [f"expected: {result['expected_ipa']}",
             *(f"{n:>9}: {s}" for n, s in result["heard_ipa"].items())]
    for w in result["words"]:
        bits = []
        for p in w["phones"]:
            s, e = p["status"], p["expected"]
            if s == "ok":
                bits.append(e)
            elif s == "substituted":
                alt = f"/{p['also_heard']}" if p.get("also_heard") else ""
                bits.append(f"[{e}→{p['heard']}{alt}{'~' if p.get('near') else ''}]")
            elif s == "missing":
                alt = f"/{p['also_heard']}" if p.get("also_heard") else ""
                bits.append(f"[-{e}{alt}]")
            elif s == "extra":
                bits.append(f"[+{p['heard']}]")
            else:
                def short(v):
                    if v["status"] == "ok":
                        return e or "∅"
                    if v["status"] == "missing":
                        return "∅"
                    return ("+" if v["status"] == "extra" else "") + v.get("heard", "?")
                bits.append(f"[{e or '∅'}? z:{short(p['zipa'])} w:{short(p['wav2vec2'])}]")
        lines.append(f"  {w['status']:>9}  {w['word']:<14} {' '.join(bits)}")
    return "\n".join(lines)
