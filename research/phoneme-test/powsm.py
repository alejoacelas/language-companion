import sys, glob, os, time, numpy as np, soundfile as sf
from espnet2.bin.s2t_inference import Speech2Text
lang = sys.argv[2]
s2t = Speech2Text.from_pretrained("espnet/powsm", device="cpu", lang_sym=lang, task_sym="<pr>")
for f in sorted(glob.glob(sys.argv[1]+"/*.wav")):
    a, sr = sf.read(f)
    a = np.pad(a, (0, 16000*20-len(a)))
    t=time.time()
    pred = s2t(a, text_prev="<na>")[0][0]
    pred = pred.split("<notimestamps>")[-1].strip().replace("/", " ")
    print(f"{os.path.basename(f):32s} {time.time()-t:4.2f}s | {' '.join(pred.split())}")
