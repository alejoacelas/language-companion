import sys, glob, os, time, torch, soundfile as sf
from transformers import AutoProcessor, AutoModelForCTC
from espeakng_loader import get_library_path, get_data_path
from phonemizer.backend.espeak.wrapper import EspeakWrapper
os.environ["ESPEAK_DATA_PATH"]=get_data_path(); EspeakWrapper.set_library(get_library_path()); EspeakWrapper.set_data_path(get_data_path())
from phonemizer import phonemize
model_id, audio_dir = sys.argv[1], sys.argv[2]
proc = AutoProcessor.from_pretrained(model_id); model = AutoModelForCTC.from_pretrained(model_id).eval()
for f in sorted(glob.glob(audio_dir+"/*.wav")):
    wav, sr = sf.read(f); assert sr==16000
    t=time.time()
    with torch.no_grad():
        logits = model(**proc(wav, sampling_rate=16000, return_tensors="pt")).logits
    out = proc.batch_decode(logits.argmax(-1))[0]
    print(f"{os.path.basename(f):32s} {len(wav)/sr:4.1f}s {time.time()-t:4.2f}s | {out}")
for s in ["schön","schon","Das ist sehr schön.","Ich möchte zwei Brötchen.","Die Bücher sind grün."]:
    print("espeak de:", s, "->", phonemize(s, language="de", backend="espeak", with_stress=False))
